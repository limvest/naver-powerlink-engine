import { describe, expect, it } from 'vitest'
import { configFromPolicy, isWithinAutoBidSchedule } from '../src/control-plane'

const schedule = { timezone: 'Asia/Seoul', weekdays: [0, 1, 2, 3, 4, 5, 6], start: '08:00', end: '22:00' }

describe('automatic bidder control plane', () => {
  it('allows only the configured half-open Seoul schedule', () => {
    expect(isWithinAutoBidSchedule(new Date('2026-09-07T23:00:00Z'), schedule)).toBe(true) // Mon 08:00
    expect(isWithinAutoBidSchedule(new Date('2026-09-08T12:59:00Z'), schedule)).toBe(true) // Tue 21:59
    expect(isWithinAutoBidSchedule(new Date('2026-09-08T13:00:00Z'), schedule)).toBe(false) // Tue 22:00
    expect(isWithinAutoBidSchedule(new Date('2026-09-12T03:00:00Z'), schedule)).toBe(true) // Saturday 12:00
    expect(isWithinAutoBidSchedule(new Date('2026-09-13T03:00:00Z'), schedule)).toBe(true) // Sunday 12:00
  })

  it('allows a full-day Seoul schedule', () => {
    const unlimited = { timezone: 'Asia/Seoul', weekdays: [0, 1, 2, 3, 4, 5, 6], start: '00:00', end: '24:00' }
    expect(isWithinAutoBidSchedule(new Date('2026-09-12T02:00:00Z'), unlimited)).toBe(true)
    expect(isWithinAutoBidSchedule(new Date('2026-09-12T15:59:00Z'), unlimited)).toBe(true)
  })

  it('refuses live config without both hard mutation bounds', () => {
    const policy = { device: 'mobile', strategy: 'target_position', targetPosition: 3,
      bidFloor: 70, bidCeiling: null, stepUp: 100, stepDown: 10, allowBidDecrease: true,
      exposureBuffer: 10, cooldownMinutes: 360, batchSize: 50, maxChangesPerRun: null }
    expect(() => configFromPolicy({ firmId: 1, campaignName: 'campaign', mode: 'live', runKey: 'run', policy }))
      .toThrow(/ceiling and max changes/)
  })
})
