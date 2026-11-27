// tests/unit/naver-client.test.ts
import { describe, it, expect } from 'vitest'
import { createHmac } from 'node:crypto'
import { naverSignature } from '@/lib/engine/naver/signature'
import { NaverSearchAdClient, NaverApiError } from '@/lib/engine/naver/client'

const CREDS = { customerId: '123', apiKey: 'ak', secret: 'sk' }
const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 })

describe('naver signature', () => {
  it('HMAC-SHA256(ts.method.path) base64', () => {
    const expected = createHmac('sha256', 'sk').update('1000.GET./ncc/campaigns').digest('base64')
    expect(naverSignature('1000', 'GET', '/ncc/campaigns', 'sk')).toBe(expected)
    expect(naverSignature('1000', 'GET', '/ncc/adgroups', 'sk')).not.toBe(expected)
  })
})

describe('naver client', () => {
  it('인증 헤더 4종 부착, 쿼리 직렬화', async () => {
    let captured: Request | null = null
    const client = new NaverSearchAdClient(CREDS, {
      fetchFn: async (input, init) => { captured = new Request(input, init); return ok([]) },
    })
    await client.request('GET', '/ncc/campaigns', { query: { recordSize: '10' } })
    expect(captured!.url).toContain('/ncc/campaigns?recordSize=10')
    for (const h of ['X-Timestamp', 'X-API-KEY', 'X-Customer', 'X-Signature']) {
      expect(captured!.headers.get(h)).toBeTruthy()
    }
    expect(captured!.headers.get('X-Customer')).toBe('123')
  })

  it('동일 쿼리 키의 다중 값을 반복 파라미터로 직렬화한다', async () => {
    let captured: Request | null = null
    const client = new NaverSearchAdClient(CREDS, {
      fetchFn: async (input, init) => { captured = new Request(input, init); return ok([]) },
    })
    await client.request('GET', '/stats', { query: { ids: ['nkw-a', 'nkw-b'], fields: '["impCnt"]' } })
    const url = new URL(captured!.url)
    expect(url.searchParams.getAll('ids')).toEqual(['nkw-a', 'nkw-b'])
  })

  it('5xx 재시도 후 성공, 4xx 즉시 실패', async () => {
    let calls = 0
    const flaky = new NaverSearchAdClient(CREDS, {
      sleepFn: async () => {},
      fetchFn: async () => (++calls < 3 ? new Response('boom', { status: 500 }) : ok({ id: 'x' })),
    })
    expect(await flaky.request('GET', '/ncc/campaigns')).toEqual({ id: 'x' })
    expect(calls).toBe(3)

    const bad = new NaverSearchAdClient(CREDS, {
      sleepFn: async () => {},
      fetchFn: async () => new Response('nope', { status: 400 }),
    })
    await expect(bad.request('GET', '/x')).rejects.toBeInstanceOf(NaverApiError)
  })
})
