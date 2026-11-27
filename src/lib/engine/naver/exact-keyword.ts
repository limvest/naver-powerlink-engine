import { createHash } from 'node:crypto'

/** Naver Search Ads currently accepts at most 25 characters per keyword. */
export const NAVER_EXACT_KEYWORD_MAX = 25
export const SAMPLEONE_SEARCH_AD_SHARDS = 64
export const SAMPLEONE_CASE_LANDING_CAMPAIGN = 'sampleone_case_search'

const TRAILING_INCIDENT_LANGUAGE = /\s+(?:사기|출금|피해|먹튀|사칭|환불|위장)(?:\s|$|이|와|과|를|을|로|관련|지연|문제)/i
const SEO_BOILERPLATE = /(?:확인해야|확인이 필요|알아둘 사항|알아보기|살펴보는|진행 과정|이용 전|시작됐다면|피해 예방|사례 분석|회복을 위한|골든타임|추가 입금|송금하기 전)/i
const URL_FRAGMENT = /(?:https?:\/\/|www\.|\.(?:com|net|org|co\.kr|kr)(?:\/|$))/i
const DOMAIN_DEBRIS_A = /^(?:app|com|www)\s+[a-z0-9]{7,}\s+(?:cc|com|pro|net|org)$/i
const DOMAIN_DEBRIS_B = /^[a-z0-9]{8,}\s+\S+\s+(?:cc|com|pro|net|org)$/i

const GENERIC_ONLY = new Set([
  '사기', '피해', '출금', '투자', '리딩방', '주식', '코인', '공모주', '비상장주식', '쇼핑몰',
  '보이스피싱', '금융신고', '앱', '플랫폼', '거래소', '마켓', '프로젝트', '전문가', '매니저', '대표', '비서',
  '교수', '실장', '작업대출', '대포통장', '로맨스스캠', '노쇼', '팀미션',
])

export type ExactKeywordRejectReason =
  | 'too_short'
  | 'too_long'
  | 'url_fragment'
  | 'boilerplate'
  | 'generic'
  | 'no_word'
  | 'symbol_heavy'
  | 'repetition'
  | 'random_ascii'
  | 'domain_debris'

export type ExactKeywordDecision =
  | { accepted: true; keyword: string; trimmed: boolean }
  | { accepted: false; keyword: string; reason: ExactKeywordRejectReason }

function compactKey(value: string): string {
  return value.toLocaleLowerCase('en-US').replace(/[^0-9a-z가-힣]/g, '')
}

/** Naver stores exact-search keywords without whitespace or punctuation. */
export function naverExactKeywordText(value: string): string {
  return value.normalize('NFKC').replace(/[^0-9A-Za-z가-힣]/g, '')
}

/**
 * Convert a collected case title into the exact search term we can actually buy.
 * The filter is intentionally conservative: it only removes clear crawler/SEO debris
 * and Naver-hard-invalid values. It does not try to decide whether a plausible brand
 * is legitimate; the landing disclaimer handles name impersonation cases.
 */
export function decideExactSearchKeyword(input: string): ExactKeywordDecision {
  let keyword = input.normalize('NFKC').replace(/\s+/g, ' ').trim()
  const original = keyword
  const incidentLanguage = keyword.match(TRAILING_INCIDENT_LANGUAGE)
  if (incidentLanguage?.index !== undefined && incidentLanguage.index >= 2) {
    keyword = keyword.slice(0, incidentLanguage.index).trim()
  }

  if (URL_FRAGMENT.test(keyword)) return { accepted: false, keyword, reason: 'url_fragment' }
  if (SEO_BOILERPLATE.test(keyword)) return { accepted: false, keyword, reason: 'boilerplate' }
  if (GENERIC_ONLY.has(compactKey(keyword))) return { accepted: false, keyword, reason: 'generic' }
  if (!/[0-9A-Za-z가-힣]/.test(keyword)) return { accepted: false, keyword, reason: 'no_word' }

  const wordChars = keyword.match(/[0-9A-Za-z가-힣]/g)?.length ?? 0
  if (wordChars / keyword.length < 0.6) return { accepted: false, keyword, reason: 'symbol_heavy' }
  if (/(.)\1{4,}/u.test(keyword)) return { accepted: false, keyword, reason: 'repetition' }
  if (/^[a-z0-9]{12,}$/i.test(keyword) && !/[aeiou]/i.test(keyword)) {
    return { accepted: false, keyword, reason: 'random_ascii' }
  }
  if (DOMAIN_DEBRIS_A.test(keyword) || (DOMAIN_DEBRIS_B.test(keyword) && /\d/.test(keyword))) {
    return { accepted: false, keyword, reason: 'domain_debris' }
  }

  const naverKeyword = naverExactKeywordText(keyword)
  if (naverKeyword.length < 2) return { accepted: false, keyword: naverKeyword, reason: 'too_short' }
  if (naverKeyword.length > NAVER_EXACT_KEYWORD_MAX) return { accepted: false, keyword: naverKeyword, reason: 'too_long' }
  return { accepted: true, keyword: naverKeyword, trimmed: naverKeyword !== original }
}

export function exactKeywordDedupeKey(keyword: string): string {
  return compactKey(keyword)
}

export function exactKeywordShard(stableId: string, shardCount = SAMPLEONE_SEARCH_AD_SHARDS): number {
  if (!Number.isInteger(shardCount) || shardCount < 1) throw new Error('shardCount must be a positive integer')
  return createHash('sha256').update(stableId).digest().readUInt32BE(0) % shardCount
}

/**
 * Fail-closed contract for Sampleone Powerlink destinations.
 *
 * The case subdomain and its DB registration are the content authority.  The
 * query string is attribution only, so neither the apex host nor the shared
 * `/c/{id}` host can silently replace a case-specific destination.
 */
export function assertSampleoneCaseLandingUrl(value: string, keyword: string, domain = 'sampleone.attorney'): URL {
  const url = new URL(value)
  const suffix = `.${domain}`
  if (url.protocol !== 'https:' || !url.hostname.endsWith(suffix) || url.hostname === domain
    || url.hostname === `xn--jj0b0c185dgfg.${domain}` || url.pathname !== '/') {
    throw new Error(`invalid Sampleone case-host landing: ${url.origin}${url.pathname}`)
  }
  if (url.searchParams.get('utm_source') !== 'naver' || url.searchParams.get('utm_medium') !== 'cpc'
    || url.searchParams.get('utm_campaign') !== SAMPLEONE_CASE_LANDING_CAMPAIGN
    || url.searchParams.get('utm_term') !== keyword) {
    throw new Error(`invalid Sampleone landing attribution for keyword: ${keyword}`)
  }
  return url
}

export function exactKeywordLandingUrl(domain: string, hostLabel: string, keyword: string): string {
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(hostLabel)) {
    throw new Error(`invalid case host label: ${hostLabel}`)
  }
  const params = new URLSearchParams({
    utm_source: 'naver',
    utm_medium: 'cpc',
    utm_campaign: SAMPLEONE_CASE_LANDING_CAMPAIGN,
    utm_term: keyword,
  })
  const final = `https://${hostLabel}.${domain}/?${params.toString()}`
  assertSampleoneCaseLandingUrl(final, keyword, domain)
  return final
}
