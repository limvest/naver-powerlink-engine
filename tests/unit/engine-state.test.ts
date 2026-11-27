import { describe, it, expect } from 'vitest'
import { canTransition, assertTransition } from '@/lib/engine/state'

describe('firm_keywords 상태머신', () => {
  it.each([
    ['subscribed', 'ad_pending', true],
    ['ad_pending', 'ad_registered', true],
    ['ad_pending', 'subscribed', true],   // 등록 실패 롤백
    ['ad_pending', 'rejected', true],
    ['ad_registered', 'live', true],
    ['ad_registered', 'rejected', true],
    ['live', 'paused', true],             // blocklist·수동 중지
    ['paused', 'subscribed', true],
    ['paused', 'ad_registered', true],    // 네이버 광고 통합 §D5 — 올리기(userLock 해제) 반영
    ['rejected', 'subscribed', true],     // 소재 수정 후 재시도
    ['subscribed', 'live', false],        // 단계 건너뛰기 금지
    ['live', 'subscribed', false],
    ['rejected', 'live', false],
  ] as const)('%s → %s = %s', (from, to, ok) => {
    expect(canTransition(from, to)).toBe(ok)
    if (!ok) expect(() => assertTransition(from, to)).toThrow()
  })
})
