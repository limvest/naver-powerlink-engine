import type { AutoBidConfig } from './config'

export type AutoBidSchedule = {
  timezone: string
  weekdays: number[]
  start: string
  end: string
}

function parts(now: Date, timezone: string): Record<string, string> {
  const values = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now)
  return Object.fromEntries(values.map((value) => [value.type, value.value]))
}

export function isWithinAutoBidSchedule(now: Date, schedule: AutoBidSchedule): boolean {
  if (Number.isNaN(now.getTime()) || !/^\d{2}:\d{2}$/.test(schedule.start)
    || !/^\d{2}:\d{2}$/.test(schedule.end)) return false
  const value = parts(now, schedule.timezone)
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(value.weekday)
  const clock = `${value.hour}:${value.minute}`
  return schedule.weekdays.includes(weekday) && clock >= schedule.start && clock < schedule.end
}

export function configFromPolicy(input: {
  firmId: number
  campaignName: string
  mode: 'dry-run' | 'live'
  runKey: string
  policy: {
    device: string; strategy: string; targetPosition: number; bidFloor: number; bidCeiling: number | null
    stepUp: number; stepDown: number; allowBidDecrease: boolean; exposureBuffer: number
    cooldownMinutes: number; batchSize: number; maxChangesPerRun: number | null
  }
}): AutoBidConfig {
  if (input.mode === 'live' && (input.policy.bidCeiling === null || input.policy.maxChangesPerRun === null)) {
    throw new Error('live policy requires bid ceiling and max changes')
  }
  return {
    firmId: input.firmId,
    campaignName: input.campaignName,
    device: input.policy.device === 'pc' ? 'pc' : 'mobile',
    strategy: input.policy.strategy === 'observed_rank'
      ? 'observed_rank'
      : input.policy.strategy === 'exposure_minimum' ? 'exposure_minimum' : 'target_position',
    targetPosition: input.policy.targetPosition,
    floor: input.policy.bidFloor,
    ceiling: input.policy.bidCeiling,
    stepUp: input.policy.stepUp,
    stepDown: input.policy.stepDown,
    allowBidDecrease: input.policy.allowBidDecrease,
    exposureBuffer: input.policy.exposureBuffer,
    cooldownHours: input.policy.cooldownMinutes / 60,
    batchSize: input.policy.batchSize,
    rankCheckLimit: 50_000,
    rankIntervalMs: 60,
    rankRequestsPerMinute: 1_000,
    rankConcurrency: 24,
    maxChanges: input.policy.maxChangesPerRun,
    mode: input.mode,
    live: input.mode === 'live',
    dryRun: input.mode === 'dry-run',
    stage: 'all',
    runKey: input.runKey,
  }
}
