/**
 * Command-line configuration for the Naver SearchAd bidder.
 *
 * This module intentionally contains no database or provider imports.  The
 * bidder is being assembled from separate policy/provider adapters, so the
 * command boundary owns parsing and fail-closed safety checks only.
 */

export const AUTO_BID_STAGES = [
  'snapshot',
  'estimate',
  'decide',
  'apply',
  'verify',
  'report',
] as const

export type AutoBidStage = (typeof AUTO_BID_STAGES)[number]
export type AutoBidStageSelector = AutoBidStage | 'all'
export type AutoBidDevice = 'mobile' | 'pc'
export type AutoBidMode = 'dry-run' | 'live'
export type AutoBidStrategy = 'observed_rank' | 'target_position' | 'exposure_minimum'

export const AUTO_BID_DEFAULTS = Object.freeze({
  campaignName: '파워링크#1',
  device: 'mobile' as AutoBidDevice,
  strategy: 'observed_rank' as AutoBidStrategy,
  targetPosition: 3,
  floor: 70,
  stepUp: 100,
  stepDown: 100,
  exposureBuffer: 10,
  cooldownHours: 6,
  batchSize: 50,
  rankCheckLimit: 50_000,
  rankIntervalMs: 20,
  rankRequestsPerMinute: 3_000,
  rankConcurrency: 64,
})

export interface AutoBidConfig {
  /** Explicit operator-authorized acquisition trial: outside +1000, hard cap 4000. */
  readonly fastAcquire4000?: boolean
  readonly legalCompetitorsOnly?: boolean
  /** Explicit one-shot trials must not wait for unrelated historical retention. */
  readonly skipRetention?: boolean
  readonly keywordIds?: readonly string[]
  readonly rankConfirmationReads?: 1 | 3
  readonly firmId: number
  readonly campaignName: string
  readonly device: AutoBidDevice
  readonly strategy: AutoBidStrategy
  readonly targetPosition: number
  readonly floor: number
  /** Null means that a dry-run was not given an operator ceiling. */
  readonly ceiling: number | null
  readonly stepUp: number
  readonly stepDown: number
  readonly allowBidDecrease: boolean
  readonly exposureBuffer: number
  readonly cooldownHours: number
  readonly batchSize: number
  readonly rankCheckLimit: number
  readonly rankIntervalMs: number
  readonly rankRequestsPerMinute: number
  readonly rankConcurrency: number
  /** Null is allowed only for dry-run previews. */
  readonly maxChanges: number | null
  readonly mode: AutoBidMode
  readonly live: boolean
  readonly dryRun: boolean
  readonly stage: AutoBidStageSelector
  readonly runKey: string
}

export type AutoBidConfigErrorCode =
  | 'invalid-arguments'
  | 'live-ceiling-required'
  | 'live-max-changes-required'

export class AutoBidConfigError extends Error {
  readonly code: AutoBidConfigErrorCode

  constructor(message: string, code: AutoBidConfigErrorCode = 'invalid-arguments') {
    super(message)
    this.name = 'AutoBidConfigError'
    this.code = code
  }
}

export type ConfigEnvironment = Readonly<Record<string, string | undefined>>

export interface ParseConfigOptions {
  readonly env?: ConfigEnvironment
  readonly now?: Date
}

type ParsedOptionValues = {
  firmId?: number
  campaignName?: string
  device?: AutoBidDevice
  strategy?: AutoBidStrategy
  targetPosition?: number
  floor?: number
  ceiling?: number
  stepUp?: number
  stepDown?: number
  allowBidDecrease?: boolean
  exposureBuffer?: number
  cooldownHours?: number
  batchSize?: number
  rankCheckLimit?: number
  rankIntervalMs?: number
  rankRequestsPerMinute?: number
  rankConcurrency?: number
  maxChanges?: number
  stage?: AutoBidStageSelector
  runKey?: string
}

type NumericOptionKey =
  | 'firmId'
  | 'floor'
  | 'ceiling'
  | 'stepUp'
  | 'stepDown'
  | 'targetPosition'
  | 'exposureBuffer'
  | 'cooldownHours'
  | 'batchSize'
  | 'rankCheckLimit'
  | 'rankIntervalMs'
  | 'rankRequestsPerMinute'
  | 'rankConcurrency'
  | 'maxChanges'

const STAGE_ALIASES: Readonly<Record<string, AutoBidStageSelector>> = {
  all: 'all',
  snapshot: 'snapshot',
  'auto-bid-snapshot': 'snapshot',
  estimate: 'estimate',
  'auto-bid-estimate': 'estimate',
  decide: 'decide',
  'auto-bid-decide': 'decide',
  apply: 'apply',
  'auto-bid-apply': 'apply',
  verify: 'verify',
  'auto-bid-verify': 'verify',
  report: 'report',
  'auto-bid-report': 'report',
}

function fail(message: string): never {
  throw new AutoBidConfigError(message)
}

function nonEmpty(value: string | undefined): string | undefined {
  const result = value?.trim()
  return result || undefined
}

function optionValue(argv: readonly string[], index: number, name: string, inline: string | undefined): string {
  if (inline !== undefined) {
    if (!inline.trim()) fail(`${name} requires a value`)
    return inline
  }
  const next = argv[index + 1]
  if (next === undefined || next.startsWith('--')) fail(`${name} requires a value`)
  return next
}

function parseInteger(value: string, name: string, minimum: number): number {
  const text = value.trim()
  if (!/^[+]?(?:0|[1-9]\d*)$/.test(text)) {
    fail(`${name} must be a safe integer >= ${minimum}`)
  }
  const parsed = Number(text)
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    fail(`${name} must be a safe integer >= ${minimum}`)
  }
  return parsed
}

function parseEnvInteger(
  env: ConfigEnvironment,
  names: readonly string[],
  label: string,
  minimum: number,
): number | undefined {
  const value = names.map((name) => nonEmpty(env[name])).find((candidate) => candidate !== undefined)
  return value === undefined ? undefined : parseInteger(value, label, minimum)
}

function parseDevice(value: string, name: string): AutoBidDevice {
  const normalized = value.trim().toLocaleLowerCase('en-US')
  if (normalized === 'mobile' || normalized === 'pc') return normalized
  fail(`${name} must be mobile or pc`)
}

function parseStrategy(value: string, name: string): AutoBidStrategy {
  if (value === 'observed_rank' || value === 'target_position' || value === 'exposure_minimum') return value
  fail(`${name} must be observed_rank, target_position, or exposure_minimum`)
}

function parseStage(value: string, name: string): AutoBidStageSelector {
  const normalized = STAGE_ALIASES[value.trim().toLocaleLowerCase('en-US')]
  if (normalized) return normalized
  fail(`${name} must be one of ${Object.keys(STAGE_ALIASES).join(', ')}`)
}

function seoulDay(now: Date): string {
  if (Number.isNaN(now.getTime())) fail('now must be a valid date')
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now)
  const values = new Map(parts.map((part) => [part.type, part.value]))
  return `${values.get('year')}-${values.get('month')}-${values.get('day')}`
}

function envOrDefault(
  env: ConfigEnvironment,
  names: readonly string[],
  fallback: string,
): string {
  return names.map((name) => nonEmpty(env[name])).find((value) => value !== undefined) ?? fallback
}

/**
 * Parse the operator contract.  Only the `--live` flag can select live mode;
 * environment variables may provide dry-run defaults but cannot silently
 * turn a scheduled invocation into a writer.
 */
export function parseArgs(
  argv: readonly string[] = [],
  options: ParseConfigOptions = {},
): AutoBidConfig {
  const env = options.env ?? process.env
  const values: ParsedOptionValues = {}
  const provided = new Set<string>()
  let live = false
  let dryRun = false
  let allowBidDecrease = true

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '-h' || token === '--help') continue
    if (!token.startsWith('--')) fail(`unexpected argument: ${token}`)

    const separator = token.indexOf('=')
    const name = separator === -1 ? token : token.slice(0, separator)
    const inline = separator === -1 ? undefined : token.slice(separator + 1)

    if (name === '--live') {
      if (inline !== undefined) fail('--live does not accept a value')
      live = true
      provided.add('live')
      continue
    }
    if (name === '--dry-run') {
      if (inline !== undefined) fail('--dry-run does not accept a value')
      dryRun = true
      provided.add('dry-run')
      continue
    }
    if (name === '--no-bid-decrease') {
      if (inline !== undefined) fail('--no-bid-decrease does not accept a value')
      allowBidDecrease = false
      provided.add('allowBidDecrease')
      continue
    }

    const option = (key: NumericOptionKey, minimum: number): void => {
      const raw = optionValue(argv, index, name, inline)
      values[key] = parseInteger(raw, name, minimum)
      provided.add(key)
      if (inline === undefined) index += 1
    }

    switch (name) {
      case '--firm':
      case '--firm-id':
        option('firmId', 1)
        break
      case '--campaign':
      case '--campaign-name': {
        const value = optionValue(argv, index, name, inline).trim()
        if (!value) fail(`${name} requires a value`)
        values.campaignName = value
        provided.add('campaignName')
        if (inline === undefined) index += 1
        break
      }
      case '--device':
        values.device = parseDevice(optionValue(argv, index, name, inline), name)
        provided.add('device')
        if (inline === undefined) index += 1
        break
      case '--strategy':
        values.strategy = parseStrategy(optionValue(argv, index, name, inline), name)
        provided.add('strategy')
        if (inline === undefined) index += 1
        break
      case '--target-position':
        option('targetPosition', 1)
        break
      case '--floor':
        option('floor', 0)
        break
      case '--ceiling':
        option('ceiling', 1)
        break
      case '--step-up':
        option('stepUp', 1)
        break
      case '--step-down':
        option('stepDown', 1)
        break
      case '--exposure-buffer':
        option('exposureBuffer', 0)
        break
      case '--cooldown-hours':
        option('cooldownHours', 0)
        break
      case '--batch-size':
        option('batchSize', 1)
        break
      case '--rank-check-limit':
        option('rankCheckLimit', 1)
        break
      case '--rank-interval-ms':
        option('rankIntervalMs', 1)
        break
      case '--rank-rpm':
        option('rankRequestsPerMinute', 1)
        break
      case '--rank-concurrency':
        option('rankConcurrency', 1)
        break
      case '--max-changes':
        option('maxChanges', 1)
        break
      case '--stage':
        values.stage = parseStage(optionValue(argv, index, name, inline), name)
        provided.add('stage')
        if (inline === undefined) index += 1
        break
      case '--run-key': {
        const value = optionValue(argv, index, name, inline).trim()
        if (!value) fail(`${name} requires a value`)
        values.runKey = value
        provided.add('runKey')
        if (inline === undefined) index += 1
        break
      }
      default:
        fail(`unknown option: ${name}`)
    }
  }

  if (live && dryRun) fail('--live cannot be combined with --dry-run')

  // Live bounds are intentionally required as explicit command-line values.
  // This prevents a stale environment file from becoming an unreviewed write
  // limit when an operator types --live.
  if (live && !provided.has('ceiling')) {
    throw new AutoBidConfigError('--live requires --ceiling', 'live-ceiling-required')
  }
  if (live && !provided.has('maxChanges')) {
    throw new AutoBidConfigError('--live requires --max-changes', 'live-max-changes-required')
  }

  const firmId = values.firmId
    ?? parseEnvInteger(env, ['NAVER_AUTO_BID_FIRM_ID', 'NAVER_AUTO_FIRM_ID'], '--firm', 1)
  if (firmId === undefined) fail('--firm is required (or set NAVER_AUTO_BID_FIRM_ID)')

  const campaignName = values.campaignName
    ?? envOrDefault(env, ['NAVER_AUTO_BID_CAMPAIGN', 'NAVER_AUTO_BID_CAMPAIGN_NAME'], AUTO_BID_DEFAULTS.campaignName)
  const device = values.device
    ?? parseDevice(
      envOrDefault(env, ['NAVER_AUTO_BID_DEVICE'], AUTO_BID_DEFAULTS.device),
      'NAVER_AUTO_BID_DEVICE',
    )
  const strategy = values.strategy
    ?? parseStrategy(envOrDefault(env, ['NAVER_AUTO_BID_STRATEGY'], AUTO_BID_DEFAULTS.strategy), 'NAVER_AUTO_BID_STRATEGY')
  const targetPosition = values.targetPosition
    ?? parseEnvInteger(env, ['NAVER_AUTO_BID_TARGET_POSITION'], '--target-position', 1)
    ?? AUTO_BID_DEFAULTS.targetPosition
  if (targetPosition > 15) fail('--target-position must be between 1 and 15')
  const floor = values.floor
    ?? parseEnvInteger(env, ['NAVER_AUTO_BID_FLOOR'], '--floor', 0)
    ?? AUTO_BID_DEFAULTS.floor
  const ceiling = values.ceiling
    ?? parseEnvInteger(env, ['NAVER_AUTO_BID_CEILING'], '--ceiling', 1)
    ?? null
  const stepUp = values.stepUp
    ?? parseEnvInteger(env, ['NAVER_AUTO_BID_STEP_UP'], '--step-up', 1)
    ?? AUTO_BID_DEFAULTS.stepUp
  const stepDown = values.stepDown
    ?? parseEnvInteger(env, ['NAVER_AUTO_BID_STEP_DOWN'], '--step-down', 1)
    ?? AUTO_BID_DEFAULTS.stepDown
  const exposureBuffer = values.exposureBuffer
    ?? parseEnvInteger(env, ['NAVER_AUTO_BID_EXPOSURE_BUFFER'], '--exposure-buffer', 0)
    ?? AUTO_BID_DEFAULTS.exposureBuffer
  const cooldownHours = values.cooldownHours
    ?? parseEnvInteger(env, ['NAVER_AUTO_BID_COOLDOWN_HOURS'], '--cooldown-hours', 0)
    ?? AUTO_BID_DEFAULTS.cooldownHours
  const batchSize = values.batchSize
    ?? parseEnvInteger(env, ['NAVER_AUTO_BID_BATCH_SIZE'], '--batch-size', 1)
    ?? AUTO_BID_DEFAULTS.batchSize
  const rankCheckLimit = values.rankCheckLimit
    ?? parseEnvInteger(env, ['NAVER_AUTO_BID_RANK_CHECK_LIMIT'], '--rank-check-limit', 1)
    ?? AUTO_BID_DEFAULTS.rankCheckLimit
  const rankIntervalMs = values.rankIntervalMs
    ?? parseEnvInteger(env, ['NAVER_AUTO_BID_RANK_INTERVAL_MS'], '--rank-interval-ms', 1)
    ?? AUTO_BID_DEFAULTS.rankIntervalMs
  const rankRequestsPerMinute = values.rankRequestsPerMinute
    ?? parseEnvInteger(env, ['NAVER_AUTO_BID_RANK_RPM'], '--rank-rpm', 1)
    ?? AUTO_BID_DEFAULTS.rankRequestsPerMinute
  const rankConcurrency = values.rankConcurrency
    ?? parseEnvInteger(env, ['NAVER_AUTO_BID_RANK_CONCURRENCY'], '--rank-concurrency', 1)
    ?? AUTO_BID_DEFAULTS.rankConcurrency
  const maxChanges = values.maxChanges
    ?? parseEnvInteger(env, ['NAVER_AUTO_BID_MAX_CHANGES'], '--max-changes', 1)
    ?? null
  const stage = values.stage ?? 'all'

  if (ceiling !== null && ceiling < floor) {
    fail('--ceiling must be greater than or equal to --floor')
  }

  const runKey = values.runKey
    ?? nonEmpty(env.NAVER_AUTO_BID_RUN_KEY)
    ?? nonEmpty(env.AGENT_RUN_KEY)
    ?? `naver-auto-bid:${firmId}:${seoulDay(options.now ?? new Date())}`

  const mode: AutoBidMode = live ? 'live' : 'dry-run'
  return {
    firmId,
    campaignName,
    device,
    strategy,
    targetPosition,
    floor,
    ceiling,
    stepUp,
    stepDown,
    allowBidDecrease,
    exposureBuffer,
    cooldownHours,
    batchSize,
    rankCheckLimit,
    rankIntervalMs,
    rankRequestsPerMinute,
    rankConcurrency,
    maxChanges,
    mode,
    live,
    dryRun: mode === 'dry-run',
    stage,
    runKey,
  }
}

/** Explicit name for callers that prefer config terminology. */
export const parseConfig = parseArgs

/** Entry-point helper used by the executable and by embedding callers. */
export function loadConfig(
  argv: readonly string[] = process.argv.slice(2),
  options: ParseConfigOptions = {},
): AutoBidConfig {
  return parseArgs(argv, options)
}

export const AUTO_BID_HELP = `Usage: npm run naver:auto-bid -- --firm <id> [options]

Safe default: dry-run. Provider writes require --live, --ceiling, and --max-changes.

Options:
  --firm <id>             Firm ID (or NAVER_AUTO_BID_FIRM_ID)
  --campaign <name>       Campaign name (default: 파워링크#1)
  --device <mobile|pc>    Device to estimate (default: mobile)
  --strategy <name>       observed_rank, target_position, or exposure_minimum
  --target-position <n>   Target ad position, 1-15 (default: 3)
  --floor <krw>           Minimum bid (default: 70)
  --ceiling <krw>         Required explicit live bid ceiling
  --step-up <krw>         Maximum one-run increase (default: 100)
  --step-down <krw>       Maximum one-run decrease (default: 10)
  --no-bid-decrease       Disable bid decreases
  --exposure-buffer <krw> Exposure buffer (default: 10)
  --cooldown-hours <n>    Cooldown between changes (default: 6)
  --batch-size <n>        Provider batch size (default: 50)
  --rank-check-limit <n>  Maximum real-search rank checks per run (default: 50000)
  --rank-rpm <n>          Rank request start-rate ceiling (default: 3000/min)
  --rank-concurrency <n>  Maximum in-flight rank requests (default: 64)
  --rank-interval-ms <n>  Compatibility floor between starts (default: 20)
  --max-changes <n>       Required explicit live mutation limit
  --stage <stage>         all, snapshot, estimate, decide, apply, verify, report
  --run-key <key>         Idempotency/ledger key
  --live                   Permit the live adapter path after all guards pass
  --dry-run                Explicitly select the safe default mode
  --help                   Show this help
`
