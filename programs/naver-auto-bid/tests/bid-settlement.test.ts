import { describe, expect, it } from 'vitest'
import { bidIsSettled, rankQueuePriority } from '../src/bid-settlement'

describe('non-blocking bid settlement', () => {
  const changed = '2026-09-08T01:00:00Z'
  it('waits the full three minutes and fails closed on corrupt timestamps', () => {
    expect(bidIsSettled(changed, Date.parse('2026-09-08T01:02:59Z'))).toBe(false)
    expect(bidIsSettled(changed, Date.parse('2026-09-08T01:03:00Z'))).toBe(true)
    expect(bidIsSettled('bad', Date.now())).toBe(false)
    expect(bidIsSettled(null, Date.now())).toBe(true)
  })
  it('processes another keyword while waiting, then prioritizes the due recheck', () => {
    const before = Date.parse('2026-09-08T01:02:00Z')
    expect(rankQueuePriority(changed, changed, before)).toBe(2)
    expect(rankQueuePriority(null, null, before)).toBe(1)
    const due = Date.parse('2026-09-08T01:03:00Z')
    expect(rankQueuePriority(changed, changed, due)).toBe(0)
    expect(rankQueuePriority(changed, '2026-09-08T01:03:00Z', due)).toBe(1)
  })
})
