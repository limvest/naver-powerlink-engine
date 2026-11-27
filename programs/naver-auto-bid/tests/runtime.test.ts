import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTestDb } from '../../../tests/helpers/test-db'
import {
  firmAdEntities, firmKeywords, firms, keywords, naverAutoBidDecisions, naverAutoBidEvents, naverAutoBidRuns,
  naverAutoBidGroupPolicies, naverAutoBidKeywordPolicies, naverAutoBidPolicies,
} from '@/lib/db/schema'
import type { AutoBidConfig } from '../src/config'
import type { NaverProvider } from '../src/naver-provider'
import { ProductionAutoBidRuntime } from '../src/runtime'
import type { RankObserver } from '../src/rank-observer'
import { syncAutoBidAccount } from '../src/command-worker'

function config(mode: 'dry-run' | 'live'): AutoBidConfig {
  return {
    firmId: 701,
    campaignName: '파워링크#1',
    device: 'mobile',
    strategy: 'exposure_minimum',
    targetPosition: 3,
    floor: 70,
    ceiling: 300,
    stepUp: 100,
    stepDown: 10,
    allowBidDecrease: true,
    exposureBuffer: 10,
    cooldownHours: 6,
    batchSize: 50,
    rankCheckLimit: 50_000,
    rankIntervalMs: 60,
    rankRequestsPerMinute: 1_000,
    rankConcurrency: 24,
    maxChanges: mode === 'live' ? 10 : null,
    mode,
    live: mode === 'live',
    dryRun: mode === 'dry-run',
    stage: 'all',
    runKey: `runtime-${mode}`,
  }
}

async function fixture() {
  const db = await createTestDb()
  await db.insert(firms).values({
    id: 701, slug: 'runtime-firm', name: 'Runtime Firm', adLawyerName: 'Lawyer',
    phone: '02-0000-0000', phoneIntl: '+82-2-0000-0000', address: 'Seoul',
    addressRegion: 'Seoul', addressLocality: 'Jung-gu',
  })
  const [keyword] = await db.insert(keywords).values({
    firmId: 701, name: '가상앱MOCKER', normalizedName: '가상앱mocker',
    slug: 'aimer-runtime', scamType: 'investment', status: 'published',
  }).returning()
  const [firmKeyword] = await db.insert(firmKeywords).values({
    firmId: 701, keywordId: keyword.id, status: 'live', adDesired: true,
    hostStatus: 'public', publicHostLabel: 'runtime-host',
  }).returning()
  await db.insert(firmAdEntities).values({
    firmId: 701, entityType: 'keyword', keywordId: keyword.id,
    naverId: 'nkw-runtime-1', reviewStatus: 'approved',
    raw: { nccKeywordId: 'nkw-runtime-1', nccAdgroupId: 'grp-runtime-1' },
  })
  await db.insert(naverAutoBidGroupPolicies).values({
    firmId: 701, naverCampaignId: 'cmp-runtime', naverAdgroupId: 'grp-runtime-1',
    campaignName: '파워링크#1', adgroupName: '샘플원_사건명_01', enabled: true,
  })
  await db.insert(naverAutoBidKeywordPolicies).values({
    firmId: 701, naverAdgroupId: 'grp-runtime-1', naverKeywordId: 'nkw-runtime-1',
    keyword: '가상앱MOCKER', enabled: true,
  })
  await db.insert(naverAutoBidPolicies).values({firmId:701,enabled:true,status:'active',bidCeiling:300})
  return { db, firmKeyword }
}

function context(value: AutoBidConfig, stage: 'snapshot' | 'estimate' | 'decide' | 'apply' | 'verify' | 'report') {
  return { config: value, mode: value.mode, runKey: value.runKey, stage }
}

function fakeProvider() {
  let putCalls = 0
  let remote = {
    nccKeywordId: 'nkw-runtime-1', nccAdgroupId: 'grp-runtime-1', keyword: '가상앱MOCKER',
    inspectStatus: 'APPROVED', status: 'ELIGIBLE', userLock: false,
    useGroupBidAmt: true, bidAmt: 70,
  }
  return {
    get putCalls() { return putCalls },
    getCampaigns: async () => [{ nccCampaignId: 'cmp-runtime', name: '파워링크#1', status: 'ELIGIBLE' }],
    getAdGroups: async () => [{ nccAdgroupId: 'grp-runtime-1', bidAmt: 70, status: 'ELIGIBLE' }],
    getKeywords: async () => [remote],
    estimateExposureMinimumBids: async () => [{
      keyword: '가상앱MOCKER', device: 'MOBILE' as const, period: 'MONTH' as const,
      bid: 170, raw: { keyword: '가상앱MOCKER', bid: 170 },
    }],
    bulkUpdateBids: async (updates: Array<{ bidAmt: number }>) => {
      putCalls++
      remote = { ...remote, bidAmt: updates[0].bidAmt, useGroupBidAmt: false }
      return [remote]
    },
    verifyBidUpdates: async (updates: Array<{ bidAmt: number }>) => ({
      verified: remote.bidAmt === updates[0].bidAmt && remote.useGroupBidAmt === false,
      checked: 1, mismatches: [], groups: new Map([['grp-runtime-1', [remote]]]),
    }),
  }
}

describe('production auto-bid runtime', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-09-07T10:00:00Z'))
  })
  afterEach(() => vi.useRealTimers())

  it('immediately applies a scoped streaming decision from a fresh competitor observation', async () => {
    const { db } = await fixture()
    const provider = fakeProvider()
    const runtime = new ProductionAutoBidRuntime(db, provider as unknown as NaverProvider, {
      observe: async (keyword, device) => ({ keyword, device, status: 'found', rank: 7,
        visibleAds: 8, legalCompetitorPresent: true, legalCompetitorCount: 1, legalCompetitors: [],
        source: 'mobile_ad_only', latencyMs: 1, observedAt: new Date().toISOString() }),
    })
    const value = { ...config('live'), strategy: 'observed_rank' as const,
      keywordIds: ['nkw-runtime-1'], rankConfirmationReads: 1 as const, skipRetention: true }
    expect(await runtime.snapshot(context(value, 'snapshot'))).toMatchObject({ recorded: 1 })
    await runtime.estimate(context(value, 'estimate'))
    expect(await runtime.decide(context({ ...value, legalCompetitorsOnly: true }, 'decide')))
      .toMatchObject({ changesProposed: 1 })
    expect(await runtime.apply(context(value, 'apply'))).toMatchObject({ applied: 1 })
    expect(await runtime.verify(context(value, 'verify'))).toMatchObject({ verified: true })
    expect(provider.putCalls).toBe(1)
  })

  it('caps an older keyword ceiling at the lower run-level ceiling', async () => {
    const { db } = await fixture()
    await db.update(naverAutoBidKeywordPolicies).set({ bidCeiling: 4000 })
    const runtime = new ProductionAutoBidRuntime(db, fakeProvider() as unknown as NaverProvider)
    const value = { ...config('dry-run'), ceiling: 3000, keywordIds: ['nkw-runtime-1'] }
    await runtime.snapshot(context(value, 'snapshot'))
    const [row] = await db.select().from(naverAutoBidDecisions)
    expect(row.raw).toMatchObject({ effectivePolicy: { ceiling: 3000 } })
  })

  it.each([
    ['outside', 70, 1070], ['outside', 3500, 3500], ['outside', 4000, 4000],
    ['no_ads', 70, 70], ['found', 70, 170],
  ] as const)('fast acquisition %s at %i produces %i', async (status, bid, expected) => {
    const { db } = await fixture()
    const runtime = new ProductionAutoBidRuntime(db, fakeProvider() as unknown as NaverProvider, {
      observe: async (keyword, device) => ({ keyword, device, status, rank: status === 'found' ? 7 : null,
        visibleAds: status === 'no_ads' ? 0 : 8, legalCompetitorPresent: status !== 'no_ads',
        legalCompetitorCount: 1, legalCompetitors: [], source: 'mobile_ad_only', latencyMs: 1,
        observedAt: new Date().toISOString() }),
    })
    const value = { ...config('live'), strategy: 'observed_rank' as const, ceiling: 4000,
      fastAcquire4000: true, rankConfirmationReads: 1 as const, skipRetention: true }
    await runtime.snapshot(context(value, 'snapshot'))
    await db.update(naverAutoBidDecisions).set({ beforeBid: bid })
    await runtime.estimate(context(value, 'estimate'))
    await runtime.decide(context(value, 'decide'))
    const [row] = await db.select().from(naverAutoBidDecisions)
    expect(row.targetBid ?? row.beforeBid).toBe(expected)
    if (status === 'outside' && bid > 1500) {
      expect(row).toMatchObject({ status: 'skipped', reason: 'unexposed_above_1500_hold' })
      expect(row.raw).toMatchObject({ evidenceState: 'UNEXPOSED' })
    }
  })

  it('skips a settling keyword without blocking others, then rechecks it when due', async () => {
    const { db } = await fixture()
    const requested: string[] = []
    const runtime = new ProductionAutoBidRuntime(db, fakeProvider() as unknown as NaverProvider, {
      observe: async (keyword, device) => {
        requested.push(keyword)
        return { keyword, device, status: 'found', rank: 2, visibleAds: 3,
          legalCompetitorPresent: false, legalCompetitorCount: 0, legalCompetitors: [],
          source: 'mobile_ad_only', latencyMs: 1, observedAt: new Date().toISOString() }
      },
    })
    const value = { ...config('dry-run'), strategy: 'observed_rank' as const, runKey: 'settlement-queue', rankCheckLimit: 1 }
    await runtime.snapshot(context(value, 'snapshot'))
    const [first] = await db.select().from(naverAutoBidDecisions)
    await db.update(naverAutoBidDecisions).set({ raw: { ...first.raw,
      lastBidChangedAt: new Date().toISOString(),
    } }).where(eq(naverAutoBidDecisions.id, first.id))
    await db.insert(naverAutoBidDecisions).values({ ...first, id: undefined, naverKeywordId: 'other-keyword',
      raw: { ...first.raw, keyword: '다른 키워드' },
    })
    await db.insert(naverAutoBidKeywordPolicies).values({ firmId: 701, naverAdgroupId: 'grp-runtime-1',
      naverKeywordId: 'other-keyword', keyword: '다른 키워드', enabled: true })
    expect(await runtime.estimate(context(value, 'estimate'))).toMatchObject({ observed: 1, deferred: 1 })
    expect(requested).toEqual(['다른 키워드'])
    const [waiting] = await db.select().from(naverAutoBidDecisions).where(eq(naverAutoBidDecisions.id, first.id))
    expect(waiting.reason).toBe('bid_settlement_pending')
    vi.setSystemTime(new Date(Date.now() + 180_000))
    await db.update(naverAutoBidDecisions).set({ status: 'planned' }).where(eq(naverAutoBidDecisions.id, first.id))
    // The first completed observation still consumes this run's limit when resumed.
    expect(await runtime.estimate(context({ ...value, rankCheckLimit: 2 }, 'estimate')))
      .toMatchObject({ observed: 1, reused: 1 })
    expect(requested).toEqual(['다른 키워드', '가상앱MOCKER'])
  })

  it('selects an unobserved keyword before a recently observed one despite sync timestamps', async () => {
    const { db } = await fixture()
    const requested: string[] = []
    const runtime = new ProductionAutoBidRuntime(db, fakeProvider() as unknown as NaverProvider, {
      observe: async (keyword, device) => {
        requested.push(keyword)
        return { keyword, device, status: 'found', rank: 2, visibleAds: 3,
          legalCompetitorPresent: false, legalCompetitorCount: 0, legalCompetitors: [],
          source: 'mobile_ad_only', latencyMs: 1, observedAt: new Date().toISOString() }
      },
    })
    const value = { ...config('dry-run'), strategy: 'observed_rank' as const, runKey: 'fair-order', rankCheckLimit: 1 }
    await runtime.snapshot(context(value, 'snapshot'))
    const [first] = await db.select().from(naverAutoBidDecisions)
    await db.update(naverAutoBidDecisions).set({ raw: { ...first.raw,
      rankPolicyUpdatedAt: '2026-09-01T00:00:00Z',
      priorRankState: { observedAt: '2026-09-07T09:59:00Z' },
    } }).where(eq(naverAutoBidDecisions.id, first.id))
    await db.insert(naverAutoBidDecisions).values({ ...first, id: undefined, naverKeywordId: 'never-observed',
      raw: { ...first.raw, keyword: '미조회 키워드', rankPolicyUpdatedAt: '2026-09-07T10:00:00Z',
        priorRankState: { observedAt: null } },
    })
    await db.insert(naverAutoBidKeywordPolicies).values({ firmId: 701, naverAdgroupId: 'grp-runtime-1',
      naverKeywordId: 'never-observed', keyword: '미조회 키워드', enabled: true })
    expect(await runtime.estimate(context(value, 'estimate'))).toMatchObject({ observed: 1, deferred: 1 })
    expect(requested).toEqual(['미조회 키워드'])
  })

  it('records after-hours visibility but excludes it from bid decisions', async () => {
    const { db } = await fixture()
    const provider = fakeProvider()
    const runtime = new ProductionAutoBidRuntime(db, provider as unknown as NaverProvider, {
      observe: async (keyword, device) => ({ keyword, device, status: 'outside', rank: null,
        visibleAds: 4, legalCompetitorPresent: true, legalCompetitorCount: 1, legalCompetitors: [],
        source: 'mobile_ad_only', latencyMs: 1, observedAt: '2026-09-07T13:00:00Z' }),
    })
    const value = { ...config('dry-run'), strategy: 'observed_rank' as const, runKey: 'after-hours' }
    await runtime.snapshot(context(value, 'snapshot'))
    await runtime.estimate(context(value, 'estimate'))
    expect(await runtime.decide(context(value, 'decide'))).toMatchObject({ changesProposed: 0 })
    const [row] = await db.select().from(naverAutoBidDecisions)
    expect(row.reason).toBe('rank_observation_outside_schedule')
    expect(row.raw).toMatchObject({ rankObservation: { status: 'outside', biddingEligible: false } })
  })

  it('rechecks the schedule before applying a previously planned bid', async () => {
    const { db } = await fixture()
    const provider = fakeProvider()
    const runtime = new ProductionAutoBidRuntime(db, provider as unknown as NaverProvider)
    const value = { ...config('live'), strategy: 'observed_rank' as const, runKey: 'apply-after-close' }
    await runtime.snapshot(context(value, 'snapshot'))
    await db.update(naverAutoBidDecisions).set({ targetBid: 170, status: 'planned' })
    vi.setSystemTime(new Date('2026-09-07T13:00:00Z'))
    await expect(runtime.apply(context(value, 'apply'))).rejects.toThrow('outside configured bidding schedule')
    expect(provider.putCalls).toBe(0)
  })

  it('does not write a stale planned bid while the latest change is settling', async () => {
    const { db } = await fixture()
    const provider = fakeProvider()
    const runtime = new ProductionAutoBidRuntime(db, provider as unknown as NaverProvider)
    const value = { ...config('live'), strategy: 'observed_rank' as const, runKey: 'pending-apply' }
    await runtime.snapshot(context(value, 'snapshot'))
    const [row] = await db.select().from(naverAutoBidDecisions)
    await db.update(naverAutoBidDecisions).set({ targetBid: 170, status: 'planned',
      raw: { ...row.raw, rankObservation: { observedAt: new Date().toISOString() } },
    })
    await db.update(naverAutoBidKeywordPolicies).set({ lastChangedAt: new Date(), lastObservedBid: 70 })
    expect(await runtime.apply(context(value, 'apply'))).toMatchObject({ applied: 0 })
    expect(provider.putCalls).toBe(0)
    const [after] = await db.select().from(naverAutoBidDecisions)
    expect(after.reason).toBe('bid_settlement_or_stale_observation')
  })
  it('refuses a queued mutation after the master switch is disabled', async () => {
    const {db}=await fixture(); const provider=fakeProvider()
    const runtime=new ProductionAutoBidRuntime(db,provider as unknown as NaverProvider)
    const value={...config('live'),strategy:'observed_rank' as const,runKey:'master-stopped'}
    await runtime.snapshot(context(value,'snapshot'))
    await db.update(naverAutoBidPolicies).set({enabled:false})
    await expect(runtime.apply(context(value,'apply'))).rejects.toThrow('master switch is disabled')
    expect(provider.putCalls).toBe(0)
  })

  it.each(['keyword','group','ceiling','stale'] as const)('refuses changed %s controls before applying', async kind => {
    const {db}=await fixture(); const provider=fakeProvider()
    const runtime=new ProductionAutoBidRuntime(db,provider as unknown as NaverProvider)
    const value={...config('live'),strategy:'observed_rank' as const,runKey:'control-'+kind}
    await runtime.snapshot(context(value,'snapshot'))
    const [row]=await db.select().from(naverAutoBidDecisions)
    await db.update(naverAutoBidDecisions).set({targetBid:170,status:'planned',raw:{...row.raw,rankObservation:{observedAt:new Date(Date.now()-(kind==='stale'?31000:0)).toISOString()}}})
    await db.update(naverAutoBidKeywordPolicies).set({lastObservedBid:70,...(kind==='keyword'?{enabled:false}:{})})
    if(kind==='group')await db.update(naverAutoBidGroupPolicies).set({enabled:false})
    if(kind==='ceiling')await db.update(naverAutoBidPolicies).set({bidCeiling:100})
    expect(await runtime.apply(context(value,'apply'))).toMatchObject({applied:0})
    expect(provider.putCalls).toBe(0)
  })

  it('reports failed rank reads as partial even though they were skipped for bidding', async () => {
    const { db } = await fixture()
    const runtime = new ProductionAutoBidRuntime(db, fakeProvider() as unknown as NaverProvider, {
      observe: async () => { throw new Error('request timeout') },
    })
    const value = { ...config('dry-run'), strategy: 'observed_rank' as const, runKey: 'failed-observation' }
    await runtime.snapshot(context(value, 'snapshot'))
    await runtime.estimate(context(value, 'estimate'))
    await runtime.decide(context(value, 'decide'))
    expect(await runtime.report(context(value, 'report'))).toMatchObject({
      status: 'partial', failed: 1, observationFailures: 1,
    })
    const [run] = await db.select().from(naverAutoBidRuns)
    expect(run).toMatchObject({ status: 'partial', failedCount: 1, skippedCount: 0 })
  })
  it('runs a complete dry-run without any provider PUT', async () => {
    const { db } = await fixture()
    const provider = fakeProvider()
    const runtime = new ProductionAutoBidRuntime(db, provider as unknown as NaverProvider)
    const value = config('dry-run')

    await runtime.snapshot(context(value, 'snapshot'))
    await runtime.estimate(context(value, 'estimate'))
    const decided = await runtime.decide(context(value, 'decide')) as { changesProposed: number }
    await runtime.verify(context(value, 'verify'))
    const report = await runtime.report(context(value, 'report')) as { status: string }

    expect(decided.changesProposed).toBe(1)
    expect(provider.putCalls).toBe(0)
    expect(report.status).toBe('completed')
    const [run] = await db.select().from(naverAutoBidRuns)
    expect(run.changedCount).toBe(1)
    const rows = await db.select().from(naverAutoBidDecisions)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ beforeBid: 70, estimatedBid: 170, targetBid: 170, status: 'planned' })
  })

  it('applies a bounded live raise and verifies the provider read-back', async () => {
    const { db } = await fixture()
    const provider = fakeProvider()
    const runtime = new ProductionAutoBidRuntime(db, provider as unknown as NaverProvider)
    const value = config('live')

    await runtime.snapshot(context(value, 'snapshot'))
    await runtime.estimate(context(value, 'estimate'))
    await runtime.decide(context(value, 'decide'))
    const applied = await runtime.apply(context(value, 'apply')) as { applied: number }
    const verified = await runtime.verify(context(value, 'verify')) as { verified: boolean }
    await runtime.report(context(value, 'report'))

    expect(applied.applied).toBe(1)
    expect(provider.putCalls).toBe(1)
    expect(verified.verified).toBe(true)
    const rows = await db.select().from(naverAutoBidDecisions)
    expect(rows[0]).toMatchObject({ status: 'verified', beforeBid: 70, targetBid: 170, afterBid: 170,
      afterUseGroupBid: false, verificationStatus: 'passed' })
    const [afterAction] = await db.select().from(naverAutoBidKeywordPolicies)
    expect(afterAction.raw).toMatchObject({ lastBidAction: {
      decisionId: rows[0].id, beforeBid: 70, afterBid: 170, device: 'mobile',
    } })
    const observer: RankObserver = {
      observe: async (keyword, device) => ({ keyword, device, status: 'found', rank: 2,
        visibleAds: 4, legalCompetitorPresent: true, legalCompetitorCount: 1, legalCompetitors: [],
        source: 'mobile_ad_only', latencyMs: 1, observedAt: new Date(Date.now() + 60_000).toISOString() }),
    }
    const nextRuntime = new ProductionAutoBidRuntime(db, provider as unknown as NaverProvider, observer)
    const next = { ...config('dry-run'), strategy: 'observed_rank' as const, runKey: 'after-action' }
    vi.setSystemTime(new Date(Date.now() + 180_000))
    await nextRuntime.snapshot(context(next, 'snapshot'))
    await nextRuntime.estimate(context(next, 'estimate'))
    const [afterObservation] = await db.select().from(naverAutoBidKeywordPolicies)
    expect(afterObservation.raw).toMatchObject({ bidOutcomes: [{
      decisionId: rows[0].id, beforeBid: 70, afterBid: 170, latestRank: 2, targetHits: 1,
    }] })
    await syncAutoBidAccount(db, provider as unknown as NaverProvider, 701)
    const [afterSync] = await db.select().from(naverAutoBidKeywordPolicies)
    expect(afterSync.raw).toMatchObject({
      lastBidAction: { decisionId: rows[0].id },
      bidOutcomes: [{ decisionId: rows[0].id, targetHits: 1 }],
      remote: { bidAmt: 170 },
    })
  })

  it('uses an actual observed rank instead of an estimated bid', async () => {
    const { db } = await fixture()
    await db.update(naverAutoBidKeywordPolicies).set({
      lastObservedStatus: 'found', lastObservedRank: 6, lastObservedBid: 70,
      legalCompetitorCount: 0, consecutiveStatusCount: 2,
      observationCount: 2, foundCount: 2,
      observationWindow: [
        { at: '2026-09-07T09:58:00.000Z', bid: 70, status: 'found', rank: 6,
          visibleAds: 8, legalCompetitorCount: 0, targetPosition: 3 },
        { at: '2026-09-07T09:59:00.000Z', bid: 70, status: 'found', rank: 6,
          visibleAds: 8, legalCompetitorCount: 0, targetPosition: 3 },
      ],
    }).where(eq(naverAutoBidKeywordPolicies.naverKeywordId, 'nkw-runtime-1'))
    const provider = fakeProvider()
    const rankObserver: RankObserver = {
      observe: async (keyword, device) => ({
        keyword, device, status: 'found', rank: 6, visibleAds: 8,
        legalCompetitorPresent: true, legalCompetitorCount: 1,
        legalCompetitors: [{ position: 1, advertiser: '법무법인 경쟁', displayUrl: 'other.test', title: '경쟁', adId: null }],
        source: 'mobile_ad_only', latencyMs: 25,
        observedAt: '2026-09-07T10:00:00.000Z',
      }),
    }
    const runtime = new ProductionAutoBidRuntime(db, provider as unknown as NaverProvider, rankObserver)
    const value = { ...config('dry-run'), strategy: 'observed_rank' as const, runKey: 'observed-rank' }

    await runtime.snapshot(context(value, 'snapshot'))
    const observed = await runtime.estimate(context(value, 'estimate')) as { observed: number }
    const decided = await runtime.decide(context(value, 'decide')) as { changesProposed: number }

    expect(observed.observed).toBe(1)
    expect(decided.changesProposed).toBe(1)
    expect(provider.putCalls).toBe(0)
    const [row] = await db.select().from(naverAutoBidDecisions)
    expect(row).toMatchObject({ beforeBid: 70, estimatedBid: null, targetBid: 170, status: 'planned' })
    expect(row.raw).toMatchObject({ rankObservation: { status: 'found', rank: 6 } })
    expect(row.raw).not.toHaveProperty('priorRankState')
    const [policy] = await db.select().from(naverAutoBidKeywordPolicies)
    expect(policy).toMatchObject({ lastObservedRank: 6, lastObservedStatus: 'found',
      legalCompetitorPresent: true, legalCompetitorCount: 1, observationCount: 3,
      bidLearning: { phase: 'acquire', recommendedBid: 170 },
      raw: { lastRankObservation: { status: 'found', rank: 6, visibleAds: 8 } } })
    const [event] = await db.select().from(naverAutoBidEvents)
    expect(event).toMatchObject({ eventType: 'rank_observation', beforeRank: 6, targetPosition: 3 })
    const repeated = await runtime.estimate(context(value, 'estimate'))
    expect(repeated).toMatchObject({ observed: 0, reused: 1 })
    const [unchanged] = await db.select().from(naverAutoBidKeywordPolicies)
    expect(unchanged.observationCount).toBe(3)
  })

  it('persists the first batch before starting the next 250 observations', async () => {
    const { db } = await fixture()
    const provider = fakeProvider()
    let calls = 0
    let checkpointCount = 0
    const observer: RankObserver = {
      observe: async (keyword, device) => {
        calls++
        if (calls === 251) {
          const saved = await db.select().from(naverAutoBidDecisions)
          checkpointCount = saved.filter(row => row.reason === 'observed_found').length
        }
        return { keyword, device, status: 'found', rank: 2, visibleAds: 3,
          legalCompetitorPresent: false, legalCompetitorCount: 0, legalCompetitors: [],
          source: 'mobile_ad_only', latencyMs: 1, observedAt: '2026-09-07T10:00:00.000Z' }
      },
    }
    const runtime = new ProductionAutoBidRuntime(db, provider as unknown as NaverProvider, observer)
    const value = { ...config('dry-run'), strategy: 'observed_rank' as const, runKey: 'checkpoint' }
    await runtime.snapshot(context(value, 'snapshot'))
    const [template] = await db.select().from(naverAutoBidDecisions)
    await db.insert(naverAutoBidDecisions).values(Array.from({ length: 250 }, (_, index) => ({
      ...template, id: undefined, naverKeywordId: `checkpoint-${index}`,
    })))
    expect(await runtime.estimate(context(value, 'estimate'))).toMatchObject({ observed: 251, failed: 0 })
    expect(checkpointCount).toBe(250)
  })
})
