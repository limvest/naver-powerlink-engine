import { describe, expect, it } from 'vitest'
import { shouldUnlockApprovedKeyword } from '@/lib/engine/naver/bulk-search-run'

describe('Naver approved keyword activation', () => {
  it('unlocks only approved or eligible locked keywords', () => {
    expect(shouldUnlockApprovedKeyword({ inspectStatus: 'APPROVED', userLock: true })).toBe(true)
    expect(shouldUnlockApprovedKeyword({ inspectStatus: 'ELIGIBLE', userLock: 1 })).toBe(true)
    expect(shouldUnlockApprovedKeyword({ inspectStatus: 'APPROVED', userLock: false })).toBe(false)
    expect(shouldUnlockApprovedKeyword({ inspectStatus: 'DENIED', userLock: true })).toBe(false)
    expect(shouldUnlockApprovedKeyword({ statusReason: 'KEYWORD_DISAPPROVED', userLock: true })).toBe(false)
    expect(shouldUnlockApprovedKeyword({ inspectStatus: 'PENDING', userLock: true })).toBe(false)
  })
})
