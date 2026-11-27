// src/lib/engine/reconcile-ads.ts — 고객 올리기/내리기 의사(firm_keywords.adDesired)를 실제
// 네이버 광고그룹 userLock에 반영하고, firm_keywords.status를 그에 맞춰 전이시킨다 (스펙 §D5).
//
// 대조 행렬(브리프 확정, 4조합 + 최종 리뷰 C1 blocklist 예외):
//   desired=false ∧ status∈{ad_registered, live} ∧ naverAdgroupId 존재
//     → PUT /ncc/adgroups/{naverAdgroupId}?fields=userLock body { nccAdgroupId, userLock: true }
//       (공식 python 샘플의 keywords userLock 갱신 패턴을 adgroups에 적용한 것 —
//       VERIFY-LIVE: fields 파라미터 실동작은 실계정 첫 실행 시 확인)
//     → assertTransition(현재, 'paused') 통과 후 status→paused. lowered++
//   desired=true ∧ status='paused' ∧ naverAdgroupId 존재 ∧ slug가 blocklist에 없음
//     → PUT 동일 경로 { nccAdgroupId, userLock: false }
//     → assertTransition('paused', 'ad_registered') 통과 후 status→ad_registered. raised++
//       (이후 심사·라이브 전환은 기존 poll-reviews가 처리)
//   desired=true ∧ status='paused' ∧ slug가 blocklist에 있음(최종 리뷰 C1)
//     → raise 후보에서 제외 — API 미호출·상태 무변경(no-op). review-sync.pauseBlockedKeywords가
//       내린 차단 잠금을 adDesired 기본값(true)만으로 되살리는 경로를 막는다. lowered/raised/
//       skipped 어디에도 카운트되지 않는다(register-ads CLI의 blockedSlugs 배제와 동일하게
//       "차단"은 별도 실패가 아니라 애초에 후보가 아니다).
//   naverAdgroupId 없음(미등록 — 후보이나 실행 불가) → 상태 무변경. skipped++
//     (등록 계획에서의 제외/포함 자체는 Task 3의 registration-plan.adDesired 필터 몫)
//   그 외 조합(desired와 status가 이미 정합) → no-op — API 호출·카운트 모두 없음
//
// API 실패 시 해당 행은 lastError만 기록하고 상태는 무변경(review-sync 부분 실패 보존 관행) —
// 나머지 행 처리는 계속된다(all-or-nothing 금지).
//
// computeReconcileCandidates는 위 행렬 판정을 DB·API 없이 재현하는 순수 함수다 — reconcileAds
// (실행)와 scripts/engine/reconcile-ads.ts의 dry 집계가 이 한 함수를 공유해야, 두 곳의 판정
// 로직이 갈라져 "dry가 보여준 후보 수"와 "live가 실제로 처리한 수"가 어긋나는 사고
// (최종 리뷰 T4)를 막는다.
import { and, eq } from 'drizzle-orm'
import type { Db } from '@/lib/db/client'
import { firmKeywords, keywords } from '@/lib/db/schema'
import type { Firm } from './firms'
import type { AdApi } from './register-run'
import { assertTransition, type FirmKeywordStatus } from './state'

const LOWERABLE_STATUSES: readonly FirmKeywordStatus[] = ['ad_registered', 'live']

export type ReconcileRow = {
  keywordId: string
  slug: string
  status: FirmKeywordStatus
  adDesired: boolean
  naverAdgroupId: string | null
}

export type ReconcileCandidates = {
  lower: ReconcileRow[]
  raise: ReconcileRow[]
  skipped: number
}

/**
 * computeReconcileCandidates — 대조 행렬 판정의 단일 소스(순수 함수, 부수효과 없음). blockedSlugs에
 * 속한 slug의 행은 desired=true∧status=paused여도 raise 후보에서 제외한다(최종 리뷰 C1) — 이
 * 제외는 skipped로도 세지 않는다: "실행 불가한 후보"가 아니라 "애초에 후보가 아님"이기 때문이다.
 */
export function computeReconcileCandidates(
  rows: readonly ReconcileRow[], blockedSlugs: ReadonlySet<string>,
): ReconcileCandidates {
  const lower: ReconcileRow[] = []
  const raise: ReconcileRow[] = []
  let skipped = 0

  for (const row of rows) {
    const wantsLower = !row.adDesired && LOWERABLE_STATUSES.includes(row.status)
    const wantsRaise = row.adDesired && row.status === 'paused' && !blockedSlugs.has(row.slug)
    if (!wantsLower && !wantsRaise) continue // 그 외 조합(이미 정합, 또는 blocklist 예외) — no-op

    if (!row.naverAdgroupId) { skipped++; continue } // 미등록 — 실행 불가, 상태 무변경

    if (wantsLower) lower.push(row)
    else raise.push(row)
  }

  return { lower, raise, skipped }
}

async function setStatus(
  db: Db, firmId: number, keywordId: string, status: FirmKeywordStatus,
  extra: { lastError?: string | null } = {},
): Promise<void> {
  await db.update(firmKeywords)
    .set({ status, updatedAt: new Date(), ...extra })
    .where(and(eq(firmKeywords.firmId, firmId), eq(firmKeywords.keywordId, keywordId)))
}

export async function reconcileAds(
  db: Db, api: AdApi, firm: Firm, blockedSlugs: ReadonlySet<string> = new Set(),
): Promise<{ lowered: number; raised: number; skipped: number }> {
  let lowered = 0
  let raised = 0

  const rows = await db.select({
    keywordId: firmKeywords.keywordId,
    slug: keywords.slug,
    status: firmKeywords.status,
    adDesired: firmKeywords.adDesired,
    naverAdgroupId: firmKeywords.naverAdgroupId,
  }).from(firmKeywords)
    .innerJoin(keywords, eq(firmKeywords.keywordId, keywords.id))
    .where(eq(firmKeywords.firmId, firm.id))

  const { lower, raise, skipped } = computeReconcileCandidates(
    rows.map((r) => ({ ...r, status: r.status as FirmKeywordStatus })),
    blockedSlugs,
  )

  for (const row of lower) {
    const ok = await applyUserLock(db, api, firm.id, row, true)
    if (ok) lowered++
  }
  for (const row of raise) {
    const ok = await applyUserLock(db, api, firm.id, row, false)
    if (ok) raised++
  }

  return { lowered, raised, skipped }
}

// userLock 갱신 1건 실행 — 성공 시 상태 전이하고 true, 실패 시 lastError만 기록하고 false를
// 반환한다(호출부가 lowered/raised 카운트 여부를 결정 — 부분 실패 보존 관행).
async function applyUserLock(
  db: Db, api: AdApi, firmId: number, row: ReconcileRow, userLock: boolean,
): Promise<boolean> {
  const naverAdgroupId = row.naverAdgroupId!
  try {
    await api.request('PUT', `/ncc/adgroups/${naverAdgroupId}`, {
      query: { fields: 'userLock' },
      body: { nccAdgroupId: naverAdgroupId, userLock },
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await setStatus(db, firmId, row.keywordId, row.status, { lastError: message })
    return false // 부분 실패 보존 — 이 행은 카운트되지 않고 다음 행으로 진행
  }

  const target: FirmKeywordStatus = userLock ? 'paused' : 'ad_registered'
  assertTransition(row.status, target)
  await setStatus(db, firmId, row.keywordId, target, { lastError: null })
  return true
}
