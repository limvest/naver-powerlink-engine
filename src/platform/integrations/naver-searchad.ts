import type { NaverSearchAdClient } from '@/lib/engine/naver/client'

/** One day of ad statistics for one execution, in the shape the caller's store expects. */
export interface UpsertAdDailyStatInput {
  readonly firmId: number | string
  readonly adExecutionId: string
  readonly executionId?: string
  readonly day: Date | string | number
  readonly impressions?: number
  readonly clicks?: number
  readonly cost?: number
  readonly spend?: number
  readonly conversions?: number
  readonly qualifiedLeads?: number
  readonly retainedMatters?: number
  readonly syncedAt?: Date | string | number
}


/** The existing client contract is intentionally the only network dependency. */
export type NaverSearchAdReadClient = Pick<NaverSearchAdClient, 'request'>

export const NAVER_STATS_FIELDS = ['impCnt', 'clkCnt', 'salesAmt', 'ccnt'] as const
export type NaverStatsField = (typeof NAVER_STATS_FIELDS)[number]

const DEFAULT_CHUNK_SIZE = 100
const STAT_FIELD_SET = new Set<string>(NAVER_STATS_FIELDS)
const STAT_ID_KEYS = ['id', 'nccAdgroupId', 'adGroupId', 'adgroupId', 'entityId'] as const
const INSPECTION_ID_KEYS = [
  'id', 'nccAdId', 'nccKeywordId', 'nccAdgroupId', 'adGroupId', 'adgroupId', 'naverId', 'entityId',
] as const
const RESPONSE_ARRAY_KEYS = ['data', 'results', 'rows', 'stats', 'items', 'result'] as const

type UnknownRecord = Record<string, unknown>

export interface NaverAdGroupStatsTarget {
  /** The tenant identifier passed through to upsertAdDailyStat. */
  readonly firmId: number | string
  /** The canonical local execution identifier passed through to upsertAdDailyStat. */
  readonly adExecutionId: string
  /** Naver ad-group IDs are one homogeneous /stats entity type. */
  readonly adGroupId: string
}

export interface FetchNaverDailyStatsInput {
  readonly targets: readonly NaverAdGroupStatsTarget[]
  /** A one-day range can be supplied as `day`, or as equal `since`/`until` values. */
  readonly day?: string | Date
  readonly since?: string | Date
  readonly until?: string | Date
  /** Optional per-call override; this is not treated as a Naver API limit. */
  readonly chunkSize?: number
}

/** A parsed provider row before it is joined to a local ad execution. */
export interface NaverSearchAdStatsRecord {
  readonly externalId: string
  readonly impressions: number
  readonly clicks: number
  readonly cost: number
  readonly conversions: number
}

/** Exactly the fields accepted by upsertAdDailyStat, with provider values normalized. */
export type NaverAdDailyStatRow = Pick<
  UpsertAdDailyStatInput,
  'firmId' | 'adExecutionId' | 'day' | 'impressions' | 'clicks' | 'cost' | 'conversions'
>

export type NaverInspectionStatus = 'approved' | 'pending' | 'rejected' | 'unknown'

export interface NaverCreativeReviewTarget {
  /** The tenant identifier carried through to the review result. */
  readonly firmId: number | string
  /** The canonical local execution identifier carried through to the review result. */
  readonly adExecutionId: string
  /** The Naver creative ID used by `/ncc/ads/{adId}`. */
  readonly creativeId: string
}

export interface NaverCreativeReviewResult {
  readonly firmId: number | string
  readonly adExecutionId: string
  readonly creativeId: string
  readonly reviewStatus: NaverInspectionStatus
  readonly reason: string | null
  /** The matched `/ncc/ads/{adId}` response, retained without provider-field guessing. */
  readonly raw: UnknownRecord
}

/**
 * A deliberately small, provider-neutral parser retained for callers that have
 * already obtained inspection-like rows.  The creative review fetch below uses
 * the verified Ad and inspect-history contracts directly.
 */
export interface NaverInspectionHistoryRecord {
  readonly naverId: string
  readonly reviewStatus: NaverInspectionStatus
  readonly reason: string | null
  readonly observedAt: string | null
  readonly raw: UnknownRecord
}

export interface NaverSearchAdAdapterOptions {
  readonly chunkSize?: number
}

function isRecord(value: unknown): value is UnknownRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const result = value.trim()
  return result || null
}

function firstText(record: UnknownRecord, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = nonEmptyString(record[key])
    if (value) return value
  }
  return null
}

function hasStatField(record: UnknownRecord): boolean {
  return [...STAT_FIELD_SET].some((field) => Object.prototype.hasOwnProperty.call(record, field))
}

function looksLikeStatRecord(record: UnknownRecord): boolean {
  return hasStatField(record) || Boolean(firstText(record, STAT_ID_KEYS))
}

/**
 * Unwrap only common array envelopes.  Unknown objects are ignored rather than
 * being guessed as a provider response; this keeps malformed responses from
 * becoming zero-valued database rows.
 */
function responseRows(value: unknown, isRow: (record: UnknownRecord) => boolean): UnknownRecord[] {
  if (Array.isArray(value)) return value.filter(isRecord)
  if (!isRecord(value)) return []
  if (isRow(value)) return [value]
  for (const key of RESPONSE_ARRAY_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue
    const nested = responseRows(value[key], isRow)
    if (nested.length > 0 || Array.isArray(value[key])) return nested
  }
  return []
}

function parseNonNegativeInteger(value: unknown): number | null {
  if (value === undefined || value === null) return 0
  if (typeof value !== 'number' && typeof value !== 'string') return null

  const text = typeof value === 'number' ? String(value) : value.trim().replaceAll(',', '')
  if (!text || !/^[+]?(?:\d+)(?:\.\d+)?$/.test(text)) return null
  const parsed = Number(text)
  if (!Number.isSafeInteger(parsed) || parsed < 0) return null
  return parsed
}

function parseStatsRecord(record: UnknownRecord, fallbackExternalId?: string): NaverSearchAdStatsRecord | null {
  const externalId = firstText(record, STAT_ID_KEYS) ?? fallbackExternalId ?? null
  if (!externalId || !hasStatField(record)) return null

  const impressions = parseNonNegativeInteger(record.impCnt)
  const clicks = parseNonNegativeInteger(record.clkCnt)
  const cost = parseNonNegativeInteger(record.salesAmt)
  const conversions = parseNonNegativeInteger(record.ccnt)
  if (impressions === null || clicks === null || cost === null || conversions === null) return null

  return { externalId, impressions, clicks, cost, conversions }
}

/**
 * Parse a known-looking /stats response without assuming that an unknown
 * envelope or malformed metric is meaningful.  Missing metrics on an otherwise
 * valid row are treated as zero because the requested fields are aggregates.
 */
export function parseNaverStatsResponse(
  payload: unknown,
  fallbackExternalId?: string,
): readonly NaverSearchAdStatsRecord[] {
  return responseRows(payload, looksLikeStatRecord)
    .map((record) => parseStatsRecord(record, fallbackExternalId))
    .filter((record): record is NaverSearchAdStatsRecord => record !== null)
}

function normalizeDay(value: string | Date | undefined, label: string): string {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new TypeError(`${label} must be a valid day`)
    return value.toISOString().slice(0, 10)
  }
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value.trim())) {
    throw new TypeError(`${label} must be YYYY-MM-DD`)
  }
  const day = value.trim()
  const date = new Date(`${day}T00:00:00.000Z`)
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== day) {
    throw new TypeError(`${label} must be a valid day`)
  }
  return day
}

function normalizeDailyRange(input: FetchNaverDailyStatsInput): { since: string; until: string } {
  const source = input.day ?? input.since ?? input.until
  if (source === undefined) throw new TypeError('day or since/until is required')
  const since = normalizeDay(input.since ?? source, 'since')
  const until = normalizeDay(input.until ?? source, 'until')
  if (since !== until) throw new TypeError('daily stats requires equal since and until days')
  return { since, until }
}

function normalizeChunkSize(value: number | undefined): number {
  const chunkSize = value ?? DEFAULT_CHUNK_SIZE
  if (!Number.isSafeInteger(chunkSize) || chunkSize < 1) {
    throw new TypeError('chunkSize must be a positive safe integer')
  }
  return chunkSize
}

function normalizeTargets(targets: readonly NaverAdGroupStatsTarget[]): NaverAdGroupStatsTarget[] {
  if (!Array.isArray(targets)) throw new TypeError('targets must be an array')
  const byExternalId = new Map<string, NaverAdGroupStatsTarget>()
  for (const target of targets) {
    if (!isRecord(target)) throw new TypeError('stats target must be an object')
    const firmId = typeof target.firmId === 'number'
      ? target.firmId
      : nonEmptyString(target.firmId)
    const adExecutionId = nonEmptyString(target.adExecutionId)
    const adGroupId = nonEmptyString(target.adGroupId)
    if (firmId === null || firmId === undefined || (typeof firmId === 'number' && !Number.isFinite(firmId))) {
      throw new TypeError('stats target firmId is required')
    }
    if (!adExecutionId || !adGroupId) throw new TypeError('stats target IDs are required')

    const normalized = { firmId, adExecutionId, adGroupId }
    const existing = byExternalId.get(adGroupId)
    if (existing) {
      if (existing.firmId !== firmId || existing.adExecutionId !== adExecutionId) {
        throw new TypeError(`ad group ${adGroupId} maps to multiple executions`)
      }
      continue
    }
    byExternalId.set(adGroupId, normalized)
  }
  return [...byExternalId.values()]
}

function normalizeCreativeReviewTargets(
  targets: readonly NaverCreativeReviewTarget[],
): NaverCreativeReviewTarget[] {
  if (!Array.isArray(targets)) throw new TypeError('creative review targets must be an array')

  const normalizedTargets: NaverCreativeReviewTarget[] = []
  const byCreativeId = new Map<string, NaverCreativeReviewTarget>()
  for (const target of targets) {
    if (!isRecord(target)) throw new TypeError('creative review target must be an object')
    const firmId = typeof target.firmId === 'number'
      ? target.firmId
      : nonEmptyString(target.firmId)
    const adExecutionId = nonEmptyString(target.adExecutionId)
    const creativeId = nonEmptyString(target.creativeId)
    if (firmId === null || firmId === undefined
      || (typeof firmId === 'number' && !Number.isFinite(firmId))) {
      throw new TypeError('creative review target firmId is required')
    }
    if (!adExecutionId || !creativeId) throw new TypeError('creative review target IDs are required')

    const normalized = { firmId, adExecutionId, creativeId }
    const existing = byCreativeId.get(creativeId)
    if (existing && (existing.firmId !== firmId || existing.adExecutionId !== adExecutionId)) {
      throw new TypeError(`creative ${creativeId} maps to multiple executions`)
    }
    if (!existing) byCreativeId.set(creativeId, normalized)
    normalizedTargets.push(normalized)
  }
  return normalizedTargets
}

function chunks<T>(values: readonly T[], size: number): T[][] {
  const result: T[][] = []
  for (let offset = 0; offset < values.length; offset += size) {
    result.push(values.slice(offset, offset + size))
  }
  return result
}

function statsQuery(id: string, since: string, until: string): Record<string, string> {
  return {
    // The live SearchAd endpoint accepts the entity as a single `id`.
    id,
    fields: JSON.stringify(NAVER_STATS_FIELDS),
    timeIncrement: 'allDays',
    timeRange: JSON.stringify({ since, until }),
  }
}

function firstKnownStatus(record: UnknownRecord): string | null {
  return firstText(record, ['reviewStatus', 'inspectionStatus', 'inspectStatus', 'status', 'adStatus'])
}

function normalizeInspectionStatus(value: string): NaverInspectionStatus {
  switch (value.trim().toLocaleLowerCase('en-US')) {
    case 'approved':
    case 'accepted':
    case 'eligible':
    case 'live':
      return 'approved'
    case 'pending':
    case 'reviewing':
    case 'under_review':
    case 'in_review':
      return 'pending'
    case 'rejected':
    case 'denied':
    case 'disapproved':
      return 'rejected'
    default:
      return 'unknown'
  }
}

/**
 * Parse inspection-like rows only when an ID and status are explicit.  This is
 * intentionally a parser, not a claimed `/ncc/...` fetch contract: callers can
 * use it with a response shape they have verified for their SearchAd account.
 */
export function parseNaverInspectionHistoryResponse(
  payload: unknown,
): readonly NaverInspectionHistoryRecord[] {
  const rows = responseRows(payload, (record) => (
    Boolean(firstText(record, INSPECTION_ID_KEYS)) && Boolean(firstKnownStatus(record))
  ))
  return rows.flatMap((record) => {
    const naverId = firstText(record, INSPECTION_ID_KEYS)
    const status = firstKnownStatus(record)
    if (!naverId || !status) return []
    const reason = firstText(record, ['reason', 'rejectReason', 'reviewReason', 'inspectionReason'])
    const observedAt = firstText(record, ['observedAt', 'checkedAt', 'createdAt', 'updatedAt', 'date'])
    return [{
      naverId,
      reviewStatus: normalizeInspectionStatus(status),
      reason,
      observedAt,
      raw: record,
    }]
  })
}

function parseCreativeAdResponse(
  payload: unknown,
  target: NaverCreativeReviewTarget,
): { reviewStatus: NaverInspectionStatus; statusReason: string | null; raw: UnknownRecord } {
  if (!isRecord(payload)) {
    throw new TypeError(`creative ${target.creativeId} response must be an object`)
  }

  const nccAdId = nonEmptyString(payload.nccAdId)
  if (!nccAdId) throw new TypeError(`creative ${target.creativeId} response has no nccAdId`)
  if (nccAdId !== target.creativeId) {
    throw new Error(`creative response ${nccAdId} does not match target ${target.creativeId}`)
  }

  const inspectStatus = nonEmptyString(payload.inspectStatus)
  if (!inspectStatus) throw new TypeError(`creative ${target.creativeId} response has no inspectStatus`)

  return {
    reviewStatus: normalizeInspectionStatus(inspectStatus),
    statusReason: nonEmptyString(payload.statusReason),
    raw: payload,
  }
}

function parseCreativeInspectHistoryReason(payload: unknown, creativeId: string): string | null {
  if (!isRecord(payload)) {
    throw new TypeError(`creative ${creativeId} inspect-history response must be an object`)
  }
  // Naver documents an empty object when no inspection reason exists.
  if (Object.keys(payload).length === 0) return null

  const historyId = nonEmptyString(payload.id)
  if (!historyId) throw new TypeError(`creative ${creativeId} inspect-history response has no id`)
  if (historyId !== creativeId) {
    throw new Error(`inspect-history response ${historyId} does not match target ${creativeId}`)
  }

  const content: string[] = []
  for (const key of ['pcInspectComment', 'mobileInspectComment'] as const) {
    if (!Object.prototype.hasOwnProperty.call(payload, key)) continue
    const comments = payload[key]
    if (!Array.isArray(comments)) {
      throw new TypeError(`creative ${creativeId} ${key} must be an array`)
    }
    for (const comment of comments) {
      if (!isRecord(comment)) continue
      const text = nonEmptyString(comment.content)
      if (text) content.push(text)
    }
  }
  return content.length > 0 ? content.join('\n') : null
}

export class NaverSearchAdAdapter {
  private readonly chunkSize: number

  constructor(
    private readonly client: NaverSearchAdReadClient,
    options: NaverSearchAdAdapterOptions = {},
  ) {
    this.chunkSize = normalizeChunkSize(options.chunkSize)
  }

  /**
   * Fetches only GET /stats and returns rows that can be passed directly to
   * upsertAdDailyStat.  No database or provider write dependency is present.
   */
  async fetchDailyStats(input: FetchNaverDailyStatsInput): Promise<readonly NaverAdDailyStatRow[]> {
    const { since, until } = normalizeDailyRange(input)
    const targets = normalizeTargets(input.targets)
    if (targets.length === 0) return []

    const chunkSize = normalizeChunkSize(input.chunkSize ?? this.chunkSize)
    const targetOrder = new Map(targets.map((target, index) => [target.adGroupId, index]))
    const rowsByExternalId = new Map<string, NaverSearchAdStatsRecord>()

    // Keep requests sequential. The live endpoint accepts one entity ID per
    // request, and a missing row is an honest zero for that entity/day.
    for (const chunk of chunks(targets, chunkSize)) {
      for (const target of chunk) {
        const response = await this.client.request<unknown>('GET', '/stats', {
          query: statsQuery(target.adGroupId, since, until),
        })
        const parsed = parseNaverStatsResponse(response, target.adGroupId)
        const stat = parsed.find((row) => row.externalId === target.adGroupId)
        rowsByExternalId.set(target.adGroupId, stat ?? {
          externalId: target.adGroupId, impressions: 0, clicks: 0, cost: 0, conversions: 0,
        })
      }
    }

    return targets
      .sort((left, right) => (targetOrder.get(left.adGroupId) ?? Number.MAX_SAFE_INTEGER)
        - (targetOrder.get(right.adGroupId) ?? Number.MAX_SAFE_INTEGER))
      .map((target) => {
        const stat = rowsByExternalId.get(target.adGroupId)
        if (!stat) throw new Error(`stats row ${target.adGroupId} is missing`)
        return { firmId: target.firmId, adExecutionId: target.adExecutionId, day: since,
          impressions: stat.impressions, clicks: stat.clicks, cost: stat.cost, conversions: stat.conversions }
      })
  }

  /** Fetches creative review state using only sequential GET requests. */
  async fetchCreativeReviews(
    targets: readonly NaverCreativeReviewTarget[],
  ): Promise<readonly NaverCreativeReviewResult[]> {
    const normalizedTargets = normalizeCreativeReviewTargets(targets)
    const results: NaverCreativeReviewResult[] = []

    // Keep each target's Ad lookup and any rejected-history lookup together so
    // no response can be associated with a different local execution.
    for (const target of normalizedTargets) {
      const adResponse = await this.client.request<unknown>(
        'GET',
        `/ncc/ads/${encodeURIComponent(target.creativeId)}`,
      )
      const ad = parseCreativeAdResponse(adResponse, target)
      let reason: string | null = null

      if (ad.reviewStatus === 'rejected') {
        const historyResponse = await this.client.request<unknown>(
          'GET',
          `/ncc/inspect-history/${encodeURIComponent(target.creativeId)}`,
        )
        reason = parseCreativeInspectHistoryReason(historyResponse, target.creativeId) ?? ad.statusReason
      }

      results.push({
        firmId: target.firmId,
        adExecutionId: target.adExecutionId,
        creativeId: target.creativeId,
        reviewStatus: ad.reviewStatus,
        reason,
        raw: ad.raw,
      })
    }
    return results
  }

  /** Parse a verified inspection response without making an endpoint assumption. */
  parseInspectionHistory(payload: unknown): readonly NaverInspectionHistoryRecord[] {
    return parseNaverInspectionHistoryResponse(payload)
  }
}

export const NaverSearchAdIntegration = NaverSearchAdAdapter

export function createNaverSearchAdAdapter(
  client: NaverSearchAdReadClient,
  options: NaverSearchAdAdapterOptions = {},
): NaverSearchAdAdapter {
  return new NaverSearchAdAdapter(client, options)
}

export async function fetchNaverAdDailyStats(
  client: NaverSearchAdReadClient,
  input: FetchNaverDailyStatsInput,
  options: NaverSearchAdAdapterOptions = {},
): Promise<readonly NaverAdDailyStatRow[]> {
  return new NaverSearchAdAdapter(client, options).fetchDailyStats(input)
}
