import { describe, it, expect } from 'vitest'
import { buildCreative, TITLE_MAX, DESC_MAX } from '@/lib/engine/ad-copy'
import { findBannedTerms } from '@/lib/compliance/lexicon'
import { DEFAULT_FIRM } from '@/lib/engine/firms'

describe('광고 소재 생성', () => {
  it('기본형: 자수 제한·금지어 0·랜딩 URL', () => {
    const { creative, issues } = buildCreative(DEFAULT_FIRM, { name: '테스트업체', slug: 'test-upche' })
    expect(issues).toEqual([])
    expect(creative.title.length).toBeLessThanOrEqual(TITLE_MAX)
    expect(creative.description.length).toBeLessThanOrEqual(DESC_MAX)
    expect(creative.title).toContain('테스트업체')
    expect(findBannedTerms(`${creative.title} ${creative.description}`)).toEqual([])
    expect(creative.landingUrl).toBe(
      'https://sampletwo-law.example.com/f/test-upche?utm_source=naver&utm_medium=cpc')
  })

  it('업체명이 길면 일반형 제목 폴백', () => {
    const { creative, issues } = buildCreative(DEFAULT_FIRM,
      { name: '아주아주아주아주긴업체명입니다', slug: 'long' })
    expect(issues).toEqual([])
    expect(creative.title.length).toBeLessThanOrEqual(TITLE_MAX)
  })

  it('업체명에 금지어가 섞이면 issues 보고 (등록 차단 신호)', () => {
    // lexicon.ts의 실제 금지어 '보장'을 포함한 업체명
    const { issues } = buildCreative(DEFAULT_FIRM, { name: '전액회수보장', slug: 'x' })
    expect(issues.length).toBeGreaterThan(0)
  })

  it('단정 표현 자체 차단', () => {
    const { issues } = buildCreative(DEFAULT_FIRM, { name: '이곳은 사기입니다', slug: 'y' })
    expect(issues.length).toBeGreaterThan(0)
  })

  // F5 — 제목이 일반형으로 폴백하면 업체명이 소재 텍스트에서 사라진다. 그 업체명은 키워드·랜딩에
  // 그대로 쓰이므로, 폴백 시에도 원문 업체명을 린트해 issues에 남겨야 등록이 차단된다.
  it('제목 폴백 시에도 원문 업체명을 린트해 issues 보존', () => {
    const { creative, issues } = buildCreative(DEFAULT_FIRM,
      { name: '전액회수보장아주아주긴업체명', slug: 'long-bad' })
    expect(creative.title).not.toContain('보장') // 폴백된 일반형 제목
    expect(issues).toContain('banned:name:보장')
  })

  it('폴백 + 단정 표현 업체명도 issues 보존', () => {
    const { issues } = buildCreative(DEFAULT_FIRM,
      { name: '여기는 사기 업체입니다 아주아주긴이름', slug: 'long-assert' })
    expect(issues).toContain('assertion:name:단정 표현')
  })

  // F4 — domain 폴백 제거: 도메인 없는 firm의 광고가 샘플투 랜딩으로 새지 않게 소재 생성 자체를 거부
  it('firm.domain이 null이면 소재 생성 거부 (샘플투 도메인 폴백 없음)', () => {
    expect(() => buildCreative({ ...DEFAULT_FIRM, id: 2, slug: 'nodomain', domain: null },
      { name: '테스트업체', slug: 'test-upche' })).toThrow(/REFUSED.*domain/)
  })
})
