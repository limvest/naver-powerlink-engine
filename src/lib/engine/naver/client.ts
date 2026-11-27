// src/lib/engine/naver/client.ts
import { naverSignature } from './signature'

export type NaverCreds = { customerId: string; apiKey: string; secret: string }
export type NaverQuery = Record<string, string | readonly string[]>

export class NaverApiError extends Error {
  constructor(public status: number, public body: string) {
    super(`naver searchad api ${status}: ${body.slice(0, 200)}`)
  }
}

const RETRYABLE = (s: number) => s === 429 || s >= 500

// 베이스 URL·헤더명(X-Timestamp/X-API-KEY/X-Customer/X-Signature) — 공식 참조 구현
// github.com/naver/searchad-apidoc/blob/master/python-sample/examples/ad_management_sample.py
// 로 대조 확인함(VERIFY 2026-08-02).
export class NaverSearchAdClient {
  private baseUrl: string
  private fetchFn: typeof fetch
  private maxRetries: number
  private sleepFn: (ms: number) => Promise<void>
  private requestTimeoutMs: number

  constructor(private creds: NaverCreds, opts: {
    baseUrl?: string; fetchFn?: typeof fetch; maxRetries?: number; sleepFn?: (ms: number) => Promise<void>; requestTimeoutMs?: number
  } = {}) {
    this.baseUrl = opts.baseUrl ?? 'https://api.searchad.naver.com'
    this.fetchFn = opts.fetchFn ?? fetch
    this.maxRetries = opts.maxRetries ?? 3
    this.sleepFn = opts.sleepFn ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 20_000
  }

  async request<T>(method: string, path: string, opts: { query?: NaverQuery; body?: unknown } = {}): Promise<T> {
    const params = new URLSearchParams()
    for (const [key, value] of Object.entries(opts.query ?? {})) {
      if (Array.isArray(value)) value.forEach((item) => params.append(key, item))
      else params.set(key, value as string)
    }
    const qs = params.size ? `?${params}` : ''
    let lastErr: unknown
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (attempt > 0) await this.sleepFn(500 * 2 ** (attempt - 1))
      const ts = String(Date.now())
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs)
      const res = await this.fetchFn(`${this.baseUrl}${path}${qs}`, {
        method,
        headers: {
          'Content-Type': 'application/json; charset=UTF-8',
          'X-Timestamp': ts,
          'X-API-KEY': this.creds.apiKey,
          'X-Customer': this.creds.customerId,
          'X-Signature': naverSignature(ts, method, path, this.creds.secret),
        },
        signal: controller.signal,
        ...(opts.body !== undefined && { body: JSON.stringify(opts.body) }),
      }).catch((e) => { lastErr = e; return null }).finally(() => clearTimeout(timeout))
      if (!res) continue
      if (res.ok) return res.json() as Promise<T>
      const body = await res.text()
      if (!RETRYABLE(res.status)) throw new NaverApiError(res.status, body)
      lastErr = new NaverApiError(res.status, body)
    }
    throw lastErr
  }
}
