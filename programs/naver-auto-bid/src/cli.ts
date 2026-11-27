/**
 * Adapter-neutral command boundary for the Naver automatic bidder.
 *
 * The provider, policy, and persistence work can evolve independently.  An
 * adapter may implement one `runStage` method or the named stage methods
 * below; the CLI never imports a concrete provider and the default adapter is
 * a read-only placeholder.
 */

import { fileURLToPath } from 'node:url'
import { isAbsolute, resolve } from 'node:path'
import {
  AUTO_BID_HELP,
  AUTO_BID_STAGES,
  AutoBidConfigError,
  loadConfig,
  type AutoBidConfig,
  type AutoBidStage,
  type ParseConfigOptions,
} from './config'

export type { AutoBidConfig, AutoBidStage }
export { AUTO_BID_STAGES }

export interface AutoBidStageContext {
  readonly config: AutoBidConfig
  readonly mode: AutoBidConfig['mode']
  readonly runKey: string
  readonly stage: AutoBidStage
  /** Result from the preceding stage in this process, if any. */
  readonly input?: unknown
}

export type AutoBidStageHandler = (context: AutoBidStageContext) => unknown | Promise<unknown>

/**
 * A deliberately loose adapter boundary.  `runStage` is the preferred
 * integration point; named methods are convenient for small fake providers
 * and make unit/integration wiring possible without changing the CLI.
 */
export interface NaverAutoBidAdapter {
  readonly runStage?: (stage: AutoBidStage, context: AutoBidStageContext) => unknown | Promise<unknown>
  readonly snapshot?: AutoBidStageHandler
  readonly estimate?: AutoBidStageHandler
  readonly decide?: AutoBidStageHandler
  readonly apply?: AutoBidStageHandler
  readonly verify?: AutoBidStageHandler
  readonly report?: AutoBidStageHandler
}

export type AutoBidAdapter = NaverAutoBidAdapter

export interface AutoBidCliOptions extends ParseConfigOptions {
  readonly argv?: readonly string[]
  readonly adapter?: NaverAutoBidAdapter
  readonly log?: (line: string) => void
}

export type AutoBidCliStatus = 'completed' | 'refused' | 'failed' | 'help'

export interface AutoBidCliResult {
  readonly command: 'naver-auto-bid'
  readonly status: AutoBidCliStatus
  readonly mode?: AutoBidConfig['mode']
  readonly stage?: string
  readonly firmId?: number
  readonly runKey?: string
  readonly results?: readonly unknown[]
  readonly reasonCode?: string
  readonly error?: string
  readonly adapter?: 'placeholder' | 'provided'
}

type NamedStageMethod = Exclude<keyof NaverAutoBidAdapter, 'runStage'>

const STAGE_METHODS: Readonly<Record<AutoBidStage, NamedStageMethod>> = {
  snapshot: 'snapshot',
  estimate: 'estimate',
  decide: 'decide',
  apply: 'apply',
  verify: 'verify',
  report: 'report',
}

function placeholderAdapter(): NaverAutoBidAdapter {
  return {
    runStage: async (stage, context) => ({
      adapter: 'placeholder',
      stage,
      mode: context.mode,
      firmId: context.config.firmId,
      providerRequests: 0,
      mutations: 0,
      message: 'provider/policy adapter is not wired; no external request was made',
    }),
  }
}

export function createPlaceholderAdapter(): NaverAutoBidAdapter {
  return placeholderAdapter()
}

function isHelp(argv: readonly string[]): boolean {
  return argv.includes('--help') || argv.includes('-h')
}

function write(log: (line: string) => void, value: unknown): void {
  log(JSON.stringify(value))
}

function asError(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

function stageList(stage: AutoBidConfig['stage']): readonly AutoBidStage[] {
  return stage === 'all' ? AUTO_BID_STAGES : [stage]
}

async function runAdapterStage(
  adapter: NaverAutoBidAdapter,
  stage: AutoBidStage,
  context: AutoBidStageContext,
): Promise<unknown> {
  if (adapter.runStage) return adapter.runStage(stage, context)
  const method = adapter[STAGE_METHODS[stage]] as AutoBidStageHandler | undefined
  if (typeof method === 'function') return method(context)
  return {
    adapter: 'provided',
    stage,
    mode: context.mode,
    message: 'stage has no handler; no external request was made',
  }
}

/** Execute one or all ledger stages with an injected adapter. */
export async function runStages(
  config: AutoBidConfig,
  adapter: NaverAutoBidAdapter,
  log: (line: string) => void = console.log,
): Promise<readonly unknown[]> {
  const results: unknown[] = []
  let input: unknown

  for (const stage of stageList(config.stage)) {
    if (stage === 'apply' && config.dryRun) {
      const skipped = {
        stage,
        status: 'skipped',
        mode: config.mode,
        reason: 'dry-run; provider apply is disabled',
      }
      results.push(skipped)
      input = skipped
      write(log, { command: 'naver-auto-bid', ...skipped, firmId: config.firmId, runKey: config.runKey })
      continue
    }

    const context: AutoBidStageContext = {
      config,
      mode: config.mode,
      runKey: config.runKey,
      stage,
      ...(input === undefined ? {} : { input }),
    }
    const result = await runAdapterStage(adapter, stage, context)
    results.push(result)
    input = result
    write(log, {
      command: 'naver-auto-bid',
      stage,
      status: 'completed',
      mode: config.mode,
      firmId: config.firmId,
      runKey: config.runKey,
      result,
    })
    if (stage === 'report' && result && typeof result === 'object'
      && 'status' in result && ['partial', 'failed'].includes(String(result.status))) {
      throw new Error(`auto-bid report ended with ${result.status}; inspect the run failure counts`)
    }
  }

  return results
}

/**
 * Programmatic entry point.  Tests and the eventual provider integration can
 * inject an adapter; the executable itself remains safe until that happens.
 */
export async function main(options: AutoBidCliOptions = {}): Promise<AutoBidCliResult> {
  const argv = options.argv ?? process.argv.slice(2)
  const log = options.log ?? console.log

  if (isHelp(argv)) {
    log(AUTO_BID_HELP)
    return { command: 'naver-auto-bid', status: 'help' }
  }

  let config: AutoBidConfig
  try {
    config = loadConfig(argv, options)
  } catch (error) {
    const reasonCode = error instanceof AutoBidConfigError ? error.code : 'invalid-arguments'
    const result: AutoBidCliResult = {
      command: 'naver-auto-bid',
      status: 'refused',
      reasonCode,
      error: asError(error),
    }
    write(log, result)
    return result
  }

  const adapter = options.adapter
  if (config.live && !adapter) {
    const result: AutoBidCliResult = {
      command: 'naver-auto-bid',
      status: 'refused',
      mode: config.mode,
      stage: config.stage,
      firmId: config.firmId,
      runKey: config.runKey,
      reasonCode: 'adapter-not-configured',
      error: 'live mode requires an injected provider/policy adapter',
      adapter: 'placeholder',
    }
    write(log, result)
    return result
  }

  const selectedAdapter = adapter ?? placeholderAdapter()
  try {
    const results = await runStages(config, selectedAdapter, log)
    return {
      command: 'naver-auto-bid',
      status: 'completed',
      mode: config.mode,
      stage: config.stage,
      firmId: config.firmId,
      runKey: config.runKey,
      results,
      adapter: adapter ? 'provided' : 'placeholder',
    }
  } catch (error) {
    const result: AutoBidCliResult = {
      command: 'naver-auto-bid',
      status: 'failed',
      mode: config.mode,
      stage: config.stage,
      firmId: config.firmId,
      runKey: config.runKey,
      reasonCode: 'stage-failed',
      error: asError(error),
      adapter: adapter ? 'provided' : 'placeholder',
    }
    write(log, result)
    return result
  }
}

function invokedDirectly(): boolean {
  const entry = process.argv[1]
  return Boolean(entry) && resolve(isAbsolute(entry) ? entry : resolve(process.cwd(), entry)) === fileURLToPath(import.meta.url)
}

if (invokedDirectly()) {
  const argv = process.argv.slice(2)
  const runDirect = async (): Promise<AutoBidCliResult> => {
    if (isHelp(argv)) return main({ argv })
    let config: AutoBidConfig
    try {
      config = loadConfig(argv)
    } catch {
      // Reuse main's structured refusal output for malformed arguments.
      return main({ argv })
    }
    const { createProductionAutoBidRuntime } = await import('./runtime')
    return main({ argv, adapter: await createProductionAutoBidRuntime(config) })
  }
  runDirect().then((result) => {
    if (result.status === 'refused' || result.status === 'failed') process.exitCode = 1
  }).catch((error) => {
    console.error(JSON.stringify({
      command: 'naver-auto-bid',
      status: 'failed',
      reasonCode: 'uncaught-error',
      error: asError(error),
    }))
    process.exitCode = 1
  })
}
