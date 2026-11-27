import { describe, expect, it } from 'vitest'
import { recordBidOutcome, type VerifiedBidAction } from '../src/bid-outcomes'
import type { ObservedRank } from '../src/rank-observer'

const action: VerifiedBidAction = {
  decisionId: 'action-1', device: 'mobile', beforeBid: 70, afterBid: 170,
  beforeRank: 6, targetPosition: 3,
  appliedAt: '2026-09-07T10:00:00Z', verifiedAt: '2026-09-07T10:01:00Z',
}
const observation: ObservedRank = {
  keyword: '사건', device: 'mobile', status: 'found', rank: 2, visibleAds: 5,
  legalCompetitorPresent: true, legalCompetitorCount: 2, legalCompetitors: [],
  source: 'mobile_ad_only', latencyMs: 10, observedAt: '2026-09-07T10:03:00Z',
}

describe('verified bid outcomes', () => {
  it('links rank and target hits to the verified bid action and ignores duplicate observations', () => {
    const first = recordBidOutcome(action, [], observation, 170)
    expect(first[0]).toMatchObject({ decisionId: 'action-1', beforeRank: 6,
      latestRank: 2, observations: 1, targetHits: 1, targetMisses: 0 })
    expect(recordBidOutcome(action, first, observation, 170)).toEqual(first)
    const later = recordBidOutcome(action, first,
      { ...observation, status: 'no_ads', rank: null, observedAt: '2026-09-07T10:04:00Z' }, 170)
    expect(later[0]).toMatchObject({ observations: 2, targetHits: 1, targetMisses: 0, noAds: 1 })
  })

  it('does not attribute other bids, devices, or pre-verification observations', () => {
    expect(recordBidOutcome(action, [], { ...observation, observedAt: '2026-09-07T10:02:59Z' }, 170)).toEqual([])
    expect(recordBidOutcome(action, [], observation, 270)).toEqual([])
    expect(recordBidOutcome(action, [], { ...observation, device: 'pc' }, 170)).toEqual([])
    expect(recordBidOutcome(action, [], { ...observation, observedAt: action.appliedAt }, 170)).toEqual([])
  })

  it('bounds history to the latest twelve actions', () => {
    let history = recordBidOutcome(action, [], observation, 170)
    for (let index = 2; index <= 20; index++) {
      history = recordBidOutcome({ ...action, decisionId: `action-${index}` }, history, observation, 170)
    }
    expect(history).toHaveLength(12)
    expect(history[0].decisionId).toBe('action-9')
    expect(history.at(-1)?.decisionId).toBe('action-20')
  })
})
