import { describe, it, expect } from 'vitest'
import { findBannedTerms } from '@/lib/compliance/lexicon'

describe('findBannedTerms', () => {
  it('금지어를 검출한다 (규정 §4-10·11, §9②, §7, §6)', () => {
    expect(findBannedTerms('무료 상담 진행')).toContain('무료')
    expect(findBannedTerms('착수금 후불제')).toContain('후불')
    expect(findBannedTerms('전액 환수 보장')).toEqual(expect.arrayContaining(['전액 환수', '보장']))
    expect(findBannedTerms('업계 1위, 승소율 98%')).toEqual(expect.arrayContaining(['1위', '승소율']))
    expect(findBannedTerms('전관 출신 변호사')).toContain('전관')
    expect(findBannedTerms('AI 기반 분석')).toContain('AI')
    expect(findBannedTerms('인공지능 모니터링')).toContain('인공지능')
  })
  it('안전한 카피는 통과한다', () => {
    expect(findBannedTerms('사기피해 사건 전담 대응, 상담 문의를 남겨주세요')).toEqual([])
    expect(findBannedTerms('개인회생 주요취급, 절차를 안내합니다')).toEqual([])
  })
  it('영문 금지어는 단어 경계로만 매칭한다 (MAIN 오탐 방지)', () => {
    expect(findBannedTerms('MAINTAIN')).toEqual([])
    expect(findBannedTerms('AI로 분석')).toContain('AI')
  })
})
