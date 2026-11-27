export type ObservedRankStatus = 'found' | 'outside' | 'no_ads'

export interface ObservedLegalCompetitor {
  readonly position: number
  readonly advertiser: string | null
  readonly displayUrl: string | null
  readonly title: string | null
  readonly adId: string | null
}

export interface ObservedRank {
  readonly keyword: string
  readonly device: 'mobile' | 'pc'
  readonly status: ObservedRankStatus
  readonly rank: number | null
  readonly visibleAds: number
  readonly legalCompetitorPresent: boolean
  readonly legalCompetitorCount: number
  /** Bounded to the visible top-level rows; never contains raw HTML. */
  readonly legalCompetitors: readonly ObservedLegalCompetitor[]
  readonly source: 'mobile_ad_only' | 'integrated_search'
  readonly latencyMs: number
  readonly observedAt: string
}

export interface RankObserver {
  observe(keyword: string, device: 'mobile' | 'pc'): Promise<ObservedRank>
}

type FetchLike = typeof fetch

export interface RankObserverOptions {
  readonly requestsPerMinute?: number
  /** Safe starting rate before success-driven ramp-up. */
  readonly warmupRequestsPerMinute?: number
  readonly concurrency?: number
  readonly minIntervalMs?: number
  /** Fixed, operator-controlled outbound proxy gateway. */
  readonly proxyUrl?: string | null
  readonly fetcher?: FetchLike
  readonly maxRetries?: number
}

const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1'
const PC_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/128.0.0.0 Safari/537.36'

function domainValue(value: string): string {
  const result = value.trim().toLowerCase().replace(/^www\./, '')
  if (!result || /[^a-z0-9.-]/.test(result)) throw new TypeError('rank observer domain is invalid')
  return result
}

function decodeHtml(value: string): string {
  return value.replaceAll('&quot;', '"').replaceAll('&#x3D;', '=')
    .replaceAll('&amp;', '&').replaceAll('&#39;', "'")
    .replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&nbsp;', ' ')
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
}

function containsDomain(chunk: string, domain: string): boolean {
  const value = decodeHtml(chunk).toLowerCase()
  const escaped = domain.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // Display URLs are commonly rendered without a protocol. Match the exact
  // host or any subdomain while avoiding a suffix embedded in a longer host.
  return new RegExp(`(?:^|[^a-z0-9.-])(?:[a-z0-9-]+\\.)*${escaped}(?=[:/?#\\s<"'&]|$)`, 'i').test(value)
}

/**
 * Parse top-level Powerlink rows in display order.
 *
 * Naver's mobile ad-only result uses `#contentsList > li.list_item`, while
 * integrated mobile search uses `#power_link_body li.bx`.  `sublink_item`
 * must not be counted as an ad row; the word-boundary match below deliberately
 * excludes it.
 */
export function parsePowerlinkRank(html: string, requestedDomain: string): Pick<ObservedRank, 'status' | 'rank' | 'visibleAds'> {
  const observation = parsePowerlinkObservation(html, requestedDomain)
  return { status: observation.status, rank: observation.rank, visibleAds: observation.visibleAds }
}

function plainText(value: string): string {
  return decodeHtml(value.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim()
}

function classText(chunk: string, className: string): string | null {
  const pattern = new RegExp(`<(?:span|div)[^>]*class=["'][^"']*\\b${className}\\b[^"']*["'][^>]*>([\\s\\S]*?)<\\/(?:span|div)>`, 'i')
  const value = pattern.exec(chunk)?.[1]
  return value ? plainText(value) || null : null
}

function displayDomain(value: string | null): string | null {
  if (!value) return null
  const cleaned = value.trim().replace(/^https?:\/\//i, '').replace(/^www\./i, '').split(/[/?#\s]/)[0]
  return cleaned || null
}

function legalAdvertisement(advertiser: string | null, title: string | null, chunk: string): boolean {
  const text = `${advertiser ?? ''} ${title ?? ''} ${plainText(chunk).slice(0, 600)}`
  return /법무법인|법률\s*사무소|변호사|로펌|형사전문|법률상담/i.test(text)
}

/**
 * Parse our position and a compact competitor summary in one pass.  Keeping
 * only visible advertiser/title/domain fields avoids retaining SERP HTML and
 * makes every observation useful for later bid/relevance analysis.
 */
export function parsePowerlinkObservation(
  html: string,
  requestedDomain: string,
): Pick<ObservedRank, 'status' | 'rank' | 'visibleAds' | 'legalCompetitorPresent' | 'legalCompetitorCount' | 'legalCompetitors'> {
  const domain = domainValue(requestedDomain)
  const start = html.search(/id=["'](?:contentsList|power_link_body)["']/i)
  if (start < 0) return {
    status: 'no_ads', rank: null, visibleAds: 0,
    legalCompetitorPresent: false, legalCompetitorCount: 0, legalCompetitors: [],
  }
  const tail = html.slice(start)
  // Do not stop at the first </ul>: an ad row can contain its own sublink <ul>.
  // The enclosing section/body boundary is outside every top-level ad row.
  const containerEnd = tail.search(/<\/(?:section|body)>/i)
  const body = containerEnd < 0 ? tail : tail.slice(0, containerEnd)
  const rows = [...body.matchAll(/<li\b[^>]*\bclass=["'][^"']*\b(?:list_item|bx|lst)\b[^"']*["'][^>]*>/gi)]
  if (!rows.length) return {
    status: 'no_ads', rank: null, visibleAds: 0,
    legalCompetitorPresent: false, legalCompetitorCount: 0, legalCompetitors: [],
  }

  let ownRank: number | null = null
  const legalCompetitors: ObservedLegalCompetitor[] = []
  for (let index = 0; index < rows.length; index += 1) {
    const rowStart = rows[index].index!
    const rowEnd = rows[index + 1]?.index ?? body.length
    const chunk = body.slice(rowStart, rowEnd)
    const isOwn = containsDomain(chunk, domain)
    if (isOwn) ownRank = index + 1
    const advertiser = classText(chunk, 'site')
    const title = classText(chunk, 'tit_area')
    if (!isOwn && legalAdvertisement(advertiser, title, chunk)) {
      legalCompetitors.push({
        position: index + 1,
        advertiser,
        displayUrl: displayDomain(classText(chunk, 'url_link')),
        title,
        adId: chunk.match(/\bnad-a\d+-\d+-\d+\b/i)?.[0] ?? null,
      })
    }
  }
  return {
    status: ownRank === null ? 'outside' : 'found',
    rank: ownRank,
    visibleAds: rows.length,
    legalCompetitorPresent: legalCompetitors.length > 0,
    legalCompetitorCount: legalCompetitors.length,
    legalCompetitors,
  }
}

export class NaverSerpRankObserver implements RankObserver {
  private nextRequestAt = 0
  private paceQueue: Promise<void> = Promise.resolve()
  private active = 0
  private readonly slotWaiters: Array<() => void> = []
  private currentIntervalMs: number
  private proxyDispatcher: unknown = null
  private readonly requestsPerMinute: number
  private readonly concurrency: number
  private readonly minIntervalMs: number
  private readonly proxyUrl: string | null
  private readonly fetcher: FetchLike
  private readonly maxRetries: number
  private successfulSinceAdjustment = 0

  constructor(
    private readonly domain: string,
    options: RankObserverOptions = {},
  ) {
    domainValue(domain)
    this.requestsPerMinute = positiveInteger(options.requestsPerMinute ?? 1_000, 'requestsPerMinute')
    const warmupRequestsPerMinute = positiveInteger(
      options.warmupRequestsPerMinute ?? Math.min(this.requestsPerMinute, 1_000),
      'warmupRequestsPerMinute',
    )
    if (warmupRequestsPerMinute > this.requestsPerMinute) {
      throw new TypeError('warmupRequestsPerMinute must be <= requestsPerMinute')
    }
    this.concurrency = positiveInteger(options.concurrency ?? 24, 'concurrency')
    this.minIntervalMs = positiveInteger(options.minIntervalMs ?? 1, 'minIntervalMs')
    this.currentIntervalMs = Math.max(this.minIntervalMs, Math.ceil(60_000 / warmupRequestsPerMinute))
    this.fetcher = options.fetcher ?? fetch
    this.maxRetries = nonNegativeInteger(options.maxRetries ?? 2, 'maxRetries')
    this.proxyUrl = proxyValue(options.proxyUrl)
  }

  private async acquireSlot(): Promise<void> {
    if (this.active < this.concurrency) {
      this.active++
      return
    }
    await new Promise<void>((resolve) => this.slotWaiters.push(resolve))
    this.active++
  }

  private releaseSlot(): void {
    this.active--
    this.slotWaiters.shift()?.()
  }

  /** Serialize request starts while allowing responses to remain concurrent. */
  private async pace(): Promise<void> {
    const turn = this.paceQueue.then(async () => {
      const wait = Math.max(0, this.nextRequestAt - Date.now())
      if (wait) await new Promise((resolve) => setTimeout(resolve, wait))
      this.nextRequestAt = Date.now() + this.currentIntervalMs
    })
    this.paceQueue = turn.catch(() => undefined)
    await turn
  }

  private async request(url: string, init: RequestInit): Promise<Response> {
    if (!this.proxyUrl) return this.fetcher(url, init)
    const undici = await import('undici')
    this.proxyDispatcher ??= new undici.ProxyAgent(this.proxyUrl)
    return await undici.fetch(url, {
      method: init.method,
      headers: init.headers as Record<string, string> | undefined,
      redirect: init.redirect,
      signal: init.signal as AbortSignal | undefined,
      dispatcher: this.proxyDispatcher as InstanceType<typeof undici.ProxyAgent>,
    }) as unknown as Response
  }

  private noteSuccess(): void {
    const base = Math.max(this.minIntervalMs, Math.ceil(60_000 / this.requestsPerMinute))
    this.successfulSinceAdjustment++
    // Ramp after a meaningful clean sample instead of bursting at the target
    // rate immediately.  1000 -> 3000 RPM reaches 20ms in roughly 1250 clean
    // responses and backs off immediately on a blocked/incomplete response.
    if (this.successfulSinceAdjustment >= 250) {
      this.currentIntervalMs = Math.max(base, Math.floor(this.currentIntervalMs * 0.8))
      this.successfulSinceAdjustment = 0
    }
  }

  private noteThrottle(): void {
    this.successfulSinceAdjustment = 0
    this.currentIntervalMs = Math.min(5_000, Math.ceil(this.currentIntervalMs * 2))
  }

  async observe(keyword: string, device: 'mobile' | 'pc'): Promise<ObservedRank> {
    const key = keyword.trim()
    if (!key) throw new TypeError('rank observer keyword is required')
    const origin = device === 'mobile'
      ? 'https://m.ad.search.naver.com/search.naver'
      : 'https://search.naver.com/search.naver'
    const query = device === 'mobile'
      ? new URLSearchParams({ where: 'm_expd', query: key, gender: 'all', age: '999' })
      : new URLSearchParams({ where: 'nexearch', query: key })
    await this.acquireSlot()
    try {
      let lastError: unknown
      for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
        await this.pace()
        const startedAt = Date.now()
        try {
          const response = await this.request(`${origin}?${query}`, {
            headers: { 'accept-language': 'ko-KR,ko;q=0.9', 'user-agent': device === 'mobile' ? MOBILE_UA : PC_UA },
            redirect: 'follow',
            signal: AbortSignal.timeout(10_000),
          })
          if (!response.ok) {
            await response.body?.cancel()
            const error = new Error(`Naver rank request failed: HTTP ${response.status}`)
            Object.assign(error, { status: response.status })
            throw error
          }
          const html = await response.text()
          const title = html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] ?? ''
          if (html.length < 10_000 || /비정상적인 접근|자동입력 방지/i.test(title)) {
            throw new Error('Naver rank response was blocked or incomplete')
          }
          this.noteSuccess()
          return {
            keyword: key,
            device,
            ...parsePowerlinkObservation(html, this.domain),
            source: device === 'mobile' ? 'mobile_ad_only' : 'integrated_search',
            latencyMs: Date.now() - startedAt,
            observedAt: new Date().toISOString(),
          }
        } catch (error) {
          lastError = error
          const status = error && typeof error === 'object' ? Number((error as { status?: unknown }).status ?? 0) : 0
          const retryable = status === 403 || status === 429 || status >= 500 || status === 0
          if (retryable) this.noteThrottle()
          if (!retryable || attempt >= this.maxRetries) throw error
          await new Promise((resolve) => setTimeout(resolve, Math.min(5_000, 250 * (2 ** attempt))))
        }
      }
      throw lastError
    } finally {
      this.releaseSlot()
    }
  }
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${label} must be a positive safe integer`)
  return value
}

function nonNegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${label} must be a non-negative safe integer`)
  return value
}

function proxyValue(value: string | null | undefined): string | null {
  const text = value?.trim()
  if (!text) return null
  const url = new URL(text)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new TypeError('rank proxy URL must use http or https')
  }
  return url.toString()
}
