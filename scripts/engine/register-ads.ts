/**
 * 등록 계획 실행 CLI — dry-run 기본, live는 3중 가드.
 *
 * - DATABASE_URL 없으면 스킵 메시지만 출력하고 성공 종료 (sync-db.ts 관행)
 * - dry-run(기본): 계획 JSON을 data/engine/plans/{YYYY-MM-DD}-firm{N}.json 에 쓰고 요약 출력. DB 무변경.
 * - live: --live 플래그 AND env ENGINE_LIVE=1 AND firm_credentials 존재 — 3중 가드 중 하나라도
 *   없으면 명시적 거부 메시지 후 종료. 실 네이버 API 호출은 이 가드를 전부 통과했을 때만 발생한다.
 *
 * 실행: DATABASE_URL=… ./node_modules/.bin/tsx scripts/engine/register-ads.ts --firm 1 [--limit 20] [--live]
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

type Args = { firm: number; limit?: number; live: boolean }

function parseArgs(argv: string[]): Args {
  const out: Args = { firm: 1, live: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--firm') out.firm = Number(argv[++i])
    else if (a === '--limit') out.limit = Number(argv[++i])
    else if (a === '--live') out.live = true
  }
  return out
}

/** data/blocklist.json(slug 문자열 배열) — 파일이 없으면 빈 배열. DB blocked와 합집합으로 쓰인다. */
function readBlocklistFile(): string[] {
  const p = join(ROOT, 'data/blocklist.json')
  if (!existsSync(p)) return []
  return JSON.parse(readFileSync(p, 'utf-8')) as string[]
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.log('SKIP: DATABASE_URL not set')
    return
  }

  const args = parseArgs(process.argv.slice(2))
  if (!Number.isFinite(args.firm)) {
    console.error(`REFUSED: invalid --firm value`)
    process.exitCode = 1
    return
  }
  // --limit이 NaN(예: 값 누락·숫자 아님)이면 registration-plan의 `items.length >= limit` 비교가
  // 항상 false가 되어 상한이 무력화된다(무제한 등록 위험) — 여기서 명시적으로 막는다.
  if (args.limit !== undefined && !Number.isFinite(args.limit)) {
    console.error(`REFUSED: invalid --limit value`)
    process.exitCode = 1
    return
  }

  const { getDb } = await import('@/lib/db/client')
  const { firms, firmCredentials } = await import('@/lib/db/schema')
  const { eq, and } = await import('drizzle-orm')
  const { DEFAULT_FIRM } = await import('@/lib/engine/firms')
  const { buildRegistrationPlan } = await import('@/lib/engine/registration-plan')

  const db = getDb()

  const [firmRow] = await db.select().from(firms).where(eq(firms.id, args.firm))
  const firm = firmRow ?? (args.firm === 1 ? DEFAULT_FIRM : null)
  if (!firm) {
    console.error(`REFUSED: firm ${args.firm} not found`)
    process.exitCode = 1
    return
  }
  // domain 없는 firm은 계획 생성 자체를 거부한다 — 소재 랜딩 URL이 샘플투 도메인으로 폴백해
  // firm N의 광고 트래픽이 샘플투 랜딩으로 새는 것을 막는다(최종 리뷰 F4, ad-copy 폴백 제거와 한 쌍).
  if (!firm.domain) {
    console.error(`REFUSED: firm ${firm.id} domain 미설정 — onboard-firm으로 domain 먼저 등록`)
    process.exitCode = 1
    return
  }

  // 차단 slug = data/blocklist.json(파일) ∪ keywords.status='blocked'(중앙 DB 상태) — 최종 리뷰 F6
  const { loadBlockedSlugs } = await import('@/lib/engine/blocklist')
  const blockedSlugs = await loadBlockedSlugs(db, readBlocklistFile())

  const plan = await buildRegistrationPlan(db, firm, { limit: args.limit, blockedSlugs })
  const variantTotal = plan.items.reduce((sum, i) => sum + i.variants.length, 0)
  const droppedTotal = plan.items.reduce((sum, i) => sum + i.droppedVariants.length, 0)

  const { dailyBudgetGuardPassed } = await import('@/lib/engine/register-run')
  // 무제한 지출 방지 가드(최종 리뷰 I3) — dry는 경고만 표시(무변경 실행이라 막을 이유가 없다),
  // live는 아래에서 하드 REFUSED.
  const budgetOk = dailyBudgetGuardPassed(firm.adConfig?.dailyBudget, process.env.ALLOW_UNLIMITED_BUDGET)

  if (!args.live) {
    const day = plan.generatedAt.slice(0, 10)
    const dir = join(ROOT, 'data/engine/plans')
    mkdirSync(dir, { recursive: true })
    const outPath = join(dir, `${day}-firm${firm.id}.json`)
    writeFileSync(outPath, JSON.stringify(plan, null, 2))
    console.log(
      `dry-run: 업체 ${plan.items.length}·변형 ${variantTotal}·변형탈락 ${droppedTotal}`
      + `·skipped ${plan.skippedCount} → ${outPath}`
      + (budgetOk ? '' : ' [경고: 일예산 미설정 — live 실행 시 REFUSED됩니다]'),
    )
    return
  }

  // live 4중 가드: ① --live(이 분기 진입 자체로 충족) ② ENGINE_LIVE=1 ③ firm_credentials 존재
  // ④ adConfig.dailyBudget 설정(최종 리뷰 I3 — 무제한 지출 방지, ALLOW_UNLIMITED_BUDGET=1로 우회)
  if (process.env.ENGINE_LIVE !== '1') {
    console.error('REFUSED: --live requires env ENGINE_LIVE=1')
    process.exitCode = 1
    return
  }
  const [credRow] = await db.select().from(firmCredentials)
    .where(and(eq(firmCredentials.firmId, firm.id), eq(firmCredentials.provider, 'naver_searchad')))
  if (!credRow) {
    console.error(`REFUSED: no firm_credentials for firm ${firm.id} — onboard-firm 먼저 실행`)
    process.exitCode = 1
    return
  }
  if (!budgetOk) {
    console.error(
      'REFUSED: 일예산 미설정 firm — adConfig.dailyBudget 설정 후 재실행 '
      + '(무제한 지출 방지 가드. 의도적 무제한은 ALLOW_UNLIMITED_BUDGET=1)',
    )
    process.exitCode = 1
    return
  }

  const { decryptCred } = await import('@/lib/engine/cred-crypto')
  const { NaverSearchAdClient } = await import('@/lib/engine/naver/client')
  const { executeRegistration } = await import('@/lib/engine/register-run')

  const client = new NaverSearchAdClient({
    customerId: credRow.customerId,
    apiKey: decryptCred(credRow.apiKeyEnc),
    secret: decryptCred(credRow.secretEnc),
  })

  const result = await executeRegistration(db, client, firm, plan)
  console.log(
    `live: registered ${result.registered}, failed ${result.failed} `
    + `(skipped ${plan.skippedCount}, 변형탈락 ${droppedTotal})`,
  )
}

main().catch((e) => {
  console.error('register-ads failed:', e)
  process.exitCode = 1
})
