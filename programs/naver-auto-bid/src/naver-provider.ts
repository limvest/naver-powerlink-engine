import type { NaverQuery, NaverSearchAdClient } from '@/lib/engine/naver/client'
import {
  AdaptiveRateLimiter,
  type AdaptiveRateLimiterOptions,
  getSharedAccountRateLimiter,
  type RateLimiter,
} from './rate-limiter'

/**
 * The provider depends only on the existing client's generic request method.
 * Credentials, signatures, base URL, and HTTP parsing remain the client's
 * responsibility and can be replaced by a fake in tests.
 */
export type NaverSearchAdRequestClient = Pick<NaverSearchAdClient, 'request'>
export type NaverProviderClient = NaverSearchAdRequestClient

export type NaverRequestOptions = {
  readonly query?: NaverQuery
  readonly body?: unknown
}

export type NaverDevice = 'PC' | 'MOBILE'
export type NaverDeviceInput = NaverDevice | 'pc' | 'mobile'
export type NaverEstimatePeriod = 'DAY' | 'MONTH'

export const NAVER_AUTO_BID_ENDPOINTS = Object.freeze({
  campaigns: '/ncc/campaigns',
  adgroups: '/ncc/adgroups',
  keywords: '/ncc/keywords',
  exposureMinimumBid: '/estimate/exposure-minimum-bid/keyword',
  averagePositionBid: '/estimate/average-position-bid/keyword',
} as const)

export type NaverRemoteRow = Record<string, unknown>
export type NaverCampaignRow = NaverRemoteRow
export type NaverAdGroupRow = NaverRemoteRow
export type NaverKeywordRow = NaverRemoteRow

export type NaverExposureMinimumBidTarget = {
  readonly keyword: string
  readonly device?: NaverDeviceInput
}

export type NaverExposureMinimumBidRequest = {
  readonly keywords?: readonly string[]
  /** Official SearchAd field name; accepted as an alias of `keywords`. */
  readonly items?: readonly string[]
  readonly device?: NaverDeviceInput
  readonly period?: NaverEstimatePeriod
  readonly batchSize?: number
}

export type NaverExposureMinimumBidOptions = {
  readonly device?: NaverDeviceInput
  readonly period?: NaverEstimatePeriod
  readonly batchSize?: number
}

export type NaverExposureMinimumBidEstimate = {
  readonly keyword: string
  readonly device: NaverDevice
  readonly period: NaverEstimatePeriod
  /** `null` means that the provider did not return an estimate for the item. */
  readonly bid: number | null
  readonly raw: NaverRemoteRow | null
}

export type NaverAveragePositionBidTarget = {
  readonly keyword: string
  readonly position: number
}

export type NaverAveragePositionBidEstimate = {
  readonly keyword: string
  readonly position: number
  readonly device: NaverDevice
  readonly bid: number | null
  readonly raw: NaverRemoteRow | null
}

export type NaverKeywordBidUpdate = {
  /** The complete row returned by `/ncc/keywords`, not an id-only patch. */
  readonly row: NaverKeywordRow
  readonly bidAmt: number
  /** Optional only when the remote row does not carry its ad-group id. */
  readonly adgroupId?: string
  readonly adGroupId?: string
}

export type NaverKeywordBidUpdateInput = NaverKeywordBidUpdate | {
  /** Convenient alias for callers that call the remote row `remote`. */
  readonly remote: NaverKeywordRow
  readonly bidAmt: number
  readonly adgroupId?: string
  readonly adGroupId?: string
} | {
  /** Alias used by callers that call the source row `remoteRow`. */
  readonly remoteRow: NaverKeywordRow
  readonly bidAmt: number
  readonly adgroupId?: string
  readonly adGroupId?: string
} | (NaverKeywordRow & {
  /** Direct-row form for decision records that already contain the desired bid. */
  readonly desiredBidAmt?: number
  readonly nextBidAmt?: number
})

export type NaverBidUpdateOptions = {
  readonly batchSize?: number
} | number

export type NaverBidVerificationMismatch = {
  readonly nccKeywordId: string
  readonly adgroupId: string
  readonly expectedBidAmt: number
  readonly actualBidAmt: number | null
  readonly actualUseGroupBidAmt: unknown
  readonly reason: 'missing' | 'bidAmt' | 'useGroupBidAmt'
}

export type NaverBidVerificationResult = {
  readonly verified: boolean
  readonly checked: number
  readonly mismatches: readonly NaverBidVerificationMismatch[]
  readonly groups: ReadonlyMap<string, readonly NaverKeywordRow[]>
}

export type NaverProviderOptions = {
  /** Share this limiter explicitly when several providers use one account. */
  readonly limiter?: RateLimiter
  readonly rateLimiter?: RateLimiter
  /** If supplied, all providers in this process share the account limiter. */
  readonly accountId?: string
  readonly rateLimiterOptions?: AdaptiveRateLimiterOptions
  readonly batchSize?: number
  readonly exposureBatchSize?: number
  readonly bidBatchSize?: number
}

type ProviderOptionsOrLimiter = NaverProviderOptions | RateLimiter

type NormalizedBidUpdate = {
  readonly row: NaverKeywordRow
  readonly bidAmt: number
  readonly adgroupId: string | null
}

type IndexedExposureTarget = {
  readonly keyword: string
  readonly device: NaverDevice
  readonly index: number
}

const DEFAULT_DEVICE: NaverDevice = 'MOBILE'
const DEFAULT_PERIOD: NaverEstimatePeriod = 'MONTH'
const DEFAULT_BATCH_SIZE = 50

function isRecord(value: unknown): value is NaverRemoteRow {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isRateLimiter(value: unknown): value is RateLimiter {
  return isRecord(value) && typeof value.execute === 'function'
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${label} is required`)
  return value.trim()
}

function normalizeDevice(value: unknown, fallback: NaverDevice): NaverDevice {
  if (value === undefined) return fallback
  if (value === 'PC' || value === 'MOBILE') return value
  if (value === 'pc') return 'PC'
  if (value === 'mobile') return 'MOBILE'
  throw new TypeError('device must be PC or MOBILE')
}

function normalizePeriod(value: unknown, fallback: NaverEstimatePeriod): NaverEstimatePeriod {
  if (value === undefined) return fallback
  if (value === 'DAY' || value === 'MONTH') return value
  throw new TypeError('period must be DAY or MONTH')
}

function batchSize(value: number | undefined, fallback: number, label: string): number {
  const resolved = value ?? fallback
  if (!Number.isSafeInteger(resolved) || resolved < 1) {
    throw new TypeError(`${label} must be a positive safe integer`)
  }
  return resolved
}

function chunks<T>(values: readonly T[], size: number): T[][] {
  const result: T[][] = []
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size))
  return result
}

function responseRows(value: unknown, operation: string): NaverRemoteRow[] {
  if (!Array.isArray(value)) throw new Error(`${operation} response must be an array`)
  return value.map((row, index) => {
    if (!isRecord(row)) throw new Error(`${operation}[${index}] response must be an object`)
    return row
  })
}

function responseEstimateRows(value: unknown): NaverRemoteRow[] {
  if (Array.isArray(value)) return value.filter(isRecord)
  if (!isRecord(value)) return []
  if (typeof value.keyword === 'string' || typeof value.key === 'string') return [value]
  for (const key of ['estimate', 'items', 'data', 'results', 'rows']) {
    const nested = value[key]
    if (Array.isArray(nested)) return nested.filter(isRecord)
  }
  return []
}

function firstText(row: NaverRemoteRow, keys: readonly string[]): string | null {
  for (const key of keys) {
    if (typeof row[key] !== 'string') continue
    const value = row[key].trim()
    if (value) return value
  }
  return null
}

function integerValue(value: unknown): number | null {
  if (typeof value === 'string') {
    if (!/^\d+$/.test(value.trim())) return null
    value = Number(value)
  }
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return null
  return value
}

function estimateBid(row: NaverRemoteRow): number | null {
  for (const key of ['bid', 'bidAmt', 'exposureMinimumBid', 'minimumBid']) {
    if (!Object.prototype.hasOwnProperty.call(row, key)) continue
    return integerValue(row[key])
  }
  return null
}

function rowKeywordId(row: NaverRemoteRow): string | null {
  return firstText(row, ['nccKeywordId', 'keywordId', 'id'])
}

function rowAdgroupId(row: NaverRemoteRow): string | null {
  return firstText(row, ['nccAdgroupId', 'nccAdGroupId', 'adgroupId', 'adGroupId'])
}

function normalizeBidAmount(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`)
  }
  return value as number
}

function normalizeBidUpdate(value: NaverKeywordBidUpdateInput, index: number): NormalizedBidUpdate {
  if (!isRecord(value)) throw new TypeError(`bidUpdates[${index}] must be an object`)
  const record = value as NaverRemoteRow

  const nestedRow = isRecord(record.row)
    ? record.row
    : isRecord(record.remote)
      ? record.remote
      : isRecord(record.remoteRow)
        ? record.remoteRow
        : record
  const hasNestedRow = isRecord(record.row) || isRecord(record.remote) || isRecord(record.remoteRow)
  const bid = hasNestedRow
    ? record.bidAmt
    : record.desiredBidAmt ?? record.nextBidAmt ?? record.bidAmt
  const row = { ...nestedRow }
  const keywordId = rowKeywordId(row)
  if (!keywordId) throw new TypeError(`bidUpdates[${index}] is missing nccKeywordId`)
  const bidAmt = normalizeBidAmount(bid, `bidUpdates[${index}].bidAmt`)
  const adgroupId = firstText(record, ['adgroupId', 'adGroupId']) ?? rowAdgroupId(row)
  return { row, bidAmt, adgroupId }
}

function rowHasGroupBidDisabled(value: unknown): boolean {
  return value === false || value === 0 || value === '0'
}

function normalizeGroupIds(groupIds: string | readonly string[]): string[] {
  const values = typeof groupIds === 'string' ? [groupIds] : [...groupIds]
  const normalized = values.map((value, index) => requiredText(value, `adgroupIds[${index}]`))
  return [...new Set(normalized)]
}

/**
 * Transport adapter for the automatic bidder.  It has no policy or database
 * behavior: callers provide already-selected rows and this class only talks to
 * SearchAd through the injected client.
 */
export class NaverProvider {
  private readonly client: NaverSearchAdRequestClient
  private readonly limiter: RateLimiter
  private readonly defaultBatchSize: number
  private readonly defaultExposureBatchSize: number
  private readonly defaultBidBatchSize: number

  constructor(client: NaverSearchAdRequestClient, optionsOrLimiter: ProviderOptionsOrLimiter = {}) {
    if (!client || typeof client.request !== 'function') {
      throw new TypeError('a Naver SearchAd request client is required')
    }
    this.client = client

    if (isRateLimiter(optionsOrLimiter)) {
      this.limiter = optionsOrLimiter
      this.defaultBatchSize = DEFAULT_BATCH_SIZE
      this.defaultExposureBatchSize = DEFAULT_BATCH_SIZE
      this.defaultBidBatchSize = DEFAULT_BATCH_SIZE
      return
    }

    const options = optionsOrLimiter
    this.defaultBatchSize = batchSize(options.batchSize, DEFAULT_BATCH_SIZE, 'batchSize')
    this.defaultExposureBatchSize = batchSize(
      options.exposureBatchSize,
      this.defaultBatchSize,
      'exposureBatchSize',
    )
    this.defaultBidBatchSize = batchSize(options.bidBatchSize, this.defaultBatchSize, 'bidBatchSize')
    if (options.limiter && options.rateLimiter && options.limiter !== options.rateLimiter) {
      throw new TypeError('limiter and rateLimiter must refer to the same limiter when both are supplied')
    }
    this.limiter = options.limiter
      ?? options.rateLimiter
      ?? (options.accountId
        ? getSharedAccountRateLimiter(options.accountId, options.rateLimiterOptions)
        : new AdaptiveRateLimiter(options.rateLimiterOptions))
  }

  /** All provider requests pass through the account limiter. */
  async request<T>(method: string, path: string, options?: NaverRequestOptions): Promise<T> {
    return this.limiter.execute(() => this.client.request<T>(method, path, options))
  }

  async getCampaigns(): Promise<readonly NaverCampaignRow[]> {
    return responseRows(await this.request<unknown>('GET', NAVER_AUTO_BID_ENDPOINTS.campaigns), 'GET /ncc/campaigns')
  }

  listCampaigns(): Promise<readonly NaverCampaignRow[]> {
    return this.getCampaigns()
  }

  async getAdGroups(campaignId?: string): Promise<readonly NaverAdGroupRow[]> {
    const query = campaignId === undefined
      ? undefined
      : { nccCampaignId: requiredText(campaignId, 'campaignId') }
    return responseRows(
      await this.request<unknown>('GET', NAVER_AUTO_BID_ENDPOINTS.adgroups, { query }),
      'GET /ncc/adgroups',
    )
  }

  listAdGroups(campaignId?: string): Promise<readonly NaverAdGroupRow[]> {
    return this.getAdGroups(campaignId)
  }

  async getKeywords(adgroupId: string): Promise<readonly NaverKeywordRow[]> {
    const id = requiredText(adgroupId, 'adgroupId')
    return responseRows(
      await this.request<unknown>('GET', NAVER_AUTO_BID_ENDPOINTS.keywords, {
        query: { nccAdgroupId: id },
      }),
      `GET /ncc/keywords(${id})`,
    )
  }

  listKeywords(adgroupId: string): Promise<readonly NaverKeywordRow[]> {
    return this.getKeywords(adgroupId)
  }

  getGroupKeywords(adgroupId: string): Promise<readonly NaverKeywordRow[]> {
    return this.getKeywords(adgroupId)
  }

  getAdGroupKeywords(adgroupId: string): Promise<readonly NaverKeywordRow[]> {
    return this.getKeywords(adgroupId)
  }

  async getKeyword(keywordId: string): Promise<NaverKeywordRow> {
    const id = requiredText(keywordId, 'keywordId')
    const value = await this.request<unknown>('GET', `${NAVER_AUTO_BID_ENDPOINTS.keywords}/${encodeURIComponent(id)}`)
    if (!isRecord(value)) throw new Error(`GET /ncc/keywords/${id} response must be an object`)
    return value
  }

  /** One raw official estimate request; batching is handled by the plural helper. */
  async estimateExposureMinimumBidBatch(
    device: NaverDeviceInput,
    keywords: readonly string[],
    period: NaverEstimatePeriod = DEFAULT_PERIOD,
  ): Promise<unknown> {
    const normalizedDevice = normalizeDevice(device, DEFAULT_DEVICE)
    const normalizedPeriod = normalizePeriod(period, DEFAULT_PERIOD)
    const items = keywords.map((keyword, index) => requiredText(keyword, `keywords[${index}]`))
    if (items.length === 0) return { device: normalizedDevice, period: normalizedPeriod, estimate: [] }
    return this.request('POST', NAVER_AUTO_BID_ENDPOINTS.exposureMinimumBid, {
      body: { device: normalizedDevice, period: normalizedPeriod, items },
    })
  }

  /**
   * Estimate in bounded batches and group requests by device.  Target arrays
   * retain their original order even though PC and MOBILE are sent separately.
   */
  async estimateExposureMinimumBids(
    device: NaverDeviceInput,
    keywords: readonly (string | NaverExposureMinimumBidTarget)[],
    period?: NaverEstimatePeriod,
    legacyBatchSize?: number,
  ): Promise<readonly NaverExposureMinimumBidEstimate[]>
  async estimateExposureMinimumBids(
    input: NaverExposureMinimumBidRequest | readonly (string | NaverExposureMinimumBidTarget)[],
    optionsOrDevice?: NaverExposureMinimumBidOptions | NaverDeviceInput,
    period?: NaverEstimatePeriod,
    legacyBatchSize?: number,
  ): Promise<readonly NaverExposureMinimumBidEstimate[]>
  async estimateExposureMinimumBids(
    input: NaverExposureMinimumBidRequest | readonly (string | NaverExposureMinimumBidTarget)[] | NaverDeviceInput,
    optionsOrDevice: NaverExposureMinimumBidOptions | NaverDeviceInput | readonly (string | NaverExposureMinimumBidTarget)[] = {},
    period?: NaverEstimatePeriod,
    legacyBatchSize?: number,
  ): Promise<readonly NaverExposureMinimumBidEstimate[]> {
    if (typeof input === 'string') {
      if (!Array.isArray(optionsOrDevice)) throw new TypeError('keywords must be an array')
      return this.estimateExposureMinimumBids(optionsOrDevice, {
        device: input,
        period,
        batchSize: legacyBatchSize,
      })
    }

    if (Array.isArray(optionsOrDevice)) throw new TypeError('estimate options must be an object')
    const options: NaverExposureMinimumBidOptions = typeof optionsOrDevice === 'string'
      ? { device: optionsOrDevice, period, batchSize: legacyBatchSize }
      : optionsOrDevice as NaverExposureMinimumBidOptions

    const request = Array.isArray(input) ? null : input as NaverExposureMinimumBidRequest
    if (request !== null && !isRecord(request)) throw new TypeError('estimate input must be an object or array')

    const defaultDevice = normalizeDevice(request?.device ?? options.device, DEFAULT_DEVICE)
    const estimatePeriod = normalizePeriod(request?.period ?? options.period, DEFAULT_PERIOD)
    const requestedItems: Array<{ keyword: string; device?: NaverDeviceInput }> = Array.isArray(input)
      ? input.map((value, index) => {
        if (typeof value === 'string') return { keyword: requiredText(value, `keywords[${index}]`) }
        if (!isRecord(value)) throw new TypeError(`keywords[${index}] must be a string or object`)
        return { keyword: requiredText(value.keyword, `keywords[${index}].keyword`), device: value.device as NaverDeviceInput | undefined }
      })
      : (request?.keywords ?? request?.items ?? []).map((keyword, index) => ({
        keyword: requiredText(keyword, `keywords[${index}]`),
      }))

    const size = batchSize(
      request?.batchSize ?? options.batchSize,
      this.defaultExposureBatchSize,
      'estimate batchSize',
    )
    const targets: IndexedExposureTarget[] = requestedItems.map((value, index) => ({
      ...value,
      device: normalizeDevice(value.device, defaultDevice),
      index,
    }))
    const result: Array<NaverExposureMinimumBidEstimate | undefined> = Array.from({ length: targets.length })
    const byDevice = new Map<NaverDevice, IndexedExposureTarget[]>()
    for (const target of targets) byDevice.set(target.device, [...(byDevice.get(target.device) ?? []), target])

    for (const [device, deviceTargets] of byDevice) {
      for (const batch of chunks(deviceTargets, size)) {
        const raw = await this.estimateExposureMinimumBidBatch(
          device,
          batch.map((target) => target.keyword),
          estimatePeriod,
        )
        const rows = responseEstimateRows(raw)
        const rowByKeyword = new Map<string, NaverRemoteRow[]>()
        const positionalRows: NaverRemoteRow[] = []
        for (const row of rows) {
          const keyword = firstText(row, ['keyword', 'key'])
          if (!keyword) {
            positionalRows.push(row)
            continue
          }
          rowByKeyword.set(keyword, [...(rowByKeyword.get(keyword) ?? []), row])
        }

        batch.forEach((target, index) => {
          const matching = rowByKeyword.get(target.keyword)?.shift() ?? positionalRows[index] ?? null
          result[target.index] = {
            keyword: target.keyword,
            device,
            period: estimatePeriod,
            bid: matching ? estimateBid(matching) : null,
            raw: matching,
          }
        })
      }
    }

    return result.map((value, index) => value ?? {
      keyword: targets[index].keyword,
      device: targets[index].device,
      period: estimatePeriod,
      bid: null,
      raw: null,
    })
  }

  async estimateExposureMinimumBid(
    keyword: string,
    options: NaverExposureMinimumBidOptions = {},
  ): Promise<NaverExposureMinimumBidEstimate> {
    const [estimate] = await this.estimateExposureMinimumBids([keyword], options)
    return estimate
  }

  async estimateExposureMinimumBidMap(
    input: NaverExposureMinimumBidRequest | readonly (string | NaverExposureMinimumBidTarget)[],
    options: NaverExposureMinimumBidOptions = {},
  ): Promise<ReadonlyMap<string, NaverExposureMinimumBidEstimate>> {
    const estimates = await this.estimateExposureMinimumBids(input, options)
    return new Map(estimates.map((estimate) => [estimate.keyword, estimate]))
  }

  /** Official target-position estimator. It is deterministic and does not mutate ads. */
  async estimateAveragePositionBids(
    targets: readonly NaverAveragePositionBidTarget[],
    options: { device?: NaverDeviceInput; batchSize?: number } = {},
  ): Promise<readonly NaverAveragePositionBidEstimate[]> {
    const device = normalizeDevice(options.device, DEFAULT_DEVICE)
    const size = batchSize(options.batchSize, this.defaultExposureBatchSize, 'position estimate batchSize')
    const normalized = targets.map((target, index) => {
      const keyword = requiredText(target.keyword, `targets[${index}].keyword`)
      if (!Number.isSafeInteger(target.position) || target.position < 1 || target.position > 15) {
        throw new TypeError(`targets[${index}].position must be an integer between 1 and 15`)
      }
      return { keyword, position: target.position }
    })
    const estimates: NaverAveragePositionBidEstimate[] = []
    for (const batch of chunks(normalized, size)) {
      const raw = await this.request<unknown>('POST', NAVER_AUTO_BID_ENDPOINTS.averagePositionBid, {
        body: { device, items: batch.map((target) => ({ key: target.keyword, position: target.position })) },
      })
      const rows = responseEstimateRows(raw)
      const rowByKey = new Map<string, NaverRemoteRow[]>()
      for (const row of rows) {
        const key = firstText(row, ['key', 'keyword'])
        if (key) rowByKey.set(key, [...(rowByKey.get(key) ?? []), row])
      }
      batch.forEach((target, index) => {
        const matching = rowByKey.get(target.keyword)?.shift() ?? rows[index] ?? null
        estimates.push({
          keyword: target.keyword,
          position: target.position,
          device,
          bid: matching ? estimateBid(matching) : null,
          raw: matching,
        })
      })
    }
    return estimates
  }

  /**
   * Update only the requested field, while sending each complete remote row.
   * Naver's group-bid flag is explicitly disabled for every changed keyword.
   */
  async bulkUpdateBids(
    updates: readonly NaverKeywordBidUpdateInput[],
    options: NaverBidUpdateOptions = {},
  ): Promise<readonly NaverKeywordRow[]> {
    const normalized = updates.map(normalizeBidUpdate)
    const size = batchSize(
      typeof options === 'number' ? options : options.batchSize,
      this.defaultBidBatchSize,
      'bid batchSize',
    )
    const updated: NaverKeywordRow[] = []

    for (const batch of chunks(normalized, size)) {
      const body = batch.map(({ row, bidAmt }) => ({
        ...row,
        bidAmt,
        useGroupBidAmt: false,
      }))
      const response = responseRows(
        await this.request<unknown>('PUT', NAVER_AUTO_BID_ENDPOINTS.keywords, {
          query: { fields: 'bidAmt' },
          body,
        }),
        'PUT /ncc/keywords',
      )
      if (response.length !== batch.length) {
        throw new Error(`PUT /ncc/keywords response count does not match bidUpdates (${batch.length})`)
      }
      updated.push(...response)
    }
    return updated
  }

  updateKeywordBids(
    updates: readonly NaverKeywordBidUpdateInput[],
    options: NaverBidUpdateOptions = {},
  ): Promise<readonly NaverKeywordRow[]> {
    return this.bulkUpdateBids(updates, options)
  }

  updateBids(
    updates: readonly NaverKeywordBidUpdateInput[],
    options: NaverBidUpdateOptions = {},
  ): Promise<readonly NaverKeywordRow[]> {
    return this.bulkUpdateBids(updates, options)
  }

  /** Read every keyword in each affected ad group through the shared limiter. */
  async readBackGroups(
    groupIds: string | readonly string[],
  ): Promise<ReadonlyMap<string, readonly NaverKeywordRow[]>> {
    const normalizedIds = normalizeGroupIds(groupIds)
    const groups = new Map<string, readonly NaverKeywordRow[]>()
    for (const groupId of normalizedIds) groups.set(groupId, await this.getKeywords(groupId))
    return groups
  }

  readBackKeywordGroups(
    groupIds: string | readonly string[],
  ): Promise<ReadonlyMap<string, readonly NaverKeywordRow[]>> {
    return this.readBackGroups(groupIds)
  }

  getKeywordGroups(
    groupIds: string | readonly string[],
  ): Promise<ReadonlyMap<string, readonly NaverKeywordRow[]>> {
    return this.readBackGroups(groupIds)
  }

  readBackGroup(adgroupId: string): Promise<readonly NaverKeywordRow[]> {
    return this.getKeywords(adgroupId)
  }

  readBackAdGroup(adgroupId: string): Promise<readonly NaverKeywordRow[]> {
    return this.getKeywords(adgroupId)
  }

  /** Compare both the requested bid and the group-bid switch after a live write. */
  async verifyBidUpdates(updates: readonly NaverKeywordBidUpdateInput[]): Promise<NaverBidVerificationResult> {
    const normalized = updates.map(normalizeBidUpdate)
    if (normalized.length === 0) {
      return { verified: true, checked: 0, mismatches: [], groups: new Map() }
    }

    const missingGroup = normalized.find(({ adgroupId }) => !adgroupId)
    if (missingGroup) throw new TypeError('every bid update needs an adgroupId for read-back verification')
    const groupIds = [...new Set(normalized.map(({ adgroupId }) => adgroupId!))]
    const groups = await this.readBackGroups(groupIds)
    const rowsByGroupAndKeyword = new Map<string, NaverKeywordRow>()
    for (const [groupId, rows] of groups) {
      for (const row of rows) {
        const id = rowKeywordId(row)
        if (id) rowsByGroupAndKeyword.set(`${groupId}\u0000${id}`, row)
      }
    }

    const mismatches: NaverBidVerificationMismatch[] = []
    for (const update of normalized) {
      const id = rowKeywordId(update.row)!
      const groupId = update.adgroupId!
      const actual = rowsByGroupAndKeyword.get(`${groupId}\u0000${id}`)
      if (!actual) {
        mismatches.push({
          nccKeywordId: id,
          adgroupId: groupId,
          expectedBidAmt: update.bidAmt,
          actualBidAmt: null,
          actualUseGroupBidAmt: undefined,
          reason: 'missing',
        })
        continue
      }

      const actualBidAmt = integerValue(actual.bidAmt)
      if (actualBidAmt !== update.bidAmt) {
        mismatches.push({
          nccKeywordId: id,
          adgroupId: groupId,
          expectedBidAmt: update.bidAmt,
          actualBidAmt,
          actualUseGroupBidAmt: actual.useGroupBidAmt,
          reason: 'bidAmt',
        })
        continue
      }
      if (!rowHasGroupBidDisabled(actual.useGroupBidAmt)) {
        mismatches.push({
          nccKeywordId: id,
          adgroupId: groupId,
          expectedBidAmt: update.bidAmt,
          actualBidAmt,
          actualUseGroupBidAmt: actual.useGroupBidAmt,
          reason: 'useGroupBidAmt',
        })
      }
    }

    return {
      verified: mismatches.length === 0,
      checked: normalized.length,
      mismatches,
      groups,
    }
  }

  async updateKeywordBidsAndVerify(
    updates: readonly NaverKeywordBidUpdateInput[],
    options: NaverBidUpdateOptions = {},
  ): Promise<NaverBidVerificationResult> {
    await this.bulkUpdateBids(updates, options)
    return this.verifyBidUpdates(updates)
  }

  applyBidUpdatesAndVerify(
    updates: readonly NaverKeywordBidUpdateInput[],
    options: NaverBidUpdateOptions = {},
  ): Promise<NaverBidVerificationResult> {
    return this.updateKeywordBidsAndVerify(updates, options)
  }
}

export const NaverSearchAdProvider = NaverProvider

export function createNaverProvider(
  client: NaverSearchAdRequestClient,
  options: NaverProviderOptions = {},
): NaverProvider {
  return new NaverProvider(client, options)
}
