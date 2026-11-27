import { describe, expect, it, vi } from 'vitest'
import { NaverSerpRankObserver, parsePowerlinkObservation, parsePowerlinkRank } from '../src/rank-observer'

const HTML = `<!doctype html><html><head><title>검색</title></head><body>${'x'.repeat(11_000)}
<ul id="power_link_body">
  <li class="bx ext"><span class="url">competitor.example</span></li>
  <li class="bx ext"><a onclick='go("https://case.sampleone.attorney")'>법무법인 샘플원</a></li>
  <li class="bx ext"><span class="url">other.example</span></li>
</ul></section></body></html>`

const AD_ONLY_HTML = `<!doctype html><html><head><title>검색광고</title></head><body>${'x'.repeat(11_000)}
<ul id="contentsList" class="powerlink_list">
  <li class="list_item type_subtitle"><span class="site">법무법인 경쟁</span><span class="url_link">competitor.example</span><div class="tit_area"><span class="tit">사기 변호사</span></div></li>
  <li class="list_item ext_link"><span class="url_link">case.sampleone.attorney</span>
    <ul class="sublink_list"><li class="sublink_item">카톡 상담</li></ul>
  </li>
  <li class="list_item type_subtitle"><span class="url_link">other.example</span></li>
</ul></body></html>`

describe('Naver SERP rank observer', () => {
  it('retries a timeout without an HTTP status instead of treating NaN as non-retryable', async () => {
    const fetcher = vi.fn()
      .mockRejectedValueOnce(new DOMException('timed out', 'TimeoutError'))
      .mockResolvedValueOnce(new Response(AD_ONLY_HTML))
    const observer = new NaverSerpRankObserver('sampleone.attorney', {
      fetcher, maxRetries: 1, requestsPerMinute: 60_000, warmupRequestsPerMinute: 60_000,
    })
    expect(await observer.observe('사건명', 'mobile')).toMatchObject({ status: 'found', rank: 2 })
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('stops after the retry limit and releases the slot for subsequent queries', async () => {
    const fetcher = vi.fn().mockRejectedValue(new DOMException('timed out', 'TimeoutError'))
    const observer = new NaverSerpRankObserver('sampleone.attorney', {
      fetcher, maxRetries: 1, concurrency: 1, requestsPerMinute: 60_000, warmupRequestsPerMinute: 60_000,
    })
    await expect(observer.observe('실패', 'mobile')).rejects.toThrow('timed out')
    expect(fetcher).toHaveBeenCalledTimes(2)
    fetcher.mockResolvedValueOnce(new Response(AD_ONLY_HTML))
    expect(await observer.observe('다음', 'mobile')).toMatchObject({ status: 'found' })
  })
  it('finds the firm domain in top-level Powerlink order', () => {
    expect(parsePowerlinkRank(HTML, 'sampleone.attorney')).toEqual({ status: 'found', rank: 2, visibleAds: 3 })
  })

  it('recognizes a protocol-free exact display domain as our ad', () => {
    const html = AD_ONLY_HTML.replace('case.sampleone.attorney', 'sampleone.attorney')
    expect(parsePowerlinkRank(html, 'sampleone.attorney'))
      .toEqual({ status: 'found', rank: 2, visibleAds: 3 })
  })

  it('distinguishes outside and no-ad responses', () => {
    expect(parsePowerlinkRank(HTML, 'absent.example')).toEqual({ status: 'outside', rank: null, visibleAds: 3 })
    expect(parsePowerlinkRank('<html><title>검색</title></html>', 'sampleone.attorney'))
      .toEqual({ status: 'no_ads', rank: null, visibleAds: 0 })
  })

  it('parses the mobile ad-only list without counting nested sublinks', () => {
    expect(parsePowerlinkRank(AD_ONLY_HTML, 'sampleone.attorney'))
      .toEqual({ status: 'found', rank: 2, visibleAds: 3 })
  })

  it('captures bounded legal competitor metadata without retaining HTML', () => {
    expect(parsePowerlinkObservation(AD_ONLY_HTML, 'sampleone.attorney')).toMatchObject({
      status: 'found', rank: 2, visibleAds: 3,
      legalCompetitorPresent: true,
      legalCompetitorCount: 1,
      legalCompetitors: [{
        position: 1,
        advertiser: '법무법인 경쟁',
        displayUrl: 'competitor.example',
        title: '사기 변호사',
      }],
    })
  })

  it('requests the selected device search result and returns an observation', async () => {
    const fetcher = vi.fn(async () => new Response(AD_ONLY_HTML, { status: 200 }))
    const observer = new NaverSerpRankObserver('sampleone.attorney', {
      minIntervalMs: 1,
      requestsPerMinute: 60_000,
      warmupRequestsPerMinute: 60_000,
      fetcher: fetcher as typeof fetch,
    })
    const result = await observer.observe('1300억금융', 'mobile')
    expect(result).toMatchObject({ keyword: '1300억금융', device: 'mobile', status: 'found', rank: 2 })
    const requested = String(fetcher.mock.calls.at(0)?.at(0))
    expect(requested).toContain('m.ad.search.naver.com/search.naver')
    expect(requested).toContain('where=m_expd')
    expect(requested).toContain('gender=all')
    expect(requested).toContain('age=999')
  })

  it('bounds concurrent requests even when callers submit a burst', async () => {
    let active = 0
    let maximum = 0
    const fetcher = vi.fn(async () => {
      active++
      maximum = Math.max(maximum, active)
      await new Promise((resolve) => setTimeout(resolve, 10))
      active--
      return new Response(AD_ONLY_HTML, { status: 200 })
    })
    const observer = new NaverSerpRankObserver('sampleone.attorney', {
      minIntervalMs: 1,
      requestsPerMinute: 60_000,
      warmupRequestsPerMinute: 60_000,
      concurrency: 2,
      fetcher: fetcher as typeof fetch,
      maxRetries: 0,
    })

    await Promise.all(Array.from({ length: 6 }, (_, index) => observer.observe(`키워드${index}`, 'mobile')))
    expect(maximum).toBe(2)
  })
})
