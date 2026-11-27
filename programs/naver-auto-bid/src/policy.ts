import { AUTO_BID_DEVICES } from './types'
import type {
  AutoBidDevice,
  AutoBidEligibilityInput,
  AutoBidLocalSnapshot,
  AutoBidMode,
  AutoBidPolicy,
  AutoBidPolicyInput,
  AutoBidProviderSnapshot,
  AutoBidReasonCode,
  BidDecision,
  BidDecisionInput,
  BidDecisionReasonCode,
  DateLike,
  EligibilityDecision,
  EligibilityReasonCode,
  LocalKeywordStatus,
  NaverAutoBidPatch,
  PolicyReasonCode,
  PolicyValidationResult,
  ProviderDeliveryStatus,
  ProviderReviewStatus,
  ValidAutoBidPolicy,
} from './types'

/** Six hours, matching the initial policy in PLAN.md. */
export const AUTO_BID_HOUR_MS = 60 * 60 * 1_000
export const AUTO_BID_COOLDOWN_MS = 6 * AUTO_BID_HOUR_MS

/**
 * A null ceiling and change limit are deliberate: an operator must fill them
 * before a policy can be used for the corresponding provider operation.
 */
export const DEFAULT_AUTO_BID_POLICY: AutoBidPolicy = Object.freeze({
  device: 'mobile',
  floor: 70,
  ceiling: null,
  stepUp: 100,
  stepDown: 10,
  allowBidDecrease: true,
  exposureBuffer: 10,
  cooldownMs: AUTO_BID_COOLDOWN_MS,
  batchSize: 50,
  maxChangesPerRun: null,
})

/** Short alias for callers that use the generic policy name. */
export const DEFAULT_POLICY = DEFAULT_AUTO_BID_POLICY

const REASON_TEXT: Partial<Record<AutoBidReasonCode, string>> = {
  provider_review_pending: 'provider review is pending',
  provider_review_rejected: 'provider review is rejected',
  provider_review_unknown: 'provider review status is unknown',
  provider_status_excluded: 'provider keyword status is excluded',
  provider_status_unknown: 'provider keyword status is unknown',
  provider_keyword_locked: 'provider keyword delivery is locked',
  provider_user_lock_unknown: 'provider keyword lock state is unknown',
  local_status_excluded: 'local keyword status is excluded',
  local_status_unknown: 'local keyword status is unknown',
  local_ad_disabled: 'local adDesired is false',
  local_ad_desired_unknown: 'local adDesired is unknown',
  local_host_missing: 'public host is missing',
  local_host_not_public: 'host is not public',
  local_archived: 'local keyword is archived',
  local_source_blocked: 'source is blocked',
  local_source_excluded: 'source status is excluded',
  local_source_status_unknown: 'source status is unknown',
  policy_device_invalid: 'policy device is invalid',
  policy_floor_invalid: 'policy floor is invalid',
  policy_ceiling_required: 'policy ceiling is required',
  policy_ceiling_invalid: 'policy ceiling is invalid',
  policy_floor_above_ceiling: 'policy floor exceeds policy ceiling',
  policy_step_up_invalid: 'policy step-up is invalid',
  policy_step_down_invalid: 'policy step-down is invalid',
  policy_exposure_buffer_invalid: 'policy exposure buffer is invalid',
  policy_cooldown_invalid: 'policy cooldown is invalid',
  policy_batch_size_invalid: 'policy batch size is invalid',
  policy_change_limit_required: 'policy maxChangesPerRun is required for live mode',
  policy_change_limit_invalid: 'policy maxChangesPerRun is invalid',
  not_eligible: 'keyword is not eligible for bidding',
  current_bid_missing: 'current bid is missing',
  current_bid_invalid: 'current bid is invalid',
  current_bid_above_ceiling: 'current bid is already above the policy ceiling',
  decision_clock_missing: 'decision time is required to evaluate cooldown',
  cooldown_timestamp_invalid: 'last bid-change timestamp is invalid',
  cooldown_active: 'keyword is still inside its bid cooldown',
  estimate_missing: 'exposure estimate is missing',
  estimate_invalid: 'exposure estimate is invalid',
  exposure_buffer_applied: 'exposure buffer was applied',
  floor_applied: 'policy floor was applied',
  ceiling_applied: 'policy ceiling was applied',
  step_up_capped: 'increase was capped by step-up limit',
  step_down_capped: 'decrease was capped by step-down limit',
  step_up_limit_reached: 'step-up limit leaves the bid unchanged',
  bid_unchanged: 'calculated bid is unchanged',
  bid_lowering_disabled: 'bid lowering is disabled in v1',
  bid_increase: 'bid increase is allowed',
  bid_decrease: 'bid decrease is allowed',
}

const PROVIDER_STATUS_EXCLUDED = new Set<ProviderDeliveryStatus>([
  'paused',
  'blocked',
  'archived',
  'deleted',
  'under_review',
  'rejected',
])

const LOCAL_STATUS_ALLOWED = new Set<LocalKeywordStatus>([
  'ad_registered',
  'live',
  'active',
])

const LOCAL_STATUS_EXCLUDED = new Set<LocalKeywordStatus>([
  'subscribed',
  'ad_pending',
  'paused',
  'rejected',
  'blocked',
  'archived',
])

const SOURCE_STATUS_ALLOWED = new Set([
  'active',
  'approved',
  'candidate',
  'discovered',
  'eligible',
  'indexed',
  'live',
  'observed',
  'published',
])

const SOURCE_STATUS_EXCLUDED = new Set([
  'archived',
  'blocked',
  'deleted',
  'draft',
  'excluded',
  'failed',
  'in_review',
  'noindex',
  'pending',
  'preview',
  'rejected',
  'removed',
  'retired',
  'under_review',
])

function statusKey(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim().toLocaleLowerCase('en-US').replace(/[\s-]+/g, '_')
  return normalized || null
}

function isPresent<T>(value: T | undefined): value is T {
  return value !== undefined
}

function firstPresent<T>(...values: readonly (T | undefined)[]): { present: boolean; value: T | undefined } {
  const value = values.find(isPresent)
  return value === undefined
    ? { present: false, value: undefined }
    : { present: true, value }
}

function reasonText(code: AutoBidReasonCode): string {
  return REASON_TEXT[code] ?? code
}

/** Stable human-readable text for a persisted reason code. */
export function autoBidReasonMessage(code: AutoBidReasonCode): string {
  return reasonText(code)
}

function uniqueReasonCodes<T extends AutoBidReasonCode>(codes: readonly T[]): T[] {
  return [...new Set(codes)]
}

function eligibilityResult(reasonCodes: readonly EligibilityReasonCode[]): EligibilityDecision {
  const codes = uniqueReasonCodes(reasonCodes)
  const first = codes[0] ?? null
  return {
    eligible: codes.length === 0,
    reasonCodes: codes,
    reasons: codes.map(reasonText),
    reasonCode: first,
    reason: first ? reasonText(first) : null,
  }
}

/** Normalize provider review states without treating an unknown state as approved. */
export function normalizeProviderReviewStatus(value: unknown): ProviderReviewStatus {
  switch (statusKey(value)) {
    case 'approved':
    case 'accepted':
    case 'eligible':
    case 'live':
      return 'approved'
    case 'pending':
    case 'reviewing':
    case 'under_review':
    case 'in_review':
    case 'submitted':
      return 'pending'
    case 'denied':
    case 'disapproved':
    case 'ineligible':
    case 'rejected':
      return 'rejected'
    default:
      return 'unknown'
  }
}

/** Normalize a provider delivery/status field used in addition to review. */
export function normalizeProviderStatus(value: unknown): ProviderDeliveryStatus {
  switch (statusKey(value)) {
    case 'active':
    case 'approved':
    case 'enabled':
    case 'live':
    case 'on':
    case 'serving':
      return 'active'
    case 'eligible':
      return 'eligible'
    case 'archived':
    case 'retired':
      return 'archived'
    case 'blocked':
    case 'blacklisted':
      return 'blocked'
    case 'deleted':
    case 'removed':
      return 'deleted'
    case 'denied':
    case 'disapproved':
    case 'ineligible':
    case 'rejected':
      return 'rejected'
    case 'in_review':
    case 'pending':
    case 'reviewing':
    case 'under_review':
      return 'under_review'
    case 'disabled':
    case 'inactive':
    case 'paused':
    case 'user_disabled':
    case 'user_locked':
      return 'paused'
    default:
      return 'unknown'
  }
}

/** Normalize the local firm-keyword status used by the bidding policy. */
export function normalizeLocalStatus(value: unknown): LocalKeywordStatus {
  switch (statusKey(value)) {
    case 'subscribed':
      return 'subscribed'
    case 'ad_pending':
    case 'pending':
      return 'ad_pending'
    case 'ad_registered':
    case 'registered':
      return 'ad_registered'
    case 'active':
    case 'enabled':
      return 'active'
    case 'live':
      return 'live'
    case 'archived':
      return 'archived'
    case 'blocked':
      return 'blocked'
    case 'paused':
      return 'paused'
    case 'denied':
    case 'disapproved':
    case 'rejected':
      return 'rejected'
    default:
      return 'unknown'
  }
}

/** Convert provider lock representations to a small, fail-closed vocabulary. */
export function normalizeProviderLock(value: unknown): 'locked' | 'unlocked' | 'unknown' {
  if (value === false || value === 0) return 'unlocked'
  if (value === true || value === 1) return 'locked'
  switch (statusKey(value)) {
    case 'false':
    case '0':
      return 'unlocked'
    case 'true':
    case '1':
      return 'locked'
    default:
      return 'unknown'
  }
}

/** Return a normalized source status, or null when the source did not send one. */
export function normalizeSourceStatus(value: unknown): string | null {
  return statusKey(value)
}

function providerSnapshot(input: AutoBidEligibilityInput): AutoBidProviderSnapshot | null {
  return input.provider ?? null
}

function localSnapshot(input: AutoBidEligibilityInput): AutoBidLocalSnapshot | null {
  return input.local ?? null
}

/**
 * Evaluate all safety gates in a fixed order.  Every failed gate is retained;
 * this makes dry-run reports useful and keeps reason ordering deterministic.
 */
export function evaluateEligibility(input: AutoBidEligibilityInput): EligibilityDecision {
  const provider = providerSnapshot(input)
  const local = localSnapshot(input)
  const reasonCodes: EligibilityReasonCode[] = []

  const review = firstPresent(
    input.providerReviewStatus,
    provider?.reviewStatus,
    input.reviewStatus,
    input.inspectStatus,
    provider?.inspectStatus,
  )
  const reviewStatus = normalizeProviderReviewStatus(review.value)
  if (reviewStatus === 'pending') reasonCodes.push('provider_review_pending')
  else if (reviewStatus === 'rejected') reasonCodes.push('provider_review_rejected')
  else if (reviewStatus !== 'approved') reasonCodes.push('provider_review_unknown')

  const explicitProviderStatus = firstPresent(
    input.providerStatus,
    input.providerDeliveryStatus,
    provider?.status,
    provider?.keywordStatus,
  )
  const legacyStatusIsProviderLike = !explicitProviderStatus.present
    && normalizeProviderStatus(input.status) !== 'unknown'
  const providerStatus = firstPresent(
    explicitProviderStatus.value,
    legacyStatusIsProviderLike ? input.status : undefined,
  )
  if (providerStatus.present) {
    const normalized = normalizeProviderStatus(providerStatus.value)
    if (normalized === 'unknown') reasonCodes.push('provider_status_unknown')
    else if (PROVIDER_STATUS_EXCLUDED.has(normalized)) reasonCodes.push('provider_status_excluded')
  }

  const lock = firstPresent(input.providerUserLock, provider?.userLock, input.userLock)
  const lockStatus = normalizeProviderLock(lock.value)
  if (lockStatus === 'locked') reasonCodes.push('provider_keyword_locked')
  else if (lockStatus !== 'unlocked') reasonCodes.push('provider_user_lock_unknown')

  const localStatus = firstPresent(
    input.localStatus,
    local?.status,
    legacyStatusIsProviderLike ? undefined : input.status,
  )
  if (localStatus.present) {
    const normalized = normalizeLocalStatus(localStatus.value)
    if (normalized === 'unknown') reasonCodes.push('local_status_unknown')
    else if (!LOCAL_STATUS_ALLOWED.has(normalized) || LOCAL_STATUS_EXCLUDED.has(normalized)) {
      reasonCodes.push('local_status_excluded')
    }
  }

  const adDesired = firstPresent(input.adDesired, local?.adDesired)
  if (!adDesired.present || adDesired.value === null) reasonCodes.push('local_ad_desired_unknown')
  else if (adDesired.value !== true) reasonCodes.push('local_ad_disabled')

  const hostStatus = firstPresent(input.hostStatus, local?.hostStatus)
  const publicHost = firstPresent(
    input.publicHost,
    input.publicHostLabel,
    local?.publicHost,
    local?.publicHostLabel,
  )
  if (!publicHost.present || typeof publicHost.value !== 'string' || publicHost.value.trim() === '') {
    reasonCodes.push('local_host_missing')
  }
  if (!hostStatus.present || statusKey(hostStatus.value) !== 'public') {
    reasonCodes.push('local_host_not_public')
  }

  const archived = firstPresent(input.archived, local?.archived)
  const archivedAt = firstPresent(input.archivedAt, local?.archivedAt)
  if (archived.value === true || local?.archived === true
    || (archivedAt.present && archivedAt.value !== null && archivedAt.value !== '')) {
    reasonCodes.push('local_archived')
  }

  const sourceBlocked = firstPresent(input.sourceBlocked, local?.sourceBlocked)
  if (sourceBlocked.value === true) reasonCodes.push('local_source_blocked')

  const sourceStatus = firstPresent(input.sourceStatus, local?.sourceStatus)
  const normalizedSource = normalizeSourceStatus(sourceStatus.value)
  if (!sourceStatus.present || normalizedSource === null || normalizedSource === 'unknown') {
    reasonCodes.push('local_source_status_unknown')
  } else if (SOURCE_STATUS_EXCLUDED.has(normalizedSource)) {
    reasonCodes.push('local_source_excluded')
  } else if (!SOURCE_STATUS_ALLOWED.has(normalizedSource)) {
    reasonCodes.push('local_source_status_unknown')
  }

  return eligibilityResult(reasonCodes)
}

/** Boolean convenience form for filters. */
export function isEligibleForBid(input: AutoBidEligibilityInput): boolean {
  return evaluateEligibility(input).eligible
}

/** Alias used by some callers that phrase the operation as a keyword check. */
export const evaluateKeywordEligibility = evaluateEligibility

function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isPositiveSafeInteger(value: unknown): value is number {
  return isSafeNonNegativeInteger(value) && value > 0
}

function policyValue<T>(
  primary: T | undefined,
  alias: T | undefined,
  fallback: T,
): T {
  if (primary !== undefined) return primary
  if (alias !== undefined) return alias
  return fallback
}

function policyWithDefaults(input: AutoBidPolicyInput | AutoBidPolicy | null | undefined): AutoBidPolicy {
  const source = (input ?? {}) as AutoBidPolicyInput
  const floorValue = source.floor !== undefined
    ? source.floor
    : source.minimumBid !== undefined
      ? source.minimumBid
      : source.minBid !== undefined
        ? source.minBid
        : source.bidFloor !== undefined
          ? source.bidFloor
          : DEFAULT_AUTO_BID_POLICY.floor
  const ceilingValue = source.ceiling !== undefined
    ? source.ceiling
    : source.maximumBid !== undefined
      ? source.maximumBid
      : source.bidCeiling !== undefined
        ? source.bidCeiling
        : null
  const stepUpValue = policyValue(source.stepUp, source.stepUpAmount, DEFAULT_AUTO_BID_POLICY.stepUp)
  const stepDownValue = source.stepDown ?? DEFAULT_AUTO_BID_POLICY.stepDown
  const bufferValue = policyValue(
    source.exposureBuffer,
    source.exposureBufferKrw,
    DEFAULT_AUTO_BID_POLICY.exposureBuffer,
  )

  let cooldownValue: number | null | undefined = source.cooldownMs
  if (cooldownValue === undefined && source.cooldownMinutes !== undefined) {
    cooldownValue = typeof source.cooldownMinutes === 'number'
      ? source.cooldownMinutes * 60_000
      : Number.NaN
  }
  if (cooldownValue === undefined && source.cooldownHours !== undefined) {
    cooldownValue = typeof source.cooldownHours === 'number'
      ? source.cooldownHours * AUTO_BID_HOUR_MS
      : Number.NaN
  }

  const maxChangesValue = policyValue(source.maxChangesPerRun, source.maxChanges, null)
  const deviceValue = source.device
  const device = typeof deviceValue === 'string' && (AUTO_BID_DEVICES as readonly string[]).includes(deviceValue)
    ? deviceValue as AutoBidDevice
    : DEFAULT_AUTO_BID_POLICY.device

  return {
    device,
    floor: typeof floorValue === 'number' ? floorValue : Number.NaN,
    ceiling: ceilingValue === null || ceilingValue === undefined
      ? null
      : typeof ceilingValue === 'number' ? ceilingValue : Number.NaN,
    stepUp: typeof stepUpValue === 'number' ? stepUpValue : Number.NaN,
    stepDown: typeof stepDownValue === 'number' ? stepDownValue : Number.NaN,
    allowBidDecrease: source.allowBidDecrease ?? DEFAULT_AUTO_BID_POLICY.allowBidDecrease,
    exposureBuffer: typeof bufferValue === 'number' ? bufferValue : Number.NaN,
    cooldownMs: typeof cooldownValue === 'number'
      ? cooldownValue
      : cooldownValue === null ? Number.NaN : DEFAULT_AUTO_BID_POLICY.cooldownMs,
    batchSize: typeof source.batchSize === 'number'
      ? source.batchSize
      : source.batchSize === null ? Number.NaN : DEFAULT_AUTO_BID_POLICY.batchSize,
    maxChangesPerRun: maxChangesValue === null || maxChangesValue === undefined
      ? null
      : typeof maxChangesValue === 'number' ? maxChangesValue : Number.NaN,
  }
}

/** Validate and fill policy defaults without reading time, environment, or I/O. */
export function validateAutoBidPolicy(
  input: AutoBidPolicyInput | AutoBidPolicy | null | undefined,
  mode: AutoBidMode = 'dry-run',
): PolicyValidationResult {
  const policy = policyWithDefaults(input)
  const reasonCodes: PolicyReasonCode[] = []
  const source = (input ?? {}) as AutoBidPolicyInput

  if (source.device !== undefined
    && (typeof source.device !== 'string'
      || !(AUTO_BID_DEVICES as readonly string[]).includes(source.device))) {
    reasonCodes.push('policy_device_invalid')
  }
  if (!isSafeNonNegativeInteger(policy.floor)) reasonCodes.push('policy_floor_invalid')

  if (policy.ceiling === null) reasonCodes.push('policy_ceiling_required')
  else if (!isSafeNonNegativeInteger(policy.ceiling)) reasonCodes.push('policy_ceiling_invalid')
  if (isSafeNonNegativeInteger(policy.floor) && isSafeNonNegativeInteger(policy.ceiling)
    && policy.floor > policy.ceiling) {
    reasonCodes.push('policy_floor_above_ceiling')
  }

  if (!isSafeNonNegativeInteger(policy.stepUp)) reasonCodes.push('policy_step_up_invalid')
  if (!isSafeNonNegativeInteger(policy.stepDown)) reasonCodes.push('policy_step_down_invalid')
  if (!isSafeNonNegativeInteger(policy.exposureBuffer)) {
    reasonCodes.push('policy_exposure_buffer_invalid')
  }
  if (!isSafeNonNegativeInteger(policy.cooldownMs)) reasonCodes.push('policy_cooldown_invalid')
  if (!isPositiveSafeInteger(policy.batchSize)) reasonCodes.push('policy_batch_size_invalid')

  if (mode === 'live' && policy.maxChangesPerRun === null) {
    reasonCodes.push('policy_change_limit_required')
  } else if (policy.maxChangesPerRun !== null && !isPositiveSafeInteger(policy.maxChangesPerRun)) {
    reasonCodes.push('policy_change_limit_invalid')
  }

  const codes = uniqueReasonCodes(reasonCodes)
  return {
    valid: codes.length === 0,
    mode,
    policy,
    reasonCodes: codes,
    reasons: codes.map(reasonText),
  }
}

/** Alias that makes the normalization aspect explicit to adapter callers. */
export const normalizeAutoBidPolicy = validateAutoBidPolicy

export function isValidAutoBidPolicy(
  input: AutoBidPolicyInput | AutoBidPolicy | null | undefined,
  mode: AutoBidMode = 'dry-run',
): boolean {
  return validateAutoBidPolicy(input, mode).valid
}

/** Throwing helper for code paths that have already decided to require validity. */
export function requireValidAutoBidPolicy(
  input: AutoBidPolicyInput | AutoBidPolicy,
  mode: AutoBidMode = 'dry-run',
): ValidAutoBidPolicy {
  const result = validateAutoBidPolicy(input, mode)
  if (!result.valid || result.policy.ceiling === null) {
    throw new RangeError(result.reasons.join('; ') || 'invalid automatic-bid policy')
  }
  return result.policy as ValidAutoBidPolicy
}

function boundsFromPolicy(policy: AutoBidPolicyInput): {
  floor: number
  ceiling: number
} {
  const floor = policy.floor !== undefined
    ? policy.floor
    : policy.minimumBid !== undefined
      ? policy.minimumBid
      : policy.minBid !== undefined
        ? policy.minBid
        : policy.bidFloor !== undefined
          ? policy.bidFloor
          : DEFAULT_AUTO_BID_POLICY.floor
  const ceiling = policy.ceiling !== undefined
    ? policy.ceiling
    : policy.maximumBid !== undefined
      ? policy.maximumBid
      : policy.bidCeiling !== undefined
        ? policy.bidCeiling
        : null
  if (!isSafeNonNegativeInteger(floor)) throw new RangeError('bid floor must be a non-negative safe integer')
  if (!isSafeNonNegativeInteger(ceiling)) throw new RangeError('bid ceiling is required')
  if (floor > ceiling) throw new RangeError('bid floor exceeds bid ceiling')
  return { floor, ceiling }
}

/** Clamp one provider estimate to the operator's explicit floor and ceiling. */
export function clampBid(
  value: number,
  policy: AutoBidPolicyInput,
): number {
  if (!isSafeNonNegativeInteger(value)) throw new RangeError('bid must be a non-negative safe integer')
  const { floor, ceiling } = boundsFromPolicy(policy)
  return Math.min(ceiling, Math.max(floor, value))
}

/** Add the configured exposure margin before floor/ceiling clamping. */
export function applyExposureBuffer(estimate: number, exposureBuffer: number): number {
  if (!isSafeNonNegativeInteger(estimate)) throw new RangeError('estimate must be a non-negative safe integer')
  if (!isSafeNonNegativeInteger(exposureBuffer)) {
    throw new RangeError('exposure buffer must be a non-negative safe integer')
  }
  const buffered = estimate + exposureBuffer
  if (!Number.isSafeInteger(buffered)) throw new RangeError('buffered estimate exceeds safe integer range')
  return buffered
}

/** Cap an increase to one run's configured step and the explicit ceiling. */
export function capBidIncrease(
  currentBid: number,
  targetBid: number,
  stepUp: number,
  ceiling: number,
): number {
  if (!isSafeNonNegativeInteger(currentBid)) throw new RangeError('current bid is invalid')
  if (!isSafeNonNegativeInteger(targetBid)) throw new RangeError('target bid is invalid')
  if (!isSafeNonNegativeInteger(stepUp)) throw new RangeError('step-up is invalid')
  if (!isSafeNonNegativeInteger(ceiling)) throw new RangeError('bid ceiling is invalid')
  if (currentBid > ceiling) return currentBid
  const maximumIncrease = currentBid > ceiling - stepUp
    ? ceiling
    : currentBid + stepUp
  return Math.min(targetBid, maximumIncrease, ceiling)
}

function epochMilliseconds(value: DateLike | null | undefined): number | null {
  if (value instanceof Date) {
    const milliseconds = value.getTime()
    return Number.isFinite(milliseconds) ? milliseconds : null
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string' && value.trim() !== '') {
    const milliseconds = Date.parse(value)
    return Number.isFinite(milliseconds) ? milliseconds : null
  }
  return null
}

/**
 * True only while the elapsed time is strictly less than cooldown.  Invalid
 * values return false here; `decideBid` separately fails closed so callers
 * receive a deterministic reason instead of silently bidding.
 */
export function isBidInCooldown(
  lastBidChangedAt: DateLike | null | undefined,
  now: DateLike,
  cooldownMs: number,
): boolean {
  if (lastBidChangedAt === null || lastBidChangedAt === undefined) return false
  if (!isSafeNonNegativeInteger(cooldownMs) || cooldownMs === 0) return false
  const last = epochMilliseconds(lastBidChangedAt)
  const current = epochMilliseconds(now)
  if (last === null || current === null) return false
  return current - last < cooldownMs
}

/** Alias for callers that use the shorter name. */
export const isInCooldown = isBidInCooldown

/** Check a repository-stored cooldown boundary without applying it twice. */
export function isCooldownUntilActive(
  cooldownUntil: DateLike | null | undefined,
  now: DateLike,
): boolean {
  if (cooldownUntil === null || cooldownUntil === undefined) return false
  const until = epochMilliseconds(cooldownUntil)
  const current = epochMilliseconds(now)
  if (until === null || current === null) return false
  return current < until
}

function nullableBid(value: unknown): number | null {
  return isSafeNonNegativeInteger(value) ? value : null
}

function estimateFromInput(input: BidDecisionInput): number | null | undefined {
  if (input.estimatedMinimumBid !== undefined) return input.estimatedMinimumBid
  if (input.estimate !== undefined) return input.estimate
  if (input.estimatedBid !== undefined) return input.estimatedBid
  return input.minimumBid
}

function decisionResult(
  input: BidDecisionInput,
  values: {
    currentBid: number | null
    estimatedMinimumBid: number | null
    bufferedBid?: number | null
    clampedBid?: number | null
    targetBid?: number | null
    proposedBid?: number | null
    cooldownActive?: boolean
    stepUpCapped?: boolean
    stepDownCapped?: boolean
    reasonCodes: readonly AutoBidReasonCode[]
  },
): BidDecision {
  const reasonCodes = uniqueReasonCodes(values.reasonCodes)
  const first = reasonCodes[0] ?? null
  const changed = values.proposedBid !== null && values.proposedBid !== undefined
  const action = !changed ? 'skip' : values.proposedBid! < (values.currentBid ?? values.proposedBid!) ? 'lower' : 'raise'
  return {
    keywordId: input.keywordId,
    decision: action,
    action,
    changed,
    currentBid: values.currentBid,
    estimatedMinimumBid: values.estimatedMinimumBid,
    bufferedBid: values.bufferedBid ?? null,
    clampedBid: values.clampedBid ?? null,
    targetBid: values.targetBid ?? null,
    proposedBid: values.proposedBid ?? null,
    cooldownActive: values.cooldownActive ?? false,
    stepUpCapped: values.stepUpCapped ?? false,
    stepDownCapped: values.stepDownCapped ?? false,
    reasonCode: first,
    reason: first ? reasonText(first) : null,
    reasonCodes,
    reasons: reasonCodes.map(reasonText),
  }
}

function skipDecision(
  input: BidDecisionInput,
  reasonCodes: readonly AutoBidReasonCode[],
  values: Partial<{
    currentBid: number | null
    estimatedMinimumBid: number | null
    bufferedBid: number | null
    clampedBid: number | null
    targetBid: number | null
    cooldownActive: boolean
    stepUpCapped: boolean
    stepDownCapped: boolean
  }> = {},
): BidDecision {
  return decisionResult(input, {
    currentBid: values.currentBid ?? nullableBid(input.currentBid),
    estimatedMinimumBid: values.estimatedMinimumBid
      ?? nullableBid(estimateFromInput(input)),
    bufferedBid: values.bufferedBid,
    clampedBid: values.clampedBid,
    targetBid: values.targetBid,
    proposedBid: null,
    cooldownActive: values.cooldownActive,
    stepUpCapped: values.stepUpCapped,
    stepDownCapped: values.stepDownCapped,
    reasonCodes,
  })
}

/** Decide one bounded bid change without performing a provider call. */
export function decideBid(input: BidDecisionInput): BidDecision {
  const mode = input.mode ?? 'dry-run'
  const policyResult = validateAutoBidPolicy(input.policy, mode)
  if (!policyResult.valid) {
    return skipDecision(input, policyResult.reasonCodes)
  }

  const eligibilityCodes: AutoBidReasonCode[] = []
  if (input.eligible === false || input.eligibility?.eligible === false) {
    eligibilityCodes.push('not_eligible')
    if (input.eligibility) eligibilityCodes.push(...input.eligibility.reasonCodes)
    return skipDecision(input, eligibilityCodes)
  }

  const currentBid = input.currentBid
  if (currentBid === null || currentBid === undefined) {
    return skipDecision(input, ['current_bid_missing'])
  }
  if (!isSafeNonNegativeInteger(currentBid)) {
    return skipDecision(input, ['current_bid_invalid'], { currentBid: null })
  }
  if (currentBid > policyResult.policy.ceiling!) {
    return skipDecision(input, ['current_bid_above_ceiling'], { currentBid, targetBid: currentBid })
  }

  const lastBidChangedAt = input.lastBidChangedAt !== undefined
    ? input.lastBidChangedAt
    : input.lastBidAt
  const cooldownUntil = input.cooldownUntil
  if (policyResult.policy.cooldownMs > 0
    && ((lastBidChangedAt !== null && lastBidChangedAt !== undefined)
      || (cooldownUntil !== null && cooldownUntil !== undefined))) {
    if (input.now === undefined) return skipDecision(input, ['decision_clock_missing'], { currentBid })
    if (epochMilliseconds(input.now) === null) {
      return skipDecision(input, ['cooldown_timestamp_invalid'], { currentBid })
    }
    if (lastBidChangedAt !== null && lastBidChangedAt !== undefined) {
      if (epochMilliseconds(lastBidChangedAt) === null) {
        return skipDecision(input, ['cooldown_timestamp_invalid'], { currentBid })
      }
      if (isBidInCooldown(lastBidChangedAt, input.now, policyResult.policy.cooldownMs)) {
        return skipDecision(input, ['cooldown_active'], { currentBid, targetBid: currentBid, cooldownActive: true })
      }
    } else {
      if (epochMilliseconds(cooldownUntil) === null) {
        return skipDecision(input, ['cooldown_timestamp_invalid'], { currentBid })
      }
      if (isCooldownUntilActive(cooldownUntil, input.now)) {
        return skipDecision(input, ['cooldown_active'], { currentBid, targetBid: currentBid, cooldownActive: true })
      }
    }
  }

  const estimateValue = estimateFromInput(input)
  if (estimateValue === null || estimateValue === undefined) {
    return skipDecision(input, ['estimate_missing'], { currentBid })
  }
  if (!isSafeNonNegativeInteger(estimateValue)) {
    return skipDecision(input, ['estimate_invalid'], { currentBid })
  }

  let bufferedBid: number
  try {
    bufferedBid = applyExposureBuffer(estimateValue, policyResult.policy.exposureBuffer)
  } catch {
    return skipDecision(input, ['estimate_invalid'], { currentBid })
  }
  const clampedBid = clampBid(bufferedBid, policyResult.policy)
  const floorApplied = bufferedBid < policyResult.policy.floor
  const ceilingApplied = bufferedBid > policyResult.policy.ceiling!
  const bufferApplied = policyResult.policy.exposureBuffer > 0

  if (clampedBid < currentBid) {
    if (!policyResult.policy.allowBidDecrease) {
      return skipDecision(input, ['bid_lowering_disabled'], {
        currentBid,
        estimatedMinimumBid: estimateValue,
        bufferedBid,
        clampedBid,
        targetBid: currentBid,
      })
    }
    const targetBid = Math.max(clampedBid, currentBid - policyResult.policy.stepDown)
    const stepDownCapped = targetBid > clampedBid
    const reasonCodes: BidDecisionReasonCode[] = ['bid_decrease']
    if (bufferApplied) reasonCodes.push('exposure_buffer_applied')
    if (floorApplied) reasonCodes.push('floor_applied')
    if (ceilingApplied) reasonCodes.push('ceiling_applied')
    if (stepDownCapped) reasonCodes.push('step_down_capped')
    return decisionResult(input, {
      currentBid,
      estimatedMinimumBid: estimateValue,
      bufferedBid,
      clampedBid,
      targetBid,
      proposedBid: targetBid,
      stepDownCapped,
      reasonCodes,
    })
  }

  if (clampedBid === currentBid) {
    return skipDecision(input, ['bid_unchanged'], {
      currentBid,
      estimatedMinimumBid: estimateValue,
      bufferedBid,
      clampedBid,
      targetBid: currentBid,
    })
  }

  const targetBid = capBidIncrease(
    currentBid,
    clampedBid,
    policyResult.policy.stepUp,
    policyResult.policy.ceiling!,
  )
  const stepUpCapped = clampedBid > targetBid
  if (targetBid === currentBid) {
    return skipDecision(input, ['step_up_limit_reached'], {
      currentBid, estimatedMinimumBid: estimateValue, bufferedBid, clampedBid,
      targetBid: currentBid, stepUpCapped,
    })
  }
  const reasonCodes: BidDecisionReasonCode[] = ['bid_increase']
  if (bufferApplied) reasonCodes.push('exposure_buffer_applied')
  if (floorApplied) reasonCodes.push('floor_applied')
  if (ceilingApplied) reasonCodes.push('ceiling_applied')
  if (stepUpCapped) reasonCodes.push('step_up_capped')
  return decisionResult(input, {
    currentBid,
    estimatedMinimumBid: estimateValue,
    bufferedBid,
    clampedBid,
    targetBid,
    proposedBid: targetBid,
    cooldownActive: false,
    stepUpCapped,
    reasonCodes,
  })
}

/** Alias for callers that name the operation after the program. */
export const decideAutoBid = decideBid

/**
 * Build the only provider patch permitted by this policy layer.  Dry-run
 * retains group bidding and therefore contains no bid amount.  A live raise
 * opts out of group bidding and supplies the exact integer bid.
 */
export function buildBidPatch(
  decision: Pick<BidDecision, 'changed' | 'proposedBid'>,
  mode: AutoBidMode = 'dry-run',
): NaverAutoBidPatch {
  if (mode === 'live' && decision.changed && decision.proposedBid !== null) {
    return { useGroupBidAmt: false, bidAmt: decision.proposedBid }
  }
  return { useGroupBidAmt: true }
}

/** Alias used by provider adapters. */
export const buildProviderBidPatch = buildBidPatch
