/**
 * A small, account-scoped transport limiter.
 *
 * The SearchAd client already owns authentication and HTTP serialization.  This
 * module owns the concern that is not visible to that client: several workers
 * may be using the same customer account at once.  Requests are therefore
 * serialized through one limiter and retryable responses feed back into the
 * pacing and circuit state.
 */

export type RateLimiterOperation<T> = () => T | PromiseLike<T>

export type RateLimiterClock = {
  readonly now: () => number
  readonly sleep: (milliseconds: number) => Promise<void>
  readonly random: () => number
}

export type AdaptiveRateLimiterOptions = {
  /** Minimum gap between request starts when the account is healthy. */
  readonly minIntervalMs?: number
  /** Upper bound for the adaptive request gap. */
  readonly maxIntervalMs?: number
  /** First retryable-error backoff. */
  readonly baseBackoffMs?: number
  /** Upper bound for exponential backoff. */
  readonly maxBackoffMs?: number
  /** Symmetric jitter as a fraction of the calculated backoff, e.g. 0.2. */
  readonly jitterRatio?: number
  /** Number of retries after the first attempt. */
  readonly maxRetries?: number
  /** Consecutive retryable failures needed to open the circuit. */
  readonly failureThreshold?: number
  /** How long an open circuit remains open before one probe is allowed. */
  readonly circuitCooldownMs?: number

  /** Injectable clock hooks make all waiting deterministic in unit tests. */
  readonly now?: () => number
  readonly sleep?: (milliseconds: number) => Promise<void>
  readonly random?: () => number
}

export type RateLimiterState = 'closed' | 'open' | 'half-open'

export type RateLimiterSnapshot = {
  readonly state: RateLimiterState
  readonly consecutiveFailures: number
  readonly currentIntervalMs: number
  readonly nextAllowedAt: number
  readonly circuitOpenedUntil: number | null
}

/** Error returned when a caller is refused without making an HTTP request. */
export class CircuitOpenError extends Error {
  readonly name = 'CircuitOpenError'

  constructor(
    public readonly retryAt: number,
    message = `Naver account circuit is open until ${new Date(retryAt).toISOString()}`,
  ) {
    super(message)
  }
}

const DEFAULTS = Object.freeze({
  minIntervalMs: 100,
  maxIntervalMs: 5_000,
  baseBackoffMs: 500,
  maxBackoffMs: 30_000,
  jitterRatio: 0.2,
  maxRetries: 3,
  failureThreshold: 5,
  circuitCooldownMs: 30_000,
})

function finiteNonNegative(value: number | undefined, fallback: number, label: string): number {
  const resolved = value ?? fallback
  if (!Number.isFinite(resolved) || resolved < 0) {
    throw new TypeError(`${label} must be a finite non-negative number`)
  }
  return resolved
}

function positiveInteger(value: number | undefined, fallback: number, label: string): number {
  const resolved = value ?? fallback
  if (!Number.isSafeInteger(resolved) || resolved < 1) {
    throw new TypeError(`${label} must be a positive safe integer`)
  }
  return resolved
}

function nonNegativeInteger(value: number | undefined, fallback: number, label: string): number {
  const resolved = value ?? fallback
  if (!Number.isSafeInteger(resolved) || resolved < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`)
  }
  return resolved
}

function statusFromError(error: unknown): number | null {
  if (!error || typeof error !== 'object') return null

  const record = error as Record<string, unknown>
  if (typeof record.status === 'number' && Number.isInteger(record.status)) return record.status

  const response = record.response
  if (response && typeof response === 'object') {
    const responseStatus = (response as Record<string, unknown>).status
    if (typeof responseStatus === 'number' && Number.isInteger(responseStatus)) return responseStatus
  }

  const cause = record.cause
  if (cause && cause !== error) return statusFromError(cause)
  return null
}

/** SearchAd 429 and server errors are safe to retry at the transport layer. */
export function isRetryableProviderError(error: unknown): boolean {
  const status = statusFromError(error)
  return status === 429 || (status !== null && status >= 500 && status <= 599)
}

export function providerErrorStatus(error: unknown): number | null {
  return statusFromError(error)
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function defaultRandom(): number {
  return Math.random()
}

/**
 * Serializes requests for one SearchAd account and adapts its pace after
 * retryable failures.  `execute` retries only 429/5xx; authentication and
 * validation failures pass through immediately.
 */
export class AdaptiveRateLimiter {
  private readonly minIntervalMs: number
  private readonly maxIntervalMs: number
  private readonly baseBackoffMs: number
  private readonly maxBackoffMs: number
  private readonly jitterRatio: number
  private readonly maxRetries: number
  private readonly failureThreshold: number
  private readonly circuitCooldownMs: number
  private readonly clock: RateLimiterClock

  private currentIntervalMs: number
  private nextAllowedAt = 0
  private consecutiveFailures = 0
  private circuitOpenedUntil: number | null = null
  private halfOpenProbe = false
  private queue: Promise<void> = Promise.resolve()

  constructor(options: AdaptiveRateLimiterOptions = {}) {
    this.minIntervalMs = finiteNonNegative(options.minIntervalMs, DEFAULTS.minIntervalMs, 'minIntervalMs')
    this.maxIntervalMs = finiteNonNegative(options.maxIntervalMs, DEFAULTS.maxIntervalMs, 'maxIntervalMs')
    if (this.maxIntervalMs < this.minIntervalMs) {
      throw new TypeError('maxIntervalMs must be >= minIntervalMs')
    }

    this.baseBackoffMs = finiteNonNegative(options.baseBackoffMs, DEFAULTS.baseBackoffMs, 'baseBackoffMs')
    this.maxBackoffMs = finiteNonNegative(options.maxBackoffMs, DEFAULTS.maxBackoffMs, 'maxBackoffMs')
    if (this.maxBackoffMs < this.baseBackoffMs) {
      throw new TypeError('maxBackoffMs must be >= baseBackoffMs')
    }

    this.jitterRatio = finiteNonNegative(options.jitterRatio, DEFAULTS.jitterRatio, 'jitterRatio')
    if (this.jitterRatio > 1) throw new TypeError('jitterRatio must be <= 1')
    this.maxRetries = nonNegativeInteger(options.maxRetries, DEFAULTS.maxRetries, 'maxRetries')
    this.failureThreshold = positiveInteger(options.failureThreshold, DEFAULTS.failureThreshold, 'failureThreshold')
    this.circuitCooldownMs = finiteNonNegative(
      options.circuitCooldownMs,
      DEFAULTS.circuitCooldownMs,
      'circuitCooldownMs',
    )
    this.currentIntervalMs = this.minIntervalMs
    this.clock = {
      now: options.now ?? (() => Date.now()),
      sleep: options.sleep ?? defaultSleep,
      random: options.random ?? defaultRandom,
    }
  }

  get state(): RateLimiterState {
    const now = this.clock.now()
    if (this.circuitOpenedUntil === null) return 'closed'
    if (now < this.circuitOpenedUntil) return 'open'
    return 'half-open'
  }

  getSnapshot(): RateLimiterSnapshot {
    return {
      state: this.state,
      consecutiveFailures: this.consecutiveFailures,
      currentIntervalMs: this.currentIntervalMs,
      nextAllowedAt: this.nextAllowedAt,
      circuitOpenedUntil: this.circuitOpenedUntil,
    }
  }

  /** Alias useful to callers that expose the limiter as a health check. */
  snapshot(): RateLimiterSnapshot {
    return this.getSnapshot()
  }

  /**
   * Queue one operation.  The queue is deliberately kept internal: callers
   * cannot accidentally bypass pacing by starting several requests at once.
   */
  execute<T>(operation: RateLimiterOperation<T>): Promise<T> {
    const result = this.queue.then(() => this.executeQueued(operation))
    this.queue = result.then(() => undefined, () => undefined)
    return result
  }

  /** Alias for code that names this operation `run`. */
  run<T>(operation: RateLimiterOperation<T>): Promise<T> {
    return this.execute(operation)
  }

  /** Clear failures and close the circuit after an operator-approved reset. */
  reset(): void {
    this.consecutiveFailures = 0
    this.currentIntervalMs = this.minIntervalMs
    this.circuitOpenedUntil = null
    this.halfOpenProbe = false
  }

  private async executeQueued<T>(operation: RateLimiterOperation<T>): Promise<T> {
    this.beginCircuitAttempt()
    let retryCount = 0

    while (true) {
      await this.waitForSlot()
      try {
        const value = await operation()
        this.recordSuccess()
        return value
      } catch (error) {
        if (!isRetryableProviderError(error)) {
          // A non-retryable half-open probe has proved that the request path is
          // reachable. Do not leave the circuit stuck in half-open state.
          if (this.state === 'half-open') this.closeCircuit()
          throw error
        }

        this.recordRetryableFailure()
        const backoff = this.jitteredBackoff(this.consecutiveFailures)
        this.nextAllowedAt = Math.max(this.nextAllowedAt, this.clock.now() + backoff)
        if (this.state === 'open' || retryCount >= this.maxRetries) throw error

        retryCount += 1
      }
    }
  }

  private beginCircuitAttempt(): void {
    const state = this.state
    if (state === 'open') {
      throw new CircuitOpenError(this.circuitOpenedUntil ?? this.clock.now())
    }
    if (state === 'half-open') {
      if (this.halfOpenProbe) {
        throw new CircuitOpenError(this.circuitOpenedUntil ?? this.clock.now())
      }
      this.halfOpenProbe = true
    }
  }

  private async waitForSlot(): Promise<void> {
    const delay = Math.max(0, this.nextAllowedAt - this.clock.now())
    if (delay > 0) {
      await this.clock.sleep(delay)
      // A fake sleep in a unit test may not advance its clock. Treat the
      // awaited sleep as having consumed this reservation so tests do not
      // spin; with the real clock this is the observed post-sleep timestamp.
      this.nextAllowedAt = Math.min(this.nextAllowedAt, this.clock.now())
    }

    const startedAt = this.clock.now()
    this.nextAllowedAt = Math.max(this.nextAllowedAt, startedAt) + this.currentIntervalMs
  }

  private recordSuccess(): void {
    this.consecutiveFailures = 0
    this.closeCircuit()
    // Additive recovery avoids a burst after a transient success while
    // returning to the configured healthy-account pace over time.
    const recovery = Math.max(1, this.minIntervalMs * 0.1)
    this.currentIntervalMs = Math.max(this.minIntervalMs, this.currentIntervalMs - recovery)
  }

  private closeCircuit(): void {
    this.circuitOpenedUntil = null
    this.halfOpenProbe = false
  }

  private recordRetryableFailure(): void {
    this.consecutiveFailures += 1
    this.currentIntervalMs = Math.min(
      this.maxIntervalMs,
      Math.max(this.minIntervalMs, this.currentIntervalMs * 2 || this.minIntervalMs),
    )

    if (this.state === 'half-open' || this.consecutiveFailures >= this.failureThreshold) {
      this.circuitOpenedUntil = this.clock.now() + this.circuitCooldownMs
      this.halfOpenProbe = false
    }
  }

  private jitteredBackoff(failureNumber: number): number {
    const exponent = Math.max(0, failureNumber - 1)
    const exponential = Math.min(this.maxBackoffMs, this.baseBackoffMs * 2 ** exponent)
    const random = Math.min(1, Math.max(0, this.clock.random()))
    const factor = 1 + ((random * 2) - 1) * this.jitterRatio
    return Math.max(0, Math.min(this.maxBackoffMs, exponential * factor))
  }
}

/** Descriptive alias for code that creates one limiter per shared account. */
export class SharedAccountRateLimiter extends AdaptiveRateLimiter {}

export const NaverRateLimiter = AdaptiveRateLimiter

/** The narrow interface accepted by the provider, also convenient for fakes. */
export type RateLimiter = Pick<AdaptiveRateLimiter, 'execute'>

const sharedLimiters = new Map<string, AdaptiveRateLimiter>()

function accountKey(accountId: string): string {
  const key = accountId.trim()
  if (!key) throw new TypeError('accountId is required for a shared limiter')
  return key
}

/**
 * Return the process-local limiter for one Naver customer account.  The first
 * caller establishes its pacing options; later callers share that limiter.
 */
export function getSharedAccountRateLimiter(
  accountId: string,
  options: AdaptiveRateLimiterOptions = {},
): AdaptiveRateLimiter {
  const key = accountKey(accountId)
  const existing = sharedLimiters.get(key)
  if (existing) return existing

  const limiter = new SharedAccountRateLimiter(options)
  sharedLimiters.set(key, limiter)
  return limiter
}

/** Explicit factory spelling for callers that prefer dependency injection. */
export const createSharedAccountRateLimiter = getSharedAccountRateLimiter

/** Clear process-local account limiters between isolated jobs or unit tests. */
export function resetSharedAccountRateLimiters(): void {
  sharedLimiters.clear()
}
