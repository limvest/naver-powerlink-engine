import { describe, it, expect, vi } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { createTestDb } from '../helpers/test-db'
import { firms, keywords, firmKeywords } from '@/lib/db/schema'
import { DEFAULT_FIRM } from '@/lib/engine/firms'
import type { AdApi } from '@/lib/engine/register-run'
import { reconcileAds, computeReconcileCandidates, type ReconcileRow } from '@/lib/engine/reconcile-ads'

async function seedFirm(db: Awaited<ReturnType<typeof createTestDb>>, id: number, domain: string | null = null) {
  await db.insert(firms).values({
    id, slug: `firm-${id}`, name: `firm ${id}`, adLawyerName: 'x', phone: 'x', phoneIntl: 'x',
    address: 'x', addressRegion: 'x', addressLocality: 'x', domain,
  })
}

async function seedKeyword(db: Awaited<ReturnType<typeof createTestDb>>, slug: string) {
  const [kw] = await db.insert(keywords).values(
    { name: slug, slug, scamType: 'coin', status: 'published' },
  ).returning()
  return kw
}

async function seedFirmKeyword(
  db: Awaited<ReturnType<typeof createTestDb>>,
  opts: { firmId: number; keywordId: string; status: string; adDesired: boolean; naverAdgroupId?: string | null },
) {
  const [row] = await db.insert(firmKeywords).values({
    firmId: opts.firmId, keywordId: opts.keywordId, status: opts.status,
    adDesired: opts.adDesired, naverAdgroupId: opts.naverAdgroupId ?? null,
  }).returning()
  return row
}

async function loadFirmKeyword(db: Awaited<ReturnType<typeof createTestDb>>, firmId: number, keywordId: string) {
  const [row] = await db.select().from(firmKeywords)
    .where(and(eq(firmKeywords.firmId, firmId), eq(firmKeywords.keywordId, keywordId)))
  return row
}

function createFakeApi(opts: { fail?: Set<string> } = {}) {
  const calls: { method: string; path: string; body?: unknown; query?: Record<string, string> }[] = []
  const api: AdApi = {
    request: vi.fn(async (
      method: string, path: string, reqOpts?: { body?: unknown; query?: Record<string, string> },
    ) => {
      calls.push({ method, path, body: reqOpts?.body, query: reqOpts?.query })
      const naverId = path.split('/').pop()!
      if (opts.fail?.has(naverId)) throw new Error(`boom: userLock 갱신 실패 (${naverId})`)
      return {}
    }),
  }
  return { api, calls }
}

describe('reconcileAds', () => {
  it('① desired=false ∧ status∈{ad_registered, live} ∧ naverAdgroupId 존재 → PUT userLock:true + paused 전이, lowered++', async () => {
    const db = await createTestDb()
    await seedFirm(db, 1)
    const kwA = await seedKeyword(db, 'kw-a')
    const kwB = await seedKeyword(db, 'kw-b')
    await seedFirmKeyword(db, { firmId: 1, keywordId: kwA.id, status: 'ad_registered', adDesired: false, naverAdgroupId: 'ag-a' })
    await seedFirmKeyword(db, { firmId: 1, keywordId: kwB.id, status: 'live', adDesired: false, naverAdgroupId: 'ag-b' })

    const { api, calls } = createFakeApi()
    const result = await reconcileAds(db, api, DEFAULT_FIRM)

    expect(result).toEqual({ lowered: 2, raised: 0, skipped: 0 })
    expect(calls).toEqual(expect.arrayContaining([
      { method: 'PUT', path: '/ncc/adgroups/ag-a', query: { fields: 'userLock' }, body: { nccAdgroupId: 'ag-a', userLock: true } },
      { method: 'PUT', path: '/ncc/adgroups/ag-b', query: { fields: 'userLock' }, body: { nccAdgroupId: 'ag-b', userLock: true } },
    ]))
    expect(calls).toHaveLength(2)

    const fkA = await loadFirmKeyword(db, 1, kwA.id)
    const fkB = await loadFirmKeyword(db, 1, kwB.id)
    expect(fkA.status).toBe('paused')
    expect(fkA.lastError).toBeNull()
    expect(fkB.status).toBe('paused')
    expect(fkB.lastError).toBeNull()
  })

  it('② desired=true ∧ status=paused ∧ naverAdgroupId 존재 → PUT userLock:false + ad_registered 전이, raised++', async () => {
    const db = await createTestDb()
    await seedFirm(db, 1)
    const kw = await seedKeyword(db, 'kw-c')
    await seedFirmKeyword(db, { firmId: 1, keywordId: kw.id, status: 'paused', adDesired: true, naverAdgroupId: 'ag-c' })

    const { api, calls } = createFakeApi()
    const result = await reconcileAds(db, api, DEFAULT_FIRM)

    expect(result).toEqual({ lowered: 0, raised: 1, skipped: 0 })
    expect(calls).toEqual([
      { method: 'PUT', path: '/ncc/adgroups/ag-c', query: { fields: 'userLock' }, body: { nccAdgroupId: 'ag-c', userLock: false } },
    ])

    const fk = await loadFirmKeyword(db, 1, kw.id)
    expect(fk.status).toBe('ad_registered')
    expect(fk.lastError).toBeNull()
  })

  it('③ naverAdgroupId 없음(미등록 후보) → 상태 무변경·API 미호출, skipped++', async () => {
    const db = await createTestDb()
    await seedFirm(db, 1)
    const kwLower = await seedKeyword(db, 'kw-d')
    const kwRaise = await seedKeyword(db, 'kw-e')
    await seedFirmKeyword(db, { firmId: 1, keywordId: kwLower.id, status: 'ad_registered', adDesired: false, naverAdgroupId: null })
    await seedFirmKeyword(db, { firmId: 1, keywordId: kwRaise.id, status: 'paused', adDesired: true, naverAdgroupId: null })

    const { api, calls } = createFakeApi()
    const result = await reconcileAds(db, api, DEFAULT_FIRM)

    expect(result).toEqual({ lowered: 0, raised: 0, skipped: 2 })
    expect(calls).toHaveLength(0)

    const fkLower = await loadFirmKeyword(db, 1, kwLower.id)
    const fkRaise = await loadFirmKeyword(db, 1, kwRaise.id)
    expect(fkLower.status).toBe('ad_registered')
    expect(fkRaise.status).toBe('paused')
  })

  it('④ 그 외 조합(desired와 status가 이미 정합) → no-op, API 미호출·카운트 0', async () => {
    const db = await createTestDb()
    await seedFirm(db, 1)
    const kwUp = await seedKeyword(db, 'kw-f')     // 이미 올라가 있고 계속 원함
    const kwNever = await seedKeyword(db, 'kw-g')  // 등록된 적 없고 계속 원함
    const kwDown = await seedKeyword(db, 'kw-h')   // 이미 내려가 있고 계속 원치 않음
    await seedFirmKeyword(db, { firmId: 1, keywordId: kwUp.id, status: 'ad_registered', adDesired: true, naverAdgroupId: 'ag-f' })
    await seedFirmKeyword(db, { firmId: 1, keywordId: kwNever.id, status: 'subscribed', adDesired: true, naverAdgroupId: null })
    await seedFirmKeyword(db, { firmId: 1, keywordId: kwDown.id, status: 'paused', adDesired: false, naverAdgroupId: 'ag-h' })

    const { api, calls } = createFakeApi()
    const result = await reconcileAds(db, api, DEFAULT_FIRM)

    expect(result).toEqual({ lowered: 0, raised: 0, skipped: 0 })
    expect(calls).toHaveLength(0)

    expect((await loadFirmKeyword(db, 1, kwUp.id)).status).toBe('ad_registered')
    expect((await loadFirmKeyword(db, 1, kwNever.id)).status).toBe('subscribed')
    expect((await loadFirmKeyword(db, 1, kwDown.id)).status).toBe('paused')
  })

  it('API 실패 시 lastError 기록·상태 무변경(부분 실패 보존), 나머지 행은 정상 처리', async () => {
    const db = await createTestDb()
    await seedFirm(db, 1)
    const kwFail = await seedKeyword(db, 'kw-i')
    const kwOk = await seedKeyword(db, 'kw-j')
    await seedFirmKeyword(db, { firmId: 1, keywordId: kwFail.id, status: 'ad_registered', adDesired: false, naverAdgroupId: 'ag-i' })
    await seedFirmKeyword(db, { firmId: 1, keywordId: kwOk.id, status: 'ad_registered', adDesired: false, naverAdgroupId: 'ag-j' })

    const { api } = createFakeApi({ fail: new Set(['ag-i']) })
    const result = await reconcileAds(db, api, DEFAULT_FIRM)

    expect(result).toEqual({ lowered: 1, raised: 0, skipped: 0 })

    const fkFail = await loadFirmKeyword(db, 1, kwFail.id)
    expect(fkFail.status).toBe('ad_registered') // 무변경
    expect(fkFail.lastError).toMatch(/boom/)

    const fkOk = await loadFirmKeyword(db, 1, kwOk.id)
    expect(fkOk.status).toBe('paused')
    expect(fkOk.lastError).toBeNull()
  })

  it('타 firm 격리 — firm 스코프 밖 행은 API 호출·상태 변경 모두 없음', async () => {
    const db = await createTestDb()
    await seedFirm(db, 1)
    await seedFirm(db, 2)
    const kw = await seedKeyword(db, 'kw-shared')
    await seedFirmKeyword(db, { firmId: 1, keywordId: kw.id, status: 'ad_registered', adDesired: false, naverAdgroupId: 'ag-firm1' })
    await seedFirmKeyword(db, { firmId: 2, keywordId: kw.id, status: 'ad_registered', adDesired: false, naverAdgroupId: 'ag-firm2' })

    const { api, calls } = createFakeApi()
    const result = await reconcileAds(db, api, DEFAULT_FIRM) // DEFAULT_FIRM.id === 1

    expect(result).toEqual({ lowered: 1, raised: 0, skipped: 0 })
    expect(calls).toEqual([
      { method: 'PUT', path: '/ncc/adgroups/ag-firm1', query: { fields: 'userLock' }, body: { nccAdgroupId: 'ag-firm1', userLock: true } },
    ])

    const fk1 = await loadFirmKeyword(db, 1, kw.id)
    const fk2 = await loadFirmKeyword(db, 2, kw.id)
    expect(fk1.status).toBe('paused')
    expect(fk2.status).toBe('ad_registered') // 타 firm 무변경
  })

  // 최종 리뷰 C1 — pauseBlockedKeywords(review-sync.ts)가 차단 slug를 paused+adDesired 기본값
  // (true) 그대로 남겨도, 다음 reconcileAds 실행이 raise 행렬(desired=true∧paused∧id존재)만 보고
  // 고객 클릭 없이 잠금을 되살리면 안 된다.
  it('C1 — blocklist slug는 desired=true∧status=paused∧naverAdgroupId 존재여도 raise 안 됨(no-op)', async () => {
    const db = await createTestDb()
    await seedFirm(db, 1)
    const kwBlocked = await seedKeyword(db, 'kw-blocked')
    const kwNormal = await seedKeyword(db, 'kw-normal')
    await seedFirmKeyword(db, { firmId: 1, keywordId: kwBlocked.id, status: 'paused', adDesired: true, naverAdgroupId: 'ag-blocked' })
    await seedFirmKeyword(db, { firmId: 1, keywordId: kwNormal.id, status: 'paused', adDesired: true, naverAdgroupId: 'ag-normal' })

    const { api, calls } = createFakeApi()
    const result = await reconcileAds(db, api, DEFAULT_FIRM, new Set(['kw-blocked']))

    expect(result).toEqual({ lowered: 0, raised: 1, skipped: 0 }) // blocked 행은 어떤 카운트에도 없음
    expect(calls).toEqual([
      { method: 'PUT', path: '/ncc/adgroups/ag-normal', query: { fields: 'userLock' }, body: { nccAdgroupId: 'ag-normal', userLock: false } },
    ])

    const fkBlocked = await loadFirmKeyword(db, 1, kwBlocked.id)
    const fkNormal = await loadFirmKeyword(db, 1, kwNormal.id)
    expect(fkBlocked.status).toBe('paused') // userLock 잠금 유지 — 고객 클릭 없이 되살아나지 않음
    expect(fkNormal.status).toBe('ad_registered')
  })

  it('C1 — blockedSlugs 미전달(기본값) 시에는 기존 행동(raise 후보 그대로) 유지', async () => {
    const db = await createTestDb()
    await seedFirm(db, 1)
    const kw = await seedKeyword(db, 'kw-k')
    await seedFirmKeyword(db, { firmId: 1, keywordId: kw.id, status: 'paused', adDesired: true, naverAdgroupId: 'ag-k' })

    const { api } = createFakeApi()
    const result = await reconcileAds(db, api, DEFAULT_FIRM) // 4번째 인자 생략

    expect(result).toEqual({ lowered: 0, raised: 1, skipped: 0 })
    expect((await loadFirmKeyword(db, 1, kw.id)).status).toBe('ad_registered')
  })
})

describe('computeReconcileCandidates', () => {
  function row(overrides: Partial<ReconcileRow>): ReconcileRow {
    return {
      keywordId: 'kw-1', slug: 'slug-1', status: 'paused', adDesired: true, naverAdgroupId: 'ag-1',
      ...overrides,
    }
  }

  it('순수 함수 — DB·API 없이 dry/live 동일 입력에 동일 출력(T4 dry-live 단일 소스 검증)', () => {
    const rows: ReconcileRow[] = [
      row({ keywordId: 'a', slug: 'a', status: 'ad_registered', adDesired: false, naverAdgroupId: 'ag-a' }), // lower
      row({ keywordId: 'b', slug: 'b', status: 'paused', adDesired: true, naverAdgroupId: 'ag-b' }), // raise
      row({ keywordId: 'c', slug: 'c', status: 'paused', adDesired: true, naverAdgroupId: null }), // skipped
      row({ keywordId: 'd', slug: 'blocked-d', status: 'paused', adDesired: true, naverAdgroupId: 'ag-d' }), // blocked — 제외
    ]
    const blocked = new Set(['blocked-d'])

    const result1 = computeReconcileCandidates(rows, blocked)
    const result2 = computeReconcileCandidates(rows, blocked) // 동일 입력 재호출(부수효과 없음 확인)

    expect(result1.lower.map((r) => r.keywordId)).toEqual(['a'])
    expect(result1.raise.map((r) => r.keywordId)).toEqual(['b'])
    expect(result1.skipped).toBe(1)
    expect(result2).toEqual(result1)
  })

  it('blocked raise 후보는 skipped로도 세지 않는다(실행 불가가 아니라 애초에 후보가 아님)', () => {
    const rows: ReconcileRow[] = [
      row({ keywordId: 'x', slug: 'blocked-x', status: 'paused', adDesired: true, naverAdgroupId: 'ag-x' }),
    ]
    const result = computeReconcileCandidates(rows, new Set(['blocked-x']))
    expect(result).toEqual({ lower: [], raise: [], skipped: 0 })
  })
})
