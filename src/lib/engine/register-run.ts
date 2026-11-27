// src/lib/engine/register-run.ts — 등록 계획을 네이버 검색광고 API에 반영하는 live 실행기.
// 순서(항목당): ① subscribed→ad_pending ② 캠페인 확보(firm당 1회) ③ adgroup 확보 ④ keywords 벌크
// ⑤ ads ⑥ 성공 시 firm_ad_entities 삽입 + ad_pending→ad_registered / 실패 시 subscribed 롤백 + lastError.
// 상태 갱신은 반드시 assertTransition 통과 후 db.update. skipped 항목은 api 호출 없이 건너뛴다.
//
// 재시도 멱등성(리뷰 fix, 2026-08-02): 부분 실패 후 catch는 firm_keywords 상태만 롤백하고, 이미
// 커밋된 firm_ad_entities/keyword_variants 행은 지우지 않는다(고아 방지가 아니라 "같은 자리로 수렴"
// 전략). 그래서 재실행 시 중복 생성이 없도록 두 층으로 방어한다:
//   1) 원격 객체 재사용 — ensureCampaign/ensureAdgroup은 생성 전에 이름으로 GET 조회해 이미 있으면
//      재사용한다(캠페인은 firm당, 광고그룹은 item당 최대 1개만 실제로 POST됨).
//   2) 로컬 미러 재삽입 방지 — firm_ad_entities는 (firmId, entityType, naverId) 유니크에
//      onConflictDoNothing, keyword_variants는 (keywordId, text) 유니크에 onConflictDoUpdate를 걸어
//      같은 naverId/텍스트가 다시 와도 행이 중복되지 않는다.
// 커버되지 않는 잔여 리스크: keywords 벌크 POST와 ads POST 자체는 멱등 확보 대상이 아니다(Naver 쪽
// 벌크 키워드 dedup 동작에 의존, 소재는 ensureAd 없음) — 후속 과제로 남김.
import { and, eq } from 'drizzle-orm'
import type { Db } from '@/lib/db/client'
import { firmAdEntities, firmKeywords, keywordVariants } from '@/lib/db/schema'
import type { Firm } from './firms'
import type { NaverSearchAdClient } from './naver/client'
import { matchChannel, naverChannelId, naverChannelReady, type NaverChannelRaw } from './naver/channel'
import type { PlanItem, RegistrationPlan } from './registration-plan'
import { assertTransition, type FirmKeywordStatus } from './state'

const DEFAULT_BID_AMT = 70

export type ChannelIds = { pcChannelId: string; mobileChannelId: string }

export type AdApi = Pick<NaverSearchAdClient, 'request'>

const ENTITY_UNIQUE_TARGET = [firmAdEntities.firmId, firmAdEntities.entityType, firmAdEntities.naverId]

/**
 * dailyBudgetGuardPassed — 첫 live 실행 무제한 지출 방지 가드(최종 리뷰 I3)의 판정만 뽑은 순수
 * 함수(env 접근·프로세스 종료·콘솔 출력 없음 — scripts/engine/register-ads.ts가 이 결과로 REFUSED
 * 여부·종료코드를 결정한다). adConfig.dailyBudget이 양수로 설정돼 있으면 통과. 미설정(undefined)·
 * 0 이하면, 운영자가 ALLOW_UNLIMITED_BUDGET=1로 명시적으로 무제한 지출을 허용한 경우에만 통과한다
 * — 그 외에는 첫 live 등록이 일예산 상한 없이 실행되는 사고를 막기 위해 실패시킨다.
 */
export function dailyBudgetGuardPassed(
  dailyBudget: number | undefined, allowUnlimitedEnv: string | undefined,
): boolean {
  if (dailyBudget !== undefined && dailyBudget > 0) return true
  return allowUnlimitedEnv === '1'
}

function campaignName(firmId: number): string {
  return `engine_f${firmId}`
}

// 응답 바디에서 네이버 객체 id 추출. 없으면 null — 호출측이 raw 응답을 에러 메시지에 담아 보존한다
// (firm_ad_entities.naverId는 NOT NULL이라 id 없이는 행을 만들 수 없음 — 대신 lastError에 raw를 남긴다).
function extractId(body: unknown, field: string): string | null {
  if (!body || typeof body !== 'object') return null
  const v = (body as Record<string, unknown>)[field]
  return typeof v === 'string' && v.length > 0 ? v : null
}

async function ensureCampaign(api: AdApi, firmId: number): Promise<string> {
  const name = campaignName(firmId)
  const existing = await api.request<Array<Record<string, unknown>>>('GET', '/ncc/campaigns')
  const found = Array.isArray(existing) ? existing.find((c) => c.name === name) : undefined
  const foundId = found ? extractId(found, 'nccCampaignId') : null
  if (foundId) return foundId

  const created = await api.request<Record<string, unknown>>('POST', '/ncc/campaigns', {
    body: { name, campaignTp: 'WEB_SITE' }, // VERIFY-LIVE: campaignTp 값 — naver/searchad-apidoc 샘플 대조로도
    // 미확정(캠페인 타입 열거값 자체를 표본에서 못 찾음) — live 전 공식 문서 확인 필요.
  })
  const id = extractId(created, 'nccCampaignId')
  if (!id) throw new Error(`campaign 생성 응답에 nccCampaignId 없음: ${JSON.stringify(created)}`)
  return id
}

// firm의 비즈채널(pc/mobile) 확보 — firm.adConfig 캐시(saveCredentialsForFirm이 채움) 우선,
// 없으면 GET /ncc/channels로 재조회해 firm.domain과 매칭한다(ad-settings.ts와 동일 계약,
// naver/channel.ts로 추출해 양쪽이 같은 매칭 로직을 공유). null 반환 시 호출측(executeRegistration)이
// firm 전체 등록을 skip한다 — 채널 없이 adgroup을 만들면 광고가 노출될 채널이 없는 무효 등록이 된다.
export async function ensureChannel(api: AdApi, firm: Firm): Promise<ChannelIds | null> {
  const cached = firm.adConfig
  if (cached?.pcChannelId && cached.mobileChannelId) {
    return { pcChannelId: cached.pcChannelId, mobileChannelId: cached.mobileChannelId }
  }

  const channels = await api.request<NaverChannelRaw[]>('GET', '/ncc/channels')
  const match = matchChannel(channels, firm.domain)
  const id = naverChannelId(match)
  if (!id || !naverChannelReady(match)) return null
  return { pcChannelId: id, mobileChannelId: id }
}

// item당 광고그룹을 이름으로 조회 후 없을 때만 생성 — 재시도가 POST /ncc/adgroups를 중복 호출해
// 실계정에 중복 광고그룹을 만드는 것을 막는다(ensureCampaign과 동일한 idempotency 패턴).
async function ensureAdgroup(
  api: AdApi, campaignId: string, item: PlanItem, firm: Firm, channel: ChannelIds,
): Promise<{ id: string; raw: unknown }> {
  const existing = await api.request<Array<Record<string, unknown>>>('GET', '/ncc/adgroups', {
    // VERIFY-LIVE: 목록 조회 쿼리 파라미터명 — POST body 관례상 nccCampaignId로 추정(고신뢰),
    // 공식 문서 미확인 — 실계정 첫 실행 시 확인.
    query: { nccCampaignId: campaignId },
  })
  const found = Array.isArray(existing) ? existing.find((a) => a.name === item.adgroupName) : undefined
  const foundId = found ? extractId(found, 'nccAdgroupId') : null
  if (foundId) return { id: foundId, raw: found }

  const created = await api.request<Record<string, unknown>>('POST', '/ncc/adgroups', {
    body: {
      name: item.adgroupName,
      nccCampaignId: campaignId,
      pcChannelId: channel.pcChannelId,
      mobileChannelId: channel.mobileChannelId,
      bidAmt: firm.adConfig?.bidAmt ?? DEFAULT_BID_AMT,
      ...(firm.adConfig?.dailyBudget ? { dailyBudget: firm.adConfig.dailyBudget, useDailyBudget: true } : {}),
    },
  })
  const id = extractId(created, 'nccAdgroupId')
  if (!id) throw new Error(`item ${item.slug}: adgroup 생성 응답에 nccAdgroupId 없음: ${JSON.stringify(created)}`)
  return { id, raw: created }
}

async function loadStatus(db: Db, firmId: number, keywordId: string): Promise<FirmKeywordStatus> {
  const [row] = await db.select({ status: firmKeywords.status }).from(firmKeywords)
    .where(and(eq(firmKeywords.firmId, firmId), eq(firmKeywords.keywordId, keywordId)))
  if (!row) throw new Error(`firm_keywords row not found (firm ${firmId}, keyword ${keywordId})`)
  return row.status as FirmKeywordStatus
}

async function setStatus(
  db: Db, firmId: number, keywordId: string, status: FirmKeywordStatus,
  extra: { lastError?: string | null; naverAdgroupId?: string } = {},
): Promise<void> {
  await db.update(firmKeywords)
    .set({ status, updatedAt: new Date(), ...extra })
    .where(and(eq(firmKeywords.firmId, firmId), eq(firmKeywords.keywordId, keywordId)))
}

async function registerItem(
  db: Db, api: AdApi, firm: Firm, item: PlanItem, getCampaignId: () => Promise<string>, channel: ChannelIds,
): Promise<void> {
  if (!item.creative) throw new Error(`item ${item.slug}: creative 없음 (계획 단계 skip 누락)`)

  // ② 캠페인 확보 (firm당 1회 — 메모이즈된 getCampaignId + firm_ad_entities 유니크 제약으로 이중 삽입 방지)
  const campaignId = await getCampaignId()
  await db.insert(firmAdEntities).values({
    firmId: firm.id, entityType: 'campaign', naverId: campaignId, reviewStatus: 'approved',
  }).onConflictDoNothing({ target: ENTITY_UNIQUE_TARGET })

  // ③ adgroup 확보 (item당 1회 — 이름 조회 후 재사용, 없을 때만 생성)
  const adgroup = await ensureAdgroup(api, campaignId, item, firm, channel)
  const adgroupId = adgroup.id
  await db.insert(firmAdEntities).values({
    firmId: firm.id, entityType: 'adgroup', keywordId: item.keywordId,
    naverId: adgroupId, reviewStatus: 'approved', raw: adgroup.raw,
  }).onConflictDoNothing({ target: ENTITY_UNIQUE_TARGET })

  // ④ keywords 벌크 — 확정: naver/searchad-apidoc 샘플. adgroupId는 바디가 아니라 쿼리
  // 파라미터(nccAdgroupId)로 전달하고, 각 키워드는 그룹 기본입찰가를 따른다(useGroupBidAmt).
  const keywordsRes = await api.request<Array<Record<string, unknown>>>('POST', '/ncc/keywords', {
    query: { nccAdgroupId: adgroupId },
    body: item.variants.map((v) => ({ keyword: v.text, useGroupBidAmt: true })),
  })
  if (!Array.isArray(keywordsRes) || keywordsRes.length !== item.variants.length) {
    throw new Error(`item ${item.slug}: keywords 응답 개수 불일치: ${JSON.stringify(keywordsRes)}`)
  }
  for (let i = 0; i < item.variants.length; i++) {
    const { text, rule } = item.variants[i]
    const keywordNaverId = extractId(keywordsRes[i], 'nccKeywordId')
    if (!keywordNaverId) {
      throw new Error(`item ${item.slug}: keyword[${text}] 응답에 nccKeywordId 없음: ${JSON.stringify(keywordsRes[i])}`)
    }
    // 계획이 들고 온 rule(base/alias/suffix:…)을 그대로 기록한다 — 'engine' 리터럴로 뭉개면
    // 어떤 규칙이 만든 변형인지 사후에 복원할 수 없다 (최종 리뷰 F7).
    const [variantRow] = await db.insert(keywordVariants)
      .values({ keywordId: item.keywordId, text, rule })
      .onConflictDoUpdate({
        target: [keywordVariants.keywordId, keywordVariants.text],
        set: { text, rule },
      })
      .returning()
    await db.insert(firmAdEntities).values({
      firmId: firm.id, entityType: 'keyword', keywordId: item.keywordId, variantId: variantRow.id,
      naverId: keywordNaverId, reviewStatus: 'pending', raw: keywordsRes[i],
    }).onConflictDoNothing({ target: ENTITY_UNIQUE_TARGET })
  }

  // ⑤ ads — 확정: naver/searchad-apidoc 샘플. type 'TEXT_45'(텍스트 확장소재), pc/mobile 각각
  // { final } 랜딩 URL을 갖는 중첩 구조(기존 평면 pcLandingUrl 대체).
  const adRes = await api.request<Record<string, unknown>>('POST', '/ncc/ads', {
    body: {
      nccAdgroupId: adgroupId,
      type: 'TEXT_45',
      ad: {
        headline: item.creative.title,
        description: item.creative.description,
        pc: { final: item.creative.landingUrl },
        mobile: { final: item.creative.landingUrl },
      },
    },
  })
  const adId = extractId(adRes, 'nccAdId')
  if (!adId) throw new Error(`item ${item.slug}: ad 응답에 nccAdId 없음: ${JSON.stringify(adRes)}`)
  await db.insert(firmAdEntities).values({
    firmId: firm.id, entityType: 'ad', keywordId: item.keywordId, naverId: adId, reviewStatus: 'pending', raw: adRes,
  }).onConflictDoNothing({ target: ENTITY_UNIQUE_TARGET })

  // ⑥ 성공 — ad_pending → ad_registered
  assertTransition('ad_pending', 'ad_registered')
  await setStatus(db, firm.id, item.keywordId, 'ad_registered', { lastError: null, naverAdgroupId: adgroupId })
}

export async function executeRegistration(
  db: Db, api: AdApi, firm: Firm, plan: RegistrationPlan,
): Promise<{ registered: number; failed: number; channelMissing?: boolean }> {
  let registered = 0
  let failed = 0

  // 처리할 항목이 하나도 없으면(전부 계획 단계 skip) 채널 확인 자체를 생략한다 — api 호출 0회
  // 불변식(기존 skipped 항목 테스트)을 유지하기 위함이다.
  const hasWork = plan.items.some((item) => !item.skipped)
  let channel: ChannelIds | null = null
  if (hasWork) {
    channel = await ensureChannel(api, firm)
    // 채널을 확보 못 하면 adgroup을 만들 수 없다 — 개별 항목이 아니라 firm 등록 전체를 skip한다
    // (부분적으로 잘못된 채널에 일부만 등록되는 상태를 만들지 않는다).
    if (!channel) return { registered, failed, channelMissing: true }
  }

  let campaignId: string | null = null
  const getCampaignId = async (): Promise<string> => {
    if (!campaignId) campaignId = await ensureCampaign(api, firm.id)
    return campaignId
  }

  for (const item of plan.items) {
    if (item.skipped) continue

    let enteredPending = false
    try {
      // ① subscribed → ad_pending
      const from = await loadStatus(db, firm.id, item.keywordId)
      assertTransition(from, 'ad_pending')
      await setStatus(db, firm.id, item.keywordId, 'ad_pending')
      enteredPending = true

      await registerItem(db, api, firm, item, getCampaignId, channel as ChannelIds)
      registered++
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (enteredPending) {
        assertTransition('ad_pending', 'subscribed')
        await setStatus(db, firm.id, item.keywordId, 'subscribed', { lastError: message })
      }
      failed++
    }
  }

  return { registered, failed }
}
