/**
 * Types shared by the Naver automatic-bid policy and its callers.
 *
 * The policy layer intentionally models a snapshot rather than a database
 * row.  Adapters can map whatever the provider returns into this shape, and
 * the pure functions below can then be used for both dry-run and live plans.
 */

export const AUTO_BID_DEVICES = ['mobile', 'pc'] as const
export type AutoBidDevice = (typeof AUTO_BID_DEVICES)[number]

export const AUTO_BID_MODES = ['dry-run', 'live'] as const
export type AutoBidMode = (typeof AUTO_BID_MODES)[number]

export type DateLike = Date | string | number

/** Naver has returned both booleans and numeric/string equivalents over time. */
export type ProviderLockValue = boolean | 0 | 1 | '0' | '1' | 'false' | 'true'

export type ProviderReviewStatus = 'approved' | 'pending' | 'rejected' | 'unknown'

export type ProviderDeliveryStatus =
  | 'active'
  | 'eligible'
  | 'paused'
  | 'blocked'
  | 'archived'
  | 'deleted'
  | 'under_review'
  | 'rejected'
  | 'unknown'

export type LocalKeywordStatus =
  | 'subscribed'
  | 'ad_pending'
  | 'ad_registered'
  | 'live'
  | 'active'
  | 'paused'
  | 'rejected'
  | 'blocked'
  | 'archived'
  | 'unknown'

/** Optional nested form useful when an adapter already separates sources. */
export interface AutoBidProviderSnapshot {
  readonly reviewStatus?: string | null
  readonly inspectStatus?: string | null
  readonly status?: string | null
  readonly keywordStatus?: string | null
  readonly userLock?: ProviderLockValue | null
}

/** Optional nested local form useful when an adapter already separates sources. */
export interface AutoBidLocalSnapshot {
  readonly status?: string | null
  readonly adDesired?: boolean | null
  readonly hostStatus?: string | null
  readonly publicHost?: string | null
  readonly publicHostLabel?: string | null
  readonly archived?: boolean | null
  readonly archivedAt?: DateLike | null
  readonly sourceStatus?: string | null
  readonly sourceBlocked?: boolean | null
}

/**
 * A provider/local keyword snapshot accepted by `evaluateEligibility`.
 *
 * The direct fields are aliases for the nested fields because existing
 * snapshots and provider rows use both conventions.  Missing safety fields
 * are treated as unknown by the policy function and fail closed where the
 * policy requires proof of safety.
 */
export interface AutoBidEligibilityInput {
  readonly firmId?: number | string
  readonly campaignId?: string
  readonly adGroupId?: string
  readonly keywordId?: string
  readonly providerKeywordId?: string

  readonly provider?: AutoBidProviderSnapshot | null
  readonly local?: AutoBidLocalSnapshot | null

  readonly providerReviewStatus?: string | null
  readonly reviewStatus?: string | null
  readonly inspectStatus?: string | null
  readonly providerStatus?: string | null
  readonly providerDeliveryStatus?: string | null
  readonly providerUserLock?: ProviderLockValue | null
  readonly userLock?: ProviderLockValue | null

  /** Local firm-keyword status. `status` is accepted as a legacy alias. */
  readonly localStatus?: string | null
  readonly status?: string | null
  readonly adDesired?: boolean | null
  readonly hostStatus?: string | null
  readonly publicHost?: string | null
  readonly publicHostLabel?: string | null
  readonly archived?: boolean | null
  readonly archivedAt?: DateLike | null
  readonly sourceStatus?: string | null
  readonly sourceBlocked?: boolean | null
}

export type EligibilityReasonCode =
  | 'provider_review_pending'
  | 'provider_review_rejected'
  | 'provider_review_unknown'
  | 'provider_status_excluded'
  | 'provider_status_unknown'
  | 'provider_keyword_locked'
  | 'provider_user_lock_unknown'
  | 'local_status_excluded'
  | 'local_status_unknown'
  | 'local_ad_disabled'
  | 'local_ad_desired_unknown'
  | 'local_host_missing'
  | 'local_host_not_public'
  | 'local_archived'
  | 'local_source_blocked'
  | 'local_source_excluded'
  | 'local_source_status_unknown'

export interface EligibilityDecision {
  readonly eligible: boolean
  /** Reasons are always emitted in the policy's stable check order. */
  readonly reasonCodes: readonly EligibilityReasonCode[]
  readonly reasons: readonly string[]
  readonly reasonCode: EligibilityReasonCode | null
  readonly reason: string | null
}

export interface AutoBidPolicy {
  readonly device: AutoBidDevice
  readonly floor: number
  /** Null means the operator has not supplied the required ceiling. */
  readonly ceiling: number | null
  readonly stepUp: number
  readonly stepDown: number
  readonly allowBidDecrease: boolean
  readonly exposureBuffer: number
  readonly cooldownMs: number
  readonly batchSize: number
  /** Null is allowed for dry-run, but required for live mode. */
  readonly maxChangesPerRun: number | null
}

/** Input form with safe defaults for all fields except the required ceiling. */
export interface AutoBidPolicyInput {
  readonly device?: AutoBidDevice | string | null
  readonly floor?: number | null
  readonly minimumBid?: number | null
  readonly minBid?: number | null
  readonly bidFloor?: number | null
  readonly ceiling?: number | null
  readonly maximumBid?: number | null
  readonly bidCeiling?: number | null
  readonly stepUp?: number | null
  readonly stepUpAmount?: number | null
  readonly stepDown?: number | null
  readonly allowBidDecrease?: boolean | null
  readonly exposureBuffer?: number | null
  readonly exposureBufferKrw?: number | null
  readonly cooldownMs?: number | null
  readonly cooldownHours?: number | null
  readonly cooldownMinutes?: number | null
  readonly batchSize?: number | null
  readonly maxChangesPerRun?: number | null
  readonly maxChanges?: number | null
}

export interface ValidAutoBidPolicy extends Omit<AutoBidPolicy, 'ceiling'> {
  readonly ceiling: number
}

export type PolicyReasonCode =
  | 'policy_device_invalid'
  | 'policy_floor_invalid'
  | 'policy_ceiling_required'
  | 'policy_ceiling_invalid'
  | 'policy_floor_above_ceiling'
  | 'policy_step_up_invalid'
  | 'policy_step_down_invalid'
  | 'policy_exposure_buffer_invalid'
  | 'policy_cooldown_invalid'
  | 'policy_batch_size_invalid'
  | 'policy_change_limit_required'
  | 'policy_change_limit_invalid'

export interface PolicyValidationResult {
  readonly valid: boolean
  readonly mode: AutoBidMode
  readonly policy: AutoBidPolicy
  readonly reasonCodes: readonly PolicyReasonCode[]
  readonly reasons: readonly string[]
}

export type BidDecisionReasonCode =
  | 'not_eligible'
  | 'current_bid_missing'
  | 'current_bid_invalid'
  | 'current_bid_above_ceiling'
  | 'decision_clock_missing'
  | 'cooldown_timestamp_invalid'
  | 'cooldown_active'
  | 'estimate_missing'
  | 'estimate_invalid'
  | 'exposure_buffer_applied'
  | 'floor_applied'
  | 'ceiling_applied'
  | 'step_up_capped'
  | 'step_down_capped'
  | 'step_up_limit_reached'
  | 'bid_unchanged'
  | 'bid_lowering_disabled'
  | 'bid_increase'
  | 'bid_decrease'

export type AutoBidReasonCode =
  | EligibilityReasonCode
  | PolicyReasonCode
  | BidDecisionReasonCode

export interface BidDecisionInput {
  readonly keywordId?: string
  readonly currentBid: number | null | undefined
  readonly estimatedMinimumBid?: number | null
  /** Alias used by estimate adapters. */
  readonly estimate?: number | null
  readonly estimatedBid?: number | null
  readonly minimumBid?: number | null
  readonly lastBidChangedAt?: DateLike | null
  /** Alias for snapshots that call the timestamp simply `lastBidAt`. */
  readonly lastBidAt?: DateLike | null
  /** Persisted cooldown boundary, when the repository stores it directly. */
  readonly cooldownUntil?: DateLike | null
  /** Required for a time-based decision when a cooldown timestamp exists. */
  readonly now?: DateLike
  readonly policy: AutoBidPolicyInput | AutoBidPolicy
  readonly mode?: AutoBidMode
  readonly eligible?: boolean
  readonly eligibility?: Pick<EligibilityDecision, 'eligible' | 'reasonCodes' | 'reasons'> | null
}

export type BidDecisionKind = 'raise' | 'lower' | 'skip'

export interface BidDecision {
  readonly keywordId?: string
  readonly decision: BidDecisionKind
  readonly action: BidDecisionKind
  readonly changed: boolean
  readonly currentBid: number | null
  readonly estimatedMinimumBid: number | null
  readonly bufferedBid: number | null
  readonly clampedBid: number | null
  /** The calculated target, including no-op decisions. */
  readonly targetBid: number | null
  /** Non-null only when a provider mutation should be considered. */
  readonly proposedBid: number | null
  readonly cooldownActive: boolean
  readonly stepUpCapped: boolean
  readonly stepDownCapped: boolean
  readonly reasonCode: AutoBidReasonCode | null
  readonly reason: string | null
  readonly reasonCodes: readonly AutoBidReasonCode[]
  readonly reasons: readonly string[]
}

/** Provider payload shape for one keyword bid mutation. */
export interface NaverAutoBidPatch {
  readonly useGroupBidAmt: boolean
  readonly bidAmt?: number
}
