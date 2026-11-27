import { describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTestDb } from '../../../tests/helpers/test-db'
import {
  firmAdEntities,
  firmKeywords,
  firms,
  keywords,
  naverAutoBidDecisions,
  naverAutoBidRuns,
} from '@/lib/db/schema'
import {
  getNaverAutoBidPolicy,
  listNaverAutoBidDecisions,
  recordNaverAutoBidDecision,
  startNaverAutoBidRun,
  updateNaverAutoBidDecision,
  updateNaverAutoBidRun,
  upsertNaverAutoBidPolicy,
  NaverAutoBidConcurrencyError,
  NaverAutoBidScopeError,
} from '../src/repository'

const firmValues = (id: number) => ({
  id,
  slug: `auto-bid-${id}`,
  name: `Auto Bid Firm ${id}`,
  adLawyerName: 'Test Lawyer',
  phone: '02-0000-0000',
  phoneIntl: '+82-2-0000-0000',
  address: 'Seoul',
  addressRegion: 'Seoul',
  addressLocality: 'Jung-gu',
})

describe('Naver automatic-bid persistence', () => {
  it('upserts one firm policy while preserving explicit dry-run bounds', async () => {
    const db = await createTestDb()
    await db.insert(firms).values([firmValues(201), firmValues(202)])

    const first = await upsertNaverAutoBidPolicy(db, {
      firmId: 201,
      floor: 70,
      ceiling: 800,
      stepUp: 100,
      exposureBuffer: 10,
      cooldownHours: 6,
      batchSize: 50,
      maxChanges: 10,
      raw: { operator: 'test' },
      updatedAt: '2026-09-07T01:00:00Z',
    })
    expect(first).toMatchObject({ inserted: true, updated: false })
    expect(first.policy).toMatchObject({
      firmId: 201,
      bidFloor: 70,
      bidCeiling: 800,
      strategy: 'observed_rank',
      cooldownMinutes: 360,
      maxChangesPerRun: 10,
      raw: { operator: 'test' },
    })

    const replay = await upsertNaverAutoBidPolicy(db, {
      firmId: 201,
      minimumBid: 80,
      maximumBid: 900,
      cooldownMs: 2 * 60 * 60 * 1_000,
      maxChangesPerRun: null,
    })
    expect(replay).toMatchObject({ inserted: false, updated: true })
    expect(replay.policy).toMatchObject({ bidFloor: 80, bidCeiling: 900, cooldownMinutes: 120, maxChangesPerRun: null })
    expect(await getNaverAutoBidPolicy(db, 201)).toMatchObject({ id: replay.policy.id, firmId: 201 })
    expect(await db.select().from(naverAutoBidRuns)).toHaveLength(0)
  })

  it('makes run keys idempotent, keeps firms isolated, and refuses overlap', async () => {
    const db = await createTestDb()
    await db.insert(firms).values([firmValues(211), firmValues(212)])

    const first = await startNaverAutoBidRun(db, {
      firmId: 211,
      runKey: 'same-key',
      dryRun: true,
      raw: { stage: 'snapshot' },
      startedAt: new Date(),
    })
    const replay = await startNaverAutoBidRun(db, {
      firmId: 211,
      runKey: 'same-key',
      dryRun: true,
    })
    expect(replay).toMatchObject({ inserted: false, reused: true, run: { id: first.run.id } })

    const otherFirm = await startNaverAutoBidRun(db, { firmId: 212, runKey: 'same-key' })
    expect(otherFirm.inserted).toBe(true)
    await expect(startNaverAutoBidRun(db, { firmId: 211, runKey: 'other-key' }))
      .rejects.toBeInstanceOf(NaverAutoBidConcurrencyError)

    const completed = await updateNaverAutoBidRun(db, {
      firmId: 211,
      runId: first.run.id,
      status: 'completed',
      verificationStatus: 'passed',
      verifiedAt: '2026-09-07T01:15:00Z',
      finishedAt: '2026-09-07T01:16:00Z',
    })
    expect(completed.run).toMatchObject({
      status: 'completed',
      activeKey: null,
      verificationStatus: 'passed',
      error: null,
    })
    const next = await startNaverAutoBidRun(db, { firmId: 211, runKey: 'other-key' })
    expect(next.inserted).toBe(true)
    expect(await db.select().from(naverAutoBidRuns).where(eq(naverAutoBidRuns.firmId, 211))).toHaveLength(2)
  })

  it('recovers a stale firm lease after the process disappeared', async () => {
    const db = await createTestDb()
    await db.insert(firms).values(firmValues(213))
    const stale = await startNaverAutoBidRun(db, {
      firmId: 213,
      runKey: 'stale-run',
      startedAt: new Date(Date.now() - 4 * 60 * 60 * 1000),
    })
    await db.update(naverAutoBidRuns).set({
      heartbeatAt: new Date(Date.now() - 4 * 60 * 60 * 1000),
    }).where(eq(naverAutoBidRuns.id, stale.run.id))

    const next = await startNaverAutoBidRun(db, { firmId: 213, runKey: 'fresh-run' })
    expect(next.inserted).toBe(true)
    const rows = await db.select().from(naverAutoBidRuns).where(eq(naverAutoBidRuns.firmId, 213))
    expect(rows.find((row) => row.id === stale.run.id)).toMatchObject({
      status: 'failed', activeKey: null, error: 'stale auto-bid lease recovered',
    })
  })

  it('upserts a decision through apply and read-back verification', async () => {
    const db = await createTestDb()
    await db.insert(firms).values(firmValues(221))
    const [keyword] = await db.insert(keywords).values({
      firmId: 221,
      name: '테스트 키워드',
      normalizedName: '테스트 키워드',
      slug: 'auto-bid-keyword-221',
      scamType: 'coin',
    }).returning()
    const [firmKeyword] = await db.insert(firmKeywords).values({
      firmId: 221,
      keywordId: keyword.id,
      status: 'live',
      adDesired: true,
    }).returning()
    const [entity] = await db.insert(firmAdEntities).values({
      firmId: 221,
      entityType: 'keyword',
      keywordId: keyword.id,
      naverId: 'ncc-keyword-221',
      reviewStatus: 'approved',
      raw: { nccKeywordId: 'ncc-keyword-221' },
    }).returning()
    const run = await startNaverAutoBidRun(db, { firmId: 221, runKey: 'decision-run' })

    const planned = await recordNaverAutoBidDecision(db, {
      firmId: 221,
      runId: run.run.id,
      keywordId: keyword.id,
      firmKeywordId: firmKeyword.id,
      firmAdEntityId: entity.id,
      naverKeywordId: entity.naverId,
      beforeBid: 300,
      estimatedBid: 500,
      targetBid: 500,
      reason: 'bid increase',
      cooldownUntil: '2026-09-07T07:00:00Z',
      raw: { estimate: { minimumBid: 490 } },
    })
    expect(planned.inserted).toBe(true)
    expect(planned.decision).toMatchObject({ status: 'planned', beforeBid: 300, afterBid: null })

    const applied = await recordNaverAutoBidDecision(db, {
      firmId: 221,
      runId: run.run.id,
      naverKeywordId: entity.naverId,
      status: 'applied',
      targetBid: 500,
      afterBid: 500,
      appliedAt: '2026-09-07T01:05:00Z',
      requestRaw: { bidAmt: 500 },
      responseRaw: { ok: true },
    })
    expect(applied).toMatchObject({ inserted: false, updated: true, decision: { id: planned.decision.id } })
    expect(applied.decision).toMatchObject({ beforeBid: 300, afterBid: 500, status: 'applied' })

    const verified = await updateNaverAutoBidDecision(db, {
      firmId: 221,
      decisionId: planned.decision.id,
      status: 'verified',
      verificationStatus: 'passed',
      verifiedAt: '2026-09-07T01:06:00Z',
      verificationRaw: { observedBidAmt: 500, useGroupBidAmt: false },
      afterUseGroupBid: false,
    })
    expect(verified.decision).toMatchObject({
      status: 'verified',
      verificationStatus: 'passed',
      afterBid: 500,
      afterUseGroupBid: false,
      verificationRaw: { observedBidAmt: 500, useGroupBidAmt: false },
    })
    expect(await listNaverAutoBidDecisions(db, { firmId: 221, runId: run.run.id })).toHaveLength(1)
  })

  it('rejects decision links and run IDs outside the requested firm', async () => {
    const db = await createTestDb()
    await db.insert(firms).values([firmValues(231), firmValues(232)])
    const run = await startNaverAutoBidRun(db, { firmId: 231, runKey: 'scope-run' })

    await expect(recordNaverAutoBidDecision(db, {
      firmId: 232,
      runId: run.run.id,
      naverKeywordId: 'cross-firm-keyword',
    })).rejects.toBeInstanceOf(NaverAutoBidScopeError)
    await expect(listNaverAutoBidDecisions(db, { firmId: 232, runId: run.run.id }))
      .rejects.toBeInstanceOf(NaverAutoBidScopeError)
  })
})
