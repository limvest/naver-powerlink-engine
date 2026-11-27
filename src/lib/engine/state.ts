// src/lib/engine/state.ts — firm_keywords.status 전이표 (스펙 §3·§4.2). DB 갱신 전 반드시 assert.
export type FirmKeywordStatus = 'subscribed' | 'ad_pending' | 'ad_registered' | 'live' | 'paused' | 'rejected'

const TRANSITIONS: Record<FirmKeywordStatus, readonly FirmKeywordStatus[]> = {
  subscribed: ['ad_pending', 'paused'],
  ad_pending: ['ad_registered', 'subscribed', 'rejected'],
  ad_registered: ['live', 'rejected', 'paused'],
  live: ['paused'],
  // 'ad_registered' — 네이버 광고 통합 §D5: 고객이 올리기(adDesired=true)를 눌러 reconcile-ads가
  // userLock을 해제하는 경로. 재등록(subscribed 경유) 없이 기존 adgroup을 바로 되살린다.
  paused: ['subscribed', 'ad_registered'],
  rejected: ['subscribed'],
}

export function canTransition(from: FirmKeywordStatus, to: FirmKeywordStatus): boolean {
  return (TRANSITIONS[from] ?? []).includes(to)
}

export function assertTransition(from: FirmKeywordStatus, to: FirmKeywordStatus): void {
  if (!canTransition(from, to)) throw new Error(`illegal firm_keyword transition: ${from} → ${to}`)
}
