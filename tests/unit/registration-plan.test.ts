import { describe, it, expect } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { createTestDb } from '../helpers/test-db'
import { firms, keywords, firmKeywords } from '@/lib/db/schema'
import { findBannedTerms } from '@/lib/compliance/lexicon'
import { DEFAULT_FIRM } from '@/lib/engine/firms'
import { buildRegistrationPlan } from '@/lib/engine/registration-plan'
import { loadBlockedSlugs } from '@/lib/engine/blocklist'

async function seed(db: Awaited<ReturnType<typeof createTestDb>>) {
  await db.insert(firms).values({ id: 1, slug: 'sampletwo', name: DEFAULT_FIRM.name,
    adLawyerName: DEFAULT_FIRM.adLawyerName, phone: DEFAULT_FIRM.phone, phoneIntl: DEFAULT_FIRM.phoneIntl,
    address: DEFAULT_FIRM.address, addressRegion: DEFAULT_FIRM.addressRegion,
    addressLocality: DEFAULT_FIRM.addressLocality, domain: DEFAULT_FIRM.domain })
  const rows = await db.insert(keywords).values([
    { name: '업체가', slug: 'kw-a', scamType: 'coin', status: 'published' },
    { name: '업체나', slug: 'kw-b', scamType: 'coin', status: 'published' },
    { name: '업체다', slug: 'kw-c', scamType: 'coin', status: 'discovered' }, // 미공개 → 제외
    { name: '업체라', slug: 'kw-d', scamType: 'coin', status: 'published' },  // blocklist → 제외
  ]).returning()
  await db.insert(firmKeywords).values(rows.map((r) => ({ firmId: 1, keywordId: r.id, adDesired: true })))
  return rows
}

describe('등록 계획 빌더', () => {
  it('published·구독·비차단만 선별, 변형·소재 포함', async () => {
    const db = await createTestDb()
    await seed(db)
    const plan = await buildRegistrationPlan(db, DEFAULT_FIRM, { blockedSlugs: new Set(['kw-d']) })
    const slugs = plan.items.map((i) => i.slug)
    expect(slugs).toEqual(['kw-a', 'kw-b'])
    const a = plan.items[0]
    expect(a.adgroupName).toBe('f_kw-a')
    expect(a.variants.map((v) => v.text)).toContain('업체가사기')
    // rule 보존 (F7) — 실행기가 keyword_variants.rule로 그대로 기록한다
    expect(a.variants.find((v) => v.text === '업체가')?.rule).toBe('base')
    expect(a.variants.find((v) => v.text === '업체가사기')?.rule).toBe('suffix:사기')
    expect(a.creative!.landingUrl).toContain('/f/kw-a?')
  })

  // F5 — 변형 텍스트도 그대로 등록되는 광고 문구다. 접미사 '환불'은 lexicon 금칙어라
  // 소재만 검사하던 기존 게이트로는 새어나갔다.
  it('금칙어 변형은 제외 + droppedVariants에 근거 기록', async () => {
    const db = await createTestDb()
    await seed(db)
    const plan = await buildRegistrationPlan(db, DEFAULT_FIRM, { blockedSlugs: new Set(['kw-d']) })
    const a = plan.items[0]
    expect(a.variants.map((v) => v.text)).not.toContain('업체가환불')
    expect(a.droppedVariants).toContainEqual({ text: '업체가환불', reason: 'banned:환불' })
    for (const v of a.variants) expect(findBannedTerms(v.text)).toEqual([])
    expect(a.skipped).toBeUndefined() // 일부 탈락은 항목 skip 사유가 아니다
  })

  it('전 변형 탈락 시 항목 skipped (variants:all-dropped)', async () => {
    const db = await createTestDb()
    await db.insert(firms).values({ id: 1, slug: 'sampletwo', name: DEFAULT_FIRM.name,
      adLawyerName: 'x', phone: 'x', phoneIntl: 'x', address: 'x', addressRegion: 'x', addressLocality: 'x' })
    // 업체명 자체가 금칙어를 포함 → base·alias·suffix 모든 변형이 금칙어를 물고 나온다
    const [kw] = await db.insert(keywords).values(
      { name: '무조건환수', slug: 'kw-all-bad', scamType: 'coin', status: 'published' }).returning()
    await db.insert(firmKeywords).values({ firmId: 1, keywordId: kw.id, adDesired: true })

    const plan = await buildRegistrationPlan(db, DEFAULT_FIRM)
    expect(plan.items[0].variants).toHaveLength(0)
    expect(plan.items[0].skipped).toContain('variants:all-dropped')
    expect(plan.items[0].creative).toBeNull()
    expect(plan.skippedCount).toBe(1)
  })

  // F6 — CLI가 파일만 읽으면 DB에서 blocked로 내려간 키워드가 blockedSlugs 경로에 안 잡힌다
  it('blocklist 합집합: 파일 slug ∪ keywords.status=blocked', async () => {
    const db = await createTestDb()
    await db.insert(keywords).values([
      { name: '차단가', slug: 'blk-db', scamType: 'coin', status: 'blocked' },
      { name: '정상가', slug: 'ok-1', scamType: 'coin', status: 'published' },
    ])
    const set = await loadBlockedSlugs(db, ['blk-file'])
    expect([...set].sort()).toEqual(['blk-db', 'blk-file'])
    expect(set.has('ok-1')).toBe(false)
    // 파일 인자 없이도 DB blocked는 잡힌다
    expect([...await loadBlockedSlugs(db)]).toEqual(['blk-db'])
  })

  // F4 — domain 폴백이 있으면 firm N의 광고 트래픽이 샘플투 랜딩으로 샌다
  it('firm.domain이 null이면 계획 생성 거부', async () => {
    const db = await createTestDb()
    await seed(db)
    await expect(buildRegistrationPlan(db, { ...DEFAULT_FIRM, id: 2, slug: 'nodomain', domain: null }))
      .rejects.toThrow(/REFUSED.*domain/)
  })

  it('limit 적용', async () => {
    const db = await createTestDb()
    await seed(db)
    const plan = await buildRegistrationPlan(db, DEFAULT_FIRM, { limit: 1 })
    expect(plan.items).toHaveLength(1)
  })

  // 네이버 광고 통합 §B — adDesired=false(고객의 '내리기' 의사표시)는 등록 후보에서 원천 제외되고
  // excludedByDesire로만 카운트된다(플랜 소비자가 "왜 후보가 줄었는지" 보여줄 수 있게).
  it('adDesired=false 항목 제외 + excludedByDesire 카운트', async () => {
    const db = await createTestDb()
    const rows = await seed(db)
    const kwB = rows.find((r) => r.slug === 'kw-b')!
    await db.update(firmKeywords)
      .set({ adDesired: false })
      .where(and(eq(firmKeywords.firmId, 1), eq(firmKeywords.keywordId, kwB.id)))

    const plan = await buildRegistrationPlan(db, DEFAULT_FIRM, { blockedSlugs: new Set(['kw-d']) })
    expect(plan.items.map((i) => i.slug)).toEqual(['kw-a'])
    expect(plan.excludedByDesire).toBe(1)
  })

  it('excludedByDesire=0 (전부 올리기 의사표시)', async () => {
    const db = await createTestDb()
    await seed(db)
    const plan = await buildRegistrationPlan(db, DEFAULT_FIRM, { blockedSlugs: new Set(['kw-d']) })
    expect(plan.excludedByDesire).toBe(0)
  })

  it('린트 불통과 소재는 skipped (dry-run은 DB 무변경)', async () => {
    const db = await createTestDb()
    // 금지어 포함 업체명 (lexicon.ts 실단어로 교체할 것)
    const [kw] = await db.insert(keywords).values(
      { name: '전액회수보장', slug: 'kw-bad', scamType: 'coin', status: 'published' }).returning()
    await db.insert(firms).values({ id: 1, slug: 'sampletwo', name: DEFAULT_FIRM.name,
      adLawyerName: 'x', phone: 'x', phoneIntl: 'x', address: 'x', addressRegion: 'x', addressLocality: 'x' })
    await db.insert(firmKeywords).values({ firmId: 1, keywordId: kw.id, adDesired: true })
    const plan = await buildRegistrationPlan(db, DEFAULT_FIRM)
    expect(plan.items[0].skipped).toMatch(/^lint:/)
    expect(plan.items[0].creative).toBeNull()
    expect(plan.skippedCount).toBe(1)
    const fk = await db.select().from(firmKeywords)
    expect(fk[0].status).toBe('subscribed') // 상태 무변경
  })
})
