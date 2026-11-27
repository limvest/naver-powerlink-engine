// src/lib/engine/review-sync.ts — 심사 결과 동기화 + blocklist 중지 훅 (스펙 §4.2·§4.3).
//
// applyReviewResults: 폴링 CLI가 조회해온 개별 keyword/ad 심사 결과를 firm_ad_entities에 반영하고,
// keyword 단위로 재판정한다 — 그 keyword에 속한 keyword·ad 엔티티가 전부 approved면
// ad_registered→live, 하나라도 rejected면 ad_registered→rejected(+최초 rejectReason을 lastError로),
// 그 외(일부 pending)는 유지. campaign/adgroup 엔티티는 keyword FK가 없거나 재판정 대상이 아니므로
// 제외. 재판정은 firm_keywords.status가 정확히 'ad_registered'일 때만 시도한다 — 이미 live/rejected/
// paused로 넘어간 keyword를 재폴링해도 조용히 스킵되어(no-op) 여러 번 돌려도 안전(idempotent)하다.
// 상태 갱신은 반드시 assertTransition 게이트를 통과한다.
//
// pauseBlockedKeywords: blocklist 등재 slug의 구독을 상태머신상 가능한 전이(live/ad_registered/
// subscribed → paused)로만 내린다. api가 주어지면(null이 아니면) 해당 keyword의 adgroup 엔티티마다
// 광고그룹 중지 API를 호출한다 — api가 null이면 상태만 내리는 dry 환경 동작.
import { and, eq, inArray } from 'drizzle-orm'
import type { Db } from '@/lib/db/client'
import { firmAdEntities, firmKeywords, keywords } from '@/lib/db/schema'
import type { AdApi } from './register-run'
import { assertTransition, canTransition, type FirmKeywordStatus } from './state'

export type ReviewResult = {
  naverId: string
  entityType: 'keyword' | 'ad'
  reviewStatus: 'approved' | 'rejected'
  reason?: string
}

const JUDGED_ENTITY_TYPES = ['keyword', 'ad'] as const

export async function applyReviewResults(
  db: Db, firmId: number, results: ReviewResult[],
): Promise<{ updated: number; wentLive: number; wentRejected: number }> {
  let updated = 0
  const touchedKeywordIds = new Set<string>()

  for (const r of results) {
    const [entity] = await db.select().from(firmAdEntities).where(and(
      eq(firmAdEntities.firmId, firmId),
      eq(firmAdEntities.entityType, r.entityType),
      eq(firmAdEntities.naverId, r.naverId),
    ))
    if (!entity) continue // 모르는 naverId는 무시

    await db.update(firmAdEntities)
      .set({ reviewStatus: r.reviewStatus, rejectReason: r.reason ?? null, updatedAt: new Date() })
      .where(eq(firmAdEntities.id, entity.id))
    updated++
    if (entity.keywordId) touchedKeywordIds.add(entity.keywordId)
  }

  let wentLive = 0
  let wentRejected = 0

  for (const keywordId of touchedKeywordIds) {
    const [fk] = await db.select().from(firmKeywords)
      .where(and(eq(firmKeywords.firmId, firmId), eq(firmKeywords.keywordId, keywordId)))
    if (!fk || fk.status !== 'ad_registered') continue // ad_registered일 때만 재판정 대상

    const entities = await db.select().from(firmAdEntities).where(and(
      eq(firmAdEntities.firmId, firmId),
      eq(firmAdEntities.keywordId, keywordId),
      inArray(firmAdEntities.entityType, JUDGED_ENTITY_TYPES),
    )).orderBy(firmAdEntities.createdAt, firmAdEntities.id)
    if (entities.length === 0) continue

    const allApproved = entities.every((e) => e.reviewStatus === 'approved')
    const firstRejected = entities.find((e) => e.reviewStatus === 'rejected')

    if (allApproved) {
      assertTransition('ad_registered', 'live')
      await db.update(firmKeywords).set({ status: 'live', updatedAt: new Date() })
        .where(and(eq(firmKeywords.firmId, firmId), eq(firmKeywords.keywordId, keywordId)))
      wentLive++
    } else if (firstRejected) {
      assertTransition('ad_registered', 'rejected')
      await db.update(firmKeywords)
        .set({ status: 'rejected', lastError: firstRejected.rejectReason ?? null, updatedAt: new Date() })
        .where(and(eq(firmKeywords.firmId, firmId), eq(firmKeywords.keywordId, keywordId)))
      wentRejected++
    }
    // 그 외(일부 pending 남음) — 유지, no-op
  }

  return { updated, wentLive, wentRejected }
}

export async function pauseBlockedKeywords(
  db: Db, api: AdApi | null, firmId: number, blockedSlugs: Set<string>,
): Promise<{ paused: number }> {
  if (blockedSlugs.size === 0) return { paused: 0 }

  const rows = await db.select({
    keywordId: firmKeywords.keywordId,
    status: firmKeywords.status,
    slug: keywords.slug,
  }).from(firmKeywords)
    .innerJoin(keywords, eq(firmKeywords.keywordId, keywords.id))
    .where(eq(firmKeywords.firmId, firmId))

  let paused = 0
  for (const row of rows) {
    if (!blockedSlugs.has(row.slug)) continue
    const from = row.status as FirmKeywordStatus
    if (!canTransition(from, 'paused')) continue // 상태머신상 불가능한 전이(예: ad_pending, 이미 paused)는 건너뜀
    assertTransition(from, 'paused')
    await db.update(firmKeywords).set({ status: 'paused', updatedAt: new Date() })
      .where(and(eq(firmKeywords.firmId, firmId), eq(firmKeywords.keywordId, row.keywordId)))
    paused++

    if (api) {
      const adgroups = await db.select().from(firmAdEntities).where(and(
        eq(firmAdEntities.firmId, firmId),
        eq(firmAdEntities.keywordId, row.keywordId),
        eq(firmAdEntities.entityType, 'adgroup'),
      ))
      for (const ag of adgroups) {
        // VERIFY: 광고그룹 중지 엔드포인트·필드명(userLock) — live 전 공식 문서 확인
        await api.request('PUT', `/ncc/adgroups/${ag.naverId}`, { body: { userLock: true } })
      }
    }
  }

  return { paused }
}
