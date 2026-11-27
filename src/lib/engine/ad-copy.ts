// 파워링크 소재 생성. 관측 언어만, 성과 단정·수치 창작 금지.
import { findBannedTerms } from '@/lib/compliance/lexicon'
import type { Firm } from './firms'

export const TITLE_MAX = 15 // VERIFY: 파워링크 제목 자수 — live 전 공식 문서 확인
export const DESC_MAX = 45  // VERIFY: 파워링크 설명 자수

export type Creative = { title: string; description: string; landingUrl: string }

const GENERIC_TITLE = '사기피해 골든타임 상담'
const ASSERTION = /[은는]\s*사기/

export function buildCreative(firm: Firm, kw: { name: string; slug: string }): { creative: Creative; issues: string[] } {
  // domain 필수 (최종 리뷰 F4). 예전 `?? 'sampletwo-law.example.com'` 폴백은 firm N의 광고가 샘플투 랜딩으로
  // 트래픽을 흘려보내는 사고 경로였다 — 도메인 없는 firm은 소재 자체를 만들 수 없어야 한다.
  if (!firm.domain) {
    throw new Error(`REFUSED: firm ${firm.id}(${firm.slug}) domain 미설정 — 랜딩 URL 생성 불가`)
  }
  const named = `${kw.name} 피해 상담`
  const fellBack = named.length > TITLE_MAX
  const title = fellBack ? GENERIC_TITLE : named
  let description = `${firm.name} — 추가 입금 중단과 기록 확보가 먼저입니다.`
  if (description.length > DESC_MAX) description = '추가 입금 중단과 기록 확보가 먼저입니다.'
  const landingUrl = `https://${firm.domain}/f/${encodeURIComponent(kw.slug)}?utm_source=naver&utm_medium=cpc`

  const text = `${title} ${description}`
  const issues: string[] = findBannedTerms(text).map((t) => `banned:${t}`)
  if (ASSERTION.test(text)) issues.push('assertion:단정 표현')
  // 제목이 일반형으로 폴백하면 업체명이 소재 텍스트에서 사라져 린트 사각지대가 된다(최종 리뷰 F5):
  // 금칙어가 든 긴 업체명이 issues 0으로 통과해 키워드·랜딩에는 그대로 쓰이는 경로가 열린다.
  // 폴백 시에는 원문 업체명을 별도로 린트해 issues에 보존한다.
  if (fellBack) {
    for (const t of findBannedTerms(kw.name)) issues.push(`banned:name:${t}`)
    if (ASSERTION.test(kw.name)) issues.push('assertion:name:단정 표현')
  }
  if (title.length > TITLE_MAX) issues.push('len:title')
  if (description.length > DESC_MAX) issues.push('len:desc')
  return { creative: { title, description, landingUrl }, issues }
}
