import { describe, it, expect, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTestDb } from '../helpers/test-db'
import { firms, keywords, firmKeywords, firmAdEntities, keywordVariants } from '@/lib/db/schema'
import { DEFAULT_FIRM } from '@/lib/engine/firms'
import { buildRegistrationPlan } from '@/lib/engine/registration-plan'
import { executeRegistration, dailyBudgetGuardPassed, type AdApi } from '@/lib/engine/register-run'

async function seed(db: Awaited<ReturnType<typeof createTestDb>>) {
  await db.insert(firms).values({
    id: 1, slug: 'sampletwo', name: DEFAULT_FIRM.name, adLawyerName: DEFAULT_FIRM.adLawyerName,
    phone: DEFAULT_FIRM.phone, phoneIntl: DEFAULT_FIRM.phoneIntl, address: DEFAULT_FIRM.address,
    addressRegion: DEFAULT_FIRM.addressRegion, addressLocality: DEFAULT_FIRM.addressLocality,
    domain: DEFAULT_FIRM.domain,
  })
  const rows = await db.insert(keywords).values([
    { name: '업체가', slug: 'kw-a', scamType: 'coin', status: 'published' },
    { name: '업체나', slug: 'kw-b', scamType: 'coin', status: 'published' },
  ]).returning()
  await db.insert(firmKeywords).values(rows.map((r) => ({ firmId: 1, keywordId: r.id, adDesired: true })))
  return rows
}

// 성공 경로만 흉내내는 가짜 AdApi — 채널은 DEFAULT_FIRM.domain과 매칭되는 SITE 채널 1개,
// 캠페인·광고그룹 조회는 항상 빈 배열(신규 생성 유도), 이후 모든 POST는 요청 바디/쿼리에서
// 파생한 결정적 naverId를 반환한다. (무상태 — 매 실행이 "빈 계정".)
function createFakeApi() {
  const calls: { method: string; path: string; body?: unknown; query?: Record<string, string> }[] = []
  const api: AdApi = {
    request: vi.fn(async (
      method: string, path: string, opts?: { body?: unknown; query?: Record<string, string> },
    ) => {
      calls.push({ method, path, body: opts?.body, query: opts?.query })
      if (method === 'GET' && path === '/ncc/channels') {
        return [{ nccChannelId: 'chan-1', channelTp: 'SITE', url: 'https://sampletwo-law.example.com' }]
      }
      if (method === 'GET' && path === '/ncc/campaigns') return []
      if (method === 'POST' && path === '/ncc/campaigns') return { nccCampaignId: 'c1' }
      if (method === 'GET' && path === '/ncc/adgroups') return []
      if (method === 'POST' && path === '/ncc/adgroups') {
        const body = opts!.body as { name: string }
        return { nccAdgroupId: `ag-${body.name}` }
      }
      if (method === 'POST' && path === '/ncc/keywords') {
        const body = opts!.body as { keyword: string }[]
        const adgroupId = opts!.query!.nccAdgroupId
        return body.map((b, i) => ({ nccKeywordId: `kw-${adgroupId}-${i}` }))
      }
      if (method === 'POST' && path === '/ncc/ads') {
        const body = opts!.body as { nccAdgroupId: string }
        return { nccAdId: `ad-${body.nccAdgroupId}` }
      }
      throw new Error(`unexpected fake api call: ${method} ${path}`)
    }),
  }
  return { api, calls }
}

// createFakeApi의 채널 조회만 "매칭 없음"(빈 배열)으로 바꾼 변형 — ensureChannel null 반환 경로
// (firm 전체 skip) 검증용.
function createFakeApiNoChannel() {
  const { api, calls } = createFakeApi()
  const original = api.request
  api.request = vi.fn(async (method: string, path: string, opts?: { body?: unknown; query?: Record<string, string> }) => {
    if (method === 'GET' && path === '/ncc/channels') {
      calls.push({ method, path })
      return []
    }
    return original(method, path, opts)
  })
  return { api, calls }
}

// 상태를 유지하는(=실계정을 흉내내는) 가짜 AdApi — GET은 그동안 POST로 "생성"된 목록을 그대로 반환한다.
// 재시도 멱등성 검증(ensureCampaign/ensureAdgroup가 같은 이름을 재사용하는지)에 쓴다.
// keywords 벌크는 최초 1회만 두 번째 변형의 nccKeywordId를 누락시켜 부분 실패를 재현한다.
function createStatefulApi() {
  const calls: { method: string; path: string; body?: unknown; query?: Record<string, string> }[] = []
  const campaigns: Record<string, unknown>[] = []
  const adgroups: Record<string, unknown>[] = []
  let campaignSeq = 0
  let adgroupSeq = 0
  let keywordsCallCount = 0
  const api: AdApi = {
    request: vi.fn(async (method: string, path: string, opts?: { body?: unknown; query?: Record<string, string> }) => {
      calls.push({ method, path, body: opts?.body, query: opts?.query })
      if (method === 'GET' && path === '/ncc/channels') {
        return [{ nccChannelId: 'chan-1', channelTp: 'SITE', url: 'https://sampletwo-law.example.com' }]
      }
      if (method === 'GET' && path === '/ncc/campaigns') return campaigns
      if (method === 'POST' && path === '/ncc/campaigns') {
        const body = opts!.body as { name: string }
        const row = { name: body.name, nccCampaignId: `c${++campaignSeq}` }
        campaigns.push(row)
        return row
      }
      if (method === 'GET' && path === '/ncc/adgroups') return adgroups
      if (method === 'POST' && path === '/ncc/adgroups') {
        const body = opts!.body as { name: string; nccCampaignId: string }
        const row = { name: body.name, nccCampaignId: body.nccCampaignId, nccAdgroupId: `ag${++adgroupSeq}` }
        adgroups.push(row)
        return row
      }
      if (method === 'POST' && path === '/ncc/keywords') {
        keywordsCallCount++
        const body = opts!.body as { keyword: string }[]
        const adgroupId = opts!.query!.nccAdgroupId
        return body.map((b, i) => {
          if (keywordsCallCount === 1 && i === 1) return { keyword: b.keyword } // 부분 응답: id 누락
          return { nccKeywordId: `kw-${adgroupId}-${i}` }
        })
      }
      if (method === 'POST' && path === '/ncc/ads') {
        const body = opts!.body as { nccAdgroupId: string }
        return { nccAdId: `ad-${body.nccAdgroupId}` }
      }
      throw new Error(`unexpected fake api call: ${method} ${path}`)
    }),
  }
  return { api, calls }
}

// item2(f_kw-b)의 광고그룹 생성에서만 실패하는 가짜 AdApi. 그 외 동작은 createFakeApi와 동일.
function createFailingApi(failAdgroupName: string) {
  const { api, calls } = createFakeApi()
  const original = api.request
  api.request = vi.fn(async (method: string, path: string, opts?: { body?: unknown }) => {
    if (method === 'POST' && path === '/ncc/adgroups') {
      const body = opts!.body as { name: string }
      if (body.name === failAdgroupName) {
        calls.push({ method, path, body: opts?.body })
        throw new Error(`boom: adgroup 생성 실패 (${failAdgroupName})`)
      }
    }
    return original(method, path, opts)
  })
  return { api, calls }
}

describe('등록 실행기 (live 경로)', () => {
  it('정상 2건 — api 호출 시퀀스, firm_ad_entities 행, firm_keywords 전부 ad_registered', async () => {
    const db = await createTestDb()
    await seed(db)
    const plan = await buildRegistrationPlan(db, DEFAULT_FIRM)
    expect(plan.items).toHaveLength(2)
    expect(plan.items.every((i) => !i.skipped)).toBe(true)
    const variantTotal = plan.items.reduce((sum, i) => sum + i.variants.length, 0)

    const { api, calls } = createFakeApi()
    const result = await executeRegistration(db, api, DEFAULT_FIRM, plan)

    expect(result).toEqual({ registered: 2, failed: 0 })

    // api 호출 시퀀스: 채널 확인 → campaigns 조회 → 생성 → (adgroup 조회→생성→keywords→ads) × 2
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'GET /ncc/channels',
      'GET /ncc/campaigns',
      'POST /ncc/campaigns',
      'GET /ncc/adgroups',
      'POST /ncc/adgroups',
      'POST /ncc/keywords',
      'POST /ncc/ads',
      'GET /ncc/adgroups',
      'POST /ncc/adgroups',
      'POST /ncc/keywords',
      'POST /ncc/ads',
    ])

    // 페이로드 정합 (브리프 확정 스키마) — adgroup 생성: nccCampaignId·채널 id·bidAmt 기본값
    // (adConfig 없음 → 70)·dailyBudget 필드 자체 생략
    const adgroupPosts = calls.filter((c) => c.method === 'POST' && c.path === '/ncc/adgroups')
    expect(adgroupPosts).toHaveLength(2)
    for (const c of adgroupPosts) {
      const body = c.body as Record<string, unknown>
      expect(body.nccCampaignId).toBe('c1')
      expect(body.pcChannelId).toBe('chan-1')
      expect(body.mobileChannelId).toBe('chan-1')
      expect(body.bidAmt).toBe(70)
      expect(body).not.toHaveProperty('dailyBudget')
      expect(body).not.toHaveProperty('useDailyBudget')
      expect(body).not.toHaveProperty('campaignId') // 구 필드명 잔존 금지
    }

    // keywords 벌크 — nccAdgroupId는 쿼리로, 바디는 {keyword, useGroupBidAmt}만
    const keywordPosts = calls.filter((c) => c.method === 'POST' && c.path === '/ncc/keywords')
    expect(keywordPosts).toHaveLength(2)
    for (const c of keywordPosts) {
      expect(c.query?.nccAdgroupId).toMatch(/^ag-f_kw-/)
      const body = c.body as Array<Record<string, unknown>>
      expect(body.length).toBeGreaterThan(0)
      for (const v of body) {
        expect(v.useGroupBidAmt).toBe(true)
        expect(v).not.toHaveProperty('adgroupId') // 구 필드명 잔존 금지
        expect(typeof v.keyword).toBe('string')
      }
    }

    // ads — type TEXT_45, nccAdgroupId, ad.pc.final/ad.mobile.final 중첩 구조
    const adPosts = calls.filter((c) => c.method === 'POST' && c.path === '/ncc/ads')
    expect(adPosts).toHaveLength(2)
    for (const c of adPosts) {
      const body = c.body as Record<string, unknown>
      expect(body.type).toBe('TEXT_45')
      expect(body.nccAdgroupId).toMatch(/^ag-f_kw-/)
      expect(body).not.toHaveProperty('adgroupId') // 구 필드명 잔존 금지
      const ad = body.ad as Record<string, unknown>
      expect(ad).not.toHaveProperty('pcLandingUrl') // 구 평면 구조 잔존 금지
      const pc = ad.pc as Record<string, unknown>
      const mobile = ad.mobile as Record<string, unknown>
      expect(typeof pc.final).toBe('string')
      expect(pc.final).toBe(mobile.final)
    }

    const entities = await db.select().from(firmAdEntities).where(eq(firmAdEntities.firmId, 1))
    expect(entities.filter((e) => e.entityType === 'campaign')).toHaveLength(1)
    expect(entities.filter((e) => e.entityType === 'adgroup')).toHaveLength(2)
    expect(entities.filter((e) => e.entityType === 'keyword')).toHaveLength(variantTotal)
    expect(entities.filter((e) => e.entityType === 'ad')).toHaveLength(2)

    const fk = await db.select().from(firmKeywords).where(eq(firmKeywords.firmId, 1))
    expect(fk).toHaveLength(2)
    expect(fk.every((r) => r.status === 'ad_registered')).toBe(true)

    // F7 — 계획의 rule(base/alias/suffix:…)이 keyword_variants.rule에 그대로 기록된다('engine' 뭉갬 제거)
    const variantRows = await db.select().from(keywordVariants)
    expect(variantRows).toHaveLength(variantTotal)
    expect(variantRows.some((v) => v.rule === 'engine')).toBe(false)
    const byText = new Map(variantRows.map((v) => [v.text, v.rule]))
    for (const item of plan.items) {
      for (const v of item.variants) expect(byText.get(v.text)).toBe(v.rule)
    }
    expect(byText.get('업체가')).toBe('base')
    expect(byText.get('업체가사기')).toBe('suffix:사기')
  })

  it('두 번째 항목에서 api가 throw — 첫 항목 유지, 둘째 subscribed 롤백 + lastError', async () => {
    const db = await createTestDb()
    const rows = await seed(db)
    const plan = await buildRegistrationPlan(db, DEFAULT_FIRM)
    expect(plan.items).toHaveLength(2)
    const [itemA, itemB] = plan.items
    expect(itemA.slug).toBe('kw-a')
    expect(itemB.slug).toBe('kw-b')

    const { api } = createFailingApi(itemB.adgroupName)
    const result = await executeRegistration(db, api, DEFAULT_FIRM, plan)

    expect(result).toEqual({ registered: 1, failed: 1 })

    const kwA = rows.find((r) => r.slug === 'kw-a')!
    const kwB = rows.find((r) => r.slug === 'kw-b')!
    const [fkA] = await db.select().from(firmKeywords)
      .where(eq(firmKeywords.keywordId, kwA.id))
    const [fkB] = await db.select().from(firmKeywords)
      .where(eq(firmKeywords.keywordId, kwB.id))
    expect(fkA.status).toBe('ad_registered')
    expect(fkA.lastError).toBeNull()
    expect(fkB.status).toBe('subscribed')
    expect(fkB.lastError).toMatch(/boom/)

    // 실패한 항목은 firm_ad_entities에 어떤 행도 남기지 않는다 (adgroup 실패 = keyword/ad 이전)
    const adgroupEntities = await db.select().from(firmAdEntities)
      .where(eq(firmAdEntities.entityType, 'adgroup'))
    expect(adgroupEntities).toHaveLength(1)
    expect(adgroupEntities[0].keywordId).toBe(kwA.id)
    const adEntities = await db.select().from(firmAdEntities).where(eq(firmAdEntities.entityType, 'ad'))
    expect(adEntities).toHaveLength(1)
    // 캠페인은 firm당 1회만 확보 — 실패해도 재사용되므로 여전히 1행
    const campaignEntities = await db.select().from(firmAdEntities)
      .where(eq(firmAdEntities.entityType, 'campaign'))
    expect(campaignEntities).toHaveLength(1)
  })

  it('부분 실패 후 재시도 — adgroup 재생성 없이 수렴(idempotent retry)', async () => {
    const db = await createTestDb()
    await seed(db)
    const plan = await buildRegistrationPlan(db, DEFAULT_FIRM, { limit: 1 }) // kw-a 단일 항목으로 격리
    expect(plan.items).toHaveLength(1)
    const item = plan.items[0]
    expect(item.variants.length).toBeGreaterThanOrEqual(2) // 부분 응답(두 번째 변형 id 누락)을 재현하려면 필요

    const { api, calls } = createStatefulApi()

    // 1차 시도: keywords 벌크 응답의 두 번째 요소에 nccKeywordId 누락 → item 실패
    const result1 = await executeRegistration(db, api, DEFAULT_FIRM, plan)
    expect(result1).toEqual({ registered: 0, failed: 1 })

    const [fk1] = await db.select().from(firmKeywords).where(eq(firmKeywords.keywordId, item.keywordId))
    expect(fk1.status).toBe('subscribed')
    expect(fk1.lastError).toBeTruthy()

    // adgroup은 1차 시도에서 정확히 1회만 POST (성공적으로 확보됨 — 실패는 그 이후 keywords 단계)
    const adgroupPostsAfterRun1 = calls.filter((c) => c.method === 'POST' && c.path === '/ncc/adgroups')
    expect(adgroupPostsAfterRun1).toHaveLength(1)
    const campaignPostsAfterRun1 = calls.filter((c) => c.method === 'POST' && c.path === '/ncc/campaigns')
    expect(campaignPostsAfterRun1).toHaveLength(1)

    // 2차 시도(재실행, 같은 plan) — keywords 벌크는 이번엔 전부 유효한 id를 반환(장애 복구 가정)
    const result2 = await executeRegistration(db, api, DEFAULT_FIRM, plan)
    expect(result2).toEqual({ registered: 1, failed: 0 })

    const [fk2] = await db.select().from(firmKeywords).where(eq(firmKeywords.keywordId, item.keywordId))
    expect(fk2.status).toBe('ad_registered')
    expect(fk2.lastError).toBeNull()

    // 재실행에서도 adgroup·campaign은 다시 POST되지 않는다 — ensure가 GET으로 찾아 재사용
    const adgroupPostsTotal = calls.filter((c) => c.method === 'POST' && c.path === '/ncc/adgroups')
    expect(adgroupPostsTotal).toHaveLength(1)
    const campaignPostsTotal = calls.filter((c) => c.method === 'POST' && c.path === '/ncc/campaigns')
    expect(campaignPostsTotal).toHaveLength(1)

    // firm_ad_entities에도 adgroup·campaign은 각 1행뿐 — 고아 행이 있어도 재실행이 중복 삽입하지 않음
    const adgroupEntities = await db.select().from(firmAdEntities).where(eq(firmAdEntities.entityType, 'adgroup'))
    expect(adgroupEntities).toHaveLength(1)
    const campaignEntities = await db.select().from(firmAdEntities).where(eq(firmAdEntities.entityType, 'campaign'))
    expect(campaignEntities).toHaveLength(1)
    // keyword 엔티티는 정확히 변형 개수만큼 — 1차 시도에서 살아남은 고아 1행 + 2차 시도 신규분, 중복 없음
    const keywordEntities = await db.select().from(firmAdEntities).where(eq(firmAdEntities.entityType, 'keyword'))
    expect(keywordEntities).toHaveLength(item.variants.length)
    const adEntities = await db.select().from(firmAdEntities).where(eq(firmAdEntities.entityType, 'ad'))
    expect(adEntities).toHaveLength(1)
  })

  it('skipped 항목 — api 호출 0회, 상태 무변경', async () => {
    const db = await createTestDb()
    // 금지어 포함 업체명 → buildRegistrationPlan이 skipped 처리 (Task10 픽스처 재사용)
    const [kw] = await db.insert(keywords).values(
      { name: '전액회수보장', slug: 'kw-bad', scamType: 'coin', status: 'published' },
    ).returning()
    await db.insert(firms).values({
      id: 1, slug: 'sampletwo', name: DEFAULT_FIRM.name, adLawyerName: 'x', phone: 'x', phoneIntl: 'x',
      address: 'x', addressRegion: 'x', addressLocality: 'x',
    })
    await db.insert(firmKeywords).values({ firmId: 1, keywordId: kw.id, adDesired: true })

    const plan = await buildRegistrationPlan(db, DEFAULT_FIRM)
    expect(plan.items).toHaveLength(1)
    expect(plan.items[0].skipped).toMatch(/^lint:/)

    const { api, calls } = createFakeApi()
    const result = await executeRegistration(db, api, DEFAULT_FIRM, plan)

    expect(result).toEqual({ registered: 0, failed: 0 })
    expect(calls).toHaveLength(0)
    expect(api.request).not.toHaveBeenCalled()

    const [fk] = await db.select().from(firmKeywords).where(eq(firmKeywords.keywordId, kw.id))
    expect(fk.status).toBe('subscribed')
    expect(fk.lastError).toBeNull()

    const entities = await db.select().from(firmAdEntities)
    expect(entities).toHaveLength(0)
  })

  // 브리프 인터페이스 — firm.adConfig가 있으면 bidAmt/dailyBudget이 그 값을 따르고, 채널도
  // 캐시(adConfig.pcChannelId/mobileChannelId)를 우선 사용해 GET /ncc/channels를 재조회하지 않는다.
  it('adConfig 있으면 bidAmt·dailyBudget 반영 + 채널 캐시 우선(재조회 없음)', async () => {
    const db = await createTestDb()
    await seed(db)
    const plan = await buildRegistrationPlan(db, DEFAULT_FIRM, { limit: 1 })
    expect(plan.items).toHaveLength(1)

    const firmWithConfig = {
      ...DEFAULT_FIRM,
      adConfig: {
        bidAmt: 500, dailyBudget: 20000, useDailyBudget: true,
        channelOk: true, pcChannelId: 'chan-cached', mobileChannelId: 'chan-cached',
      },
    }

    const { api, calls } = createFakeApi()
    const result = await executeRegistration(db, api, firmWithConfig, plan)
    expect(result).toEqual({ registered: 1, failed: 0 })

    // 채널 캐시 우선 — GET /ncc/channels 재조회 없음
    expect(calls.some((c) => c.method === 'GET' && c.path === '/ncc/channels')).toBe(false)

    const adgroupPost = calls.find((c) => c.method === 'POST' && c.path === '/ncc/adgroups')!
    const body = adgroupPost.body as Record<string, unknown>
    expect(body.pcChannelId).toBe('chan-cached')
    expect(body.mobileChannelId).toBe('chan-cached')
    expect(body.bidAmt).toBe(500)
    expect(body.dailyBudget).toBe(20000)
    expect(body.useDailyBudget).toBe(true)
  })

  // 브리프 인터페이스 — ensureChannel이 null(채널 미확보)이면 firm 전체를 skip한다: 항목별
  // 실패가 아니라 실행 자체를 중단하고 channelMissing: true를 반환. api 호출은 채널 확인 1회뿐,
  // DB는 완전히 무변경(상태 전이·엔티티 삽입 없음).
  it('채널 미확보 — firm 전체 skip (channelMissing: true), 상태·엔티티 무변경', async () => {
    const db = await createTestDb()
    await seed(db)
    const plan = await buildRegistrationPlan(db, DEFAULT_FIRM)
    expect(plan.items).toHaveLength(2)

    const { api, calls } = createFakeApiNoChannel()
    const result = await executeRegistration(db, api, DEFAULT_FIRM, plan)

    expect(result).toEqual({ registered: 0, failed: 0, channelMissing: true })
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(['GET /ncc/channels'])

    const fk = await db.select().from(firmKeywords).where(eq(firmKeywords.firmId, 1))
    expect(fk.every((r) => r.status === 'subscribed')).toBe(true)
    const entities = await db.select().from(firmAdEntities).where(eq(firmAdEntities.firmId, 1))
    expect(entities).toHaveLength(0)
  })
})

// 최종 리뷰 I3 — 첫 live 실행 무제한 지출 방지 가드의 판정 로직(순수 함수). scripts/engine/
// register-ads.ts가 이 함수 결과로 REFUSED 여부를 결정하는 것은 스크립트 레벨이라 여기서는
// 판정 자체만 단위 테스트한다(스크립트 가드 배선의 스모크는 리포트에 별도 기록).
describe('dailyBudgetGuardPassed', () => {
  it('dailyBudget > 0 이면 통과', () => {
    expect(dailyBudgetGuardPassed(5000, undefined)).toBe(true)
  })

  it('dailyBudget undefined(미설정) ∧ ALLOW_UNLIMITED_BUDGET 미설정 → 실패', () => {
    expect(dailyBudgetGuardPassed(undefined, undefined)).toBe(false)
  })

  it('dailyBudget 0(명시적 미사용) ∧ ALLOW_UNLIMITED_BUDGET 미설정 → 실패', () => {
    expect(dailyBudgetGuardPassed(0, undefined)).toBe(false)
  })

  it('dailyBudget 미설정이어도 ALLOW_UNLIMITED_BUDGET=1이면 통과(명시적 우회)', () => {
    expect(dailyBudgetGuardPassed(undefined, '1')).toBe(true)
    expect(dailyBudgetGuardPassed(0, '1')).toBe(true)
  })

  it("ALLOW_UNLIMITED_BUDGET이 '1'이 아닌 다른 값(예: 'true')이면 우회 안 됨", () => {
    expect(dailyBudgetGuardPassed(undefined, 'true')).toBe(false)
  })

  it('음수 dailyBudget(비정상 데이터)은 통과 아님 — ALLOW_UNLIMITED_BUDGET 필요', () => {
    expect(dailyBudgetGuardPassed(-1, undefined)).toBe(false)
  })
})
