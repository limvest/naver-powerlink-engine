import { pathToFileURL } from 'node:url'
import { and, asc, desc, eq, gte, ne, sql } from 'drizzle-orm'
import { getDb, type Db } from '@/lib/db/client'
import {
  naverAutoBidCommands, naverAutoBidEvents, naverAutoBidGroupPolicies,
  naverAutoBidKeywordPolicies, naverAutoBidPolicies,
} from '@/lib/db/schema'
import { runStages } from './cli'
import { configFromPolicy, isWithinAutoBidSchedule, type AutoBidSchedule } from './control-plane'
import { createProductionNaverProvider, ProductionAutoBidRuntime } from './runtime'
import type { NaverProvider } from './naver-provider'

type Raw = Record<string, unknown>
type Command = typeof naverAutoBidCommands.$inferSelect

function text(row: Raw, ...keys: string[]): string | null {
  for (const key of keys) if (typeof row[key] === 'string' && String(row[key]).trim()) return String(row[key]).trim()
  return null
}

function integer(value: unknown): number | null {
  const result = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value
  return typeof result === 'number' && Number.isSafeInteger(result) && result >= 0 ? result : null
}

function active(row: Raw): boolean {
  return !['DELETED', 'BLOCKED'].includes(String(row.status ?? '').toUpperCase())
}

function unlocked(row: Raw): boolean {
  return ![true, 1, '1', 'true'].includes(row.userLock as never)
}

function observedBid(keyword: Raw, group: Raw): number | null {
  return [true, 1, '1', 'true'].includes(keyword.useGroupBidAmt as never)
    ? integer(group.bidAmt) : integer(keyword.bidAmt)
}

export async function syncAutoBidAccount(db: Db, provider: NaverProvider, firmId: number): Promise<Raw> {
  const now = new Date()
  const campaigns = (await provider.getCampaigns()).filter(active)
  let groups = 0
  let keywords = 0
  for (const campaign of campaigns) {
    const campaignId = text(campaign, 'nccCampaignId')
    if (!campaignId) continue
    const campaignName = text(campaign, 'name') ?? campaignId
    for (const group of (await provider.getAdGroups(campaignId)).filter(active)) {
      const groupId = text(group, 'nccAdgroupId', 'nccAdGroupId')
      if (!groupId) continue
      const adgroupName = text(group, 'name') ?? groupId
      const remoteKeywords = (await provider.getKeywords(groupId)).filter(active)
      await db.insert(naverAutoBidGroupPolicies).values({
        firmId, naverCampaignId: campaignId, naverAdgroupId: groupId, campaignName, adgroupName,
        enabled: false, keywordCount: remoteKeywords.length, enabledKeywordCount: 0,
        blockReason: null, lastSyncedAt: now, raw: { campaign, group }, updatedAt: now,
      }).onConflictDoUpdate({
        target: [naverAutoBidGroupPolicies.firmId, naverAutoBidGroupPolicies.naverAdgroupId],
        set: { naverCampaignId: campaignId, campaignName, adgroupName, keywordCount: remoteKeywords.length,
          blockReason: null, lastSyncedAt: now,
          raw: { campaign, group }, updatedAt: now },
      })
      groups++
      for (const keyword of remoteKeywords) {
        const keywordId = text(keyword, 'nccKeywordId')
        const keywordText = text(keyword, 'keyword')
        if (!keywordId || !keywordText) continue
        await db.insert(naverAutoBidKeywordPolicies).values({
          firmId, naverAdgroupId: groupId, naverKeywordId: keywordId, keyword: keywordText,
          enabled: false, lastObservedBid: observedBid(keyword, group), raw: { remote: keyword }, updatedAt: now,
        }).onConflictDoUpdate({
          target: [naverAutoBidKeywordPolicies.firmId, naverAutoBidKeywordPolicies.naverKeywordId],
          set: { naverAdgroupId: groupId, keyword: keywordText, lastObservedBid: observedBid(keyword, group),
            raw: sql`coalesce(${naverAutoBidKeywordPolicies.raw}, '{}'::jsonb)
              || ${JSON.stringify({ remote: keyword })}::jsonb`, updatedAt: now },
        })
        keywords++
      }
    }
  }
  await db.execute(sql`update naver_auto_bid_group_policies as g set enabled_keyword_count=(
    select count(*)::int from naver_auto_bid_keyword_policies as k
    where k.firm_id=g.firm_id and k.naver_adgroup_id=g.naver_adgroup_id and k.enabled=true
  ) where g.firm_id=${firmId}`)
  const result = { campaigns: campaigns.length, groups, keywords, syncedAt: now.toISOString() }
  await db.insert(naverAutoBidEvents).values({
    firmId, eventType: 'sync', message: `네이버 계정 전체 동기화: 캠페인 ${campaigns.length}, 그룹 ${groups}, 키워드 ${keywords}`,
    correlationKey: `sync:${firmId}:${now.toISOString()}`, raw: result,
  })
  return result
}

async function claimCommand(db: Db): Promise<Command | null> {
  const [candidate] = await db.select().from(naverAutoBidCommands)
    .where(eq(naverAutoBidCommands.status, 'pending')).orderBy(asc(naverAutoBidCommands.createdAt)).limit(1)
  if (!candidate) return null
  const [claimed] = await db.update(naverAutoBidCommands).set({ status: 'running', startedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(naverAutoBidCommands.id, candidate.id), eq(naverAutoBidCommands.status, 'pending'))).returning()
  return claimed ?? null
}

function scheduleBucket(now: Date, strategy: string): string {
  const interval = strategy === 'observed_rank' ? 120_000 : 900_000
  const bucket = new Date(Math.floor(now.getTime() / interval) * interval)
  return bucket.toISOString()
}

async function enqueueScheduledCommand(db: Db, now = new Date()): Promise<void> {
  const policies = await db.select().from(naverAutoBidPolicies).where(and(
    eq(naverAutoBidPolicies.enabled, true), eq(naverAutoBidPolicies.status, 'active'),
  ))
  for (const policy of policies) {
    if (!isWithinAutoBidSchedule(now, policy.schedule as AutoBidSchedule)) continue
    const key = `scheduled:live:${policy.firmId}:${scheduleBucket(now, policy.strategy)}:r${policy.revision}`
    await db.insert(naverAutoBidCommands).values({ firmId: policy.firmId, command: 'live_run',
      idempotencyKey: key, requestedBy: 'auto-bid-scheduler', payload: { scheduledAt: now.toISOString(), policyRevision: policy.revision } })
      .onConflictDoNothing({ target: naverAutoBidCommands.idempotencyKey })
  }
}

async function executeCommand(db: Db, provider: NaverProvider, command: Command): Promise<Raw> {
  if (command.command === 'sync') return syncAutoBidAccount(db, provider, command.firmId)
  if (!['dry_run', 'live_run'].includes(command.command)) throw new Error(`unsupported command: ${command.command}`)
  const [policy] = await db.select().from(naverAutoBidPolicies)
    .where(eq(naverAutoBidPolicies.firmId, command.firmId)).limit(1)
  if (!policy) throw new Error('auto-bid policy is not configured')
  const mode = command.command === 'live_run' ? 'live' : 'dry-run'
  if (mode === 'live') {
    if (!policy.enabled || policy.status !== 'active') throw new Error('master switch is disabled')
    if (!isWithinAutoBidSchedule(new Date(), policy.schedule as AutoBidSchedule)) throw new Error('outside configured bidding schedule')
    const recent = await db.select({ status: naverAutoBidCommands.status }).from(naverAutoBidCommands).where(and(
      eq(naverAutoBidCommands.firmId, command.firmId), eq(naverAutoBidCommands.command, 'live_run'),
      ne(naverAutoBidCommands.id, command.id),
      gte(naverAutoBidCommands.createdAt, policy.updatedAt),
    )).orderBy(desc(naverAutoBidCommands.createdAt)).limit(policy.consecutiveFailureLimit)
    if (recent.length >= policy.consecutiveFailureLimit && recent.every((row) => row.status === 'failed')) {
      throw new Error(`failure circuit is open after ${policy.consecutiveFailureLimit} consecutive live failures`)
    }
  }
  const campaignRows = await db.execute(sql`select distinct campaign_name, naver_campaign_id
    from naver_auto_bid_group_policies where firm_id=${command.firmId} and enabled=true order by campaign_name`)
  if (!campaignRows.rows.length) throw new Error('no enabled ad groups')
  const runs: Raw[] = []
  for (const row of campaignRows.rows as Array<{ campaign_name: string | null; naver_campaign_id: string }>) {
    const campaignName = row.campaign_name ?? row.naver_campaign_id
    const baseConfig = configFromPolicy({ firmId: command.firmId, campaignName, mode,
      runKey: `command:${command.id}:${row.naver_campaign_id}`, policy })
    // A scheduled cycle must sweep every eligible keyword. The old 1,000-keyword
    // clamp made a 25k account look idle for many cycles and left most keywords
    // untouched. Provider request pacing/concurrency and the policy bid/change
    // bounds still apply independently.
    // Retention is a separate maintenance concern. Running its large windowed
    // DELETE after every campaign caused full sweeps to block one another for
    // tens of minutes, so the continuous bidder never performs it inline.
    const config = { ...baseConfig, skipRetention: true }
    const runtime = new ProductionAutoBidRuntime(db, provider)
    const results = await runStages(config, runtime, () => undefined)
    runs.push({ campaignName, runKey: config.runKey, results })
  }
  return { mode, campaigns: runs.length, runs }
}

export async function processOneAutoBidCommand(): Promise<{ processed: boolean; commandId?: string; result?: Raw }> {
  const db = getDb()
  await enqueueScheduledCommand(db)
  const command = await claimCommand(db)
  if (!command) return { processed: false }
  try {
    const { provider } = await createProductionNaverProvider(command.firmId)
    const result = await executeCommand(db, provider, command)
    await db.update(naverAutoBidCommands).set({ status: 'succeeded', result, finishedAt: new Date(), updatedAt: new Date() })
      .where(eq(naverAutoBidCommands.id, command.id))
    return { processed: true, commandId: command.id, result }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await db.update(naverAutoBidCommands).set({ status: 'failed', error: message.slice(0, 1000), finishedAt: new Date(), updatedAt: new Date() })
      .where(eq(naverAutoBidCommands.id, command.id))
    await db.insert(naverAutoBidEvents).values({ firmId: command.firmId, eventType: 'error', severity: 'error',
      message: `명령 실패: ${command.command} (${message.slice(0, 300)})`, correlationKey: `command:${command.id}` })
    throw error
  }
}

async function main(): Promise<void> {
  const forever = process.env.NAVER_AUTO_BID_FOREVER === '1'
  const idleMs = Math.max(1_000, Number(process.env.NAVER_AUTO_BID_IDLE_MS ?? 5_000) || 5_000)
  do {
    try {
      const result = await processOneAutoBidCommand()
      console.log(JSON.stringify({ ...result, at: new Date().toISOString() }))
      if (!forever) return
      // Completed commands can immediately yield to the next queued campaign
      // command. An empty queue sleeps to avoid a database busy loop.
      if (!result.processed) await new Promise((resolve) => setTimeout(resolve, idleMs))
    } catch (error) {
      if (!forever) throw error
      console.error(JSON.stringify({ processed: false, workerError:
        error instanceof Error ? error.message : String(error), at: new Date().toISOString() }))
      await new Promise((resolve) => setTimeout(resolve, idleMs))
    }
  } while (forever)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1 })
}
