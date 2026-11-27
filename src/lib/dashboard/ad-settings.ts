// src/lib/dashboard/ad-settings.ts — 고객 쓰기 액션 3종의 코어(의사·설정·자격증명).
// 네이버 광고 설정·검증 계약. 제품 방향은 README.md를 따른다.
// pglite로 직접 테스트하기 위해 'use server' 래퍼(src/lib/dashboard/actions.ts)와 분리한다
// (toggleSubscriptionForFirm/updateLeadStatusForFirm과 동일한 분리 패턴).
import { and, eq } from 'drizzle-orm'
import type { Db } from '@/lib/db/client'
import { firms, firmKeywords, firmCredentials, type FirmAdConfig } from '@/lib/db/schema'
import { encryptCred } from '@/lib/engine/cred-crypto'
import { NaverApiError, NaverSearchAdClient, type NaverCreds } from '@/lib/engine/naver/client'
import { matchChannel, naverChannelId, naverChannelReady, type NaverChannelRaw } from '@/lib/engine/naver/channel'
import type { Firm } from '@/lib/engine/firms'

const PROVIDER = 'naver_searchad' as const
const DEFAULT_BID_AMT = 70

/**
 * setAdDesiredForFirm — 사건명별 올리기/내리기 의사표시(스펙 §B — firm_keywords.adDesired,
 * 고객 소유 유일 컬럼). firm 스코프 update이며, 아직 구독하지 않은(행 없는) 키워드에 대한 호출은
 * 조용히 무시한다(구독 생성은 toggleSubscriptionForFirm/CLI 소유 — 여기선 새 행을 만들지 않는다).
 */
export async function setAdDesiredForFirm(
  db: Db, firm: Firm, keywordId: string, desired: boolean,
): Promise<void> {
  await db
    .update(firmKeywords)
    .set({ adDesired: desired, updatedAt: new Date() })
    .where(and(eq(firmKeywords.firmId, firm.id), eq(firmKeywords.keywordId, keywordId)))
}

export type SaveAdConfigInput = { bidAmt: number; dailyBudget: number }
export type SaveAdConfigResult = { ok: true } | { ok: false; error: string }

function isNonNegativeInt(n: number): boolean {
  return Number.isInteger(n) && n >= 0
}

/**
 * saveAdConfigForFirm — 기본 입찰 기준액·일예산 저장(스펙 §B·A2). 검증: 둘 다 정수, 기준액은
 * DEFAULT_BID_AMT(70) 이상, 일예산은 0 이상(0 = 미사용). 에러 문구는 컴플라이언스 렉시콘과
 * 충돌하는 광고 도메인 용어("입찰" 등)를 피한다 — findBannedTerms([]) 불변식(브리프 지시).
 * 기존 adConfig의 채널 캐시 필드(channelOk/channelCheckedAt/pcChannelId/mobileChannelId)는
 * saveCredentialsForFirm이 별도로 관리하므로 여기서는 그대로 보존 병합한다.
 */
export async function saveAdConfigForFirm(
  db: Db, firm: Firm, input: SaveAdConfigInput,
): Promise<SaveAdConfigResult> {
  if (!Number.isInteger(input.bidAmt) || input.bidAmt < DEFAULT_BID_AMT) {
    return { ok: false, error: `기준 금액은 ${DEFAULT_BID_AMT}원 이상 정수만 가능합니다` }
  }
  if (!isNonNegativeInt(input.dailyBudget)) {
    return { ok: false, error: '일예산은 0 이상 정수만 가능합니다' }
  }

  const existing = firm.adConfig
  const next: FirmAdConfig = {
    ...(existing ?? {}),
    bidAmt: input.bidAmt,
    dailyBudget: input.dailyBudget,
    useDailyBudget: input.dailyBudget > 0,
  }
  await db.update(firms).set({ adConfig: next }).where(eq(firms.id, firm.id))
  return { ok: true }
}

export type NaverErrorCategory = 'auth' | 'network' | 'unknown'

// NaverApiError body 원문은 카테고리로만 환원한다 — 원문을 반환·로그하지 않는다(스펙 §F).
function categorizeNaverError(err: unknown): NaverErrorCategory {
  if (err instanceof NaverApiError) {
    if (err.status === 401 || err.status === 403) return 'auth'
    if (err.status >= 500) return 'network'
    return 'unknown'
  }
  return 'network' // fetch 자체 실패(TypeError 등) — 응답조차 못 받은 경우
}

export type MakeNaverClient = (creds: NaverCreds) => Pick<NaverSearchAdClient, 'request'>
export type SaveCredentialsInput = { customerId: string; apiKey: string; secret: string }
export type SaveCredentialsDeps = { makeClient?: MakeNaverClient }
export type SaveCredentialsResult = {
  ok: boolean
  verified: boolean
  channelOk: boolean
  errorCategory?: NaverErrorCategory
}

// withChannelCache — firm.adConfig의 채널 캐시 4필드(channelOk/channelCheckedAt/pcChannelId/
// mobileChannelId)를 매번 완전히 새로 쓴다(조건부 병합 금지 — 아래 saveCredentialsForFirm 주석
// 참조). 검증 성공/실패 두 경로 모두 이 헬퍼를 거쳐야 채널 캐시가 갈라지지 않는다(최종 리뷰 I2).
function withChannelCache(
  existing: FirmAdConfig | null, channelOk: boolean, pcChannelId?: string, mobileChannelId?: string,
): FirmAdConfig {
  return {
    bidAmt: existing?.bidAmt ?? DEFAULT_BID_AMT,
    dailyBudget: existing?.dailyBudget ?? 0,
    useDailyBudget: existing?.useDailyBudget ?? false,
    ...(existing ?? {}),
    channelOk,
    channelCheckedAt: new Date().toISOString(),
    pcChannelId,
    mobileChannelId,
  }
}

/**
 * saveCredentialsForFirm — 자격증명 암호화 upsert(firm당 provider 'naver_searchad' 1행,
 * 스펙 §A1) → 검증 핑 GET /ncc/campaigns 1회(성공 시 verifiedAt 기록) → 성공 시에만 GET
 * /ncc/channels 1회로 firm.domain 매칭 채널 탐색 → 결과를 firms.adConfig에 캐시. 검증 실패
 * 시에도(최종 리뷰 I2) withChannelCache(existing, false)로 채널 캐시 4필드를 초기화한다 —
 * 이전 자격증명 시절의 channelOk/pcChannelId/mobileChannelId가 새 자격증명 아래 유효한 것처럼
 * 오인되어 버튼 게이팅·엔진(ensureChannel)에 소비되는 사고를 막는다.
 *
 * 보안 불변식(스펙 §F, 브리프 바인딩): 시크릿·API키 원문은 암호화 저장 경로 밖 어디에도
 * 노출하지 않는다 — 반환값·throw·로그 전부. NaverApiError.body(원문 에러 메시지)도 절대
 * 반환·로그하지 않고 categorizeNaverError로 카테고리만 뽑아 쓴다. 대시보드는 쓰기(POST/PUT/
 * DELETE) API를 호출하지 않는다 — 여기서 만드는 호출은 GET 2종(campaigns·channels)뿐이며,
 * 실제 호출 여부는 makeClient가 주입한 클라이언트(테스트에서는 기록 목)로 검증한다. 암호화
 * 단계(encryptCred) 자체가 실패하면(CRED_ENC_KEY 미설정 등, 최종 리뷰 I1-code) DB 쓰기 전에
 * 조기 반환해 500 대신 error=cred-unknown 배너로 흡수한다.
 */
export async function saveCredentialsForFirm(
  db: Db, firm: Firm, input: SaveCredentialsInput, deps: SaveCredentialsDeps = {},
): Promise<SaveCredentialsResult> {
  const creds: NaverCreds = { customerId: input.customerId, apiKey: input.apiKey, secret: input.secret }

  let apiKeyEnc: string
  let secretEnc: string
  try {
    apiKeyEnc = encryptCred(input.apiKey)
    secretEnc = encryptCred(input.secret)
  } catch {
    // CRED_ENC_KEY 미설정·형식 오류 등 암호화 계층 자체의 설정 문제(최종 리뷰 I1-code) — 고객
    // 화면이 500으로 죽는 대신 기존 error=cred-unknown 배너 분기(buildCredentialsRedirectQuery,
    // src/lib/dashboard/actions.ts)를 그대로 태운다. 시크릿·에러 원문은 여기서도 절대 노출하지
    // 않는다(catch에 err 자체를 담지 않음). 실제 prod env에 키를 설정하는 것은 컨트롤러 몫이다.
    return { ok: false, verified: false, channelOk: false, errorCategory: 'unknown' }
  }

  await db
    .insert(firmCredentials)
    .values({
      firmId: firm.id,
      provider: PROVIDER,
      customerId: input.customerId,
      apiKeyEnc,
      secretEnc,
      verifiedAt: null,
    })
    .onConflictDoUpdate({
      target: [firmCredentials.firmId, firmCredentials.provider],
      set: { customerId: input.customerId, apiKeyEnc, secretEnc, verifiedAt: null },
    })

  const makeClient = deps.makeClient ?? ((c: NaverCreds) => new NaverSearchAdClient(c))
  const client = makeClient(creds)

  let verified = false
  let errorCategory: NaverErrorCategory | undefined
  try {
    await client.request('GET', '/ncc/campaigns')
    verified = true
  } catch (err) {
    errorCategory = categorizeNaverError(err)
  }

  let channelOk = false
  if (verified) {
    await db
      .update(firmCredentials)
      .set({ verifiedAt: new Date() })
      .where(and(eq(firmCredentials.firmId, firm.id), eq(firmCredentials.provider, PROVIDER)))

    let pcChannelId: string | undefined
    let mobileChannelId: string | undefined
    try {
      const channels = await client.request<NaverChannelRaw[]>('GET', '/ncc/channels')
      const match = matchChannel(channels, firm.domain)
      const matchedId = naverChannelId(match)
      if (matchedId && naverChannelReady(match)) {
        channelOk = true
        pcChannelId = matchedId
        mobileChannelId = matchedId
      }
    } catch {
      // 채널 조회 실패는 인증 핑(campaigns)과 별개 신호다 — 자격증명 자체는 이미 유효하다고
      // 확인됐으므로(verified=true) errorCategory를 여기서 덮어쓰지 않는다. channelOk=false로
      // 남기고 "미확인" 상태를 그대로 캐시한다.
    }

    // pcChannelId/mobileChannelId는 매번 이번 조회 결과로 완전히 덮어쓴다(조건부 병합 금지) —
    // 이전에 매칭됐던 채널이 이번엔 안 잡히면(도메인 변경·채널 삭제 등) 오래된 id가 캐시에
    // 남아 Task 3(ensureChannel)이 더 이상 유효하지 않을 수 있는 채널로 등록을 시도하는 사고를
    // 막는다 — channelOk=false와 함께 항상 짝을 이뤄 초기화된다.
    const nextAdConfig = withChannelCache(firm.adConfig, channelOk, pcChannelId, mobileChannelId)
    await db.update(firms).set({ adConfig: nextAdConfig }).where(eq(firms.id, firm.id))
  } else {
    // 검증 핑(GET /ncc/campaigns) 실패 — 새 자격증명은 아직 유효성이 확인되지 않았다. 이전
    // 자격증명 시절의 채널 캐시(channelOk/pcChannelId/mobileChannelId)가 그대로 남으면 버튼
    // 게이팅(keywords/page.tsx)과 엔진(register-run.ts ensureChannel)이 더 이상 이 자격증명으로
    // 유효하다고 보장되지 않는 stale 채널을 유효한 것처럼 소비한다(최종 리뷰 I2) — verifiedAt
    // 리셋(위 upsert에서 이미 null)과 같은 시점에 채널 캐시 4필드도 초기화한다.
    const nextAdConfig = withChannelCache(firm.adConfig, false)
    await db.update(firms).set({ adConfig: nextAdConfig }).where(eq(firms.id, firm.id))
  }

  return { ok: true, verified, channelOk, errorCategory }
}
