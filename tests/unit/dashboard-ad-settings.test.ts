import { describe, it, expect, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { randomBytes } from 'node:crypto'
import { createTestDb } from '../helpers/test-db'
import { firms, keywords, firmKeywords, firmCredentials } from '@/lib/db/schema'
import { findBannedTerms } from '@/lib/compliance/lexicon'
import {
  setAdDesiredForFirm,
  saveAdConfigForFirm,
  saveCredentialsForFirm,
} from '@/lib/dashboard/ad-settings'
import { NaverApiError, type NaverSearchAdClient } from '@/lib/engine/naver/client'
import type { Firm } from '@/lib/engine/firms'

const mkFirm = (id: number, token: string, overrides: Partial<Firm> = {}): Firm => ({
  id, slug: `f${id}`, name: `firm${id}`, adLawyerName: 'x', phone: '1', phoneIntl: '1',
  address: 'x', addressRegion: 'r', addressLocality: 'l',
  kakaoUrl: null, domain: null, status: 'active',
  lawyers: null, wordmark: null, landingReady: false, dashboardToken: token, adConfig: null,
  ...overrides,
})

async function seedFirm(db: Awaited<ReturnType<typeof createTestDb>>, id: number, token: string, domain: string | null = null) {
  await db.insert(firms).values({
    id, slug: `f${id}`, name: `firm${id}`, adLawyerName: 'x', phone: '1', phoneIntl: '1',
    address: 'x', addressRegion: 'r', addressLocality: 'l', dashboardToken: token, domain,
  })
}

async function seedKeyword(db: Awaited<ReturnType<typeof createTestDb>>, slug: string) {
  const [kw] = await db.insert(keywords).values(
    { name: 'k', slug, scamType: '코인', status: 'published' },
  ).returning()
  return kw
}

// ── setAdDesiredForFirm ──────────────────────────────────────────────────
describe('setAdDesiredForFirm', () => {
  it('기존 행 desired true → false 반영', async () => {
    const db = await createTestDb()
    await seedFirm(db, 100, 'tok-ad1')
    const kw = await seedKeyword(db, 'ad-set-1')
    await db.insert(firmKeywords).values({ firmId: 100, keywordId: kw.id, status: 'subscribed', adDesired: true })

    await setAdDesiredForFirm(db, mkFirm(100, 'tok-ad1'), kw.id, false)

    const [row] = await db.select().from(firmKeywords).where(eq(firmKeywords.firmId, 100))
    expect(row.adDesired).toBe(false)
  })

  it('false → true 복귀', async () => {
    const db = await createTestDb()
    await seedFirm(db, 101, 'tok-ad2')
    const kw = await seedKeyword(db, 'ad-set-2')
    await db.insert(firmKeywords).values({ firmId: 101, keywordId: kw.id, status: 'subscribed', adDesired: false })

    await setAdDesiredForFirm(db, mkFirm(101, 'tok-ad2'), kw.id, true)

    const [row] = await db.select().from(firmKeywords).where(eq(firmKeywords.firmId, 101))
    expect(row.adDesired).toBe(true)
  })

  it('행 없으면 무시 (신규 행 생성 안 함)', async () => {
    const db = await createTestDb()
    await seedFirm(db, 102, 'tok-ad3')
    const kw = await seedKeyword(db, 'ad-set-3')

    await setAdDesiredForFirm(db, mkFirm(102, 'tok-ad3'), kw.id, false)

    const rows = await db.select().from(firmKeywords).where(eq(firmKeywords.firmId, 102))
    expect(rows.length).toBe(0)
  })

  it('타 firm 소유 행은 무시(격리)', async () => {
    const db = await createTestDb()
    await seedFirm(db, 103, 'tok-ad4a')
    await seedFirm(db, 104, 'tok-ad4b')
    const kw = await seedKeyword(db, 'ad-set-4')
    await db.insert(firmKeywords).values({ firmId: 103, keywordId: kw.id, status: 'subscribed', adDesired: true })

    await setAdDesiredForFirm(db, mkFirm(104, 'tok-ad4b'), kw.id, false)

    const [row103] = await db.select().from(firmKeywords).where(eq(firmKeywords.firmId, 103))
    const rows104 = await db.select().from(firmKeywords).where(eq(firmKeywords.firmId, 104))
    expect(row103.adDesired).toBe(true) // 타 firm 조작의 영향 없음
    expect(rows104.length).toBe(0) // 신규 행 생성 안 함
  })
})

// ── saveAdConfigForFirm ───────────────────────────────────────────────────
describe('saveAdConfigForFirm', () => {
  it('bidAmt 69 거부', async () => {
    const db = await createTestDb()
    await seedFirm(db, 110, 'tok-cfg1')

    const result = await saveAdConfigForFirm(db, mkFirm(110, 'tok-cfg1'), { bidAmt: 69, dailyBudget: 0 })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(findBannedTerms(result.error)).toEqual([])
    const [row] = await db.select().from(firms).where(eq(firms.id, 110))
    expect(row.adConfig).toBeNull()
  })

  it('bidAmt 70 허용 + dailyBudget>0 이면 useDailyBudget true', async () => {
    const db = await createTestDb()
    await seedFirm(db, 111, 'tok-cfg2')

    const result = await saveAdConfigForFirm(db, mkFirm(111, 'tok-cfg2'), { bidAmt: 70, dailyBudget: 5000 })

    expect(result.ok).toBe(true)
    const [row] = await db.select().from(firms).where(eq(firms.id, 111))
    expect(row.adConfig).toEqual({ bidAmt: 70, dailyBudget: 5000, useDailyBudget: true })
  })

  it('dailyBudget 0이면 useDailyBudget false', async () => {
    const db = await createTestDb()
    await seedFirm(db, 112, 'tok-cfg3')

    const result = await saveAdConfigForFirm(db, mkFirm(112, 'tok-cfg3'), { bidAmt: 100, dailyBudget: 0 })

    expect(result.ok).toBe(true)
    const [row] = await db.select().from(firms).where(eq(firms.id, 112))
    expect(row.adConfig).toEqual({ bidAmt: 100, dailyBudget: 0, useDailyBudget: false })
  })

  it('소수 bidAmt 거부', async () => {
    const db = await createTestDb()
    await seedFirm(db, 113, 'tok-cfg4')

    const result = await saveAdConfigForFirm(db, mkFirm(113, 'tok-cfg4'), { bidAmt: 70.5, dailyBudget: 0 })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(findBannedTerms(result.error)).toEqual([])
  })

  it('음수 dailyBudget 거부', async () => {
    const db = await createTestDb()
    await seedFirm(db, 114, 'tok-cfg5')

    const result = await saveAdConfigForFirm(db, mkFirm(114, 'tok-cfg5'), { bidAmt: 100, dailyBudget: -1 })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(findBannedTerms(result.error)).toEqual([])
  })

  it('기존 채널 캐시 필드 보존 병합', async () => {
    const db = await createTestDb()
    const existingAdConfig = {
      bidAmt: 70, dailyBudget: 0, useDailyBudget: false,
      channelOk: true, channelCheckedAt: '2026-08-01T00:00:00.000Z',
      pcChannelId: 'pc-1', mobileChannelId: 'mo-1',
    }
    await db.insert(firms).values({
      id: 115, slug: 'f115', name: 'firm115', adLawyerName: 'x', phone: '1', phoneIntl: '1',
      address: 'x', addressRegion: 'r', addressLocality: 'l', dashboardToken: 'tok-cfg6',
      adConfig: existingAdConfig,
    })
    const firm = mkFirm(115, 'tok-cfg6', { adConfig: existingAdConfig })

    const result = await saveAdConfigForFirm(db, firm, { bidAmt: 200, dailyBudget: 10000 })

    expect(result.ok).toBe(true)
    const [row] = await db.select().from(firms).where(eq(firms.id, 115))
    expect(row.adConfig).toEqual({
      bidAmt: 200, dailyBudget: 10000, useDailyBudget: true,
      channelOk: true, channelCheckedAt: '2026-08-01T00:00:00.000Z',
      pcChannelId: 'pc-1', mobileChannelId: 'mo-1',
    })
  })
})

// ── saveCredentialsForFirm ────────────────────────────────────────────────
type Recorded = { method: string; path: string }

function recordingClient(handlers: {
  campaigns: () => unknown
  channels?: () => unknown
}): { client: Pick<NaverSearchAdClient, 'request'>; calls: Recorded[] } {
  const calls: Recorded[] = []
  const client: Pick<NaverSearchAdClient, 'request'> = {
    request: async (method: string, path: string) => {
      calls.push({ method, path })
      if (path === '/ncc/campaigns') return handlers.campaigns()
      if (path === '/ncc/channels') return handlers.channels ? handlers.channels() : []
      throw new Error(`unexpected path in test double: ${path}`)
    },
  }
  return { client, calls }
}

describe('saveCredentialsForFirm', () => {
  const originalKey = process.env.CRED_ENC_KEY

  afterEach(() => {
    if (originalKey === undefined) delete process.env.CRED_ENC_KEY
    else process.env.CRED_ENC_KEY = originalKey
  })

  it('암호화 저장 — DB 행에 평문 부재, 결과 JSON에 secret/apiKey 원문 부재', async () => {
    process.env.CRED_ENC_KEY = randomBytes(32).toString('base64')
    const db = await createTestDb()
    await seedFirm(db, 120, 'tok-cred1')
    const firm = mkFirm(120, 'tok-cred1')
    const { client } = recordingClient({ campaigns: () => [] })

    const input = { customerId: 'cust-1', apiKey: 'PLAINTEXT_APIKEY_XYZ', secret: 'PLAINTEXT_SECRET_XYZ' }
    const result = await saveCredentialsForFirm(db, firm, input, { makeClient: () => client })

    const json = JSON.stringify(result)
    expect(json).not.toContain('PLAINTEXT_APIKEY_XYZ')
    expect(json).not.toContain('PLAINTEXT_SECRET_XYZ')

    const [row] = await db.select().from(firmCredentials).where(eq(firmCredentials.firmId, 120))
    expect(row.apiKeyEnc).not.toContain('PLAINTEXT_APIKEY_XYZ')
    expect(row.secretEnc).not.toContain('PLAINTEXT_SECRET_XYZ')
    expect(row.customerId).toBe('cust-1')
  })

  it('핑 성공 시 verifiedAt 기록', async () => {
    process.env.CRED_ENC_KEY = randomBytes(32).toString('base64')
    const db = await createTestDb()
    await seedFirm(db, 121, 'tok-cred2')
    const firm = mkFirm(121, 'tok-cred2')
    const { client } = recordingClient({ campaigns: () => [] })

    const result = await saveCredentialsForFirm(
      db, firm, { customerId: 'c', apiKey: 'ak', secret: 'sk' }, { makeClient: () => client },
    )

    expect(result.ok).toBe(true)
    expect(result.verified).toBe(true)
    const [row] = await db.select().from(firmCredentials).where(eq(firmCredentials.firmId, 121))
    expect(row.verifiedAt).not.toBeNull()
  })

  it('핑 401(인증 실패) 목 — errorCategory auth, verifiedAt 미기록, 시크릿 원문 미노출', async () => {
    process.env.CRED_ENC_KEY = randomBytes(32).toString('base64')
    const db = await createTestDb()
    await seedFirm(db, 122, 'tok-cred3')
    const firm = mkFirm(122, 'tok-cred3')
    const { client, calls } = recordingClient({
      campaigns: () => { throw new NaverApiError(401, 'invalid signature: sk-PLAINTEXT') },
    })

    const result = await saveCredentialsForFirm(
      db, firm, { customerId: 'c', apiKey: 'ak', secret: 'sk-PLAINTEXT' }, { makeClient: () => client },
    )

    expect(result.verified).toBe(false)
    expect(result.errorCategory).toBe('auth')
    expect(result.channelOk).toBe(false)
    const json = JSON.stringify(result)
    expect(json).not.toContain('sk-PLAINTEXT')
    expect(json).not.toContain('invalid signature')

    const [row] = await db.select().from(firmCredentials).where(eq(firmCredentials.firmId, 122))
    expect(row.verifiedAt).toBeNull()

    // 검증 핑 실패 시 채널 조회를 시도하지 않는다 — GET /ncc/campaigns 1회만
    expect(calls).toEqual([{ method: 'GET', path: '/ncc/campaigns' }])
  })

  it('5xx 목 — errorCategory network', async () => {
    process.env.CRED_ENC_KEY = randomBytes(32).toString('base64')
    const db = await createTestDb()
    await seedFirm(db, 125, 'tok-cred6')
    const firm = mkFirm(125, 'tok-cred6')
    const { client } = recordingClient({
      campaigns: () => { throw new NaverApiError(500, 'boom') },
    })

    const result = await saveCredentialsForFirm(
      db, firm, { customerId: 'c', apiKey: 'ak', secret: 'sk' }, { makeClient: () => client },
    )

    expect(result.errorCategory).toBe('network')
  })

  it('순수 fetch 실패(네트워크 예외) 목 — errorCategory network', async () => {
    process.env.CRED_ENC_KEY = randomBytes(32).toString('base64')
    const db = await createTestDb()
    await seedFirm(db, 126, 'tok-cred7')
    const firm = mkFirm(126, 'tok-cred7')
    const { client } = recordingClient({
      campaigns: () => { throw new TypeError('fetch failed') },
    })

    const result = await saveCredentialsForFirm(
      db, firm, { customerId: 'c', apiKey: 'ak', secret: 'sk' }, { makeClient: () => client },
    )

    expect(result.errorCategory).toBe('network')
  })

  it('4xx(400 등) 목 — errorCategory unknown', async () => {
    process.env.CRED_ENC_KEY = randomBytes(32).toString('base64')
    const db = await createTestDb()
    await seedFirm(db, 127, 'tok-cred8')
    const firm = mkFirm(127, 'tok-cred8')
    const { client } = recordingClient({
      campaigns: () => { throw new NaverApiError(400, 'bad request') },
    })

    const result = await saveCredentialsForFirm(
      db, firm, { customerId: 'c', apiKey: 'ak', secret: 'sk' }, { makeClient: () => client },
    )

    expect(result.errorCategory).toBe('unknown')
  })

  it('채널 매칭 시 channelOk true + adConfig에 pcChannelId/mobileChannelId/channelCheckedAt 캐시', async () => {
    process.env.CRED_ENC_KEY = randomBytes(32).toString('base64')
    const db = await createTestDb()
    await seedFirm(db, 123, 'tok-cred4', 'example.com')
    const firm = mkFirm(123, 'tok-cred4', { domain: 'example.com' })
    const { client, calls } = recordingClient({
      campaigns: () => [],
      channels: () => [
        { nccChannelId: 'other-1', channelTp: 'SITE', url: 'https://not-matching.com' },
        { nccChannelId: 'ch-1', channelTp: 'SITE', url: 'https://example.com/landing' },
      ],
    })

    const result = await saveCredentialsForFirm(
      db, firm, { customerId: 'c', apiKey: 'ak', secret: 'sk' }, { makeClient: () => client },
    )

    expect(result.channelOk).toBe(true)
    const [row] = await db.select().from(firms).where(eq(firms.id, 123))
    expect(row.adConfig?.channelOk).toBe(true)
    expect(row.adConfig?.pcChannelId).toBe('ch-1')
    expect(row.adConfig?.mobileChannelId).toBe('ch-1')
    expect(row.adConfig?.channelCheckedAt).toBeTruthy()

    // 쓰기 메서드 호출 절대 없음 — 전부 GET, 정확히 campaigns→channels 순서
    expect(calls).toEqual([
      { method: 'GET', path: '/ncc/campaigns' },
      { method: 'GET', path: '/ncc/channels' },
    ])
    for (const c of calls) expect(c.method).toBe('GET')
  })

  it('채널 미매칭 — channelOk false로 캐시되고 기존 bidAmt/dailyBudget 보존', async () => {
    process.env.CRED_ENC_KEY = randomBytes(32).toString('base64')
    const db = await createTestDb()
    const existingAdConfig = { bidAmt: 150, dailyBudget: 3000, useDailyBudget: true }
    await db.insert(firms).values({
      id: 124, slug: 'f124', name: 'firm124', adLawyerName: 'x', phone: '1', phoneIntl: '1',
      address: 'x', addressRegion: 'r', addressLocality: 'l', dashboardToken: 'tok-cred5',
      domain: 'other-domain.com', adConfig: existingAdConfig,
    })
    const firm = mkFirm(124, 'tok-cred5', { domain: 'other-domain.com', adConfig: existingAdConfig })
    const { client } = recordingClient({
      campaigns: () => [],
      channels: () => [{ nccChannelId: 'ch-x', channelTp: 'SITE', url: 'https://unrelated.com' }],
    })

    const result = await saveCredentialsForFirm(
      db, firm, { customerId: 'c', apiKey: 'ak', secret: 'sk' }, { makeClient: () => client },
    )

    expect(result.channelOk).toBe(false)
    const [row] = await db.select().from(firms).where(eq(firms.id, 124))
    expect(row.adConfig?.channelOk).toBe(false)
    expect(row.adConfig?.bidAmt).toBe(150)
    expect(row.adConfig?.dailyBudget).toBe(3000)
    expect(row.adConfig?.pcChannelId).toBeUndefined()
  })

  it('이전에 매칭됐던 채널 id는 재확인 시 미매칭이면 캐시에서 제거(오래된 채널로 등록 방지)', async () => {
    process.env.CRED_ENC_KEY = randomBytes(32).toString('base64')
    const db = await createTestDb()
    const staleAdConfig = {
      bidAmt: 70, dailyBudget: 0, useDailyBudget: false,
      channelOk: true, channelCheckedAt: '2026-08-01T00:00:00.000Z',
      pcChannelId: 'stale-pc', mobileChannelId: 'stale-mo',
    }
    await db.insert(firms).values({
      id: 129, slug: 'f129', name: 'firm129', adLawyerName: 'x', phone: '1', phoneIntl: '1',
      address: 'x', addressRegion: 'r', addressLocality: 'l', dashboardToken: 'tok-cred10',
      domain: 'changed-domain.com', adConfig: staleAdConfig,
    })
    const firm = mkFirm(129, 'tok-cred10', { domain: 'changed-domain.com', adConfig: staleAdConfig })
    const { client } = recordingClient({
      campaigns: () => [],
      channels: () => [{ nccChannelId: 'unrelated', channelTp: 'SITE', url: 'https://something-else.com' }],
    })

    const result = await saveCredentialsForFirm(
      db, firm, { customerId: 'c', apiKey: 'ak', secret: 'sk' }, { makeClient: () => client },
    )

    expect(result.channelOk).toBe(false)
    const [row] = await db.select().from(firms).where(eq(firms.id, 129))
    expect(row.adConfig?.channelOk).toBe(false)
    expect(row.adConfig?.pcChannelId).toBeUndefined()
    expect(row.adConfig?.mobileChannelId).toBeUndefined()
    // bidAmt/dailyBudget는 채널과 무관하므로 그대로 보존
    expect(row.adConfig?.bidAmt).toBe(70)
  })

  // 최종 리뷰 I1-code — CRED_ENC_KEY 미설정이면 encryptCred가 throw하는데, 이걸 안 잡으면
  // saveCredentials 서버 액션을 거쳐 고객 화면이 500으로 죽는다. 실계정 연결 직전이라 이 경로가
  // 실제로 밟힐 위험이 있다(예: env 배포 실수).
  it('I1-code — CRED_ENC_KEY 미설정 시 throw 대신 ok:false·verified:false·errorCategory unknown 반환(500 없음)', async () => {
    delete process.env.CRED_ENC_KEY
    const db = await createTestDb()
    await seedFirm(db, 130, 'tok-cred11')
    const firm = mkFirm(130, 'tok-cred11')
    const { client, calls } = recordingClient({ campaigns: () => [] })

    const result = await saveCredentialsForFirm(
      db, firm, { customerId: 'c', apiKey: 'ak', secret: 'sk' }, { makeClient: () => client },
    )

    expect(result).toEqual({ ok: false, verified: false, channelOk: false, errorCategory: 'unknown' })
    // 암호화 실패 시 DB에 쓰지 않는다 — 평문도, 실패한 상태의 행도 남기지 않는다.
    const rows = await db.select().from(firmCredentials).where(eq(firmCredentials.firmId, 130))
    expect(rows.length).toBe(0)
    // 암호화 단계에서 조기 반환하므로 네이버 API 호출 자체가 없다.
    expect(calls).toHaveLength(0)
  })

  it('I1-code — CRED_ENC_KEY가 32바이트 아니면(형식 오류) 마찬가지로 500 없이 unknown 카테고리', async () => {
    process.env.CRED_ENC_KEY = Buffer.from('too-short').toString('base64')
    const db = await createTestDb()
    await seedFirm(db, 131, 'tok-cred12')
    const firm = mkFirm(131, 'tok-cred12')
    const { client } = recordingClient({ campaigns: () => [] })

    const result = await saveCredentialsForFirm(
      db, firm, { customerId: 'c', apiKey: 'ak', secret: 'sk' }, { makeClient: () => client },
    )

    expect(result).toEqual({ ok: false, verified: false, channelOk: false, errorCategory: 'unknown' })
  })

  // 최종 리뷰 I2 — 교체 핑 실패 시 이전 계정의 channelOk/pcChannelId/mobileChannelId가 남으면
  // 버튼 게이팅·엔진이 더 이상 유효하다고 보장되지 않는 stale 채널을 계속 유효한 것처럼 소비한다.
  it('I2 — 자격증명 교체 검증 실패 시 이전 채널 캐시(channelOk/pcChannelId/mobileChannelId) 초기화', async () => {
    process.env.CRED_ENC_KEY = randomBytes(32).toString('base64')
    const db = await createTestDb()
    const staleAdConfig = {
      bidAmt: 70, dailyBudget: 0, useDailyBudget: false,
      channelOk: true, channelCheckedAt: '2026-08-01T00:00:00.000Z',
      pcChannelId: 'stale-pc', mobileChannelId: 'stale-mo',
    }
    await db.insert(firms).values({
      id: 132, slug: 'f132', name: 'firm132', adLawyerName: 'x', phone: '1', phoneIntl: '1',
      address: 'x', addressRegion: 'r', addressLocality: 'l', dashboardToken: 'tok-cred13',
      domain: 'example.com', adConfig: staleAdConfig,
    })
    const firm = mkFirm(132, 'tok-cred13', { domain: 'example.com', adConfig: staleAdConfig })
    const { client } = recordingClient({
      campaigns: () => { throw new NaverApiError(401, 'invalid signature') },
    })

    const result = await saveCredentialsForFirm(
      db, firm, { customerId: 'c', apiKey: 'ak', secret: 'sk-new' }, { makeClient: () => client },
    )

    expect(result.verified).toBe(false)
    expect(result.channelOk).toBe(false)
    const [row] = await db.select().from(firms).where(eq(firms.id, 132))
    expect(row.adConfig?.channelOk).toBe(false)
    expect(row.adConfig?.pcChannelId).toBeUndefined()
    expect(row.adConfig?.mobileChannelId).toBeUndefined()
    // bidAmt/dailyBudget는 채널 캐시와 무관하므로 그대로 보존
    expect(row.adConfig?.bidAmt).toBe(70)
  })

  it('firm당 provider 유니크 — 재저장 시 갱신(행 1개 유지)', async () => {
    process.env.CRED_ENC_KEY = randomBytes(32).toString('base64')
    const db = await createTestDb()
    await seedFirm(db, 128, 'tok-cred9')
    const firm = mkFirm(128, 'tok-cred9')
    const { client: client1 } = recordingClient({ campaigns: () => [] })
    const { client: client2 } = recordingClient({ campaigns: () => [] })

    await saveCredentialsForFirm(db, firm, { customerId: 'c1', apiKey: 'ak1', secret: 'sk1' }, { makeClient: () => client1 })
    await saveCredentialsForFirm(db, firm, { customerId: 'c2', apiKey: 'ak2', secret: 'sk2' }, { makeClient: () => client2 })

    const rows = await db.select().from(firmCredentials).where(eq(firmCredentials.firmId, 128))
    expect(rows.length).toBe(1)
    expect(rows[0].customerId).toBe('c2')
  })
})
