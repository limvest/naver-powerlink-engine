import { describe, expect, it } from 'vitest'
import { updateRankLearning, type CompactRankObservation } from '../src/rank-learning'
import type { ObservedRank } from '../src/rank-observer'

function observation(status: ObservedRank['status'], rank: number | null, at: number): ObservedRank {
  return {
    keyword: '사건명', device: 'mobile', status, rank, visibleAds: 8,
    legalCompetitorPresent: true, legalCompetitorCount: 2, legalCompetitors: [],
    source: 'mobile_ad_only', latencyMs: 100, observedAt: new Date(at).toISOString(),
  }
}

function compact(status: ObservedRank['status'], rank: number | null, at: number, bid = 1_000): CompactRankObservation {
  return { at: new Date(at).toISOString(), bid, status, rank, visibleAds: 8,
    legalCompetitorCount: 2, targetPosition: 3 }
}

const base = {
  currentBid: 1_000, targetPosition: 3, floor: 70, ceiling: 3_000,
  stepUp: 100, stepDown: 100,
}

describe('rank learning controller', () => {
  it('retests lower prices after the failed-price evidence expires during continuous observation', () => {
    const now = 86_400_004
    const result = updateRankLearning({ ...base,
      priorWindow: [compact('found', 3, now - 2), compact('found', 3, now - 1)],
      priorLearning: { highestBadBid: 990, lowestGoodBid: 1_000,
        highestBadAt: new Date(1).toISOString(), lowestGoodAt: new Date(now - 1).toISOString() },
      observation: observation('found', 3, now) })
    expect(result.learning).toMatchObject({ highestBadBid: null, highestBadAt: null,
      recommendedBid: 900, phase: 'minimize' })
  })
  it('does not count a replayed observation as new confirmation', () => {
    const priorWindow = [compact('outside', null, 1), compact('outside', null, 2)]
    const result = updateRankLearning({ ...base, priorWindow, observation: observation('outside', null, 2) })
    expect(result.window).toEqual(priorWindow)
    expect(result.learning).toMatchObject({ recommendedBid: 1_000, evidenceAtCurrentBid: 0 })
    expect(result.stateChanged).toBe(false)
  })

  it('requires recent evidence and forgets a bracket after more than a day without observation', () => {
    const priorWindow = [compact('outside', null, 1), compact('outside', null, 2)]
    const old = updateRankLearning({ ...base, priorWindow, observation: observation('outside', null, 3_600_003) })
    expect(old.learning).toMatchObject({ recommendedBid: 1_000, evidenceAtCurrentBid: 1 })
    const idle = updateRankLearning({ ...base, priorWindow,
      priorLearning: { highestBadBid: 900, lowestGoodBid: 1_100 },
      observation: observation('found', 3, 86_400_003) })
    expect(idle.learning).toMatchObject({ highestBadBid: null, lowestGoodBid: null })
  })
  it('does not raise from after-hours misses or a current no-ad result', () => {
    const input = { ...base, priorWindow: [compact('outside', null, 1), compact('outside', null, 2)] }
    const closed = updateRankLearning({ ...input, biddingEligible: false, observation: observation('outside', null, 3) })
    expect(closed.learning).toMatchObject({ recommendedBid: 1_000, evidenceAtCurrentBid: 0 })
    const noAds = updateRankLearning({ ...input, observation: observation('no_ads', null, 3) })
    expect(noAds.learning).toMatchObject({ recommendedBid: 1_000, highestBadBid: null })
  })

  it('converges on the minimum maintaining bid across repeated increases and decreases', () => {
    let bid = 70
    let priorWindow: readonly CompactRankObservation[] = []
    let priorLearning: ReturnType<typeof updateRankLearning>['learning'] | undefined
    const visited: number[] = []
    for (let at = 1; at <= 90; at++) {
      const rank = bid >= 430 ? 3 : 6
      const result = updateRankLearning({ ...base, currentBid: bid, priorWindow, priorLearning,
        observation: observation('found', rank, at) })
      priorWindow = result.window
      priorLearning = result.learning
      bid = result.learning.recommendedBid!
      visited.push(bid)
    }
    expect(visited.some(value => value > 430)).toBe(true)
    expect(visited.slice(-20)).toEqual(Array(20).fill(430))
    expect(priorLearning).toMatchObject({ phase: 'hold', highestBadBid: 420, lowestGoodBid: 430 })
  })
  it('holds the good bid once the bracket is one bid increment wide', () => {
    const result = updateRankLearning({
      ...base, priorLearning: { highestBadBid: 990 },
      priorWindow: [compact('found', 2, 1), compact('found', 3, 2)],
      observation: observation('found', 2, 3),
    })
    expect(result.learning).toMatchObject({ phase: 'hold', recommendedBid: 1_000 })
  })

  it('returns to the adjacent known good bid without overshooting', () => {
    const result = updateRankLearning({
      ...base, priorLearning: { lowestGoodBid: 1_010 },
      priorWindow: [compact('outside', null, 1), compact('outside', null, 2)],
      observation: observation('outside', null, 3),
    })
    expect(result.learning.recommendedBid).toBe(1_010)
  })

  it('holds at the floor when the target is confirmed', () => {
    const result = updateRankLearning({
      ...base, currentBid: 70,
      priorWindow: [compact('found', 2, 1, 70), compact('found', 3, 2, 70)],
      observation: observation('found', 2, 3),
    })
    expect(result.learning).toMatchObject({ phase: 'hold', recommendedBid: 70 })
  })

  it('requires fresh confirmation after changing the target rank', () => {
    const result = updateRankLearning({
      ...base, targetPosition: 1, priorLearning: { lowestGoodBid: 800, highestBadBid: 700 },
      priorWindow: [compact('found', 2, 1), compact('found', 3, 2)],
      observation: observation('found', 2, 3),
    })
    expect(result.learning).toMatchObject({ phase: 'observe', evidenceAtCurrentBid: 1,
      lowestGoodBid: null, highestBadBid: null })
  })

  it('does not use mobile evidence and bid bounds for a PC observation', () => {
    const result = updateRankLearning({
      ...base, priorLearning: { lowestGoodBid: 800, highestBadBid: 700 },
      priorWindow: [1, 2].map(at => ({ ...compact('found', 2, at), device: 'mobile' as const })),
      observation: { ...observation('outside', null, 3), device: 'pc' },
    })
    expect(result.learning).toMatchObject({ phase: 'observe', evidenceAtCurrentBid: 1,
      lowestGoodBid: null, highestBadBid: null })
  })
  it('does not act on a single volatile observation', () => {
    const result = updateRankLearning({ ...base, observation: observation('outside', null, 3) })
    expect(result.learning).toMatchObject({ phase: 'observe', recommendedBid: 1_000, evidenceAtCurrentBid: 1 })
  })

  it('raises only after two of three same-bid observations miss the target', () => {
    const result = updateRankLearning({
      ...base,
      priorWindow: [compact('outside', null, 1), compact('found', 6, 2)],
      observation: observation('outside', null, 3),
    })
    expect(result.learning).toMatchObject({
      phase: 'acquire', highestBadBid: 1_000, recommendedBid: 1_100,
      evidenceAtCurrentBid: 3, badEvidence: 3,
    })
  })

  it('marks an outside bid above 1500 as unexposed and never raises it', () => {
    const result = updateRankLearning({
      ...base, currentBid: 1_510,
      priorWindow: [compact('outside', null, 1, 1_510), compact('outside', null, 2, 1_510)],
      observation: observation('outside', null, 3),
    })
    expect(result.learning).toMatchObject({
      phase: 'unexposed', recommendedBid: 1_510, highestBadBid: 1_510,
    })
  })

  it('does not reinterpret a found below-target bid above 1500 as unexposed', () => {
    const result = updateRankLearning({
      ...base, currentBid: 1_510,
      priorWindow: [compact('found', 7, 1, 1_510), compact('found', 7, 2, 1_510)],
      observation: observation('found', 7, 3),
    })
    expect(result.learning).toMatchObject({ phase: 'acquire', recommendedBid: 1_610 })
  })

  it('lowers a confirmed good bid and brackets between known bad and good bids', () => {
    const result = updateRankLearning({
      ...base,
      priorLearning: { highestBadBid: 700 },
      priorWindow: [compact('found', 2, 1), compact('found', 3, 2)],
      observation: observation('found', 2, 3),
    })
    expect(result.learning).toMatchObject({
      phase: 'minimize', highestBadBid: 700, lowestGoodBid: 1_000,
      recommendedBid: 850, targetConfirmed: true,
    })
  })

  it('keeps a fixed 24-observation evidence window', () => {
    const prior = Array.from({ length: 30 }, (_, index) => compact('found', 3, index + 1))
    const result = updateRankLearning({ ...base, priorWindow: prior, observation: observation('found', 3, 31) })
    expect(result.window).toHaveLength(24)
    expect(result.window.at(-1)?.at).toBe(new Date(31).toISOString())
  })
})
