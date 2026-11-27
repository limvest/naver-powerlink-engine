import { and, asc, eq } from 'drizzle-orm'
import type { Db } from '@/lib/db/client'
import { firmKeywords, keywords } from '@/lib/db/schema'
import { findBannedTerms } from '@/lib/compliance/lexicon'
import type { Firm } from './firms'
import { generateVariants } from './variants'
import { buildCreative, type Creative } from './ad-copy'
import { notOperatorExcluded } from './ad-keyword-exclusions'

export type PlanVariant = { text: string; rule: string }
export type DroppedVariant = { text: string; reason: string }

export type PlanItem = {
  keywordId: string; slug: string; name: string; adgroupName: string
  // rule(base|alias|suffix:…)을 실행기까지 들고 간다 — keyword_variants.rule에 그대로 기록되어
  // "어떤 규칙이 만든 변형인가"를 사후 분석·롤백할 수 있다 (최종 리뷰 F7).
  variants: PlanVariant[]
  droppedVariants: DroppedVariant[]
  creative: Creative | null; skipped?: string
}
export type RegistrationPlan = {
  firmId: number; generatedAt: string; items: PlanItem[]; skippedCount: number
  // 네이버 광고 통합 §B — 고객이 adDesired=false(내리기)로 명시한 사건명은 등록 후보에서 원천
  // 제외한다. 자격증명·채널 부재는 firm 수준에서 다루므로(plan 소비자 책임) 여기서는 카운트만.
  excludedByDesire: number
}

export async function buildRegistrationPlan(
  db: Db, firm: Firm,
  opts: { limit?: number; blockedSlugs?: Set<string>; now?: Date } = {},
): Promise<RegistrationPlan> {
  // domain 없는 firm은 계획 자체를 만들지 않는다 (최종 리뷰 F4) — 소재 랜딩 URL이 샘플투 도메인으로
  // 폴백해 firm N의 광고비가 샘플투 랜딩으로 새는 경로를 원천 차단한다. CLI가 먼저 걸러주지만
  // 라이브러리 단에서도 방어한다(다른 호출부가 생겨도 동일 계약).
  if (!firm.domain) {
    throw new Error(`REFUSED: firm ${firm.id}(${firm.slug}) domain 미설정 — 등록 계획 생성 거부`)
  }

  const limit = opts.limit ?? 20
  const blocked = opts.blockedSlugs ?? new Set()
  const baseWhere = and(eq(firmKeywords.firmId, firm.id), eq(firmKeywords.status, 'subscribed'),
                         eq(keywords.status, 'published'), notOperatorExcluded(firm.id))

  const rows = await db.select({ fk: firmKeywords, kw: keywords })
    .from(firmKeywords)
    .innerJoin(keywords, eq(firmKeywords.keywordId, keywords.id))
    .where(and(baseWhere, eq(firmKeywords.adDesired, true)))
    .orderBy(asc(firmKeywords.createdAt))

  // adDesired=false로 명시적으로 내려진 사건명 개수 — 대시보드/CLI가 "왜 등록 후보가 줄었는지"
  // 보여줄 수 있도록 별도 카운트만 셈(항목 자체는 만들지 않는다).
  const excludedRows = await db.select({ id: firmKeywords.id })
    .from(firmKeywords)
    .innerJoin(keywords, eq(firmKeywords.keywordId, keywords.id))
    .where(and(baseWhere, eq(firmKeywords.adDesired, false)))
  const excludedByDesire = excludedRows.length

  const items: PlanItem[] = []
  for (const { kw } of rows) {
    if (items.length >= limit) break
    if (blocked.has(kw.slug)) continue

    // 변형 린터 게이트 (최종 리뷰 F5): 변형 텍스트도 그대로 네이버에 등록되는 광고 문구다.
    // 접미사 규칙만으로도 금칙어가 생성될 수 있어서(예: VARIANT_SUFFIXES의 '환불'은 lexicon 금칙어)
    // 소재만 검사하던 기존 게이트로는 새어나갔다. 걸린 변형은 제외하고 droppedVariants에 근거를 남긴다.
    const variants: PlanVariant[] = []
    const droppedVariants: DroppedVariant[] = []
    for (const v of generateVariants({ name: kw.name, aliases: kw.aliases })) {
      const banned = findBannedTerms(v.text)
      if (banned.length) droppedVariants.push({ text: v.text, reason: `banned:${banned.join(',')}` })
      else variants.push(v)
    }

    const { creative, issues } = buildCreative(firm, { name: kw.name, slug: kw.slug })

    const skipReasons: string[] = []
    if (issues.length) skipReasons.push(`lint:${issues.join(',')}`)
    // 전 변형이 탈락하면 등록할 키워드가 없다 — 소재가 멀쩡해도 항목 자체를 건너뛴다.
    if (variants.length === 0) skipReasons.push('variants:all-dropped')

    items.push({
      keywordId: kw.id, slug: kw.slug, name: kw.name, adgroupName: `f_${kw.slug}`,
      variants,
      droppedVariants,
      creative: skipReasons.length ? null : creative,
      ...(skipReasons.length && { skipped: skipReasons.join(';') }),
    })
  }
  return {
    firmId: firm.id,
    generatedAt: (opts.now ?? new Date()).toISOString(),
    items,
    skippedCount: items.filter((i) => i.skipped).length,
    excludedByDesire,
  }
}
