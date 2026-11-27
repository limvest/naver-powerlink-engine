import { describe, expect, it } from 'vitest'
import type { NaverQuery } from '@/lib/engine/naver/client'
import { AdaptiveRateLimiter } from '../src/rate-limiter'
import {
  NaverProvider,
  type NaverRemoteRow,
  type NaverRequestOptions,
  type NaverSearchAdRequestClient,
} from '../src/naver-provider'

type Call = {
  method: string
  path: string
  options: NaverRequestOptions | undefined
}

function noWaitLimiter(): AdaptiveRateLimiter {
  return new AdaptiveRateLimiter({ minIntervalMs: 0, baseBackoffMs: 0, maxBackoffMs: 0 })
}

describe('NaverProvider', () => {
  it('batches official target-position estimates and preserves requested order', async () => {
    const calls: Call[] = []
    const client: NaverSearchAdRequestClient = {
      request: async <T>(method: string, path: string, options?: { query?: NaverQuery; body?: unknown }) => {
        calls.push({ method, path, options })
        const body = options?.body as { items: Array<{ key: string; position: number }> }
        return { estimate: [...body.items].reverse().map((item) => ({ ...item, bid: item.position * 100 })) } as T
      },
    }
    const provider = new NaverProvider(client, { limiter: noWaitLimiter(), batchSize: 2 })

    const estimates = await provider.estimateAveragePositionBids([
      { keyword: '첫째', position: 1 },
      { keyword: '둘째', position: 3 },
      { keyword: '셋째', position: 5 },
    ], { device: 'MOBILE' })

    expect(calls.map(({ method, path }) => `${method} ${path}`)).toEqual([
      'POST /estimate/average-position-bid/keyword',
      'POST /estimate/average-position-bid/keyword',
    ])
    expect(calls[0].options?.body).toEqual({
      device: 'MOBILE',
      items: [{ key: '첫째', position: 1 }, { key: '둘째', position: 3 }],
    })
    expect(estimates.map(({ keyword, position, bid }) => ({ keyword, position, bid }))).toEqual([
      { keyword: '첫째', position: 1, bid: 100 },
      { keyword: '둘째', position: 3, bid: 300 },
      { keyword: '셋째', position: 5, bid: 500 },
    ])
  })

  it('rejects an impossible target position before calling Naver', async () => {
    const client: NaverSearchAdRequestClient = { request: async <T>() => [] as T }
    const provider = new NaverProvider(client, { limiter: noWaitLimiter() })
    await expect(provider.estimateAveragePositionBids([{ keyword: '테스트', position: 0 }]))
      .rejects.toThrow('between 1 and 15')
  })

  it('batches exposure estimates by device and never sends a PUT during estimate-only work', async () => {
    const calls: Call[] = []
    const client: NaverSearchAdRequestClient = {
      request: async <T>(method: string, path: string, options?: { query?: NaverQuery; body?: unknown }) => {
        calls.push({ method, path, options })
        const body = options?.body as { device: string; items: string[] }
        return {
          device: body.device,
          estimate: body.items.map((keyword, index) => ({ keyword, bid: 100 + index })),
        } as T
      },
    }
    const provider = new NaverProvider(client, { limiter: noWaitLimiter(), batchSize: 2 })

    const estimates = await provider.estimateExposureMinimumBids([
      { keyword: 'pc-a', device: 'PC' },
      { keyword: 'mobile-a', device: 'MOBILE' },
      { keyword: 'pc-b', device: 'PC' },
      { keyword: 'pc-c', device: 'PC' },
    ])

    expect(calls.map(({ method, path }) => `${method} ${path}`)).toEqual([
      'POST /estimate/exposure-minimum-bid/keyword',
      'POST /estimate/exposure-minimum-bid/keyword',
      'POST /estimate/exposure-minimum-bid/keyword',
    ])
    expect((calls[0].options?.body as NaverRemoteRow)).toMatchObject({
      device: 'PC', period: 'MONTH', items: ['pc-a', 'pc-b'],
    })
    expect((calls[1].options?.body as NaverRemoteRow)).toMatchObject({
      device: 'PC', period: 'MONTH', items: ['pc-c'],
    })
    expect((calls[2].options?.body as NaverRemoteRow)).toMatchObject({
      device: 'MOBILE', period: 'MONTH', items: ['mobile-a'],
    })
    expect(estimates.map((estimate) => estimate.bid)).toEqual([100, 100, 101, 100])
    expect(calls.some(({ method }) => method === 'PUT')).toBe(false)
  })

  it('bulk-updates complete remote rows, disables group bidding, and reads affected groups back', async () => {
    const calls: Call[] = []
    const remoteByGroup = new Map<string, NaverRemoteRow[]>()
    const remoteRow: NaverRemoteRow = {
      nccKeywordId: 'keyword-1',
      nccAdgroupId: 'group-1',
      keyword: '사기 상담',
      bidAmt: 70,
      useGroupBidAmt: true,
      userLock: false,
      links: { pc: { final: 'https://example.test/' } },
      customProviderField: 'preserve-me',
    }
    remoteByGroup.set('group-1', [{ ...remoteRow }])

    const client: NaverSearchAdRequestClient = {
      request: async <T>(method: string, path: string, options?: { query?: NaverQuery; body?: unknown }) => {
        calls.push({ method, path, options })
        if (method === 'PUT') {
          const body = options?.body as NaverRemoteRow[]
          remoteByGroup.set('group-1', body.map((row) => ({ ...row })))
          return body as T
        }
        const groupId = (options?.query as NaverQuery | undefined)?.nccAdgroupId
        return (remoteByGroup.get(String(groupId)) ?? []) as T
      },
    }
    const provider = new NaverProvider(client, { limiter: noWaitLimiter(), batchSize: 50 })

    const result = await provider.updateKeywordBidsAndVerify([
      { row: remoteRow, bidAmt: 170 },
    ])

    const put = calls.find(({ method }) => method === 'PUT')!
    expect(put.path).toBe('/ncc/keywords')
    expect(put.options?.query).toEqual({ fields: 'bidAmt' })
    expect(put.options?.body).toEqual([{
      ...remoteRow,
      bidAmt: 170,
      useGroupBidAmt: false,
    }])
    expect(remoteRow.bidAmt).toBe(70)
    expect(result).toMatchObject({ verified: true, checked: 1, mismatches: [] })
    expect([...result.groups.keys()]).toEqual(['group-1'])
    expect(calls.filter(({ method, path }) => method === 'GET' && path === '/ncc/keywords')).toHaveLength(1)
  })

  it('reports a read-back mismatch when the provider keeps group bidding enabled', async () => {
    const client: NaverSearchAdRequestClient = {
      request: async <T>(method: string, path: string, options?: { query?: NaverQuery; body?: unknown }) => {
        if (method === 'PUT') return options?.body as T
        return [{
          nccKeywordId: 'keyword-1', nccAdgroupId: 'group-1', bidAmt: 170, useGroupBidAmt: true,
        }] as T
      },
    }
    const provider = new NaverProvider(client, { limiter: noWaitLimiter() })

    const result = await provider.updateKeywordBidsAndVerify([
      {
        row: { nccKeywordId: 'keyword-1', nccAdgroupId: 'group-1', bidAmt: 70, useGroupBidAmt: true },
        bidAmt: 170,
      },
    ])

    expect(result.verified).toBe(false)
    expect(result.mismatches).toMatchObject([{ reason: 'useGroupBidAmt', actualUseGroupBidAmt: true }])
  })
})
