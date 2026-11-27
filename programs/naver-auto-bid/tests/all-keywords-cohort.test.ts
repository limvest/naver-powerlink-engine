import { describe, expect, it } from 'vitest'
import { isServingEligibleRow } from '../src/all-keywords-cohort'

describe('all-keywords serving eligibility', () => {
  it('excludes paused or locked campaign and group rows', () => {
    expect(isServingEligibleRow({ status: 'ELIGIBLE', userLock: false })).toBe(true)
    expect(isServingEligibleRow({ status: 'PAUSED', statusReason: 'ADGROUP_PAUSED' })).toBe(false)
    expect(isServingEligibleRow({ status: 'ELIGIBLE', userLock: true })).toBe(false)
  })

  it('requires keyword review approval when requested', () => {
    expect(isServingEligibleRow({ status: 'ELIGIBLE', inspectStatus: 'APPROVED', userLock: false }, true)).toBe(true)
    expect(isServingEligibleRow({ status: 'PAUSED', inspectStatus: 'PENDING' }, true)).toBe(false)
    expect(isServingEligibleRow({ status: 'ELIGIBLE', inspectStatus: 'DISAPPROVED' }, true)).toBe(false)
    expect(isServingEligibleRow({ status: 'ELIGIBLE' }, true)).toBe(false)
    expect(isServingEligibleRow({ status: 'ELIGIBLE', inspectStatus: 'UNDER_REVIEW' }, true)).toBe(false)
  })
})
