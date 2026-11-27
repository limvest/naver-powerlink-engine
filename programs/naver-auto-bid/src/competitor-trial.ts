/** Explicit one-shot operator trial. Never enables the scheduled master switch. */
import { and, eq, sql } from 'drizzle-orm'
import { getDb } from '@/lib/db/client'
import { naverAutoBidKeywordPolicies } from '@/lib/db/schema'
import { loadConfig } from './config'
import { runStages } from './cli'
import { createProductionNaverProvider, ProductionAutoBidRuntime } from './runtime'
import { BID_SETTLEMENT_MS } from './bid-settlement'
import type { NaverProvider } from './naver-provider'

async function main() {
  if (!process.argv.includes('--confirm-live')) throw new Error('explicit --confirm-live required')
  const key = process.argv.find(arg => arg.startsWith('--trial-key='))?.split('=')[1]
  if (!key || !/^[a-zA-Z0-9-]+$/.test(key)) throw new Error('unique --trial-key required')
  const db = getDb()
  try {
    const firmId = 1001
    const limit = Number(process.argv.find(arg => arg.startsWith('--limit='))?.split('=')[1] ?? 0)
    const rpm = Number(process.argv.find(arg => arg.startsWith('--rpm='))?.split('=')[1] ?? 3000)
    const sourceRun = process.argv.find(arg => arg.startsWith('--source-run='))?.split('=')[1]
    const excludeRun = process.argv.find(arg => arg.startsWith('--exclude-applied-run='))?.split('=')[1]
    if (!Number.isSafeInteger(limit) || limit < 0 || !Number.isSafeInteger(rpm) || rpm < 1) throw new Error('invalid trial limits')
    let labels = await db.select().from(naverAutoBidKeywordPolicies).where(and(
      eq(naverAutoBidKeywordPolicies.firmId, firmId),
      eq(naverAutoBidKeywordPolicies.enabled, true),
      sourceRun ? undefined : eq(naverAutoBidKeywordPolicies.legalCompetitorPresent, true),
    ))
    if (sourceRun) {
      const cohort = await db.execute(sql`select d.naver_keyword_id from naver_auto_bid_decisions d
        join naver_auto_bid_runs r on r.id=d.run_id where r.firm_id=${firmId}
        and r.run_key=${sourceRun} and d.raw->'rankObservation'->>'legalCompetitorPresent'='true'`)
      const ids = new Set(cohort.rows.map(row => String(row.naver_keyword_id)))
      if (!ids.size) throw new Error('source run has no competitor cohort')
      labels = labels.filter(row => ids.has(row.naverKeywordId))
    }
    const cohortSize = labels.length
    if (excludeRun) {
      const previous = await db.execute(sql`select d.naver_keyword_id from naver_auto_bid_decisions d
        join naver_auto_bid_runs r on r.id=d.run_id where r.firm_id=${firmId}
        and r.run_key=${excludeRun} and d.applied_at is not null`)
      const ids = new Set(previous.rows.map(row => String(row.naver_keyword_id)))
      labels = labels.filter(row => !ids.has(row.naverKeywordId))
    }
    if (!labels.length) throw new Error('no labeled candidates')
    // Pilot prioritizes already visible keywords, where a rank delta is measurable.
    labels.sort((a, b) => (a.lastObservedRank ?? 999) - (b.lastObservedRank ?? 999)
      || a.naverKeywordId.localeCompare(b.naverKeywordId))
    const allowed = new Set((limit ? labels.slice(0, limit) : labels).map(row => row.naverKeywordId))
    const { provider } = await createProductionNaverProvider(firmId, 50)
    let scopedIds = allowed
    // Explicitly gate the actual mutation as well as snapshot selection.
    const scoped = new Proxy(provider, { get(target, prop) {
      if (prop === 'getKeywords') return async (group: string) =>
        (await target.getKeywords(group)).filter(row => scopedIds.has(String(row.nccKeywordId)))
      if (prop === 'bulkUpdateBids') return async (...args: Parameters<NaverProvider['bulkUpdateBids']>) => {
        for (const change of args[0]) {
          const row = 'row' in change ? change.row as Record<string, unknown> : undefined
          const bid = change.bidAmt
          if (!row || !allowed.has(String(row.nccKeywordId)) || typeof bid !== 'number'
            || !Number.isFinite(bid) || bid > 3000 || bid < 70)
            throw new Error('trial mutation outside authorized scope')
        }
        return target.bulkUpdateBids(...args)
      }
      const value = Reflect.get(target, prop)
      return typeof value === 'function' ? value.bind(target) : value
    } })
    const base = loadConfig(['--firm', String(firmId), '--strategy', 'observed_rank',
      '--device', 'mobile', '--target-position', '3', '--ceiling', '3000',
      '--max-changes', String(allowed.size), '--rank-check-limit', '50000',
      '--rank-rpm', String(rpm), '--rank-concurrency', rpm <= 300 ? '4' : '64', '--live'])
    console.log(JSON.stringify({ trial: key, cohortSize, alreadyApplied: cohortSize - labels.length,
      candidates: allowed.size, sourceRun, excludeRun, target: 3, ceiling: 3000 }))
    // Three independent fresh observations preserve the normal confidence gate.
    for (const phase of ['baseline-1', 'baseline-2', 'live', 'after'] as const) {
      if (phase === 'after') {
        const changes = await db.execute(sql`select d.naver_keyword_id, d.applied_at
          from naver_auto_bid_decisions d join naver_auto_bid_runs r on r.id=d.run_id
          where r.firm_id=${firmId} and r.run_key=${key + '-live'} and d.applied_at is not null`)
        scopedIds = new Set(changes.rows.map(row => String(row.naver_keyword_id)))
        if (!scopedIds.size) { console.log(JSON.stringify({ phase, skipped: 'no bid changes' })); break }
        const ready = Math.max(...changes.rows.map(row => new Date(String(row.applied_at)).getTime())) + BID_SETTLEMENT_MS
        while (Date.now() < ready) await new Promise(resolve => setTimeout(resolve, Math.min(60_000, ready - Date.now())))
      }
      const live = phase === 'live'
      const config = { ...base, skipRetention: true, legalCompetitorsOnly: phase !== 'after', runKey: `${key}-${phase}`,
        live, dryRun: !live, mode: live ? 'live' as const : 'dry-run' as const }
      console.log(JSON.stringify({ phase, startedAt: new Date().toISOString() }))
      const runtime = new ProductionAutoBidRuntime(db, scoped)
      const results = await runStages(config, { runStage: (stage, context) => runtime.runStage(stage,
        // Query every ID in the fixed cohort, even if its latest label changed.
        // Decide/apply still require a fresh competitor observation.
        stage === 'snapshot' ? { ...context, config: { ...context.config, legalCompetitorsOnly: false } } : context),
      }, console.log)
      console.log(JSON.stringify({ phase, results, finishedAt: new Date().toISOString() }))
    }
  } finally { await db.$client.end() }
}
main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1 })
