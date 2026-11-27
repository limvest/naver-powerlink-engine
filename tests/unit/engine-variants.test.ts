import { describe, it, expect } from 'vitest'
import { generateVariants, NAVER_KEYWORD_MAX } from '@/lib/engine/variants'

describe('키워드 변형 생성', () => {
  it('base + 접미 6종, 공백 제거', () => {
    const v = generateVariants({ name: '테스트 플랫폼', aliases: null })
    const texts = v.map((x) => x.text)
    expect(texts).toContain('테스트플랫폼')
    expect(texts).toContain('테스트플랫폼사기')
    expect(texts).toContain('테스트플랫폼환불')
    expect(v.find((x) => x.text === '테스트플랫폼')!.rule).toBe('base')
    expect(v.find((x) => x.text === '테스트플랫폼사기')!.rule).toBe('suffix:사기')
    expect(texts).toHaveLength(7) // base 1 + 접미 6
  })

  it('alias 확장 + 중복 제거 + 길이 상한', () => {
    const v = generateVariants({ name: 'ABC', aliases: ['abc', 'A'.repeat(30)] })
    const texts = v.map((x) => x.text)
    expect(texts.filter((t) => t === 'abc')).toHaveLength(1) // name 소문자화와 alias 중복 1회만
    expect(texts.every((t) => t.length <= NAVER_KEYWORD_MAX)).toBe(true)
  })

  it('2자 미만 base 제외', () => {
    expect(generateVariants({ name: 'A', aliases: null })).toEqual([])
  })
})
