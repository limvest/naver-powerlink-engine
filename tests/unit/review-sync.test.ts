import { describe, it, expect, vi } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { createTestDb } from '../helpers/test-db'
import { firms, keywords, firmKeywords, firmAdEntities } from '@/lib/db/schema'
import { DEFAULT_FIRM } from '@/lib/engine/firms'
import type { AdApi } from '@/lib/engine/register-run'
import { applyReviewResults, pauseBlockedKeywords, type ReviewResult } from '@/lib/engine/review-sync'

async function seedFirm(db: Awaited<ReturnType<typeof createTestDb>>) {
  await db.insert(firms).values({
    id: 1, slug: 'sampletwo', name: DEFAULT_FIRM.name, adLawyerName: DEFAULT_FIRM.adLawyerName,
    phone: DEFAULT_FIRM.phone, phoneIntl: DEFAULT_FIRM.phoneIntl, address: DEFAULT_FIRM.address,
    addressRegion: DEFAULT_FIRM.addressRegion, addressLocality: DEFAULT_FIRM.addressLocality,
    domain: DEFAULT_FIRM.domain,
  })
}

// keyword 2개(kw-a, kw-b) — 각각 firm_keywords.status='ad_registered' + keyword·ad 엔티티(pending, 결정적 naverId).
// register-run.ts가 성공 등록 후 남기는 모양(⑥ ad_pending→ad_registered 직후 상태)을 그대로 재현.
async function seedRegisteredKeywords(db: Awaited<ReturnType<typeof createTestDb>>) {
  await seedFirm(db)
  const kws = await db.insert(keywords).values([
    { name: '업체가', slug: 'kw-a', scamType: 'coin', status: 'published' },
    { name: '업체나', slug: 'kw-b', scamType: 'coin', status: 'published' },
  ]).returning()
  await db.insert(firmKeywords).values(kws.map((k) => ({ firmId: 1, keywordId: k.id, status: 'ad_registered' })))
  await db.insert(firmAdEntities).values(
    kws.flatMap((k) => [
      { firmId: 1, entityType: 'keyword', keywordId: k.id, naverId: `nk-${k.slug}`, reviewStatus: 'pending' },
      { firmId: 1, entityType: 'ad', keywordId: k.id, naverId: `na-${k.slug}`, reviewStatus: 'pending' },
    ]),
  )
  return kws
}

async function loadFirmKeyword(db: Awaited<ReturnType<typeof createTestDb>>, keywordId: string) {
  const [row] = await db.select().from(firmKeywords)
    .where(and(eq(firmKeywords.firmId, 1), eq(firmKeywords.keywordId, keywordId)))
  return row
}

describe('applyReviewResults', () => {
  it('① keyword의 keyword·ad 엔티티가 전부 approved → ad_registered→live', async () => {
    const db = await createTestDb()
    const [kwA, kwB] = await seedRegisteredKeywords(db)

    const results: ReviewResult[] = [
      { naverId: 'nk-kw-a', entityType: 'keyword', reviewStatus: 'approved' },
      { naverId: 'na-kw-a', entityType: 'ad', reviewStatus: 'approved' },
    ]
    const result = await applyReviewResults(db, 1, results)

    expect(result).toEqual({ updated: 2, wentLive: 1, wentRejected: 0 })

    const fkA = await loadFirmKeyword(db, kwA.id)
    expect(fkA.status).toBe('live')
    expect(fkA.lastError).toBeNull()

    // 손대지 않은 kw-b는 그대로 ad_registered 유지
    const fkB = await loadFirmKeyword(db, kwB.id)
    expect(fkB.status).toBe('ad_registered')

    const entities = await db.select().from(firmAdEntities)
      .where(and(eq(firmAdEntities.firmId, 1), eq(firmAdEntities.keywordId, kwA.id)))
    expect(entities.every((e) => e.reviewStatus === 'approved')).toBe(true)
  })

  it('② ad 하나 rejected(사유 "표현 불가") → ad_registered→rejected + lastError 반영, keyword 엔티티는 approved로 갱신', async () => {
    const db = await createTestDb()
    const [, kwB] = await seedRegisteredKeywords(db)

    const results: ReviewResult[] = [
      { naverId: 'nk-kw-b', entityType: 'keyword', reviewStatus: 'approved' },
      { naverId: 'na-kw-b', entityType: 'ad', reviewStatus: 'rejected', reason: '표현 불가' },
    ]
    const result = await applyReviewResults(db, 1, results)

    expect(result).toEqual({ updated: 2, wentLive: 0, wentRejected: 1 })

    const fkB = await loadFirmKeyword(db, kwB.id)
    expect(fkB.status).toBe('rejected')
    expect(fkB.lastError).toBe('표현 불가')

    const [adEntity] = await db.select().from(firmAdEntities)
      .where(and(eq(firmAdEntities.firmId, 1), eq(firmAdEntities.naverId, 'na-kw-b')))
    expect(adEntity.reviewStatus).toBe('rejected')
    expect(adEntity.rejectReason).toBe('표현 불가')

    const [keywordEntity] = await db.select().from(firmAdEntities)
      .where(and(eq(firmAdEntities.firmId, 1), eq(firmAdEntities.naverId, 'nk-kw-b')))
    expect(keywordEntity.reviewStatus).toBe('approved')
  })

  it('③ 모르는 naverId는 무시 — 매칭 없으면 카운트도 상태 변경도 없음', async () => {
    const db = await createTestDb()
    const [kwA] = await seedRegisteredKeywords(db)

    const results: ReviewResult[] = [
      { naverId: 'ghost-id', entityType: 'keyword', reviewStatus: 'approved' },
    ]
    const result = await applyReviewResults(db, 1, results)

    expect(result).toEqual({ updated: 0, wentLive: 0, wentRejected: 0 })

    const fkA = await loadFirmKeyword(db, kwA.id)
    expect(fkA.status).toBe('ad_registered')

    const entities = await db.select().from(firmAdEntities).where(eq(firmAdEntities.firmId, 1))
    expect(entities.every((e) => e.reviewStatus === 'pending')).toBe(true)
  })

  it('일부만 approved(나머지 pending)면 재판정하지 않고 ad_registered 유지', async () => {
    const db = await createTestDb()
    const [kwA] = await seedRegisteredKeywords(db)

    // keyword 엔티티만 approved, ad 엔티티는 응답 없이 pending 그대로
    const results: ReviewResult[] = [
      { naverId: 'nk-kw-a', entityType: 'keyword', reviewStatus: 'approved' },
    ]
    const result = await applyReviewResults(db, 1, results)

    expect(result).toEqual({ updated: 1, wentLive: 0, wentRejected: 0 })

    const fkA = await loadFirmKeyword(db, kwA.id)
    expect(fkA.status).toBe('ad_registered')
  })
})

describe('pauseBlockedKeywords', () => {
  // firm_keywords: kw-a(live, blocked) / kw-b(subscribed, blocked) / kw-c(live, 비차단)
  // kw-a·kw-c에는 adgroup 엔티티 부여(등록 완료 상태 재현), kw-b는 아직 등록 전이라 adgroup 없음.
  async function seedMixedSubscriptions(db: Awaited<ReturnType<typeof createTestDb>>) {
    await seedFirm(db)
    const kws = await db.insert(keywords).values([
      { name: '업체가', slug: 'kw-a', scamType: 'coin', status: 'published' },
      { name: '업체나', slug: 'kw-b', scamType: 'coin', status: 'published' },
      { name: '업체다', slug: 'kw-c', scamType: 'coin', status: 'published' },
    ]).returning()
    const [kwA, kwB, kwC] = kws
    await db.insert(firmKeywords).values([
      { firmId: 1, keywordId: kwA.id, status: 'live' },
      { firmId: 1, keywordId: kwB.id, status: 'subscribed' },
      { firmId: 1, keywordId: kwC.id, status: 'live' },
    ])
    await db.insert(firmAdEntities).values([
      { firmId: 1, entityType: 'adgroup', keywordId: kwA.id, naverId: 'ag-a' },
      { firmId: 1, entityType: 'adgroup', keywordId: kwC.id, naverId: 'ag-c' },
    ])
    return { kwA, kwB, kwC }
  }

  it('blocked slug(live·subscribed)만 paused 전이 + adgroup 중지 API 호출, 비차단은 무변경', async () => {
    const db = await createTestDb()
    const { kwA, kwB, kwC } = await seedMixedSubscriptions(db)

    const calls: { method: string; path: string; body?: unknown }[] = []
    const api: AdApi = {
      request: vi.fn(async (method: string, path: string, opts?: { body?: unknown }) => {
        calls.push({ method, path, body: opts?.body })
        return {}
      }),
    }

    const result = await pauseBlockedKeywords(db, api, 1, new Set(['kw-a', 'kw-b']))

    expect(result).toEqual({ paused: 2 })

    const fkA = await loadFirmKeyword(db, kwA.id)
    const fkB = await loadFirmKeyword(db, kwB.id)
    const fkC = await loadFirmKeyword(db, kwC.id)
    expect(fkA.status).toBe('paused')
    expect(fkB.status).toBe('paused')
    expect(fkC.status).toBe('live') // 비차단 구독 무변경

    // kw-a는 adgroup 엔티티가 있어 PUT 호출됨, kw-b는 adgroup이 없어 호출 없음, kw-c는 애초 차단 대상이 아님
    expect(calls).toEqual([
      { method: 'PUT', path: '/ncc/adgroups/ag-a', body: { userLock: true } },
    ])
  })

  it('api가 null이면 상태만 내리고 API 호출은 없다 (dry 환경)', async () => {
    const db = await createTestDb()
    const { kwA, kwB, kwC } = await seedMixedSubscriptions(db)

    const result = await pauseBlockedKeywords(db, null, 1, new Set(['kw-a', 'kw-b']))

    expect(result).toEqual({ paused: 2 })

    const fkA = await loadFirmKeyword(db, kwA.id)
    const fkB = await loadFirmKeyword(db, kwB.id)
    const fkC = await loadFirmKeyword(db, kwC.id)
    expect(fkA.status).toBe('paused')
    expect(fkB.status).toBe('paused')
    expect(fkC.status).toBe('live')
  })

  it('blocked slug라도 상태머신상 paused로 갈 수 없으면(예: rejected) 건드리지 않는다', async () => {
    const db = await createTestDb()
    await seedFirm(db)
    const [kw] = await db.insert(keywords).values(
      { name: '업체라', slug: 'kw-d', scamType: 'coin', status: 'published' },
    ).returning()
    await db.insert(firmKeywords).values({ firmId: 1, keywordId: kw.id, status: 'rejected' })

    const result = await pauseBlockedKeywords(db, null, 1, new Set(['kw-d']))

    expect(result).toEqual({ paused: 0 })
    const fk = await loadFirmKeyword(db, kw.id)
    expect(fk.status).toBe('rejected')
  })

  it('blockedSlugs가 비어있으면 즉시 { paused: 0 } — 쿼리조차 하지 않는다', async () => {
    const db = await createTestDb()
    const { kwA } = await seedMixedSubscriptions(db)

    const result = await pauseBlockedKeywords(db, null, 1, new Set())

    expect(result).toEqual({ paused: 0 })
    const fkA = await loadFirmKeyword(db, kwA.id)
    expect(fkA.status).toBe('live')
  })
})
