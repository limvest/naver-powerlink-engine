import { describe, expect, it } from 'vitest'
import { parseArgs, type AutoBidConfig } from '../src/config'

const NOW = new Date('2026-09-07T01:00:00.000Z')

function baseArgs(...args: string[]): string[] {
  return ['--firm', '1001', ...args]
}

describe('Naver auto-bid CLI configuration', () => {
  it('defaults to a mobile dry-run with the PLAN values', () => {
    const config = parseArgs(baseArgs(), { env: {}, now: NOW })

    expect(config).toMatchObject<Partial<AutoBidConfig>>({
      firmId: 1001,
      campaignName: '파워링크#1',
      device: 'mobile',
      floor: 70,
      stepUp: 100,
      exposureBuffer: 10,
      cooldownHours: 6,
      batchSize: 50,
      rankCheckLimit: 50_000,
      rankRequestsPerMinute: 3_000,
      rankConcurrency: 64,
      ceiling: null,
      maxChanges: null,
      mode: 'dry-run',
      dryRun: true,
      stage: 'all',
      runKey: 'naver-auto-bid:1001:2026-09-07',
    })
  })

  it('accepts explicit tuning values and stage aliases', () => {
    const config = parseArgs(baseArgs(
      '--campaign', '파워링크#1',
      '--device', 'pc',
      '--floor', '100',
      '--ceiling', '800',
      '--step-up', '125',
      '--exposure-buffer', '15',
      '--cooldown-hours', '2',
      '--batch-size', '25',
      '--rank-rpm', '900',
      '--rank-concurrency', '18',
      '--max-changes', '7',
      '--stage', 'auto-bid-decide',
      '--run-key', 'test-run-1',
    ), { env: {}, now: NOW })

    expect(config).toMatchObject({
      device: 'pc', floor: 100, ceiling: 800, stepUp: 125,
      exposureBuffer: 15, cooldownHours: 2, batchSize: 25,
      rankRequestsPerMinute: 900, rankConcurrency: 18,
      maxChanges: 7, stage: 'decide', runKey: 'test-run-1', mode: 'dry-run',
    })
  })

  it('refuses live mode without an explicit ceiling and mutation limit', () => {
    expect(() => parseArgs(baseArgs('--live'), { env: {}, now: NOW }))
      .toThrow('--live requires --ceiling')
    expect(() => parseArgs(baseArgs('--live', '--ceiling', '500'), { env: {}, now: NOW }))
      .toThrow('--live requires --max-changes')
    expect(() => parseArgs(baseArgs('--live', '--max-changes', '3'), { env: {}, now: NOW }))
      .toThrow('--live requires --ceiling')
  })

  it('does not let environment bounds satisfy the explicit live flag requirement', () => {
    expect(() => parseArgs(baseArgs('--live'), {
      env: { NAVER_AUTO_BID_CEILING: '500', NAVER_AUTO_BID_MAX_CHANGES: '3' },
      now: NOW,
    })).toThrow('--live requires --ceiling')
  })

  it('rejects contradictory or malformed safety bounds', () => {
    expect(() => parseArgs(baseArgs('--live', '--ceiling', '500', '--max-changes', '3', '--dry-run'), {
      env: {}, now: NOW,
    })).toThrow('--live cannot be combined with --dry-run')
    expect(() => parseArgs(baseArgs('--floor', '801', '--ceiling', '800'), {
      env: {}, now: NOW,
    })).toThrow('--ceiling must be greater than or equal to --floor')
    expect(() => parseArgs(baseArgs('--max-changes', '-1'), { env: {}, now: NOW }))
      .toThrow('--max-changes must be a safe integer')
    expect(() => parseArgs(baseArgs('--max-changes', '0'), { env: {}, now: NOW }))
      .toThrow('--max-changes must be a safe integer')
  })

  it('requires a firm scope and accepts the environment fallback', () => {
    expect(() => parseArgs([], { env: {}, now: NOW })).toThrow('--firm is required')
    expect(parseArgs([], { env: { NAVER_AUTO_BID_FIRM_ID: '17' }, now: NOW }).firmId).toBe(17)
  })
})
