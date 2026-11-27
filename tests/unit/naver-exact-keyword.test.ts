import { describe, expect, it } from 'vitest'
import {
  assertSampleoneCaseLandingUrl,
  decideExactSearchKeyword,
  exactKeywordDedupeKey,
  exactKeywordLandingUrl,
  exactKeywordShard,
} from '@/lib/engine/naver/exact-keyword'

describe('Naver exact case keyword filter', () => {
  it('keeps plausible collected business names and removes provider-invalid spacing', () => {
    expect(decideExactSearchKeyword('가상리딩방B')).toEqual({ accepted: true, keyword: '가상리딩방B', trimmed: false })
    expect(decideExactSearchKeyword('Mock Nexus')).toEqual({ accepted: true, keyword: 'MockNexus', trimmed: true })
    expect(decideExactSearchKeyword('가상브릿지 3')).toEqual({ accepted: true, keyword: '가상브릿지3', trimmed: true })
  })

  it('removes incident/SEO suffixes but retains the brand prefix', () => {
    expect(decideExactSearchKeyword('가상마켓A 출금 지연 가상마켓A 피해 확인이 필요한 이유'))
      .toEqual({ accepted: true, keyword: '가상마켓A', trimmed: true })
    expect(decideExactSearchKeyword('MOCKTOKEN 사기'))
      .toEqual({ accepted: true, keyword: 'MOCKTOKEN', trimmed: true })
  })

  it('rejects obvious random/domain debris and non-brand generic values', () => {
    expect(decideExactSearchKeyword('x7qkzvwpjrtmgbhdf')).toMatchObject({ accepted: false, reason: 'random_ascii' })
    expect(decideExactSearchKeyword('app zqxwvkjhgfdpb cc')).toMatchObject({ accepted: false, reason: 'domain_debris' })
    expect(decideExactSearchKeyword('www.example.com코인')).toMatchObject({ accepted: false, reason: 'url_fragment' })
    expect(decideExactSearchKeyword('공모주')).toMatchObject({ accepted: false, reason: 'generic' })
  })

  it('deduplicates spelling/spacing variants and assigns a stable shard', () => {
    expect(exactKeywordDedupeKey('Mock Nexus')).toBe(exactKeywordDedupeKey('mock-nexus'))
    expect(exactKeywordShard('fixed-id')).toBe(exactKeywordShard('fixed-id'))
    expect(exactKeywordShard('fixed-id')).toBeGreaterThanOrEqual(0)
    expect(exactKeywordShard('fixed-id')).toBeLessThan(64)
  })

  it('builds the keyword-specific subdomain landing URL', () => {
    const url = new URL(exactKeywordLandingUrl('sampleone.attorney', 'case-abc', '가상마켓A'))
    expect(url.origin).toBe('https://case-abc.sampleone.attorney')
    expect(url.pathname).toBe('/')
    expect(url.searchParams.get('utm_source')).toBe('naver')
    expect(url.searchParams.get('utm_campaign')).toBe('sampleone_case_search')
    expect(url.searchParams.get('utm_term')).toBe('가상마켓A')
    expect(() => assertSampleoneCaseLandingUrl(url.toString(), '가상마켓A')).not.toThrow()
  })

  it('rejects apex and shared-case destinations from the default registration contract', () => {
    const query = '?utm_source=naver&utm_medium=cpc&utm_campaign=sampleone_case_search&utm_term=가상마켓A'
    expect(() => assertSampleoneCaseLandingUrl(`https://sampleone.attorney/${query}`, '가상마켓A')).toThrow()
    expect(() => assertSampleoneCaseLandingUrl(`https://금융사기.sampleone.attorney/c/abc${query}`, '가상마켓A')).toThrow()
  })
})
