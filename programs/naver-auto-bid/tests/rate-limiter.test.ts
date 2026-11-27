import { describe, expect, it } from 'vitest'
import {
  AdaptiveRateLimiter,
  CircuitOpenError,
  getSharedAccountRateLimiter,
  resetSharedAccountRateLimiters,
} from '../src/rate-limiter'

class HttpError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`)
  }
}

describe('AdaptiveRateLimiter', () => {
  it('retries 429 with jittered exponential backoff and recovers on success', async () => {
    const sleeps: number[] = []
    let calls = 0
    const limiter = new AdaptiveRateLimiter({
      minIntervalMs: 0,
      baseBackoffMs: 100,
      maxBackoffMs: 1_000,
      jitterRatio: 0.2,
      random: () => 0,
      sleep: async (milliseconds) => { sleeps.push(milliseconds) },
      maxRetries: 2,
    })

    await expect(limiter.execute(async () => {
      calls += 1
      if (calls === 1) throw new HttpError(429)
      if (calls === 2) throw new HttpError(503)
      return 'ok'
    })).resolves.toBe('ok')

    expect(calls).toBe(3)
    expect(sleeps).toEqual([80, 160])
    expect(limiter.getSnapshot()).toMatchObject({ state: 'closed', consecutiveFailures: 0 })
  })

  it('opens the circuit after consecutive retryable failures and permits one later probe', async () => {
    let now = 0
    let calls = 0
    const limiter = new AdaptiveRateLimiter({
      minIntervalMs: 0,
      baseBackoffMs: 0,
      maxBackoffMs: 0,
      maxRetries: 0,
      failureThreshold: 2,
      circuitCooldownMs: 100,
      now: () => now,
      sleep: async () => {},
    })

    await expect(limiter.execute(() => { calls += 1; throw new HttpError(500) })).rejects.toThrow('HTTP 500')
    await expect(limiter.execute(() => { calls += 1; throw new HttpError(429) })).rejects.toThrow('HTTP 429')
    expect(limiter.state).toBe('open')
    await expect(limiter.execute(() => { calls += 1; return 'blocked' })).rejects.toBeInstanceOf(CircuitOpenError)
    expect(calls).toBe(2)

    now = 100
    await expect(limiter.execute(() => { calls += 1; return 'probe-ok' })).resolves.toBe('probe-ok')
    expect(limiter.state).toBe('closed')
    expect(calls).toBe(3)
  })

  it('serializes concurrent operations and shares one account limiter', async () => {
    resetSharedAccountRateLimiters()
    const first = getSharedAccountRateLimiter('customer-1', { minIntervalMs: 0 })
    const second = getSharedAccountRateLimiter('customer-1', { minIntervalMs: 0 })
    expect(second).toBe(first)

    let active = 0
    let maximumActive = 0
    const work = async (value: string): Promise<string> => {
      active += 1
      maximumActive = Math.max(maximumActive, active)
      await Promise.resolve()
      active -= 1
      return value
    }

    await expect(Promise.all([first.execute(() => work('a')), second.execute(() => work('b'))]))
      .resolves.toEqual(['a', 'b'])
    expect(maximumActive).toBe(1)
  })
})
