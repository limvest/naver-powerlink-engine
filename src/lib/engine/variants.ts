// src/lib/engine/variants.ts — 검색광고 등록용 키워드 변형 (텍스트는 firm 무관 중앙 공유)
export const VARIANT_SUFFIXES = ['사기', '피해', '환불', '출금', '고소', '후기'] as const
export const NAVER_KEYWORD_MAX = 25 // VERIFY: 네이버 키워드 최대 자수 — live 전 공식 문서 확인

export type VariantInput = { name: string; aliases: string[] | null }
export type Variant = { text: string; rule: string }

function normalize(s: string): string {
  return s.replace(/\s+/g, '').toLowerCase()
}

export function generateVariants(kw: VariantInput): Variant[] {
  const out = new Map<string, Variant>()
  const bases: { text: string; rule: string }[] = []
  const name = normalize(kw.name)
  if (name.length >= 2) bases.push({ text: name, rule: 'base' })
  for (const a of kw.aliases ?? []) {
    const t = normalize(a)
    if (t.length >= 2 && t !== name) bases.push({ text: t, rule: 'alias' })
  }
  for (const b of bases) {
    if (b.text.length <= NAVER_KEYWORD_MAX && !out.has(b.text)) out.set(b.text, b)
    for (const suf of VARIANT_SUFFIXES) {
      const t = `${b.text}${suf}`
      if (t.length <= NAVER_KEYWORD_MAX && !out.has(t)) out.set(t, { text: t, rule: `suffix:${suf}` })
    }
  }
  return [...out.values()]
}
