import { describe, expect, it } from 'vitest'
import {
  AUTO_BID_COOLDOWN_MS,
  DEFAULT_AUTO_BID_POLICY,
  applyExposureBuffer,
  buildBidPatch,
  capBidIncrease,
  clampBid,
  decideBid,
  evaluateEligibility,
  isBidInCooldown,
  isEligibleForBid,
  normalizeLocalStatus,
  normalizeProviderLock,
  normalizeProviderReviewStatus,
  normalizeProviderStatus,
  validateAutoBidPolicy,
} from '../src/policy'
import type { AutoBidEligibilityInput, AutoBidPolicyInput } from '../src/types'

const VALID_POLICY: AutoBidPolicyInput = {
  ceiling: 500,
  floor: 70,
  stepUp: 100,
  stepDown: 50,
  allowBidDecrease: true,
  exposureBuffer: 10,
  cooldownMs: AUTO_BID_COOLDOWN_MS,
  batchSize: 50,
  maxChangesPerRun: 10,
}

const ELIGIBLE_KEYWORD: AutoBidEligibilityInput = {
  providerReviewStatus: 'APPROVED',
  providerStatus: 'ACTIVE',
  providerUserLock: false,
  localStatus: 'ad_registered',
  adDesired: true,
  hostStatus: 'PUBLIC',
  publicHostLabel: 'keyword.example.com',
  archivedAt: null,
  sourceStatus: 'published',
}

function decision(overrides: Partial<Parameters<typeof decideBid>[0]> = {}) {
  return decideBid({
    currentBid: 100,
    estimatedMinimumBid: 150,
    policy: VALID_POLICY,
    now: '2026-09-07T12:00:00.000Z',
    ...overrides,
  })
}

describe('Naver auto-bid eligibility', () => {
  it('accepts an approved, unlocked, desired keyword with a public host and source', () => {
    const result = evaluateEligibility(ELIGIBLE_KEYWORD)

    expect(result).toMatchObject({ eligible: true, reasonCodes: [], reasons: [], reasonCode: null, reason: null })
    expect(isEligibleForBid(ELIGIBLE_KEYWORD)).toBe(true)
  })

  it('accepts nested provider/local snapshots and normalizes provider aliases', () => {
    const result = evaluateEligibility({
      provider: { reviewStatus: 'eligible', status: 'serving', userLock: 0 },
      local: {
        status: 'live',
        adDesired: true,
        hostStatus: 'public',
        publicHost: 'nested.example.com',
        archivedAt: null,
        sourceStatus: 'indexed',
      },
    })

    expect(result.eligible).toBe(true)
    expect(normalizeProviderReviewStatus('ELIGIBLE')).toBe('approved')
    expect(normalizeProviderStatus('SERVING')).toBe('active')
    expect(normalizeProviderLock(0)).toBe('unlocked')
    expect(normalizeLocalStatus('LIVE')).toBe('live')
  })

  it.each([
    ['pending review', { providerReviewStatus: 'UNDER_REVIEW' }, 'provider_review_pending'],
    ['rejected review', { providerReviewStatus: 'DENIED' }, 'provider_review_rejected'],
    ['unknown review', { providerReviewStatus: 'future-state' }, 'provider_review_unknown'],
    ['paused provider', { providerStatus: 'PAUSED' }, 'provider_status_excluded'],
    ['blocked provider', { providerStatus: 'BLOCKED' }, 'provider_status_excluded'],
    ['deleted provider', { providerStatus: 'DELETED' }, 'provider_status_excluded'],
    ['locked provider keyword', { providerUserLock: true }, 'provider_keyword_locked'],
    ['unknown provider lock', { providerUserLock: null }, 'provider_user_lock_unknown'],
    ['paused local keyword', { localStatus: 'paused' }, 'local_status_excluded'],
    ['pending local keyword', { localStatus: 'ad_pending' }, 'local_status_excluded'],
    ['unknown local status', { localStatus: 'future-state' }, 'local_status_unknown'],
    ['ad not desired', { adDesired: false }, 'local_ad_disabled'],
    ['missing ad desired', { adDesired: null }, 'local_ad_desired_unknown'],
    ['missing host', { publicHostLabel: '' }, 'local_host_missing'],
    ['preview host', { hostStatus: 'preview' }, 'local_host_not_public'],
    ['archived timestamp', { archivedAt: '2026-09-07T10:00:00.000Z' }, 'local_archived'],
    ['blocked source flag', { sourceBlocked: true }, 'local_source_blocked'],
    ['blocked source status', { sourceStatus: 'blocked' }, 'local_source_excluded'],
    ['pending source status', { sourceStatus: 'pending' }, 'local_source_excluded'],
    ['missing source status', { sourceStatus: null }, 'local_source_status_unknown'],
  ] as const)('excludes %s with deterministic reason %s', (_label, change, reason) => {
    const result = evaluateEligibility({ ...ELIGIBLE_KEYWORD, ...change })

    expect(result.eligible).toBe(false)
    expect(result.reasonCodes).toContain(reason)
    expect(result.reasons[result.reasonCodes.indexOf(reason)]).toBeDefined()
  })

  it('reports all failed gates in a fixed order without duplicate reasons', () => {
    const result = evaluateEligibility({
      providerReviewStatus: 'pending',
      providerUserLock: true,
      adDesired: false,
      hostStatus: 'preview',
      publicHostLabel: '',
      archivedAt: '2026-09-07T10:00:00.000Z',
      sourceStatus: 'blocked',
    })

    expect(result.reasonCodes).toEqual([
      'provider_review_pending',
      'provider_keyword_locked',
      'local_ad_disabled',
      'local_host_missing',
      'local_host_not_public',
      'local_archived',
      'local_source_excluded',
    ])
    expect(new Set(result.reasonCodes).size).toBe(result.reasonCodes.length)
  })

  it('fails closed when required safety fields are absent', () => {
    const result = evaluateEligibility({})

    expect(result.eligible).toBe(false)
    expect(result.reasonCodes).toEqual([
      'provider_review_unknown',
      'provider_user_lock_unknown',
      'local_ad_desired_unknown',
      'local_host_missing',
      'local_host_not_public',
      'local_source_status_unknown',
    ])
  })
})

describe('Naver auto-bid policy and arithmetic', () => {
  it('keeps the documented defaults and requires an explicit ceiling', () => {
    expect(DEFAULT_AUTO_BID_POLICY).toMatchObject({
      device: 'mobile',
      floor: 70,
      ceiling: null,
      stepUp: 100,
      stepDown: 10,
      allowBidDecrease: true,
      exposureBuffer: 10,
      cooldownMs: 6 * 60 * 60 * 1_000,
      batchSize: 50,
      maxChangesPerRun: null,
    })
    expect(validateAutoBidPolicy(DEFAULT_AUTO_BID_POLICY).reasonCodes).toEqual(['policy_ceiling_required'])
    expect(validateAutoBidPolicy({ ceiling: 500 }, 'live').reasonCodes)
      .toEqual(['policy_change_limit_required'])
  })

  it('validates invalid bounds and does not invent an unlimited ceiling', () => {
    const result = validateAutoBidPolicy({ floor: 600, ceiling: 500, stepUp: -1, batchSize: 0 })

    expect(result.valid).toBe(false)
    expect(result.reasonCodes).toEqual([
      'policy_floor_above_ceiling',
      'policy_step_up_invalid',
      'policy_batch_size_invalid',
    ])
    expect(() => clampBid(100, { floor: 70, ceiling: null })).toThrow(/ceiling is required/)
  })

  it('clamps both below-floor and above-ceiling estimates', () => {
    expect(clampBid(20, VALID_POLICY)).toBe(70)
    expect(clampBid(900, VALID_POLICY)).toBe(500)
    expect(applyExposureBuffer(150, 10)).toBe(160)
    expect(capBidIncrease(100, 500, 100, 500)).toBe(200)
    expect(capBidIncrease(450, 500, 100, 500)).toBe(500)
  })
})

describe('Naver auto-bid decisions', () => {
  it('applies the exposure buffer, floor, and upward step cap deterministically', () => {
    const result = decision({ currentBid: 100, estimatedMinimumBid: 500 })

    expect(result).toMatchObject({
      decision: 'raise',
      changed: true,
      bufferedBid: 510,
      clampedBid: 500,
      targetBid: 200,
      proposedBid: 200,
      stepUpCapped: true,
    })
    expect(result.reasonCodes).toEqual(['bid_increase', 'exposure_buffer_applied', 'ceiling_applied', 'step_up_capped'])
  })

  it('raises a bid below the floor but never above one-run stepUp', () => {
    const result = decision({ currentBid: 20, estimatedMinimumBid: 1 })

    expect(result).toMatchObject({
      decision: 'raise',
      bufferedBid: 11,
      clampedBid: 70,
      targetBid: 70,
      proposedBid: 70,
    })
    expect(result.reasonCodes).toContain('floor_applied')
  })

  it('skips unchanged estimates and lowers toward the target within stepDown', () => {
    const unchanged = decision({ currentBid: 100, estimatedMinimumBid: 90 })
    const lowering = decision({ currentBid: 400, estimatedMinimumBid: 100 })

    expect(unchanged).toMatchObject({ decision: 'skip', changed: false, targetBid: 100, proposedBid: null })
    expect(unchanged.reasonCodes).toEqual(['bid_unchanged'])
    expect(lowering).toMatchObject({ decision: 'lower', changed: true, targetBid: 350, proposedBid: 350, stepDownCapped: true })
    expect(lowering.reasonCodes).toEqual(['bid_decrease', 'exposure_buffer_applied', 'step_down_capped'])
  })

  it('can explicitly disable downward bidding', () => {
    const lowering = decision({
      currentBid: 400,
      estimatedMinimumBid: 100,
      policy: { ...VALID_POLICY, allowBidDecrease: false },
    })
    expect(lowering).toMatchObject({ decision: 'skip', changed: false, targetBid: 400, proposedBid: null })
    expect(lowering.reasonCodes).toEqual(['bid_lowering_disabled'])
  })

  it('skips bids inside cooldown and permits the exact boundary', () => {
    const now = '2026-09-07T12:00:00.000Z'
    const justInside = decision({
      now,
      lastBidChangedAt: '2026-09-07T06:00:00.001Z',
      estimatedMinimumBid: 300,
    })
    const atBoundary = decision({
      now,
      lastBidChangedAt: '2026-09-07T06:00:00.000Z',
      estimatedMinimumBid: 300,
    })

    expect(justInside).toMatchObject({ decision: 'skip', cooldownActive: true, proposedBid: null })
    expect(justInside.reasonCodes).toEqual(['cooldown_active'])
    expect(atBoundary.decision).toBe('raise')
    expect(atBoundary.cooldownActive).toBe(false)
    expect(isBidInCooldown('2026-09-07T06:00:00.001Z', now, AUTO_BID_COOLDOWN_MS)).toBe(true)
    expect(isBidInCooldown('2026-09-07T06:00:00.000Z', now, AUTO_BID_COOLDOWN_MS)).toBe(false)
  })

  it('fails closed for malformed bids, estimates, timestamps, and ineligible input', () => {
    expect(decision({ currentBid: null }).reasonCodes).toEqual(['current_bid_missing'])
    expect(decision({ currentBid: 100.5 }).reasonCodes).toEqual(['current_bid_invalid'])
    expect(decision({ estimatedMinimumBid: null }).reasonCodes).toEqual(['estimate_missing'])
    expect(decision({ estimatedMinimumBid: -1 }).reasonCodes).toEqual(['estimate_invalid'])
    expect(decision({ lastBidChangedAt: 'not-a-date' }).reasonCodes).toEqual(['cooldown_timestamp_invalid'])
    expect(decision({ lastBidChangedAt: '2026-09-07T06:00:00.000Z', now: undefined }).reasonCodes)
      .toEqual(['decision_clock_missing'])
    expect(decision({ eligible: false }).reasonCodes).toEqual(['not_eligible'])
  })

  it('does not bid when the current bid is already above the policy ceiling', () => {
    const result = decision({ currentBid: 600, estimatedMinimumBid: 700 })

    expect(result).toMatchObject({ decision: 'skip', changed: false, currentBid: 600, targetBid: 600 })
    expect(result.reasonCodes).toEqual(['current_bid_above_ceiling'])
  })

  it('emits group-bid preservation for dry-run and an explicit bid patch for live raises', () => {
    const raise = decision({ currentBid: 100, estimatedMinimumBid: 150 })

    expect(buildBidPatch(raise, 'dry-run')).toEqual({ useGroupBidAmt: true })
    expect(buildBidPatch(raise, 'live')).toEqual({ useGroupBidAmt: false, bidAmt: 160 })
    expect(buildBidPatch(decision({ estimatedMinimumBid: 90 }), 'live'))
      .toEqual({ useGroupBidAmt: true })
  })
})
