import { describe, expect, it, vi } from 'vitest'
import {
  NaverSearchAdAdapter,
  fetchNaverAdDailyStats,
  parseNaverInspectionHistoryResponse,
  parseNaverStatsResponse,
  type NaverSearchAdReadClient,
} from '@/platform/integrations/naver-searchad'

type RequestCall = {
  method: string
  path: string
  options?: { query?: Record<string, string>; body?: unknown }
}

function fakeClient(responses: readonly unknown[]): {
  client: NaverSearchAdReadClient
  calls: RequestCall[]
  maxInFlight: () => number
} {
  const calls: RequestCall[] = []
  let index = 0
  let inFlight = 0
  let maxInFlight = 0
  const client: NaverSearchAdReadClient = {
    request: vi.fn(async <T>(method: string, path: string, options?: RequestCall['options']) => {
      calls.push({ method, path, options })
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      const response = responses[Math.min(index++, responses.length - 1)] as T
      await Promise.resolve()
      inFlight--
      return response
    }),
  }
  return { client, calls, maxInFlight: () => maxInFlight }
}

const targets = [
  { firmId: 7, adExecutionId: 'execution-a', adGroupId: 'grp-a' },
  { firmId: 7, adExecutionId: 'execution-b', adGroupId: 'grp-b' },
]

const creativeTargets = [
  { firmId: 7, adExecutionId: 'execution-a', creativeId: 'creative-a' },
  { firmId: 7, adExecutionId: 'execution-b', creativeId: 'creative-b' },
]

describe('NaverSearchAdAdapter', () => {
  it('uses one entity ID, requested fields, and one concrete day', async () => {
    const { client, calls } = fakeClient([[
      { id: 'grp-a', impCnt: 10, clkCnt: 2, salesAmt: 300, ccnt: 1 },
      { id: 'grp-b', impCnt: 20, clkCnt: 3, salesAmt: 400, ccnt: 2 },
    ]])

    await new NaverSearchAdAdapter(client).fetchDailyStats({
      targets,
      since: '2026-08-09',
      until: '2026-08-09',
    })

    expect(calls).toHaveLength(2)
    expect(calls[0]).toMatchObject({ method: 'GET', path: '/stats' })
    expect(calls[0].options?.body).toBeUndefined()
    const query = calls[0].options?.query
    expect(query).toBeDefined()
    expect(query!.id).toBe('grp-a')
    expect(JSON.parse(query!.fields)).toEqual(['impCnt', 'clkCnt', 'salesAmt', 'ccnt'])
    expect(query!.timeIncrement).toBe('allDays')
    expect(JSON.parse(query!.timeRange)).toEqual({ since: '2026-08-09', until: '2026-08-09' })

    // The entity is passed as one ID while fields remain JSON.
    const encoded = new URLSearchParams(query).toString()
    expect(encoded).toContain('id=grp-a')
    expect(new URLSearchParams(encoded).get('fields')).toBe(query!.fields)
  })

  it('chunks homogeneous ad-group IDs without parallel or write calls', async () => {
    const allTargets = [
      ...targets,
      { firmId: 7, adExecutionId: 'execution-c', adGroupId: 'grp-c' },
    ]
    const { client, calls } = fakeClient([
      [{ id: 'grp-a', impCnt: 1 }],
      [{ id: 'grp-b', impCnt: 2 }, { id: 'grp-c', impCnt: 3 }],
    ])

    const rows = await fetchNaverAdDailyStats(client, {
      targets: allTargets,
      day: '2026-08-09',
      chunkSize: 1,
    })

    expect(calls.map((call) => [call.method, call.path])).toEqual([
      ['GET', '/stats'],
      ['GET', '/stats'],
      ['GET', '/stats'],
    ])
    expect(calls.every((call) => call.options?.body === undefined)).toBe(true)
    expect(calls.map((call) => call.options!.query!.id)).toEqual(['grp-a', 'grp-b', 'grp-c'])
    expect(rows.map((row) => row.adExecutionId)).toEqual(['execution-a', 'execution-b', 'execution-c'])
  })

  it('parses numeric strings and returns rows shaped for upsertAdDailyStat', async () => {
    const { client } = fakeClient([[
      { id: 'grp-a', impCnt: '1,234', clkCnt: '5', salesAmt: '2,500', ccnt: 7 },
    ]])

    await expect(new NaverSearchAdAdapter(client).fetchDailyStats({
      targets: [targets[0]],
      day: '2026-08-09',
    })).resolves.toEqual([{
      firmId: 7,
      adExecutionId: 'execution-a',
      day: '2026-08-09',
      impressions: 1234,
      clicks: 5,
      cost: 2500,
      conversions: 7,
    }])
  })

  it('records a zero row when the provider returns no performance for a requested entity', async () => {
    expect(parseNaverStatsResponse(null)).toEqual([])
    expect(parseNaverStatsResponse({ unexpected: true })).toEqual([])
    expect(parseNaverStatsResponse([
      { id: 'grp-a', impCnt: 'not-a-number' },
      { id: 'grp-b' },
    ])).toEqual([])

    const { client } = fakeClient([null])
    await expect(new NaverSearchAdAdapter(client).fetchDailyStats({
      targets: [targets[0]],
      day: '2026-08-09',
    })).resolves.toEqual([{
      firmId: 7, adExecutionId: 'execution-a', day: '2026-08-09',
      impressions: 0, clicks: 0, cost: 0, conversions: 0,
    }])
  })

  it('rejects non-daily ranges and invalid dates before calling the client', async () => {
    const { client, calls } = fakeClient([[]])
    const adapter = new NaverSearchAdAdapter(client)
    await expect(adapter.fetchDailyStats({
      targets: [targets[0]], since: '2026-08-08', until: '2026-08-09',
    })).rejects.toThrow('equal since and until')
    await expect(adapter.fetchDailyStats({
      targets: [targets[0]], day: '2026-02-30',
    })).rejects.toThrow('valid day')
    expect(calls).toHaveLength(0)
  })
})
describe('defensive inspection-history parser', () => {
  it('accepts explicit id/status rows and ignores unknown shapes', () => {
    expect(parseNaverInspectionHistoryResponse({ data: [
      {
        nccAdId: 'ad-a',
        reviewStatus: 'REJECTED',
        rejectReason: 'policy',
        observedAt: '2026-08-09T01:02:03.000Z',
      },
      { nccAdId: 'ad-b', status: 'reviewing' },
      { message: 'not an inspection row' },
    ] })).toEqual([
      {
        naverId: 'ad-a',
        reviewStatus: 'rejected',
        reason: 'policy',
        observedAt: '2026-08-09T01:02:03.000Z',
        raw: {
          nccAdId: 'ad-a',
          reviewStatus: 'REJECTED',
          rejectReason: 'policy',
          observedAt: '2026-08-09T01:02:03.000Z',
        },
      },
      {
        naverId: 'ad-b',
        reviewStatus: 'pending',
        reason: null,
        observedAt: null,
        raw: { nccAdId: 'ad-b', status: 'reviewing' },
      },
    ])
  })

  it('normalizes the official ELIGIBLE status as approved', () => {
    expect(parseNaverInspectionHistoryResponse({ data: [
      { nccAdId: 'ad-eligible', inspectStatus: 'ELIGIBLE' },
    ] })).toMatchObject([{ naverId: 'ad-eligible', reviewStatus: 'approved' }])
  })
})

describe('creative review GET integration', () => {
  it('fetches targets sequentially, uses GET-only calls, maps official statuses, and joins comment content', async () => {
    const allTargets = [
      ...creativeTargets,
      { firmId: 7, adExecutionId: 'execution-c', creativeId: 'creative-c' },
      { firmId: 7, adExecutionId: 'execution-d', creativeId: 'creative-d' },
      { firmId: 7, adExecutionId: 'execution-e', creativeId: 'creative-e' },
      { firmId: 7, adExecutionId: 'execution-f', creativeId: 'creative-f' },
    ]
    const { client, calls, maxInFlight } = fakeClient([
      { nccAdId: 'creative-a', inspectStatus: 'APPROVED', status: 'ELIGIBLE' },
      { nccAdId: 'creative-b', inspectStatus: 'ELIGIBLE' },
      { nccAdId: 'creative-c', inspectStatus: 'UNDER_REVIEW' },
      { nccAdId: 'creative-d', inspectStatus: 'PENDING' },
      { nccAdId: 'creative-e', inspectStatus: 'DENIED', statusReason: 'status fallback' },
      {
        id: 'creative-e',
        pcInspectComment: [{ content: 'PC reason', faq: 'faq-a' }],
        mobileInspectComment: [{ content: ' Mobile reason ', faq: 'faq-b' }],
      },
      { nccAdId: 'creative-f', inspectStatus: 'UNRECOGNIZED_STATUS' },
    ])

    const reviews = await new NaverSearchAdAdapter(client).fetchCreativeReviews(allTargets)

    expect(calls.map((call) => [call.method, call.path])).toEqual([
      ['GET', '/ncc/ads/creative-a'],
      ['GET', '/ncc/ads/creative-b'],
      ['GET', '/ncc/ads/creative-c'],
      ['GET', '/ncc/ads/creative-d'],
      ['GET', '/ncc/ads/creative-e'],
      ['GET', '/ncc/inspect-history/creative-e'],
      ['GET', '/ncc/ads/creative-f'],
    ])
    expect(maxInFlight()).toBe(1)
    expect(calls.every((call) => call.method === 'GET' && call.options?.body === undefined)).toBe(true)
    expect(reviews.map(({ firmId, adExecutionId, creativeId, reviewStatus, reason }) => ({
      firmId, adExecutionId, creativeId, reviewStatus, reason,
    }))).toEqual([
      {
        firmId: 7,
        adExecutionId: 'execution-a',
        creativeId: 'creative-a',
        reviewStatus: 'approved',
        reason: null,
      },
      {
        firmId: 7,
        adExecutionId: 'execution-b',
        creativeId: 'creative-b',
        reviewStatus: 'approved',
        reason: null,
      },
      {
        firmId: 7,
        adExecutionId: 'execution-c',
        creativeId: 'creative-c',
        reviewStatus: 'pending',
        reason: null,
      },
      {
        firmId: 7,
        adExecutionId: 'execution-d',
        creativeId: 'creative-d',
        reviewStatus: 'pending',
        reason: null,
      },
      {
        firmId: 7,
        adExecutionId: 'execution-e',
        creativeId: 'creative-e',
        reviewStatus: 'rejected',
        reason: 'PC reason\nMobile reason',
      },
      {
        firmId: 7,
        adExecutionId: 'execution-f',
        creativeId: 'creative-f',
        reviewStatus: 'unknown',
        reason: null,
      },
    ])
    expect(reviews[0].raw).toEqual({ nccAdId: 'creative-a', inspectStatus: 'APPROVED', status: 'ELIGIBLE' })
  })

  it('uses statusReason when a rejected history has no reason', async () => {
    const { client, calls } = fakeClient([
      { nccAdId: 'creative-a', inspectStatus: 'DENIED', statusReason: 'fallback reason' },
      {},
    ])

    await expect(new NaverSearchAdAdapter(client).fetchCreativeReviews([creativeTargets[0]])).resolves.toMatchObject([
      { creativeId: 'creative-a', reviewStatus: 'rejected', reason: 'fallback reason' },
    ])
    expect(calls.map((call) => call.path)).toEqual([
      '/ncc/ads/creative-a',
      '/ncc/inspect-history/creative-a',
    ])
  })

  it('throws on malformed or cross-id responses before mapping another execution', async () => {
    const mismatched = fakeClient([{ nccAdId: 'creative-b', inspectStatus: 'APPROVED' }])
    await expect(new NaverSearchAdAdapter(mismatched.client).fetchCreativeReviews(creativeTargets))
      .rejects.toThrow('does not match target creative-a')
    expect(mismatched.calls).toHaveLength(1)

    const malformed = fakeClient([{ nccAdId: 'creative-a' }])
    await expect(new NaverSearchAdAdapter(malformed.client).fetchCreativeReviews([creativeTargets[0]]))
      .rejects.toThrow('has no inspectStatus')

    const historyMismatch = fakeClient([
      { nccAdId: 'creative-a', inspectStatus: 'DENIED' },
      { id: 'creative-b', pcInspectComment: [{ content: 'wrong target' }] },
    ])
    await expect(new NaverSearchAdAdapter(historyMismatch.client).fetchCreativeReviews([creativeTargets[0]]))
      .rejects.toThrow('does not match target creative-a')
  })
})
