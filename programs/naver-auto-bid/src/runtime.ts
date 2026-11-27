import { and, eq, inArray, sql } from 'drizzle-orm'
import type { Db } from '@/lib/db/client'
import { getDb } from '@/lib/db/client'
import {
  firmAdEntities,
  firmCredentials,
  firmKeywords,
  firms,
  keywords,
  naverAutoBidDecisions,
  naverAutoBidEvents,
  naverAutoBidGroupPolicies,
  naverAutoBidKeywordPolicies,
  naverAutoBidRuns,
} from '@/lib/db/schema'
import { decryptCred } from '@/lib/engine/cred-crypto'
import { NaverSearchAdClient } from '@/lib/engine/naver/client'
import type { AutoBidStageContext, NaverAutoBidAdapter } from './cli'
import type { AutoBidConfig } from './config'
import { evaluateEligibility, decideBid } from './policy'
import { NaverProvider, type NaverKeywordRow } from './naver-provider'
import { NaverSerpRankObserver, type ObservedRank, type RankObserver } from './rank-observer'
import { updateRankLearning, type CompactRankObservation } from './rank-learning'
import { recordBidOutcome, type VerifiedBidAction, type BidOutcome } from './bid-outcomes'
import { pruneRankEvidence } from './rank-retention'
import { BID_SETTLEMENT_MS, bidIsSettled, rankQueuePriority } from './bid-settlement'
import { isWithinAutoBidSchedule, type AutoBidSchedule } from './control-plane'
import {
  getNaverAutoBidRun,
  getNaverAutoBidPolicy,
  startNaverAutoBidRun,
  updateNaverAutoBidRun,
  upsertNaverAutoBidPolicy,
} from './repository'

type Raw = Record<string, unknown>
type Decision = typeof naverAutoBidDecisions.$inferSelect

function record(value: unknown): Raw {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Raw : {}
}

function textValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function id(row: Raw, field: string): string | null {
  return textValue(row[field])
}

function boolValue(value: unknown): boolean | null {
  if (value === true || value === 1 || value === '1' || value === 'true') return true
  if (value === false || value === 0 || value === '0' || value === 'false') return false
  return null
}

function intValue(value: unknown): number | null {
  const number = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value
  return typeof number === 'number' && Number.isSafeInteger(number) && number >= 0 ? number : null
}

function chunks<T>(values: readonly T[], size: number): T[][] {
  const result: T[][] = []
  for (let offset = 0; offset < values.length; offset += size) result.push(values.slice(offset, offset + size))
  return result
}

async function mapConcurrent<T, R>(
  values: readonly T[],
  concurrency: number,
  work: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length)
  let cursor = 0
  const worker = async () => {
    while (cursor < values.length) {
      const index = cursor++
      results[index] = await work(values[index], index)
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, () => worker()))
  return results
}

function activeRow(row: Raw): boolean {
  return String(row.status ?? '').toUpperCase() !== 'DELETED'
}

function remoteKeyword(row: Raw): string | null {
  return textValue(row.keyword)
}

function effectiveBid(keyword: Raw, group: Raw): number | null {
  return boolValue(keyword.useGroupBidAmt) === true
    ? intValue(group.bidAmt)
    : intValue(keyword.bidAmt)
}

function publicRaw(value: Raw): Raw {
  const copy = { ...value }
  for (const key of Object.keys(copy)) {
    if (/secret|api.?key|credential|signature/i.test(key)) delete copy[key]
  }
  return copy
}

function compactRankObservation(value: ObservedRank): Raw {
  return {
    keyword: value.keyword,
    device: value.device,
    status: value.status,
    rank: value.rank,
    visibleAds: value.visibleAds,
    legalCompetitorPresent: value.legalCompetitorPresent,
    legalCompetitorCount: value.legalCompetitorCount,
    source: value.source,
    latencyMs: value.latencyMs,
    observedAt: value.observedAt,
  }
}

function policyFromConfig(config: AutoBidConfig, ceiling = config.ceiling) {
  return {
    device: config.device,
    floor: config.floor,
    ceiling,
    stepUp: config.stepUp,
    stepDown: config.stepDown,
    allowBidDecrease: config.allowBidDecrease,
    exposureBuffer: config.exposureBuffer,
    cooldownMs: config.strategy === 'observed_rank' ? BID_SETTLEMENT_MS : config.cooldownHours * 60 * 60 * 1000,
    batchSize: config.batchSize,
    maxChangesPerRun: config.maxChanges,
  } as const
}

function decisionRaw(row: Decision): Raw {
  return record(row.raw)
}

function remoteFromDecision(row: Decision): NaverKeywordRow {
  return record(decisionRaw(row).remote)
}

async function rowsForRun(db: Db, firmId: number, runId: string): Promise<Decision[]> {
  return db.select().from(naverAutoBidDecisions).where(and(
    eq(naverAutoBidDecisions.firmId, firmId),
    eq(naverAutoBidDecisions.runId, runId),
  ))
}

async function updateDecisionsBulk(db: Pick<Db, 'execute'>, patches: Raw[]): Promise<void> {
  for (const batch of chunks(patches, 500)) {
    if (!batch.length) continue
    await db.execute(sql`update naver_auto_bid_decisions as decision set
      status = patch.status,
      estimated_bid = patch.estimated_bid,
      target_bid = patch.target_bid,
      after_bid = patch.after_bid,
      after_use_group_bid = patch.after_use_group_bid,
      reason = patch.reason,
      cooldown_until = patch.cooldown_until,
      raw = patch.raw,
      response_raw = patch.response_raw,
      error = patch.error,
      verification_status = patch.verification_status,
      verification_error = patch.verification_error,
      verification_raw = patch.verification_raw,
      verified_at = patch.verified_at,
      applied_at = patch.applied_at,
      updated_at = now()
      from jsonb_to_recordset(${JSON.stringify(batch)}::jsonb) as patch(
        id uuid, status text, estimated_bid integer, target_bid integer, after_bid integer,
        after_use_group_bid boolean, reason text, cooldown_until timestamptz, raw jsonb,
        response_raw jsonb, error text, verification_status text,
        verification_error text, verification_raw jsonb, verified_at timestamptz,
        applied_at timestamptz
      ) where decision.id = patch.id`)
  }
}

async function updateKeywordRanksBulk(db: Pick<Db, 'execute'>, firmId: number, patches: Raw[]): Promise<void> {
  for (const batch of chunks(patches, 500)) {
    if (!batch.length) continue
    await db.execute(sql`update naver_auto_bid_keyword_policies as policy set
      last_observed_rank = patch.rank,
      last_observed_status = patch.status,
      last_observed_bid = patch.bid,
      last_visible_ads = patch.visible_ads,
      last_observed_at = patch.observed_at,
      legal_competitor_present = patch.legal_competitor_present,
      legal_competitor_count = patch.legal_competitor_count,
      legal_competitors = patch.legal_competitors,
      observation_count = patch.observation_count,
      found_count = patch.found_count,
      outside_count = patch.outside_count,
      no_ads_count = patch.no_ads_count,
      consecutive_status_count = patch.consecutive_status_count,
      observation_window = patch.observation_window,
      bid_learning = patch.bid_learning,
      raw = coalesce(policy.raw, '{}'::jsonb) || jsonb_build_object(
        'lastRankObservation', patch.observation, 'bidOutcomes', patch.bid_outcomes),
      updated_at = patch.observed_at
      from jsonb_to_recordset(${JSON.stringify(batch)}::jsonb) as patch(
        naver_keyword_id text, rank integer, status text, bid integer,
        visible_ads integer, observed_at timestamptz,
        legal_competitor_present boolean, legal_competitor_count integer,
        legal_competitors jsonb, observation_count integer, found_count integer,
        outside_count integer, no_ads_count integer, consecutive_status_count integer,
        observation_window jsonb, bid_learning jsonb, observation jsonb, bid_outcomes jsonb
      ) where policy.firm_id = ${firmId}
        and policy.naver_keyword_id = patch.naver_keyword_id`)
  }
}

export class ProductionAutoBidRuntime implements NaverAutoBidAdapter {
  constructor(
    private readonly db: Db,
    private readonly provider: NaverProvider,
    private rankObserver: RankObserver | null = null,
  ) {}

  private async requireRankObserver(config: AutoBidConfig): Promise<RankObserver> {
    if (this.rankObserver) return this.rankObserver
    const [firm] = await this.db.select({ domain: firms.domain }).from(firms)
      .where(eq(firms.id, config.firmId)).limit(1)
    this.rankObserver = new NaverSerpRankObserver(firm?.domain ?? '', {
      requestsPerMinute: config.rankRequestsPerMinute,
      concurrency: config.rankConcurrency,
      minIntervalMs: config.rankIntervalMs,
      proxyUrl: process.env.NAVER_RANK_PROXY_URL,
    })
    return this.rankObserver
  }

  async runStage(stage: AutoBidStageContext['stage'], context: AutoBidStageContext): Promise<unknown> {
    try {
      switch (stage) {
        case 'snapshot': return await this.snapshot(context)
        case 'estimate': return await this.estimate(context)
        case 'decide': return await this.decide(context)
        case 'apply': return await this.apply(context)
        case 'verify': return await this.verify(context)
        case 'report': return await this.report(context)
      }
    } catch (error) {
      // Release the firm-level DB lease after any terminal stage failure. The
      // shell ledger records the same failure for operations visibility.
      const run = await getNaverAutoBidRun(this.db, {
        firmId: context.config.firmId,
        runKey: context.config.runKey,
      }).catch(() => null)
      if (run?.status === 'running') {
        await updateNaverAutoBidRun(this.db, {
          firmId: context.config.firmId,
          runId: run.id,
          status: 'failed',
          error: error instanceof Error ? error.message : String(error),
          finishedAt: new Date(),
        }).catch(() => undefined)
      }
      throw error
    }
  }

  private async requireRun(config: AutoBidConfig) {
    const run = await getNaverAutoBidRun(this.db, { firmId: config.firmId, runKey: config.runKey })
    if (!run) throw new Error(`auto-bid run not found: ${config.runKey}; run snapshot first`)
    return run
  }

  async snapshot({ config }: AutoBidStageContext): Promise<unknown> {
    if (config.keywordIds && !config.keywordIds.length) throw new Error('empty keyword scope')
    // A dry-run may use one step above the floor as a harmless preview bound.
    // Live mode is already fail-closed in config.ts and can never use this fallback.
    const effectiveCeiling = config.ceiling ?? config.floor + config.stepUp
    const existingPolicy = await getNaverAutoBidPolicy(this.db, config.firmId)
    const policyResult = existingPolicy ? { policy: existingPolicy } : await upsertNaverAutoBidPolicy(this.db, {
      firmId: config.firmId,
      strategy: config.strategy,
      device: config.device,
      targetPosition: config.targetPosition,
      bidFloor: config.floor,
      bidCeiling: effectiveCeiling,
      stepUp: config.stepUp,
      stepDown: config.stepDown,
      allowBidDecrease: config.allowBidDecrease,
      exposureBuffer: config.exposureBuffer,
      cooldownHours: config.cooldownHours,
      batchSize: config.batchSize,
      maxChangesPerRun: config.maxChanges,
      raw: { campaignName: config.campaignName },
    })
    const runResult = await startNaverAutoBidRun(this.db, {
      firmId: config.firmId,
      runKey: config.runKey,
      policyId: policyResult.policy.id,
      dryRun: config.dryRun,
      device: config.device,
      raw: { config, effectiveCeiling },
    })
    const run = runResult.run
    if (run.status !== 'running') throw new Error(`run ${config.runKey} is already terminal (${run.status})`)

    const campaigns = await this.provider.getCampaigns()
    const campaign = campaigns.find((row) => row.name === config.campaignName && activeRow(row))
    const campaignId = campaign ? id(campaign, 'nccCampaignId') : null
    if (!campaignId) throw new Error(`campaign not found: ${config.campaignName}`)
    const groups = (await this.provider.getAdGroups(campaignId)).filter(activeRow)
    if (!groups.length) throw new Error(`campaign has no ad groups: ${config.campaignName}`)

    // The control plane is the source of truth. Newly discovered rows remain
    // disabled until an operator explicitly enables them, so a runtime cannot
    // silently start bidding across an entire account.
    const configuredGroups = await this.db.select().from(naverAutoBidGroupPolicies).where(and(
      eq(naverAutoBidGroupPolicies.firmId, config.firmId),
      eq(naverAutoBidGroupPolicies.enabled, true),
    ))
    const groupPolicyById = new Map(configuredGroups.map((row) => [row.naverAdgroupId, row]))
    const configuredKeywords = await this.db.select().from(naverAutoBidKeywordPolicies).where(and(
      eq(naverAutoBidKeywordPolicies.firmId, config.firmId),
      eq(naverAutoBidKeywordPolicies.enabled, true),
      config.keywordIds ? inArray(naverAutoBidKeywordPolicies.naverKeywordId, [...config.keywordIds]) : undefined,
    ))
    const keywordPolicyById = new Map(configuredKeywords.map((row) => [row.naverKeywordId, row]))

    const localRows = await this.db.select({
      entityId: firmAdEntities.id,
      naverId: firmAdEntities.naverId,
      keywordId: firmAdEntities.keywordId,
      firmKeywordId: firmKeywords.id,
      localStatus: firmKeywords.status,
      adDesired: firmKeywords.adDesired,
      hostStatus: firmKeywords.hostStatus,
      archivedAt: firmKeywords.archivedAt,
      sourceStatus: keywords.status,
    }).from(firmAdEntities)
      .leftJoin(firmKeywords, and(
        eq(firmKeywords.firmId, config.firmId),
        eq(firmKeywords.keywordId, firmAdEntities.keywordId),
      ))
      .leftJoin(keywords, eq(keywords.id, firmAdEntities.keywordId))
      .where(and(eq(firmAdEntities.firmId, config.firmId), eq(firmAdEntities.entityType, 'keyword'),
        config.keywordIds ? inArray(firmAdEntities.naverId, [...config.keywordIds]) : undefined))
    const localByNaverId = new Map(localRows.map((row) => [row.naverId, row]))

    const latestApplied = config.keywordIds ? { rows: configuredKeywords.map(row => ({
      naver_keyword_id: row.naverKeywordId, applied_at: row.lastChangedAt?.toISOString() ?? null,
    })) } : await this.db.execute(sql`select distinct on (naver_keyword_id)
      naver_keyword_id, applied_at from naver_auto_bid_decisions
      where firm_id=${config.firmId} and applied_at is not null
      order by naver_keyword_id, applied_at desc`)
    const lastAppliedById = new Map(latestApplied.rows.map((row) => [String(row.naver_keyword_id), row.applied_at]))

    const values: Array<typeof naverAutoBidDecisions.$inferInsert> = []
    let remoteCount = 0
    for (const group of groups) {
      const groupId = id(group, 'nccAdgroupId')
      if (!groupId) continue
      if (config.keywordIds && !configuredKeywords.some(row => row.naverAdgroupId === groupId)) continue
      const groupPolicy = groupPolicyById.get(groupId)
      if (!groupPolicy) continue
      const remoteRows = (await this.provider.getKeywords(groupId)).filter(row => activeRow(row)
        && (!config.keywordIds || keywordPolicyById.has(id(row, 'nccKeywordId') ?? '')))
      remoteCount += remoteRows.length
      for (const remote of remoteRows) {
        const naverKeywordId = id(remote, 'nccKeywordId')
        const keyword = remoteKeyword(remote)
        if (!naverKeywordId || !keyword) continue
        const keywordPolicy = keywordPolicyById.get(naverKeywordId)
        if (!keywordPolicy || keywordPolicy.naverAdgroupId !== groupId) continue
        if (config.legalCompetitorsOnly && !keywordPolicy.legalCompetitorPresent) continue
        const local = localByNaverId.get(naverKeywordId)
        const eligibility = evaluateEligibility({
          reviewStatus: local ? String(remote.inspectStatus ?? '') : 'unknown',
          providerStatus: String(remote.status ?? remote.statusReason ?? ''),
          userLock: remote.userLock as never,
          localStatus: local?.localStatus ?? 'unknown',
          adDesired: local?.adDesired ?? null,
          hostStatus: local?.hostStatus ?? null,
          publicHostLabel: local?.hostStatus === 'public' ? 'present' : null,
          archivedAt: local?.archivedAt ?? null,
          sourceStatus: local?.sourceStatus ?? null,
          sourceBlocked: local?.sourceStatus === 'blocked',
        })
        const beforeBid = effectiveBid(remote, group)
        const configuredCeiling = keywordPolicy.bidCeiling ?? groupPolicy.bidCeiling ?? effectiveCeiling
        values.push({
          firmId: config.firmId,
          runId: run.id,
          keywordId: local?.keywordId ?? null,
          firmKeywordId: local?.firmKeywordId ?? null,
          firmAdEntityId: local?.entityId ?? null,
          naverKeywordId,
          device: config.device,
          status: eligibility.eligible ? 'planned' : 'skipped',
          beforeBid,
          beforeUseGroupBid: boolValue(remote.useGroupBidAmt),
          reason: eligibility.eligible ? 'eligible' : eligibility.reasonCodes.join(','),
          raw: publicRaw({ remote, keyword, campaignId, campaignName: config.campaignName,
            adgroupId: groupId, adgroupName: textValue(group.name), groupBidAmt: group.bidAmt,
            effectivePolicy: {
              targetPosition: keywordPolicy.targetPosition ?? groupPolicy.targetPosition ?? config.targetPosition,
              floor: keywordPolicy.bidFloor ?? groupPolicy.bidFloor ?? config.floor,
              // Per-keyword/group policy may retain an older, higher ceiling.
              // The run-level ceiling is the final live mutation boundary.
              ceiling: config.fastAcquire4000 ? 4000 : Math.min(effectiveCeiling, configuredCeiling),
              stepUp: keywordPolicy.stepUp ?? groupPolicy.stepUp ?? config.stepUp,
              stepDown: keywordPolicy.stepDown ?? groupPolicy.stepDown ?? config.stepDown,
              allowBidDecrease: config.allowBidDecrease,
            },
            eligibility, lastBidChangedAt: lastAppliedById.get(naverKeywordId) ?? null,
            priorRankState: {
              lastBidAction: record(keywordPolicy.raw).lastBidAction,
              bidOutcomes: record(keywordPolicy.raw).bidOutcomes,
              status: keywordPolicy.lastObservedStatus,
              rank: keywordPolicy.lastObservedRank,
              bid: keywordPolicy.lastObservedBid,
              visibleAds: keywordPolicy.lastVisibleAds,
              observedAt: keywordPolicy.lastObservedAt?.toISOString() ?? null,
              legalCompetitorPresent: keywordPolicy.legalCompetitorPresent,
              legalCompetitorCount: keywordPolicy.legalCompetitorCount,
              observationCount: keywordPolicy.observationCount,
              foundCount: keywordPolicy.foundCount,
              outsideCount: keywordPolicy.outsideCount,
              noAdsCount: keywordPolicy.noAdsCount,
              consecutiveStatusCount: keywordPolicy.consecutiveStatusCount,
              observationWindow: keywordPolicy.observationWindow,
              bidLearning: keywordPolicy.bidLearning,
            },
          }),
        })
      }
    }
    for (const batch of chunks(values, 500)) {
      await this.db.insert(naverAutoBidDecisions).values(batch).onConflictDoNothing({
        target: [naverAutoBidDecisions.runId, naverAutoBidDecisions.naverKeywordId],
      })
    }
    await updateNaverAutoBidRun(this.db, {
      firmId: config.firmId,
      runId: run.id,
      candidateCount: values.length,
      skippedCount: values.filter((row) => row.status === 'skipped').length,
      heartbeatAt: new Date(),
      raw: { config, effectiveCeiling, campaignId, groups: groups.length, remoteKeywords: remoteCount },
    })
    return { campaignId, groups: groups.length, remoteKeywords: remoteCount, recorded: values.length,
      eligible: values.filter((row) => row.status === 'planned').length }
  }

  async estimate({ config }: AutoBidStageContext): Promise<unknown> {
    const run = await this.requireRun(config)
    const rows = (await rowsForRun(this.db, config.firmId, run.id)).filter((row) => row.status === 'planned')
    if (config.strategy === 'observed_rank') {
      const rankObserver = await this.requireRankObserver(config)
      const policy = await getNaverAutoBidPolicy(this.db, config.firmId)
      if (!policy) throw new Error('rank observation requires a configured policy schedule')
      const completed = rows.filter((row) => textValue(record(decisionRaw(row).rankObservation).observedAt))
      const completedIds = new Set(completed.map((row) => row.id))
      const selectionTime = Date.now()
      const ready = (row: Decision) => bidIsSettled(decisionRaw(row).lastBidChangedAt, selectionTime)
      const priority = (row: Decision) => rankQueuePriority(decisionRaw(row).lastBidChangedAt,
        record(decisionRaw(row).priorRankState).observedAt, selectionTime)
      const ordered = rows.filter((row) => !completedIds.has(row.id)).sort((left, right) =>
        priority(left) - priority(right) || String(record(decisionRaw(left).priorRankState).observedAt ?? '')
          .localeCompare(String(record(decisionRaw(right).priorRankState).observedAt ?? ''))
        || left.naverKeywordId.localeCompare(right.naverKeywordId))
      const selectedIds = new Set(ordered.filter(ready).slice(0, Math.max(0, config.rankCheckLimit - completed.length)).map((row) => row.id))
      const patches: Raw[] = []
      const events: Array<typeof naverAutoBidEvents.$inferInsert> = []
      const policyUpdates: Raw[] = []
      const flush = async () => {
        await this.db.transaction(async (tx) => {
          await updateDecisionsBulk(tx, patches)
          await updateKeywordRanksBulk(tx, config.firmId, policyUpdates)
          for (const batch of chunks(events, 500)) {
            if (batch.length) await tx.insert(naverAutoBidEvents).values(batch)
          }
          await tx.update(naverAutoBidRuns).set({ heartbeatAt: new Date() })
            .where(and(eq(naverAutoBidRuns.firmId, config.firmId), eq(naverAutoBidRuns.id, run.id)))
        })
        patches.length = 0
        policyUpdates.length = 0
        events.length = 0
      }
      let observed = 0
      let failed = 0
      for (const row of ordered) {
        const raw = decisionRaw(row)
        if (!selectedIds.has(row.id)) {
          const deferredRaw = { ...raw }
          delete deferredRaw.priorRankState
          patches.push({
            id: row.id, status: 'skipped', estimated_bid: null, target_bid: row.targetBid,
            after_bid: row.afterBid, after_use_group_bid: row.afterUseGroupBid,
            reason: ready(row) ? 'rank_check_deferred' : 'bid_settlement_pending', cooldown_until: row.cooldownUntil, raw: deferredRaw,
            response_raw: row.responseRaw, error: null, verification_status: row.verificationStatus,
            verification_error: row.verificationError, verification_raw: row.verificationRaw,
            verified_at: row.verifiedAt, applied_at: row.appliedAt,
          })
        }
      }
      const selected = ordered.filter((row) => selectedIds.has(row.id))
      await flush()
      // Checkpoint bounded batches so an interrupted sweep retains completed
      // observations and competitor payloads do not accumulate for the full account.
      for (const selection of chunks(selected, 250)) {
      const observations = await mapConcurrent(selection, config.rankConcurrency, async (row) => {
        try {
          return { ok: true as const, row,
            observation: await rankObserver.observe(String(decisionRaw(row).keyword ?? ''), config.device) }
        } catch (error) {
          return { ok: false as const, row, error }
        }
      })
      for (const result of observations) {
        const row = result.row
        const raw = decisionRaw(row)
        const compactRaw = { ...raw }
        delete compactRaw.priorRankState
        if (result.ok) {
          const observation = result.observation
          const biddingEligible = isWithinAutoBidSchedule(new Date(observation.observedAt), policy.schedule as AutoBidSchedule)
            && bidIsSettled(raw.lastBidChangedAt, Date.parse(observation.observedAt))
          const compactObservation = { ...compactRankObservation(observation), biddingEligible }
          const prior = record(raw.priorRankState)
          const effectivePolicy = record(raw.effectivePolicy)
          const targetPosition = intValue(effectivePolicy.targetPosition) ?? config.targetPosition
          const learning = updateRankLearning({
            confirmationReads: config.rankConfirmationReads,
            biddingEligible,
            priorWindow: Array.isArray(prior.observationWindow)
              ? (prior.observationWindow as CompactRankObservation[]).filter(item =>
                bidIsSettled(raw.lastBidChangedAt, Date.parse(item.at))) : [],
            priorLearning: record(prior.bidLearning),
            observation,
            currentBid: row.beforeBid,
            targetPosition,
            floor: intValue(effectivePolicy.floor) ?? config.floor,
            ceiling: intValue(effectivePolicy.ceiling) ?? config.ceiling ?? config.floor + config.stepUp,
            stepUp: intValue(effectivePolicy.stepUp) ?? config.stepUp,
            stepDown: intValue(effectivePolicy.stepDown) ?? config.stepDown,
          })
          observed++
          patches.push({
            id: row.id, status: 'planned', estimated_bid: null, target_bid: row.targetBid,
            after_bid: row.afterBid, after_use_group_bid: row.afterUseGroupBid,
            reason: `observed_${observation.status}`, cooldown_until: row.cooldownUntil,
            raw: { ...compactRaw, rankObservation: compactObservation, rankLearning: learning.learning },
            response_raw: row.responseRaw, error: null,
            verification_status: row.verificationStatus, verification_error: row.verificationError,
            verification_raw: row.verificationRaw, verified_at: row.verifiedAt, applied_at: row.appliedAt,
          })
          // The keyword-policy row is the complete hot state.  Keep the event
          // table sparse: only transitions after an established baseline are
          // worth a durable event.
          if (textValue(prior.status) && learning.stateChanged) events.push({
              firmId: config.firmId, runId: run.id, decisionId: row.id,
              naverCampaignId: textValue(raw.campaignId), naverAdgroupId: textValue(raw.adgroupId),
              naverKeywordId: row.naverKeywordId, campaignName: textValue(raw.campaignName),
              adgroupName: textValue(raw.adgroupName), keyword: textValue(raw.keyword),
              eventType: 'rank_observation', beforeRank: intValue(prior.rank), afterRank: observation.rank,
              targetPosition,
              beforeBid: row.beforeBid,
              message: `${textValue(raw.keyword) ?? row.naverKeywordId}: ${textValue(prior.status)} ${intValue(prior.rank) ?? '-'}위 → ${observation.status} ${observation.rank ?? '-'}위`,
              correlationKey: `decision:${row.id}:rank-transition`, raw: { observation: compactObservation },
            })
          const priorStatus = textValue(prior.status)
          const action = record(prior.lastBidAction)
          const priorOutcomes = Array.isArray(prior.bidOutcomes) ? prior.bidOutcomes as BidOutcome[] : []
          const bidOutcomes = biddingEligible ? recordBidOutcome(
            typeof action.decisionId === 'string' ? action as unknown as VerifiedBidAction : null,
            priorOutcomes,
            observation, row.beforeBid,
          ) : priorOutcomes
          policyUpdates.push({
            naver_keyword_id: row.naverKeywordId,
            rank: observation.rank,
            status: observation.status,
            bid: row.beforeBid,
            visible_ads: observation.visibleAds,
            observed_at: observation.observedAt,
            legal_competitor_present: observation.legalCompetitorPresent,
            legal_competitor_count: observation.legalCompetitorCount,
            legal_competitors: observation.legalCompetitors,
            observation_count: (intValue(prior.observationCount) ?? 0) + 1,
            found_count: (intValue(prior.foundCount) ?? 0) + (observation.status === 'found' ? 1 : 0),
            outside_count: (intValue(prior.outsideCount) ?? 0) + (observation.status === 'outside' ? 1 : 0),
            no_ads_count: (intValue(prior.noAdsCount) ?? 0) + (observation.status === 'no_ads' ? 1 : 0),
            consecutive_status_count: priorStatus === observation.status
              ? (intValue(prior.consecutiveStatusCount) ?? 0) + 1 : 1,
            observation_window: learning.window,
            bid_learning: learning.learning,
            observation: compactObservation,
            bid_outcomes: bidOutcomes,
          })
        } else {
          const error = result.error
          failed++
          patches.push({
            id: row.id, status: 'skipped', estimated_bid: null, target_bid: row.targetBid,
            after_bid: row.afterBid, after_use_group_bid: row.afterUseGroupBid,
            reason: 'rank_observation_failed', cooldown_until: row.cooldownUntil, raw: compactRaw,
            response_raw: row.responseRaw, error: error instanceof Error ? error.message : String(error),
            verification_status: row.verificationStatus, verification_error: row.verificationError,
            verification_raw: row.verificationRaw, verified_at: row.verifiedAt, applied_at: row.appliedAt,
          })
          events.push({
            firmId: config.firmId, runId: run.id, decisionId: row.id,
            naverCampaignId: textValue(raw.campaignId), naverAdgroupId: textValue(raw.adgroupId),
            naverKeywordId: row.naverKeywordId, campaignName: textValue(raw.campaignName),
            adgroupName: textValue(raw.adgroupName), keyword: textValue(raw.keyword),
            eventType: 'error', severity: 'warning', beforeBid: row.beforeBid,
            message: `${textValue(raw.keyword) ?? row.naverKeywordId}: 실제 순위조회 실패`,
            correlationKey: `decision:${row.id}:rank-error`,
            raw: { error: error instanceof Error ? error.message : String(error) },
          })
        }
      }
      await flush()
      }
      return { strategy: config.strategy, requested: selectedIds.size, observed, failed,
        reused: completed.length, deferred: ordered.length - selectedIds.size, targetPosition: config.targetPosition,
        requestsPerMinute: config.rankRequestsPerMinute, concurrency: config.rankConcurrency }
    }
    const targets = rows.map((row) => ({
      keyword: String(decisionRaw(row).keyword ?? ''),
      position: intValue(record(decisionRaw(row).effectivePolicy).targetPosition) ?? config.targetPosition,
    })).filter((target) => Boolean(target.keyword))
    const estimates = config.strategy === 'target_position'
      ? await this.provider.estimateAveragePositionBids(
        targets,
        { device: config.device, batchSize: config.batchSize },
      )
      : await this.provider.estimateExposureMinimumBids(targets.map((target) => target.keyword), {
        device: config.device,
        period: 'MONTH',
        batchSize: config.batchSize,
      })
    const byKeyword = new Map(estimates.map((estimate) => [estimate.keyword, estimate]))
    const patches = rows.map((row) => {
      const raw = decisionRaw(row)
      const estimate = byKeyword.get(String(raw.keyword))
      return {
        id: row.id, status: estimate?.bid === null || estimate?.bid === undefined ? 'skipped' : row.status,
        estimated_bid: estimate?.bid ?? null, target_bid: row.targetBid, after_bid: row.afterBid,
        after_use_group_bid: row.afterUseGroupBid,
        reason: estimate?.bid === null || estimate?.bid === undefined ? 'estimate_missing' : row.reason,
        cooldown_until: row.cooldownUntil, raw: { ...raw, estimate: estimate?.raw ?? null }, response_raw: row.responseRaw,
        error: row.error, verification_status: row.verificationStatus,
        verification_error: row.verificationError, verification_raw: row.verificationRaw,
        verified_at: row.verifiedAt, applied_at: row.appliedAt,
      }
    })
    await updateDecisionsBulk(this.db, patches)
    await updateNaverAutoBidRun(this.db, { firmId: config.firmId, runId: run.id, heartbeatAt: new Date() })
    return {
      strategy: config.strategy,
      targetPosition: config.strategy === 'target_position' ? config.targetPosition : null,
      requested: targets.length,
      estimated: estimates.filter((item) => item.bid !== null).length,
    }
  }

  async decide({ config }: AutoBidStageContext): Promise<unknown> {
    const run = await this.requireRun(config)
    const effectiveCeiling = intValue(record(run.raw).effectiveCeiling) ?? config.ceiling
    const rows = await rowsForRun(this.db, config.firmId, run.id)
    const now = new Date()
    const patches: Raw[] = []
    const events: Array<typeof naverAutoBidEvents.$inferInsert> = []
    let changed = 0
    let skipped = 0
    for (const row of rows) {
      if (row.status !== 'planned') { skipped++; continue }
      const raw = decisionRaw(row)
      const eligibility = record(raw.eligibility)
      const effectivePolicy = record(raw.effectivePolicy)
      const rowCeiling = intValue(effectivePolicy.ceiling) ?? effectiveCeiling
      const rankObservation = record(raw.rankObservation)
      const observedRank = intValue(rankObservation.rank)
      const observedStatus = textValue(rankObservation.status)
      const targetPosition = intValue(record(raw.effectivePolicy).targetPosition) ?? config.targetPosition
      // Operator rule: a confirmed third-place result is already acceptable;
      // never lower the bid merely to force it into fourth place.
      const preserveThirdPlace = config.strategy === 'observed_rank' && observedRank === 3
      const rowStepUp = intValue(effectivePolicy.stepUp) ?? config.stepUp
      const rowStepDown = intValue(effectivePolicy.stepDown) ?? config.stepDown
      let decisionBid = row.estimatedBid
      let decisionStepUp = rowStepUp
      let decisionStepDown = rowStepDown
      if (config.strategy === 'observed_rank') {
        if (row.beforeBid === null || !observedStatus || rankObservation.biddingEligible === false
          || (config.legalCompetitorsOnly && rankObservation.legalCompetitorPresent !== true)) {
          patches.push({
            id: row.id, status: 'skipped', estimated_bid: row.estimatedBid, target_bid: null,
            after_bid: row.afterBid, after_use_group_bid: row.afterUseGroupBid,
            reason: config.legalCompetitorsOnly && rankObservation.legalCompetitorPresent !== true
              ? 'legal_competitor_not_observed' : rankObservation.biddingEligible === false
                ? 'rank_observation_outside_schedule' : 'rank_observation_missing', cooldown_until: row.cooldownUntil, raw,
            response_raw: row.responseRaw, error: row.error, verification_status: row.verificationStatus,
            verification_error: row.verificationError, verification_raw: row.verificationRaw,
            verified_at: row.verifiedAt, applied_at: row.appliedAt,
          })
          skipped++
          continue
        }
        const rankLearning = record(raw.rankLearning)
        const recommendedBid = intValue(rankLearning.recommendedBid)
        decisionBid = recommendedBid ?? row.beforeBid
        if (textValue(rankLearning.phase) === 'unexposed') {
          patches.push({
            id: row.id, status: 'skipped', estimated_bid: row.estimatedBid, target_bid: null,
            after_bid: row.afterBid, after_use_group_bid: row.afterUseGroupBid,
            reason: 'unexposed_above_1500_hold', cooldown_until: row.cooldownUntil,
            raw: { ...raw, evidenceState: 'UNEXPOSED' },
            response_raw: row.responseRaw, error: row.error, verification_status: row.verificationStatus,
            verification_error: row.verificationError, verification_raw: row.verificationRaw,
            verified_at: row.verifiedAt, applied_at: row.appliedAt,
          })
          skipped++
          continue
        }
        if (config.fastAcquire4000 && observedStatus === 'outside'
          && (!config.legalCompetitorsOnly || rankObservation.legalCompetitorPresent === true)
          && Number(rankObservation.visibleAds) > 0) {
          decisionBid = Math.min(4000, row.beforeBid + 1000)
          decisionStepUp = 1000
        }
      }
      const decision = decideBid({
        keywordId: row.naverKeywordId,
        currentBid: row.beforeBid,
        estimatedMinimumBid: decisionBid,
        lastBidChangedAt: raw.lastBidChangedAt as string | null,
        now,
        policy: {
          ...policyFromConfig(config, rowCeiling),
          floor: intValue(effectivePolicy.floor) ?? config.floor,
          stepUp: decisionStepUp,
          stepDown: decisionStepDown,
          allowBidDecrease: preserveThirdPlace ? false : effectivePolicy.allowBidDecrease !== false,
          exposureBuffer: config.strategy === 'observed_rank' ? 0 : config.exposureBuffer,
        },
        mode: config.mode,
        eligibility: {
          eligible: eligibility.eligible === true,
          reasonCodes: Array.isArray(eligibility.reasonCodes) ? eligibility.reasonCodes as never : [],
          reasons: Array.isArray(eligibility.reasons) ? eligibility.reasons as string[] : [],
        },
      })
      if (decision.changed) changed++; else skipped++
      const cooldownUntil = decision.changed
        ? new Date(now.getTime() + policyFromConfig(config).cooldownMs)
        : row.cooldownUntil
      patches.push({
        id: row.id, status: decision.changed ? 'planned' : decision.cooldownActive ? 'cooldown' : 'skipped',
        estimated_bid: row.estimatedBid, target_bid: decision.proposedBid,
        after_bid: row.afterBid, after_use_group_bid: row.afterUseGroupBid,
        reason: decision.reasonCodes.join(','), cooldown_until: cooldownUntil,
        raw: { ...raw, decision }, response_raw: row.responseRaw, error: row.error,
        verification_status: row.verificationStatus, verification_error: row.verificationError,
        verification_raw: row.verificationRaw, verified_at: row.verifiedAt, applied_at: row.appliedAt,
      })
      // A live cycle records only mutations at apply-time. A dry preview keeps
      // a bounded sample while the run counters retain the full candidate total.
      if (decision.changed && config.dryRun && events.length < (config.maxChanges ?? 1_000)) events.push({
        firmId: config.firmId, runId: run.id, decisionId: row.id,
        naverCampaignId: textValue(raw.campaignId), naverAdgroupId: textValue(raw.adgroupId),
        naverKeywordId: row.naverKeywordId, campaignName: textValue(raw.campaignName),
        adgroupName: textValue(raw.adgroupName), keyword: textValue(raw.keyword),
        eventType: config.strategy === 'observed_rank' ? 'rank_observation' : 'rank_estimate',
        beforeRank: config.strategy === 'observed_rank' ? observedRank : null,
        targetPosition,
        beforeBid: row.beforeBid, afterBid: decision.proposedBid,
        message: config.strategy === 'observed_rank'
          ? `${textValue(raw.keyword) ?? row.naverKeywordId}: 실제 ${observedRank ? `${observedRank}위` : observedStatus === 'outside' ? '조회 순위 밖' : '광고 없음'}, 목표 ${targetPosition}위, ${row.beforeBid?.toLocaleString('ko-KR') ?? '없음'}원 → ${decision.proposedBid?.toLocaleString('ko-KR') ?? '변경 없음'}원`
          : `${textValue(raw.keyword) ?? row.naverKeywordId}: 목표 ${targetPosition}위 추정가 ${row.estimatedBid?.toLocaleString('ko-KR') ?? '없음'}원, ${row.beforeBid?.toLocaleString('ko-KR') ?? '없음'}원 → ${decision.proposedBid?.toLocaleString('ko-KR') ?? '변경 없음'}원`,
        correlationKey: `decision:${row.id}:estimate`, raw: { decision },
      })
    }
    await updateDecisionsBulk(this.db, patches)
    for (const batch of chunks(events, 500)) if (batch.length) await this.db.insert(naverAutoBidEvents).values(batch)
    await updateNaverAutoBidRun(this.db, {
      firmId: config.firmId, runId: run.id, changedCount: changed, skippedCount: skipped, heartbeatAt: now,
    })
    return { evaluated: rows.length, changesProposed: changed, skipped }
  }

  async apply({ config }: AutoBidStageContext): Promise<unknown> {
    if (config.dryRun) return { skipped: true, reason: 'dry-run' }
    if (config.ceiling === null || config.maxChanges === null) throw new Error('live bounds are required')
    if (config.strategy === 'observed_rank') {
      const policy = await getNaverAutoBidPolicy(this.db, config.firmId)
      if (!policy || !isWithinAutoBidSchedule(new Date(), policy.schedule as AutoBidSchedule)) {
        throw new Error('outside configured bidding schedule at apply time')
      }
      if (!policy.enabled || policy.status !== 'active') throw new Error('master switch is disabled at apply time')
    }
    const run = await this.requireRun(config)
    let rows = (await rowsForRun(this.db, config.firmId, run.id))
      .filter((row) => row.status === 'planned' && row.targetBid !== null && row.targetBid !== row.beforeBid)
      .sort((a, b) => Math.abs(b.targetBid! - (b.beforeBid ?? 0)) - Math.abs(a.targetBid! - (a.beforeBid ?? 0)))
      .slice(0, config.maxChanges)
    if (config.strategy === 'observed_rank' && rows.length) {
      const latest = await this.db.select().from(naverAutoBidKeywordPolicies).where(and(
        eq(naverAutoBidKeywordPolicies.firmId, config.firmId),
        inArray(naverAutoBidKeywordPolicies.naverKeywordId, rows.map(row => row.naverKeywordId)),
      ))
      const byId = new Map(latest.map(item => [item.naverKeywordId, item]))
      const groups = await this.db.select().from(naverAutoBidGroupPolicies).where(and(
        eq(naverAutoBidGroupPolicies.firmId, config.firmId),
        inArray(naverAutoBidGroupPolicies.naverAdgroupId, [...new Set(latest.map(item=>item.naverAdgroupId))]),
      ))
      const byGroup = new Map(groups.map(item=>[item.naverAdgroupId,item]))
      const master = await getNaverAutoBidPolicy(this.db,config.firmId)
      const pending = rows.filter(row => {
        const state = byId.get(row.naverKeywordId)
        const group = state ? byGroup.get(state.naverAdgroupId) : undefined
        const observedAt = Date.parse(String(record(decisionRaw(row).rankObservation).observedAt ?? ''))
        const ceiling = Math.min(config.ceiling!,master?.bidCeiling ?? 0,state?.bidCeiling ?? group?.bidCeiling ?? config.ceiling!)
        return !state || !state.enabled || !group?.enabled || !master?.enabled || master.status !== 'active'
          || state.naverAdgroupId !== String(decisionRaw(row).adgroupId ?? '')
          || row.targetBid! > ceiling
          || !Number.isFinite(observedAt) || observedAt > Date.now() || Date.now()-observedAt > 30_000
          || !bidIsSettled(state.lastChangedAt, Date.now())
          || !bidIsSettled(state.lastChangedAt, observedAt)
          || state.lastObservedBid !== row.beforeBid
      })
      if (pending.length) await this.db.update(naverAutoBidDecisions).set({
        status: 'skipped', reason: 'bid_settlement_or_stale_observation', updatedAt: new Date(),
      }).where(inArray(naverAutoBidDecisions.id, pending.map(row => row.id)))
      const pendingIds = new Set(pending.map(row => row.id))
      rows = rows.filter(row => !pendingIds.has(row.id))
    }
    if (!rows.length) return { applied: 0, limit: config.maxChanges }
    // Decisions already exist before the first provider mutation.
    const responses = await this.provider.bulkUpdateBids(rows.map((row) => ({
      row: remoteFromDecision(row), bidAmt: row.targetBid!,
      adgroupId: String(decisionRaw(row).adgroupId ?? ''),
    })), { batchSize: config.batchSize })
    // Start propagation allowance after the batch response, never before a slow API write.
    const now = new Date()
    const patches = rows.map((row, index) => ({
      id: row.id, status: 'applied', estimated_bid: row.estimatedBid, target_bid: row.targetBid,
      after_bid: intValue(responses[index]?.bidAmt) ?? row.targetBid,
      after_use_group_bid: false, reason: row.reason, cooldown_until: row.cooldownUntil,
      raw: row.raw, response_raw: publicRaw(record(responses[index])), error: null,
      verification_status: 'pending', verification_error: null, verification_raw: null,
      verified_at: null, applied_at: now,
    }))
    await updateDecisionsBulk(this.db, patches)
    const eventRows: Array<typeof naverAutoBidEvents.$inferInsert> = rows.map((row, index) => {
      const raw = decisionRaw(row)
      const afterBid = intValue(responses[index]?.bidAmt) ?? row.targetBid
      return {
        firmId: config.firmId, runId: run.id, decisionId: row.id,
        naverCampaignId: textValue(raw.campaignId), naverAdgroupId: textValue(raw.adgroupId),
        naverKeywordId: row.naverKeywordId, campaignName: textValue(raw.campaignName),
        adgroupName: textValue(raw.adgroupName), keyword: textValue(raw.keyword), eventType: 'bid_change',
        targetPosition: intValue(record(raw.effectivePolicy).targetPosition) ?? config.targetPosition,
        beforeBid: row.beforeBid, afterBid,
        message: `${textValue(raw.keyword) ?? row.naverKeywordId}: ${row.beforeBid?.toLocaleString('ko-KR') ?? '없음'}원 → ${afterBid?.toLocaleString('ko-KR') ?? '없음'}원`,
        correlationKey: `decision:${row.id}:apply`, raw: { response: publicRaw(record(responses[index])) },
      }
    })
    for (const batch of chunks(eventRows, 500)) if (batch.length) await this.db.insert(naverAutoBidEvents).values(batch)
    for (const row of rows) await this.db.update(naverAutoBidKeywordPolicies).set({
      lastObservedBid: row.targetBid,
      ...(config.strategy === 'observed_rank' ? {} : { lastEstimatedBid: row.estimatedBid }),
      lastChangedAt: now, updatedAt: now,
    }).where(and(eq(naverAutoBidKeywordPolicies.firmId, config.firmId),
      eq(naverAutoBidKeywordPolicies.naverKeywordId, row.naverKeywordId)))
    await updateNaverAutoBidRun(this.db, {
      firmId: config.firmId, runId: run.id, changedCount: rows.length,
      verificationStatus: 'pending', heartbeatAt: now,
    })
    return { applied: rows.length, limit: config.maxChanges }
  }

  async verify({ config }: AutoBidStageContext): Promise<unknown> {
    const run = await this.requireRun(config)
    if (config.dryRun) {
      await updateNaverAutoBidRun(this.db, {
        firmId: config.firmId, runId: run.id, verificationStatus: 'passed', verifiedCount: 0,
        verificationRaw: { dryRun: true, providerReads: 0 }, verifiedAt: new Date(), heartbeatAt: new Date(),
      })
      return { verified: true, checked: 0, dryRun: true }
    }
    const rows = (await rowsForRun(this.db, config.firmId, run.id)).filter((row) => row.status === 'applied')
    const updates = rows.map((row) => ({ row: remoteFromDecision(row), bidAmt: row.targetBid!,
      adgroupId: String(decisionRaw(row).adgroupId ?? '') }))
    const result = await this.provider.verifyBidUpdates(updates)
    const mismatchById = new Map(result.mismatches.map((item) => [item.nccKeywordId, item]))
    const now = new Date()
    await updateDecisionsBulk(this.db, rows.map((row) => {
      const mismatch = mismatchById.get(row.naverKeywordId)
      return {
        id: row.id, status: mismatch ? 'failed' : 'verified', estimated_bid: row.estimatedBid,
        target_bid: row.targetBid, after_bid: mismatch?.actualBidAmt ?? row.targetBid,
        after_use_group_bid: mismatch ? boolValue(mismatch.actualUseGroupBidAmt) : false,
        reason: row.reason, cooldown_until: row.cooldownUntil, raw: row.raw,
        response_raw: row.responseRaw, error: mismatch?.reason ?? null,
        verification_status: mismatch ? 'failed' : 'passed', verification_error: mismatch?.reason ?? null,
        verification_raw: mismatch ? publicRaw(mismatch as unknown as Raw) : { verified: true },
        verified_at: now, applied_at: row.appliedAt,
      }
    }))
    const verifiedActions = rows.filter(row => !mismatchById.has(row.naverKeywordId)
      && row.appliedAt !== null && row.targetBid !== null).map(row => {
      const raw = decisionRaw(row)
      const action: VerifiedBidAction = {
        decisionId: row.id, device: config.device,
        appliedAt: row.appliedAt!.toISOString(), verifiedAt: now.toISOString(),
        beforeBid: row.beforeBid, afterBid: row.targetBid!,
        beforeRank: intValue(record(raw.rankObservation).rank),
        targetPosition: intValue(record(raw.effectivePolicy).targetPosition) ?? config.targetPosition,
      }
      return { naver_keyword_id: row.naverKeywordId, action }
    })
    for (const batch of chunks(verifiedActions, 500)) {
      await this.db.execute(sql`update naver_auto_bid_keyword_policies as policy
        set raw = coalesce(policy.raw, '{}'::jsonb) || jsonb_build_object('lastBidAction', patch.action)
        from jsonb_to_recordset(${JSON.stringify(batch)}::jsonb) as patch(naver_keyword_id text, action jsonb)
        where policy.firm_id = ${config.firmId} and policy.naver_keyword_id = patch.naver_keyword_id`)
    }
    await updateNaverAutoBidRun(this.db, {
      firmId: config.firmId, runId: run.id, verifiedCount: result.checked - result.mismatches.length,
      failedCount: result.mismatches.length, verificationStatus: result.verified ? 'passed' : 'failed',
      verificationError: result.verified ? null : `${result.mismatches.length} bid verification mismatches`,
      verificationRaw: { checked: result.checked, mismatches: result.mismatches.length },
      verifiedAt: now, heartbeatAt: now,
    })
    return { verified: result.verified, checked: result.checked, mismatches: result.mismatches.length }
  }

  async report({ config }: AutoBidStageContext): Promise<unknown> {
    const run = await this.requireRun(config)
    const rows = await rowsForRun(this.db, config.firmId, run.id)
    const counts = rows.reduce<Record<string, number>>((result, row) => {
      result[row.status] = (result[row.status] ?? 0) + 1
      return result
    }, {})
    const observationFailures = rows.filter(row => row.reason === 'rank_observation_failed').length
    const failed = rows.filter(row => row.status === 'failed' || row.reason === 'rank_observation_failed').length
    const status = failed ? 'partial' : 'completed'
    const now = new Date()
    const proposedCount = rows.filter((row) => record(decisionRaw(row).decision).changed === true).length
    const appliedCount = (counts.applied ?? 0) + (counts.verified ?? 0)
    await updateNaverAutoBidRun(this.db, {
      firmId: config.firmId, runId: run.id, status, candidateCount: rows.length,
      changedCount: config.dryRun ? proposedCount : appliedCount, failedCount: failed,
      skippedCount: rows.filter(row => (row.status === 'skipped' || row.status === 'cooldown')
        && row.reason !== 'rank_observation_failed').length,
      verifiedCount: counts.verified ?? 0, finishedAt: now, heartbeatAt: now,
    })
    const retention = config.strategy === 'observed_rank' && !config.skipRetention
      ? await pruneRankEvidence(this.db, config.firmId) : null
    if (retention) await updateNaverAutoBidRun(this.db, {
      firmId: config.firmId, runId: run.id, raw: { ...record(run.raw), retention },
    })
    return { runKey: config.runKey, mode: config.mode, status, total: rows.length, counts,
      failed, observationFailures, retention }
  }
}

export async function createProductionNaverProvider(
  firmId: number,
  batchSize = 50,
): Promise<{ db: Db; provider: NaverProvider }> {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required')
  const db = getDb()
  const [credential] = await db.select().from(firmCredentials).where(and(
    eq(firmCredentials.firmId, firmId),
    eq(firmCredentials.provider, 'naver_searchad'),
  )).limit(1)
  if (!credential) throw new Error('Naver SearchAd credentials are not installed')
  const client = new NaverSearchAdClient({
    customerId: credential.customerId,
    apiKey: decryptCred(credential.apiKeyEnc),
    secret: decryptCred(credential.secretEnc),
  }, { maxRetries: 0 })
  const provider = new NaverProvider(client, {
    accountId: credential.customerId,
    batchSize,
    rateLimiterOptions: {
      minIntervalMs: 100,
      maxIntervalMs: 5_000,
      baseBackoffMs: 1_000,
      maxBackoffMs: 60_000,
      failureThreshold: 5,
      circuitCooldownMs: 300_000,
    },
  })
  return { db, provider }
}

export async function createProductionAutoBidRuntime(config: AutoBidConfig): Promise<ProductionAutoBidRuntime> {
  const { db, provider } = await createProductionNaverProvider(config.firmId, config.batchSize)
  const [firm] = await db.select({ domain: firms.domain }).from(firms).where(eq(firms.id, config.firmId)).limit(1)
  const rankObserver = config.strategy === 'observed_rank'
    ? new NaverSerpRankObserver(firm?.domain ?? '', {
      requestsPerMinute: config.rankRequestsPerMinute,
      concurrency: config.rankConcurrency,
      minIntervalMs: config.rankIntervalMs,
      proxyUrl: process.env.NAVER_RANK_PROXY_URL,
    })
    : null
  return new ProductionAutoBidRuntime(db, provider, rankObserver)
}
