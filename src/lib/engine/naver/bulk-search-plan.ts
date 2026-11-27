import { and, asc, count, eq, inArray, isNotNull, ne } from 'drizzle-orm'
import type { Db } from '@/lib/db/client'
import { firmKeywords, keywords, observations } from '@/lib/db/schema'
import type { Firm } from '@/lib/engine/firms'
import { notOperatorExcluded } from '../ad-keyword-exclusions'
import {
  decideExactSearchKeyword,
  exactKeywordDedupeKey,
  exactKeywordLandingUrl,
  exactKeywordShard,
  SAMPLEONE_SEARCH_AD_SHARDS,
  type ExactKeywordRejectReason,
} from './exact-keyword'

export type BulkSearchCandidate = {
  keywordId: string
  sourceName: string
  keyword: string
  slug: string
  hostLabel: string
  landingUrl: string
  sourceStatus: string
  observationCount: number
  trimmed: boolean
  shard: number
}

export type BulkSearchRejected = {
  keywordId: string
  sourceName: string
  reason: ExactKeywordRejectReason
  candidate: string
}

export type BulkSearchDuplicate = {
  keywordId: string
  sourceName: string
  keyword: string
  selectedKeywordId: string
}

export type BulkSearchCampaignPlan = {
  firmId: number
  generatedAt: string
  sourceCount: number
  acceptedBeforeDedupe: number
  selectedCount: number
  rejected: BulkSearchRejected[]
  duplicates: BulkSearchDuplicate[]
  shards: Array<{ index: number; entries: BulkSearchCandidate[] }>
}

type SearchCampaignFirm = Pick<Firm, 'id' | 'domain'>

type SourceRow = {
  keywordId: string
  sourceName: string
  slug: string
  hostLabel: string
  sourceStatus: string
  observationCount: number
}

function candidatePriority(value: BulkSearchCandidate): [number, number, number, number, string] {
  return [
    value.sourceStatus === 'published' ? 1 : 0,
    value.trimmed ? 0 : 1,
    value.observationCount,
    -value.sourceName.length,
    value.keywordId,
  ]
}

function isBetterCandidate(next: BulkSearchCandidate, current: BulkSearchCandidate): boolean {
  const a = candidatePriority(next)
  const b = candidatePriority(current)
  for (let i = 0; i < a.length; i++) {
    if (a[i] === b[i]) continue
    return a[i] > b[i]
  }
  return false
}

export function assembleBulkSearchCampaignPlan(
  firm: SearchCampaignFirm,
  rows: SourceRow[],
  now = new Date(),
): BulkSearchCampaignPlan {
  if (!firm.domain) throw new Error(`REFUSED: firm ${firm.id} domain 미설정`)

  const accepted: BulkSearchCandidate[] = []
  const rejected: BulkSearchRejected[] = []
  for (const row of rows) {
    const decision = decideExactSearchKeyword(row.sourceName)
    if (!decision.accepted) {
      rejected.push({
        keywordId: row.keywordId,
        sourceName: row.sourceName,
        reason: decision.reason,
        candidate: decision.keyword,
      })
      continue
    }
    accepted.push({
      keywordId: row.keywordId,
      sourceName: row.sourceName,
      keyword: decision.keyword,
      slug: row.slug,
      hostLabel: row.hostLabel,
      landingUrl: exactKeywordLandingUrl(firm.domain, row.hostLabel, decision.keyword),
      sourceStatus: row.sourceStatus,
      observationCount: row.observationCount,
      trimmed: decision.trimmed,
      shard: exactKeywordShard(row.keywordId),
    })
  }

  const selectedByTerm = new Map<string, BulkSearchCandidate>()
  for (const candidate of accepted) {
    const key = exactKeywordDedupeKey(candidate.keyword)
    const current = selectedByTerm.get(key)
    if (!current || isBetterCandidate(candidate, current)) selectedByTerm.set(key, candidate)
  }
  const selected = [...selectedByTerm.values()].sort((a, b) =>
    a.shard - b.shard || a.keyword.localeCompare(b.keyword, 'ko') || a.keywordId.localeCompare(b.keywordId),
  )
  const selectedIds = new Set(selected.map((row) => row.keywordId))
  const selectedByDedupe = new Map(selected.map((row) => [exactKeywordDedupeKey(row.keyword), row]))
  const duplicates: BulkSearchDuplicate[] = accepted
    .filter((row) => !selectedIds.has(row.keywordId))
    .map((row) => ({
      keywordId: row.keywordId,
      sourceName: row.sourceName,
      keyword: row.keyword,
      selectedKeywordId: selectedByDedupe.get(exactKeywordDedupeKey(row.keyword))!.keywordId,
    }))

  const shards = Array.from({ length: SAMPLEONE_SEARCH_AD_SHARDS }, (_, index) => ({
    index,
    entries: selected.filter((entry) => entry.shard === index),
  }))

  return {
    firmId: firm.id,
    generatedAt: now.toISOString(),
    sourceCount: rows.length,
    acceptedBeforeDedupe: accepted.length,
    selectedCount: selected.length,
    rejected,
    duplicates,
    shards,
  }
}

export async function buildBulkSearchCampaignPlan(
  db: Db,
  firm: SearchCampaignFirm,
  options: { keywordIds?: readonly string[] } = {},
): Promise<BulkSearchCampaignPlan> {
  const requestedIds = options.keywordIds ? [...new Set(options.keywordIds)].filter(Boolean) : null
  if (requestedIds?.length === 0) {
    return assembleBulkSearchCampaignPlan(firm, [])
  }
  const conditions = [
    eq(firmKeywords.firmId, firm.id),
    eq(firmKeywords.hostStatus, 'public'),
    isNotNull(firmKeywords.publicHostLabel),
    ne(keywords.status, 'blocked'),
    notOperatorExcluded(firm.id),
  ]
  if (requestedIds) conditions.push(inArray(keywords.id, requestedIds))
  const rows = await db.select({
    keywordId: keywords.id,
    sourceName: keywords.name,
    slug: keywords.slug,
    hostLabel: firmKeywords.publicHostLabel,
    sourceStatus: keywords.status,
    observationCount: count(observations.id),
  })
    .from(firmKeywords)
    .innerJoin(keywords, eq(keywords.id, firmKeywords.keywordId))
    .leftJoin(observations, eq(observations.keywordId, keywords.id))
    .where(and(...conditions))
    .groupBy(
      keywords.id,
      keywords.name,
      keywords.slug,
      keywords.status,
      firmKeywords.publicHostLabel,
    )
    .orderBy(asc(keywords.name), asc(keywords.id))

  return assembleBulkSearchCampaignPlan(firm, rows.map((row) => ({
    ...row,
    hostLabel: row.hostLabel!,
    observationCount: Number(row.observationCount),
  })))
}
