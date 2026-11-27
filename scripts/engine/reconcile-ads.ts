/**
 * 올리기/내리기 반영 CLI — dry(기본)는 DB 읽기 전용 후보 집계만, live는 실 네이버 API(PUT userLock)
 * 를 호출해 firm_keywords.status를 전이시킨다.
 *
 * - DATABASE_URL 없으면 스킵 메시지만 출력하고 성공 종료 (register-ads.ts 관행)
 * - dry(기본, env ENGINE_LIVE 미설정): computeReconcileCandidates(lib/engine/reconcile-ads.ts —
 *   reconcileAds가 실행 시 쓰는 것과 동일한 순수 함수, 최종 리뷰 T4)로 후보 수(lower/raise/skip)만
 *   집계해 출력. API 호출·DB 쓰기 전혀 없음.
 * - live: env ENGINE_LIVE=1 AND firm_credentials 존재 — 이 중 하나라도 없으면 SKIP 메시지 후 종료
 *   (poll-reviews.ts와 동일 가드 — 이 CLI도 dry 아닌 실행은 곧바로 실 API 호출이므로).
 *
 * blockedSlugs(최종 리뷰 C1) — register-ads.ts·poll-reviews.ts와 동일하게 data/blocklist.json
 * (파일) ∪ keywords.status='blocked'(중앙 DB 상태)의 합집합을 dry·live 양쪽에 통과시킨다. 이게
 * 없으면 pauseBlockedKeywords가 내린 차단 잠금을 adDesired 기본값(true)만으로 되살리는 경로가
 * 남는다.
 *
 * --all-firms(2026-08-04 daily.sh 엔진 체인 배선) — subscribe-keywords.ts의 --all-firms와 동일하게
 * status가 active|pilot인 firm 전체를 순회한다. dry는 firm별 후보 수를 합산해 한 줄로 보여주고,
 * live는 firm마다 firm_credentials 존재 여부를 개별 확인해(없는 firm은 건너뛰고 계속) 합산한다 —
 * register-ads처럼 firm 하나가 자격증명 미비라고 전체 실행이 막히면 안 된다(부분 실패 보존 관행).
 *
 * 실행: DATABASE_URL=… ./node_modules/.bin/tsx scripts/engine/reconcile-ads.ts --firm 1
 *       DATABASE_URL=… ENGINE_LIVE=1 ./node_modules/.bin/tsx scripts/engine/reconcile-ads.ts --firm 1
 *       DATABASE_URL=… ./node_modules/.bin/tsx scripts/engine/reconcile-ads.ts --all-firms
 */
import { existsSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Db } from '@/lib/db/client'
import type { Firm } from '@/lib/engine/firms'
import type { FirmKeywordStatus } from '@/lib/engine/state'
import { computeReconcileCandidates, type ReconcileCandidates } from '@/lib/engine/reconcile-ads'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

type Args = { firm: number; allFirms?: boolean }

function parseArgs(argv: string[]): Args {
  const out: Args = { firm: 1 }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--firm') out.firm = Number(argv[++i])
    else if (argv[i] === '--all-firms') out.allFirms = true
  }
  return out
}

/** data/blocklist.json(slug 문자열 배열) — register-ads.ts·poll-reviews.ts와 동일 관행. */
function readBlocklistFile(): string[] {
  const p = join(ROOT, 'data/blocklist.json')
  if (!existsSync(p)) return []
  return JSON.parse(readFileSync(p, 'utf-8')) as string[]
}

// dry 후보 집계 — reconcileAds가 live에서 실행하는 것과 동일한 순수 함수(computeReconcileCandidates)
// 로 후보를 재현한다(읽기 전용, 쓰기·API 호출 없음). 판정 로직이 두 곳으로 갈라지면 dry가 보여준
// 후보 수와 live가 실제 처리하는 수가 어긋날 수 있다(최종 리뷰 T4). 단일 firm(--firm)·전체 firm
// (--all-firms) 양쪽이 이 한 함수를 공유해야 두 경로의 판정이 갈라지지 않는다.
async function computeCandidatesForFirm(
  db: Db, firmId: number, blockedSlugs: ReadonlySet<string>,
): Promise<ReconcileCandidates> {
  const { firmKeywords, keywords } = await import('@/lib/db/schema')
  const { eq } = await import('drizzle-orm')
  const rows = await db.select({
    keywordId: firmKeywords.keywordId,
    slug: keywords.slug,
    status: firmKeywords.status,
    adDesired: firmKeywords.adDesired,
    naverAdgroupId: firmKeywords.naverAdgroupId,
  }).from(firmKeywords)
    .innerJoin(keywords, eq(firmKeywords.keywordId, keywords.id))
    .where(eq(firmKeywords.firmId, firmId))
  // firm_keywords.status는 text 컬럼(DB 레벨 열거형 아님, state.ts가 정본) — computeReconcileCandidates
  // 시그니처와 맞추기 위해 캐스트한다(src/lib/engine/reconcile-ads.ts 코어와 동일 관행).
  return computeReconcileCandidates(
    rows.map((r) => ({ ...r, status: r.status as FirmKeywordStatus })),
    blockedSlugs,
  )
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.log('SKIP: DATABASE_URL not set')
    return
  }

  const args = parseArgs(process.argv.slice(2))

  const { getDb } = await import('@/lib/db/client')
  const { firms, firmCredentials } = await import('@/lib/db/schema')
  const { eq, and, inArray } = await import('drizzle-orm')
  const { loadBlockedSlugs } = await import('@/lib/engine/blocklist')

  const db = getDb()
  const blockedSlugs = await loadBlockedSlugs(db, readBlocklistFile())

  if (args.allFirms) {
    // subscribe-keywords.ts enrollAllFirms와 동일 대상 정의 — 서비스 이용 중(active·pilot) firm 전체.
    const targets = await db.select().from(firms).where(inArray(firms.status, ['active', 'pilot']))

    if (process.env.ENGINE_LIVE !== '1') {
      let lower = 0
      let raise = 0
      let skipped = 0
      for (const firm of targets) {
        const c = await computeCandidatesForFirm(db, firm.id, blockedSlugs)
        lower += c.lower.length
        raise += c.raise.length
        skipped += c.skipped
      }
      console.log(
        `dry(all-firms): firms ${targets.length}·lower후보 ${lower}·raise후보 ${raise}`
        + `·skip후보 ${skipped} (실행하려면 env ENGINE_LIVE=1 + firm_credentials 필요)`,
      )
      return
    }

    const { decryptCred } = await import('@/lib/engine/cred-crypto')
    const { NaverSearchAdClient } = await import('@/lib/engine/naver/client')
    const { reconcileAds } = await import('@/lib/engine/reconcile-ads')

    let lowered = 0
    let raised = 0
    let skipped = 0
    let attempted = 0
    let noCreds = 0
    for (const firm of targets) {
      const [credRow] = await db.select().from(firmCredentials)
        .where(and(eq(firmCredentials.firmId, firm.id), eq(firmCredentials.provider, 'naver_searchad')))
      if (!credRow) { noCreds++; continue } // 자격증명 미비 firm은 건너뛰고 계속(부분 실패 보존)
      attempted++
      const client = new NaverSearchAdClient({
        customerId: credRow.customerId,
        apiKey: decryptCred(credRow.apiKeyEnc),
        secret: decryptCred(credRow.secretEnc),
      })
      const result = await reconcileAds(db, client, firm as Firm, blockedSlugs)
      lowered += result.lowered
      raised += result.raised
      skipped += result.skipped
    }
    console.log(
      `live(all-firms): firms ${targets.length}(시도 ${attempted}·자격증명없음 ${noCreds})`
      + ` · lowered ${lowered}, raised ${raised}, skipped ${skipped}`,
    )
    return
  }

  if (!Number.isFinite(args.firm)) {
    console.error('REFUSED: invalid --firm value')
    process.exitCode = 1
    return
  }

  const { DEFAULT_FIRM } = await import('@/lib/engine/firms')

  const [firmRow] = await db.select().from(firms).where(eq(firms.id, args.firm))
  const firm = firmRow ?? (args.firm === 1 ? DEFAULT_FIRM : null)
  if (!firm) {
    console.error(`REFUSED: firm ${args.firm} not found`)
    process.exitCode = 1
    return
  }

  const candidates = await computeCandidatesForFirm(db, firm.id, blockedSlugs)

  if (process.env.ENGINE_LIVE !== '1') {
    console.log(
      `dry: lower후보 ${candidates.lower.length}·raise후보 ${candidates.raise.length}`
      + `·skip후보 ${candidates.skipped} (실행하려면 env ENGINE_LIVE=1 + firm_credentials 필요)`,
    )
    return
  }

  const [credRow] = await db.select().from(firmCredentials)
    .where(and(eq(firmCredentials.firmId, firm.id), eq(firmCredentials.provider, 'naver_searchad')))
  if (!credRow) {
    console.log(`SKIP: no firm_credentials for firm ${firm.id}`)
    return
  }

  const { decryptCred } = await import('@/lib/engine/cred-crypto')
  const { NaverSearchAdClient } = await import('@/lib/engine/naver/client')
  const { reconcileAds } = await import('@/lib/engine/reconcile-ads')

  const client = new NaverSearchAdClient({
    customerId: credRow.customerId,
    apiKey: decryptCred(credRow.apiKeyEnc),
    secret: decryptCred(credRow.secretEnc),
  })

  const result = await reconcileAds(db, client, firm, blockedSlugs)
  console.log(`live: lowered ${result.lowered}, raised ${result.raised}, skipped ${result.skipped}`)
}

main().catch((e) => {
  console.error('reconcile-ads failed:', e)
  process.exitCode = 1
})
