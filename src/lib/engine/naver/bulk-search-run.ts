import { and, eq, inArray, sql } from 'drizzle-orm'
import type { Db } from '@/lib/db/client'
import { firmAdEntities, firmKeywords } from '@/lib/db/schema'
import type { Firm } from '@/lib/engine/firms'
import { ensureChannel, type AdApi } from '@/lib/engine/register-run'
import type { BulkSearchCampaignPlan, BulkSearchCandidate } from './bulk-search-plan'
import { exactKeywordDedupeKey } from './exact-keyword'

export const SAMPLEONE_SEARCH_CAMPAIGN_NAME = '파워링크#1'
export const SAMPLEONE_SEARCH_GROUP_PREFIX = '샘플원_사건명'
export const NAVER_KEYWORD_POST_CHUNK = 100

const DEFAULT_BID = 70
const ENTITY_UNIQUE_TARGET = [firmAdEntities.firmId, firmAdEntities.entityType, firmAdEntities.naverId]

type ApiRow = Record<string, unknown>
type Progress = { phase: string; shard?: number; completed: number; total: number; message?: string }

export type BulkSearchRunResult = {
  campaignId: string
  sourceCount: number
  selectedCount: number
  rejectedCount: number
  duplicateCount: number
  groupsReady: number
  keywordsCreated: number
  keywordsReused: number
  adsCreated: number
  failedShards: Array<{ shard: number; message: string }>
  paused: true
}

export type BulkSearchRunOptions = {
  paceMs?: number
  unlockLimit?: number
  onProgress?: (progress: Progress) => void | Promise<void>
}

export type ExistingCampaignKeywordSyncResult = {
  campaignId: string
  groups: number
  selectedCount: number
  keywordsCreated: number
  keywordsRejected: number
  keywordsReused: number
  keywordsUnlocked: number
}

function chunks<T>(rows: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size))
  return out
}

function idFrom(row: unknown, key: string): string | null {
  if (!row || typeof row !== 'object') return null
  const value = (row as ApiRow)[key]
  return typeof value === 'string' && value ? value : null
}

function rowKeyword(row: unknown): string | null {
  if (!row || typeof row !== 'object') return null
  const value = (row as ApiRow).keyword
  return typeof value === 'string' && value ? value : null
}

function reviewStatus(row: ApiRow): 'pending' | 'approved' | 'rejected' {
  const reason = String(row.statusReason ?? '').toUpperCase()
  const value = String(row.inspectStatus ?? '').toUpperCase()
  if (reason === 'KEYWORD_DISAPPROVED') return 'rejected'
  if (value === 'APPROVED' || value === 'ELIGIBLE') return 'approved'
  if (value === 'DENIED' || value === 'INELIGIBLE' || value === 'REJECTED') return 'rejected'
  return 'pending'
}

function keywordIsUnlocked(row: ApiRow): boolean {
  return row.userLock === false || row.userLock === 0
}

export function shouldUnlockApprovedKeyword(row: ApiRow): boolean {
  return reviewStatus(row) === 'approved' && !keywordIsUnlocked(row)
}

async function pace(ms: number): Promise<void> {
  if (ms > 0) await new Promise((resolve) => setTimeout(resolve, ms))
}

async function mirrorEntity(db: Db, value: typeof firmAdEntities.$inferInsert): Promise<void> {
  await db.insert(firmAdEntities).values(value).onConflictDoNothing({ target: ENTITY_UNIQUE_TARGET })
}

async function ensurePausedCampaign(api: AdApi, db: Db, firm: Firm): Promise<string> {
  const campaigns = await api.request<ApiRow[]>('GET', '/ncc/campaigns')
  const existing = Array.isArray(campaigns)
    ? campaigns.find((row) => row.name === SAMPLEONE_SEARCH_CAMPAIGN_NAME && row.status !== 'DELETED')
    : undefined
  let row: ApiRow
  if (existing) row = existing
  else {
    row = await api.request<ApiRow>('POST', '/ncc/campaigns', {
      body: {
        name: SAMPLEONE_SEARCH_CAMPAIGN_NAME,
        campaignTp: 'WEB_SITE',
        userLock: true,
        deliveryMethod: 'STANDARD',
        trackingMode: 'TRACKING_DISABLED',
        useDailyBudget: false,
      },
    })
  }
  const campaignId = idFrom(row, 'nccCampaignId')
  if (!campaignId) throw new Error('네이버 캠페인 ID를 확인할 수 없습니다.')
  await mirrorEntity(db, {
    firmId: firm.id,
    entityType: 'campaign',
    naverId: campaignId,
    reviewStatus: 'approved',
    raw: row,
  })
  return campaignId
}

function groupName(shard: number): string {
  return `${SAMPLEONE_SEARCH_GROUP_PREFIX}_${String(shard + 1).padStart(2, '0')}`
}

async function ensurePausedGroup(
  api: AdApi,
  db: Db,
  firm: Firm,
  campaignId: string,
  shard: number,
  channelId: string,
  existingGroups: ApiRow[],
): Promise<string> {
  const name = groupName(shard)
  let row = existingGroups.find((value) =>
    value.name === name && value.nccCampaignId === campaignId && value.status !== 'DELETED',
  )
  if (!row) {
    row = await api.request<ApiRow>('POST', '/ncc/adgroups', {
      body: {
        name,
        nccCampaignId: campaignId,
        pcChannelId: channelId,
        mobileChannelId: channelId,
        bidAmt: firm.adConfig?.bidAmt ?? DEFAULT_BID,
        useExpSearch: false,
        aiAdsOptIn: false,
        userLock: true,
        useDailyBudget: false,
        systemBiddingType: 'NONE',
      },
    })
    existingGroups.push(row)
  }
  const adgroupId = idFrom(row, 'nccAdgroupId')
  if (!adgroupId) throw new Error(`${name} 광고그룹 ID를 확인할 수 없습니다.`)
  await mirrorEntity(db, {
    firmId: firm.id,
    entityType: 'adgroup',
    naverId: adgroupId,
    reviewStatus: 'approved',
    raw: { ...row, shard, exactSearch: true },
  })
  return adgroupId
}

async function persistKeywordEntities(
  db: Db,
  firmId: number,
  adgroupId: string,
  entries: BulkSearchCandidate[],
  apiRows: ApiRow[],
): Promise<void> {
  if (!entries.length) return
  const byKeyword = new Map(entries.map((entry) => [exactKeywordDedupeKey(entry.keyword), entry]))
  const values: Array<typeof firmAdEntities.$inferInsert> = []
  const successfulIds: string[] = []
  const liveIds: string[] = []
  for (const row of apiRows) {
    const keyword = rowKeyword(row)
    const naverId = idFrom(row, 'nccKeywordId')
    if (!keyword || !naverId) continue
    const entry = byKeyword.get(exactKeywordDedupeKey(keyword))
    if (!entry) continue
    successfulIds.push(entry.keywordId)
    if (reviewStatus(row) === 'approved' && keywordIsUnlocked(row)) liveIds.push(entry.keywordId)
    values.push({
      firmId,
      entityType: 'keyword',
      keywordId: entry.keywordId,
      naverId,
      reviewStatus: reviewStatus(row),
      raw: { ...row, exactSearch: true, landingUrl: entry.landingUrl },
    })
  }
  for (const batch of chunks(values, 400)) {
    await db.insert(firmAdEntities).values(batch).onConflictDoUpdate({
      target: ENTITY_UNIQUE_TARGET,
      set: {
        keywordId: sql`excluded.keyword_id`,
        reviewStatus: sql`excluded.review_status`,
        raw: sql`excluded.raw`,
        updatedAt: new Date(),
      },
    })
  }
  for (const batch of chunks(successfulIds, 400)) {
    await db.update(firmKeywords).set({
      adDesired: true,
      naverAdgroupId: adgroupId,
      status: sql`case when ${firmKeywords.status} = 'live' then 'live' else 'ad_registered' end`,
      lastError: null,
      updatedAt: new Date(),
    }).where(and(eq(firmKeywords.firmId, firmId), inArray(firmKeywords.keywordId, batch)))
  }
  for (const batch of chunks(liveIds, 400)) {
    await db.update(firmKeywords).set({
      adDesired: true,
      naverAdgroupId: adgroupId,
      status: 'live',
      lastError: null,
      updatedAt: new Date(),
    }).where(and(eq(firmKeywords.firmId, firmId), inArray(firmKeywords.keywordId, batch)))
  }
}

async function unlockApprovedKeywords(
  api: AdApi,
  db: Db,
  firmId: number,
  candidatesByGroup: Map<string, Array<{ entry: BulkSearchCandidate; row: ApiRow }>>,
  paceMs: number,
  limit = Number.POSITIVE_INFINITY,
): Promise<number> {
  let unlocked = 0
  for (const [groupId, candidates] of candidatesByGroup) {
    const remaining = Math.max(0, limit - unlocked)
    if (!remaining) break
    const locked = candidates.filter(({ row }) => shouldUnlockApprovedKeyword(row)).slice(0, remaining)
    for (const batch of chunks(locked, NAVER_KEYWORD_POST_CHUNK)) {
      // Naver's official sample updates keyword locks in bulk with the complete
      // keyword rows and fields=userLock.
      const response = await api.request<ApiRow[]>('PUT', '/ncc/keywords', {
        query: { fields: 'userLock' },
        body: batch.map(({ row }) => ({ ...row, userLock: false })),
      })
      if (!Array.isArray(response) || response.length !== batch.length) {
        throw new Error(`키워드 잠금 해제 응답 개수 불일치(${batch.length}개 요청)`)
      }
      const normalized = response.map((row, index) => ({
        ...row,
        keyword: rowKeyword(row) ?? batch[index].entry.keyword,
      }))
      await persistKeywordEntities(db, firmId, groupId, batch.map(({ entry }) => entry), normalized)
      unlocked += normalized.filter((row) => keywordIsUnlocked(row)).length
      await pace(paceMs)
    }
  }
  return unlocked
}

async function prepareKeywords(
  api: AdApi,
  db: Db,
  firmId: number,
  adgroupId: string,
  entries: BulkSearchCandidate[],
  paceMs: number,
): Promise<{ created: number; reused: number }> {
  const remote = await api.request<ApiRow[]>('GET', '/ncc/keywords', { query: { nccAdgroupId: adgroupId } })
  const activeRemote = Array.isArray(remote) ? remote.filter((row) => row.status !== 'DELETED') : []
  const existingByTerm = new Map(activeRemote.flatMap((row) => {
    const keyword = rowKeyword(row)
    return keyword ? [[exactKeywordDedupeKey(keyword), row] as const] : []
  }))
  const reusedEntries = entries.filter((entry) => existingByTerm.has(exactKeywordDedupeKey(entry.keyword)))
  await persistKeywordEntities(
    db,
    firmId,
    adgroupId,
    reusedEntries,
    reusedEntries.map((entry) => existingByTerm.get(exactKeywordDedupeKey(entry.keyword))!),
  )

  const missing = entries.filter((entry) => !existingByTerm.has(exactKeywordDedupeKey(entry.keyword)))
  let created = 0
  for (const batch of chunks(missing, NAVER_KEYWORD_POST_CHUNK)) {
    const response = await api.request<ApiRow[]>('POST', '/ncc/keywords', {
      query: { nccAdgroupId: adgroupId },
      body: batch.map((entry) => ({
        keyword: entry.keyword,
        useGroupBidAmt: true,
        userLock: true,
        links: {
          pc: { final: entry.landingUrl },
          mobile: { final: entry.landingUrl },
        },
      })),
    })
    if (!Array.isArray(response) || response.length !== batch.length) {
      throw new Error(`키워드 등록 응답 개수 불일치(${batch.length}개 요청)`)
    }
    // Some API responses omit the keyword string but preserve request order.
    const normalized = response.map((row, index) => ({ ...row, keyword: rowKeyword(row) ?? batch[index].keyword }))
    await persistKeywordEntities(db, firmId, adgroupId, batch, normalized)
    created += normalized.filter((row) => idFrom(row, 'nccKeywordId')).length
    await pace(paceMs)
  }
  return { created, reused: reusedEntries.length }
}

function shardFromGroup(row: ApiRow): number | null {
  if (typeof row.name !== 'string') return null
  const match = row.name.match(/^샘플원_사건명_(\d{2})$/)
  if (!match) return null
  const shard = Number(match[1]) - 1
  return Number.isInteger(shard) && shard >= 0 && shard < 64 ? shard : null
}

/**
 * Append approved corpus keywords to the already-operated 64-group campaign.
 * This path never creates campaigns, groups, or creatives. Group business-hour
 * locks are enforced by the caller before keyword synchronization.
 */
export async function syncExistingBulkSearchKeywords(
  db: Db,
  api: AdApi,
  firm: Firm,
  plan: BulkSearchCampaignPlan,
  options: Pick<BulkSearchRunOptions, 'paceMs' | 'unlockLimit' | 'onProgress'> = {},
): Promise<ExistingCampaignKeywordSyncResult> {
  if (firm.id !== plan.firmId) throw new Error('법무법인과 캠페인 계획의 firmId가 다릅니다.')
  const paceMs = options.paceMs ?? 150
  const campaigns = await api.request<ApiRow[]>('GET', '/ncc/campaigns')
  const campaign = Array.isArray(campaigns)
    ? campaigns.find((row) => row.name === SAMPLEONE_SEARCH_CAMPAIGN_NAME && row.status !== 'DELETED')
    : undefined
  const campaignId = idFrom(campaign, 'nccCampaignId')
  if (!campaignId) throw new Error(`${SAMPLEONE_SEARCH_CAMPAIGN_NAME} 기존 캠페인을 찾을 수 없습니다.`)

  const remoteGroups = await api.request<ApiRow[]>('GET', '/ncc/adgroups', { query: { nccCampaignId: campaignId } })
  const groupsByShard = new Map<number, { id: string; row: ApiRow }>()
  for (const row of Array.isArray(remoteGroups) ? remoteGroups : []) {
    if (row.status === 'DELETED') continue
    const shard = shardFromGroup(row)
    const id = idFrom(row, 'nccAdgroupId')
    if (shard !== null && id) groupsByShard.set(shard, { id, row })
  }
  if (groupsByShard.size !== 64) {
    throw new Error(`기존 광고그룹 64개가 필요하지만 ${groupsByShard.size}개를 확인했습니다.`)
  }

  const existingByTerm = new Map<string, { row: ApiRow; groupId: string }>()
  let scanned = 0
  for (const [shard, group] of [...groupsByShard].sort(([a], [b]) => a - b)) {
    const remote = await api.request<ApiRow[]>('GET', '/ncc/keywords', { query: { nccAdgroupId: group.id } })
    for (const row of Array.isArray(remote) ? remote : []) {
      if (row.status === 'DELETED') continue
      const keyword = rowKeyword(row)
      if (keyword) existingByTerm.set(exactKeywordDedupeKey(keyword), { row, groupId: group.id })
    }
    scanned++
    await options.onProgress?.({ phase: 'scan', shard, completed: scanned, total: 64 })
    await pace(paceMs)
  }

  const entries = plan.shards.flatMap((shard) => shard.entries)
  // Legacy groups can lack a group-level bid. New terms must carry an explicit
  // bid in that case; otherwise Naver returns resultStatus 3916 and creates no ID.
  const newKeywordBid = firm.adConfig?.bidAmt ?? DEFAULT_BID
  const reusedByGroup = new Map<string, Array<{ entry: BulkSearchCandidate; row: ApiRow }>>()
  const unlockCandidatesByGroup = new Map<string, Array<{ entry: BulkSearchCandidate; row: ApiRow }>>()
  const missingByShard = new Map<number, BulkSearchCandidate[]>()
  for (const entry of entries) {
    const existing = existingByTerm.get(exactKeywordDedupeKey(entry.keyword))
    if (existing) {
      const value = { entry, row: existing.row }
      reusedByGroup.set(existing.groupId, [...(reusedByGroup.get(existing.groupId) ?? []), value])
      if (shouldUnlockApprovedKeyword(existing.row)) {
        unlockCandidatesByGroup.set(existing.groupId, [...(unlockCandidatesByGroup.get(existing.groupId) ?? []), value])
      }
    } else {
      missingByShard.set(entry.shard, [...(missingByShard.get(entry.shard) ?? []), entry])
    }
  }

  let keywordsReused = 0
  for (const [groupId, values] of reusedByGroup) {
    await persistKeywordEntities(db, firm.id, groupId, values.map((value) => value.entry), values.map((value) => value.row))
    keywordsReused += values.length
  }

  let keywordsCreated = 0
  let keywordsRejected = 0
  for (const [shard, missing] of [...missingByShard].sort(([a], [b]) => a - b)) {
    const group = groupsByShard.get(shard)!
    for (const batch of chunks(missing, NAVER_KEYWORD_POST_CHUNK)) {
      const response = await api.request<ApiRow[]>('POST', '/ncc/keywords', {
        query: { nccAdgroupId: group.id },
        body: batch.map((entry) => ({
          keyword: entry.keyword,
          useGroupBidAmt: false,
          bidAmt: newKeywordBid,
          userLock: false,
          links: {
            pc: { final: entry.landingUrl },
            mobile: { final: entry.landingUrl },
          },
        })),
      })
      if (!Array.isArray(response) || response.length !== batch.length) {
        throw new Error(`키워드 등록 응답 개수 불일치(${batch.length}개 요청)`)
      }
      const normalized: ApiRow[] = response.map((row, index) => ({ ...row, keyword: rowKeyword(row) ?? batch[index].keyword }))
      const accepted = normalized.flatMap((row, index) => idFrom(row, 'nccKeywordId')
        ? [{ entry: batch[index], row }]
        : [])
      const rejected = normalized.flatMap((row, index) => !idFrom(row, 'nccKeywordId')
        ? [{ entry: batch[index], row }]
        : [])
      if (rejected.length) {
        const summary = rejected.slice(0, 5).map(({ row }) => ({
          keyword: rowKeyword(row), status: row.status, inspectStatus: row.inspectStatus,
          statusReason: row.statusReason, error: row.error, raw: row,
        }))
        console.warn(`naver keyword registration rejected (${rejected.length}/${batch.length}): ${JSON.stringify(summary)}`)
        const reason = summary.map((item) => item.raw?.resultStatus).filter(Boolean)
        for (const { entry } of rejected) {
          await db.update(firmKeywords).set({
            lastError: JSON.stringify({ stage: 'naver_keyword_registration', reason }),
            updatedAt: new Date(),
          }).where(and(eq(firmKeywords.firmId, firm.id), eq(firmKeywords.keywordId, entry.keywordId)))
        }
        keywordsRejected += rejected.length
      }
      if (accepted.length) {
        await persistKeywordEntities(db, firm.id, group.id, accepted.map(({ entry }) => entry), accepted.map(({ row }) => row))
        const unlockable = accepted.flatMap(({ entry, row }) => shouldUnlockApprovedKeyword(row)
          ? [{ entry, row }]
          : [])
        if (unlockable.length) {
          unlockCandidatesByGroup.set(group.id, [...(unlockCandidatesByGroup.get(group.id) ?? []), ...unlockable])
        }
        keywordsCreated += accepted.length
      }
      await pace(paceMs)
    }
  }

  const keywordsUnlocked = await unlockApprovedKeywords(
    api, db, firm.id, unlockCandidatesByGroup, paceMs, options.unlockLimit,
  )

  return {
    campaignId,
    groups: groupsByShard.size,
    selectedCount: plan.selectedCount,
    keywordsCreated,
    keywordsRejected,
    keywordsReused,
    keywordsUnlocked,
  }
}

function adCreative(firm: Firm) {
  return {
    headline: '사기피해 초기대응 상담',
    description: '군검사 출신 형사전문 변호사가 직접 검토합니다. 상담은 무료입니다.',
    pc: { final: `https://${firm.domain}/?utm_source=naver&utm_medium=cpc&utm_campaign=sampleone_case_search` },
    mobile: { final: `https://${firm.domain}/?utm_source=naver&utm_medium=cpc&utm_campaign=sampleone_case_search` },
  }
}

async function ensureAd(api: AdApi, db: Db, firm: Firm, adgroupId: string): Promise<boolean> {
  const ads = await api.request<ApiRow[]>('GET', '/ncc/ads', { query: { nccAdgroupId: adgroupId } })
  const existing = Array.isArray(ads)
    ? ads.find((row) => row.type === 'TEXT_45' && row.status !== 'DELETED')
    : undefined
  let row = existing
  let created = false
  if (!row) {
    row = await api.request<ApiRow>('POST', '/ncc/ads', {
      body: { nccAdgroupId: adgroupId, type: 'TEXT_45', ad: adCreative(firm) },
    })
    created = true
  }
  const adId = idFrom(row, 'nccAdId')
  if (!adId) throw new Error('광고 소재 ID를 확인할 수 없습니다.')
  await mirrorEntity(db, {
    firmId: firm.id,
    entityType: 'ad',
    naverId: adId,
    reviewStatus: reviewStatus(row),
    raw: { ...row, exactSearch: true, adgroupId },
  })
  return created
}

export async function prepareBulkSearchCampaign(
  db: Db,
  api: AdApi,
  firm: Firm,
  plan: BulkSearchCampaignPlan,
  options: BulkSearchRunOptions = {},
): Promise<BulkSearchRunResult> {
  if (firm.id !== plan.firmId) throw new Error('법무법인과 캠페인 계획의 firmId가 다릅니다.')
  if (!firm.domain) throw new Error('법무법인 도메인이 없습니다.')
  const paceMs = options.paceMs ?? 150
  const workShards = plan.shards.filter((shard) => shard.entries.length > 0)
  const progress = async (value: Omit<Progress, 'total'>) => options.onProgress?.({ ...value, total: workShards.length })

  const channel = await ensureChannel(api as never, firm)
  if (!channel) throw new Error(`승인된 ${firm.domain} 비즈니스 채널을 찾을 수 없습니다.`)
  const campaignId = await ensurePausedCampaign(api, db, firm)
  const allGroups = await api.request<ApiRow[]>('GET', '/ncc/adgroups')
  const existingGroups = Array.isArray(allGroups) ? allGroups : []

  let groupsReady = 0
  let keywordsCreated = 0
  let keywordsReused = 0
  let adsCreated = 0
  const failedShards: Array<{ shard: number; message: string }> = []

  for (let index = 0; index < workShards.length; index++) {
    const shard = workShards[index]
    await progress({ phase: 'shard', shard: shard.index, completed: index })
    try {
      const adgroupId = await ensurePausedGroup(
        api, db, firm, campaignId, shard.index, channel.pcChannelId, existingGroups,
      )
      groupsReady++
      const keywordResult = await prepareKeywords(api, db, firm.id, adgroupId, shard.entries, paceMs)
      keywordsCreated += keywordResult.created
      keywordsReused += keywordResult.reused
      if (await ensureAd(api, db, firm, adgroupId)) adsCreated++
      await pace(paceMs)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      failedShards.push({ shard: shard.index, message })
      for (const batch of chunks(shard.entries.map((entry) => entry.keywordId), 400)) {
        await db.update(firmKeywords).set({ lastError: message, updatedAt: new Date() })
          .where(and(eq(firmKeywords.firmId, firm.id), inArray(firmKeywords.keywordId, batch)))
      }
    }
  }
  await progress({ phase: 'complete', completed: workShards.length })

  return {
    campaignId,
    sourceCount: plan.sourceCount,
    selectedCount: plan.selectedCount,
    rejectedCount: plan.rejected.length,
    duplicateCount: plan.duplicates.length,
    groupsReady,
    keywordsCreated,
    keywordsReused,
    adsCreated,
    failedShards,
    paused: true,
  }
}
