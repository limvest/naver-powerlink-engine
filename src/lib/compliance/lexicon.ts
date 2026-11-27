// 근거: 스펙 §5.3·§14 — 변협 광고규정(2025-02-06) §4-1·3·10·11·12, §6, §7, §9②, §10①
const KOREAN_TERMS = [
  '보장', '무조건', '확실', '전액 환수', '승소율', '석방률', '성공률',
  '최고', '유일', '1위', '최다',
  '무료', '후불', '환불', '할인', '쿠폰', '최저', '원가', '견적', '입찰', '수익금',
  '전관', '인공지능', '챗봇',
] as const

const WORD_BOUNDARY_TERMS = ['AI', '100%'] as const

export function findBannedTerms(text: string): string[] {
  const found: string[] = []
  for (const term of KOREAN_TERMS) {
    if (text.includes(term)) found.push(term)
  }
  for (const term of WORD_BOUNDARY_TERMS) {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    if (new RegExp(`(?<![A-Za-z0-9])${escaped}(?![A-Za-z0-9])`).test(text)) found.push(term)
  }
  return found
}
