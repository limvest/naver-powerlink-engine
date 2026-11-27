import { createHash } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { getDb } from '@/lib/db/client'
import { loadConfig } from './config'
import { runStages } from './cli'
import { createProductionNaverProvider, ProductionAutoBidRuntime } from './runtime'
import { NaverSerpRankObserver, type RankObserver, type ObservedRank } from './rank-observer'
import { runParallelBidPipeline } from './parallel-bid-pipeline'
import { BID_SETTLEMENT_MS } from './bid-settlement'
import { runBidPipeline, type PipelineBatch } from './bid-pipeline'
import type { NaverProvider } from './naver-provider'
import { loadAllKeywordsCohort } from './all-keywords-cohort'
import { getNaverAutoBidPolicy } from './repository'
import { isWithinAutoBidSchedule, type AutoBidSchedule } from './control-plane'

const INTERRUPTED_LEASE_GRACE_MS = 45_000
let stopping = false
process.once('SIGTERM', () => { stopping = true })
process.once('SIGINT', () => { stopping = true })

/**
 * A container can be stopped between snapshot and report, leaving the firm lease
 * behind.  This entrypoint is protected by the host flock, so a continuous-run
 * lease whose heartbeat stays unchanged for the grace period is an orphan from
 * the previous container.  Never recover leases owned by other runner types.
 */
async function recoverInterruptedContinuousLease(db: ReturnType<typeof getDb>, firmId: number) {
  const findActive = async () => (await db.execute(sql`select id, run_key,
      coalesce(heartbeat_at, started_at) as last_seen
    from naver_auto_bid_runs
    where firm_id=${firmId} and active_key=${`firm:${firmId}`} and status='running'
    limit 1`)).rows[0] as { id: string; run_key: string; last_seen: Date | string } | undefined
  const active = await findActive()
  if (!active) return
  if (!String(active.run_key).startsWith('continuous-all-')) {
    throw new Error(`firm ${firmId} has a non-continuous active auto-bid run`)
  }
  const firstSeen = new Date(active.last_seen).getTime()
  const remaining = Math.max(0, INTERRUPTED_LEASE_GRACE_MS - (Date.now() - firstSeen))
  if (remaining) await new Promise(resolve => setTimeout(resolve, remaining))
  const current = await findActive()
  if (!current) return
  const currentSeen = new Date(current.last_seen).getTime()
  if (current.id !== active.id || currentSeen > firstSeen) {
    throw new Error(`firm ${firmId} already has a live auto-bid run`)
  }
  const recovered = await db.execute(sql`update naver_auto_bid_runs
    set status='failed', active_key=null,
      error='interrupted continuous service lease recovered',
      finished_at=now(), updated_at=now()
    where id=${active.id} and firm_id=${firmId} and status='running'
      and active_key=${`firm:${firmId}`} and coalesce(heartbeat_at, started_at) <= ${new Date(firstSeen)}
    returning id`)
  if (recovered.rows.length !== 1) throw new Error('continuous lease recovery lost a race')
  console.log(JSON.stringify({ phase: 'lease-recovered', runKey: active.run_key, firmId }))
}

async function main() {
  if (!process.argv.includes('--confirm-live')) throw new Error('--confirm-live required')
  const key = process.argv.find(arg => arg.startsWith('--run-key='))?.split('=')[1]
  const fastAcquire4000 = process.argv.includes('--fast-acquire-4000')
  const parallel = process.argv.includes('--parallel-queries')
  const allKeywords = process.argv.includes('--all-keywords')
  const ceilingArgument = process.argv.find(arg => arg.startsWith('--ceiling='))?.split('=')[1]
  const ceiling = ceilingArgument === undefined ? (fastAcquire4000 ? 4000 : 3000) : Number(ceilingArgument)
  if (!Number.isSafeInteger(ceiling) || ceiling < 70 || ceiling > 10_000) {
    throw new Error('--ceiling must be an integer from 70 to 10000')
  }
  if (!key || !/^[a-zA-Z0-9-]+$/.test(key)) throw new Error('unique --run-key required')
  const db = getDb()
  try {
    const firmId = 1001
    await recoverInterruptedContinuousLease(db, firmId)
    const canContinue = async () => {
      if (stopping) return false
      const policy = await getNaverAutoBidPolicy(db,firmId)
      return !!policy?.enabled && policy.status === 'active'
        && isWithinAutoBidSchedule(new Date(),policy.schedule as AutoBidSchedule)
    }
    if (!await canContinue()) {
      console.log(JSON.stringify({pipeline:key,status:'idle',reason:'control_plane_or_schedule',at:new Date().toISOString()}))
      return
    }
    if (parallel) {
      const prior = await db.execute(sql`select id from naver_auto_bid_runs
        where firm_id=${firmId} and run_key like ${`${key}-%`} limit 1`)
      if (prior.rows.length) throw new Error('parallel run already exists; reconcile before a new run')
    }
    const { provider } = await createProductionNaverProvider(firmId, 50)
    const cohort = allKeywords ? await loadAllKeywordsCohort(db,provider,firmId,key) : await db.execute(sql`select distinct d.naver_keyword_id, p.naver_adgroup_id, p.keyword
      from naver_auto_bid_decisions d join naver_auto_bid_runs r on r.id=d.run_id
      join naver_auto_bid_keyword_policies p on p.firm_id=r.firm_id and p.naver_keyword_id=d.naver_keyword_id
      where r.firm_id=${firmId} and r.run_key='full-rank-20260908-0805'
      and d.raw->'rankObservation'->>'legalCompetitorPresent'='true'
      and (${fastAcquire4000} or not exists (select 1 from naver_auto_bid_decisions old
        join naver_auto_bid_runs prior on prior.id=old.run_id
        where prior.firm_id=${firmId} and prior.run_key='competitor-pilot200-v2-20260908-live'
        and old.naver_keyword_id=d.naver_keyword_id and old.applied_at is not null))
      order by p.naver_adgroup_id, d.naver_keyword_id`)
    if (!cohort.rows.length) {
      console.log(JSON.stringify({pipeline:key,status:'idle',reason:'no_due_eligible_keywords',at:new Date().toISOString()}))
      return
    }
    const allowed = new Set(cohort.rows.map(row => String(row.naver_keyword_id)))
    const batches: PipelineBatch[] = []
    let current: string[] = [], group = '', campaign = ''
    const flush = () => {
      if (!current.length) return
      batches.push({ key: createHash('sha256').update(`${campaign}\n${current.join('\n')}`).digest('hex').slice(0, 16),
        ids: current, campaignName: campaign })
      current = []
    }
    for (const row of cohort.rows) {
      if (current.length >= 50 || group !== row.naver_adgroup_id || campaign !== row.naver_campaign_name) flush()
      campaign = String(row.naver_campaign_name)
      group = String(row.naver_adgroup_id)
      current.push(String(row.naver_keyword_id))
    }
    flush()
    const cache = new Map<string, { at: number; value: unknown }>()
    const scoped = new Proxy(provider, { get(target, prop) {
      if (prop === 'getCampaigns' || prop === 'getAdGroups') return async (...args: string[]) => {
        const cacheKey = `${prop}:${args.join(':')}`
        const existing = cache.get(cacheKey)
        if (existing && Date.now() - existing.at < 60_000) return existing.value
        const value = prop === 'getCampaigns' ? await target.getCampaigns() : await target.getAdGroups(args[0])
        cache.set(cacheKey, { at: Date.now(), value })
        return value
      }
      if (prop === 'bulkUpdateBids') return async (...args: Parameters<NaverProvider['bulkUpdateBids']>) => {
        for (const change of args[0]) {
          const row = 'row' in change ? change.row as Record<string, unknown> : undefined
          if (!row || !allowed.has(String(row.nccKeywordId)) || typeof change.bidAmt !== 'number'
            || !Number.isFinite(change.bidAmt) || change.bidAmt < 70 || change.bidAmt > ceiling)
            throw new Error('out of authorized mutation scope')
        }
        return target.bulkUpdateBids(...args)
      }
      const value = Reflect.get(target, prop)
      return typeof value === 'function' ? value.bind(target) : value
    } })
    // The direct A1 egress is stable around 1,000 RPM. Ramping to 3,000 RPM
    // triggers Naver's incomplete/blocked response and the adaptive limiter then
    // collapses to 5-second starts (~12 RPM), which is far slower overall.
    const sustainableRankRpm = 1000
    const sustainableRankConcurrency = 24
    const observer = new NaverSerpRankObserver('sampleone.attorney', {
      requestsPerMinute: sustainableRankRpm,
      warmupRequestsPerMinute: 1000,
      concurrency: sustainableRankConcurrency, minIntervalMs: 60,
    })
    const base = loadConfig(['--firm', String(firmId), '--strategy', 'observed_rank', '--device', 'mobile',
      '--target-position', '3', '--ceiling', String(ceiling), '--max-changes', '50', '--rank-check-limit', '50',
      '--rank-rpm', String(sustainableRankRpm), '--rank-concurrency', String(sustainableRankConcurrency), '--live'])
    const restoredChecks = parallel ? cohort.rows.filter(row=>row.recheck === true).length : 0
    const stats = { candidates: allowed.size-restoredChecks, restoredChecks, processed: 0, applied: 0, rechecked: 0, failures: 0 }
    const progress = () => console.log(JSON.stringify({ pipeline: key, ...stats, at: new Date().toISOString() }))
    const heartbeat = setInterval(progress, 30_000)
    const run = async (batch: PipelineBatch, live: boolean, rankSource: RankObserver = observer) => {
      const runKey = `${key}-${batch.key}-${live ? 'live' : 'after'}`
      const existing = await db.execute(sql`select status from naver_auto_bid_runs
        where firm_id=${firmId} and run_key=${runKey}`)
      if (existing.rows.length) {
        if (existing.rows[0].status !== 'completed') throw new Error(`manual reconciliation required: ${runKey}`)
        return { runKey, candidateCount: batch.ids.length }
      }
      const config = { ...base, campaignName: batch.campaignName ?? base.campaignName,
        fastAcquire4000, keywordIds: batch.ids, rankConfirmationReads: 1 as const,
        skipRetention: true, legalCompetitorsOnly: live && !allKeywords, runKey, live, dryRun: !live,
        mode: live ? 'live' as const : 'dry-run' as const }
      const runtime = new ProductionAutoBidRuntime(db, scoped, rankSource)
      await runStages(config, { runStage: (stage, context) => runtime.runStage(stage,
        stage === 'snapshot' ? { ...context, config: { ...config, legalCompetitorsOnly: false } } : context),
      }, () => undefined)
      const persisted = await db.execute(sql`select candidate_count from naver_auto_bid_runs
        where firm_id=${firmId} and run_key=${runKey} limit 1`)
      const candidateCount = Number(persisted.rows[0]?.candidate_count ?? 0)
      if (candidateCount !== batch.ids.length) {
        throw new Error(`campaign-scoped snapshot mismatch: ${config.campaignName} expected=${batch.ids.length} recorded=${candidateCount}`)
      }
      return { runKey, candidateCount }
    }
    progress()
    try {
      if (parallel) {
        const pool = await runParallelBidPipeline<ObservedRank>(cohort.rows.map(row => ({
          id: String(row.naver_keyword_id), keyword: String(row.keyword),
          group: String(row.naver_adgroup_id), campaignName: String(row.naver_campaign_name),
          recheck: row.recheck === true, readyAt: Number(row.readyAt ?? 0),
        })), {
          concurrency: sustainableRankConcurrency, bufferLimit: 96, batchWaitMs: 1000,
          shouldStop: () => stopping,
          now: Date.now, sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
          query: job => observer.observe(job.keyword, 'mobile'),
          commit: async rows => {
            if (!await canContinue()) { stopping = true; return [] }
            const ids = rows.map(row => row.job.id).sort()
            const campaignName = rows[0].job.campaignName ?? base.campaignName
            if (rows.some(row => row.job.campaignName !== campaignName)) throw new Error('mixed-campaign commit batch')
            const batch = { ids, campaignName,
              key: createHash('sha256').update(`${campaignName}\n${ids.join('\n')}`).digest('hex').slice(0, 16) }
            const live = !rows[0].job.recheck
            const observations = new Map(rows.map(row => [row.job.keyword, row.value]))
            const result = await run(batch, live, { observe: async (keyword, device) => {
              const cached = observations.get(keyword)
              // Backpressure bounds memory; TTL prevents queued results becoming stale.
              if (cached && cached.device === device && Date.now() - Date.parse(cached.observedAt) < 30_000)
                return cached
              return observer.observe(keyword, device)
            } })
            if (!live) { stats.rechecked += result.candidateCount; return [] }
            stats.processed += result.candidateCount
            const changed = await db.execute(sql`select d.naver_keyword_id,d.applied_at
              from naver_auto_bid_decisions d join naver_auto_bid_runs r on r.id=d.run_id
              where r.firm_id=${firmId} and r.run_key=${result.runKey} and d.applied_at is not null`)
            stats.applied += changed.rows.length
            return changed.rows.map(row => ({
              ...rows.find(item => item.job.id === row.naver_keyword_id)!.job,
              recheck: true, readyAt: new Date(String(row.applied_at)).getTime() + BID_SETTLEMENT_MS,
            }))
          },
        })
        console.log(JSON.stringify({phase:'pool-summary',pipeline:key,...pool,at:new Date().toISOString()}))
      } else await runBidPipeline(batches, {
        now: Date.now,
        sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
        execute: async batch => {
          const result = await run(batch, true)
          stats.processed += result.candidateCount
          const changed = await db.execute(sql`select d.naver_keyword_id, d.applied_at
            from naver_auto_bid_decisions d join naver_auto_bid_runs r on r.id=d.run_id
            where r.firm_id=${firmId} and r.run_key=${result.runKey} and d.applied_at is not null`)
          stats.applied += changed.rows.length
          if (!changed.rows.length) return null
          return { key: batch.key, ids: changed.rows.map(row => String(row.naver_keyword_id)),
            readyAt: Math.max(...changed.rows.map(row => new Date(String(row.applied_at)).getTime())) + BID_SETTLEMENT_MS }
        },
        recheck: async batch => {
          const result = await run(batch, false)
          stats.rechecked += result.candidateCount
        },
      })
      console.log(JSON.stringify({ ...stats, pipeline: key, status: stopping ? 'stopped' : 'completed', at:new Date().toISOString() }))
    } catch (error) {
      stats.failures++
      progress()
      throw error
    } finally { clearInterval(heartbeat) }
  } finally { await db.$client.end() }
}
main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1 })
