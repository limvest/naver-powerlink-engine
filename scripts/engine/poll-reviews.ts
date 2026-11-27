/**
 * 심사 동기화 CLI — pending firm_ad_entities의 네이버 심사 상태를 조회해 반영하고,
 * blocklist 등재 키워드의 구독을 중지한다.
 *
 * - DATABASE_URL / ENGINE_LIVE=1 / firm_credentials 중 하나라도 없으면 SKIP 메시지만 출력하고
 *   성공 종료(register-ads.ts 관행). 이 CLI는 dry-run 모드가 없고 실행 = 실 네이버 API 호출이므로
 *   ENGINE_LIVE 가드를 register-ads와 동일하게 요구한다(최종 리뷰 F3).
 * - blocklist는 data/blocklist.json(slug 문자열 배열) ∪ keywords.status='blocked'(중앙 DB) 합집합.
 * - 심사 조회 루프는 항목별 try/catch — 일부 GET이 실패해도 나머지 결과는 반드시 DB에 반영된다.
 *
 * 실행: DATABASE_URL=… ENGINE_LIVE=1 ./node_modules/.bin/tsx scripts/engine/poll-reviews.ts --firm 1
 */
import { existsSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ReviewResult } from '@/lib/engine/review-sync'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

type Args = { firm: number }

function parseArgs(argv: string[]): Args {
  const out: Args = { firm: 1 }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--firm') out.firm = Number(argv[++i])
  }
  return out
}

/** data/blocklist.json(slug 문자열 배열) — 파일이 없으면 빈 배열. DB blocked와 합집합으로 쓰인다. */
function readBlocklistFile(): string[] {
  const p = join(ROOT, 'data/blocklist.json')
  if (!existsSync(p)) return []
  return JSON.parse(readFileSync(p, 'utf-8')) as string[]
}

// 네이버 keyword/ad 심사 조회 응답에서 결론 난 상태만 추출한다 — 아직 심사중(pending/reviewing)이면
// null을 반환해 ReviewResult에 담지 않는다(불필요한 no-op 갱신 방지, DB 기본값이 이미 pending이므로).
// VERIFY: inspectStatus 필드명·값(ELIGIBLE/INELIGIBLE)·거절사유 필드명 — live 전 공식 문서 확인
function parseReviewStatus(raw: unknown): { status: 'approved' | 'rejected'; reason?: string } | null {
  if (!raw || typeof raw !== 'object') return null
  const body = raw as Record<string, unknown>
  if (body.inspectStatus === 'ELIGIBLE') return { status: 'approved' }
  if (body.inspectStatus === 'INELIGIBLE') {
    const reason = typeof body.rejectReason === 'string' ? body.rejectReason : undefined
    return { status: 'rejected', reason }
  }
  return null
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.log('SKIP: DATABASE_URL not set')
    return
  }
  // 실 API 가드 (최종 리뷰 F3) — 이 CLI에는 dry-run 경로가 없어서, 자격증명이 등록된 firm에 대해
  // 실행하는 것만으로 네이버 GET/PUT이 발생한다. register-ads와 같은 env 스위치를 요구해
  // "실수로 돌렸더니 실계정을 건드렸다"를 막는다. 미설정 시 비치명 SKIP(exit 0).
  if (process.env.ENGINE_LIVE !== '1') {
    console.log('SKIP: poll-reviews는 실 네이버 API를 호출한다 — env ENGINE_LIVE=1 필요')
    return
  }

  const args = parseArgs(process.argv.slice(2))
  if (!Number.isFinite(args.firm)) {
    console.error('REFUSED: invalid --firm value')
    process.exitCode = 1
    return
  }

  const { getDb } = await import('@/lib/db/client')
  const { firms, firmCredentials, firmAdEntities } = await import('@/lib/db/schema')
  const { eq, and, inArray } = await import('drizzle-orm')
  const { DEFAULT_FIRM } = await import('@/lib/engine/firms')

  const db = getDb()

  const [firmRow] = await db.select().from(firms).where(eq(firms.id, args.firm))
  const firm = firmRow ?? (args.firm === 1 ? DEFAULT_FIRM : null)
  if (!firm) {
    console.error(`REFUSED: firm ${args.firm} not found`)
    process.exitCode = 1
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
  const { applyReviewResults, pauseBlockedKeywords } = await import('@/lib/engine/review-sync')

  const client = new NaverSearchAdClient({
    customerId: credRow.customerId,
    apiKey: decryptCred(credRow.apiKeyEnc),
    secret: decryptCred(credRow.secretEnc),
  })

  const pending = await db.select().from(firmAdEntities).where(and(
    eq(firmAdEntities.firmId, firm.id),
    eq(firmAdEntities.reviewStatus, 'pending'),
    inArray(firmAdEntities.entityType, ['keyword', 'ad']),
  ))

  // 항목별 try/catch (최종 리뷰 F3) — 예전에는 GET 하나만 실패해도 예외가 main().catch까지 올라가
  // applyReviewResults/pauseBlockedKeywords가 아예 실행되지 않았다(그때까지 모은 결과 전량 폐기 =
  // all-or-nothing). 이제 개별 실패는 카운트·로그만 남기고 루프를 계속한다. 실패한 항목은 DB상
  // 여전히 pending이라 다음 실행에서 다시 조회 대상에 들어온다.
  const results: ReviewResult[] = []
  let fetchFailed = 0
  for (const entity of pending) {
    const entityType = entity.entityType as 'keyword' | 'ad'
    // VERIFY: 개별 심사 상태 조회 엔드포인트 — live 전 공식 문서 확인
    const path = entityType === 'ad' ? `/ncc/ads/${entity.naverId}` : `/ncc/keywords/${entity.naverId}`
    try {
      const raw = await client.request('GET', path)
      const parsed = parseReviewStatus(raw)
      if (!parsed) continue
      results.push({ naverId: entity.naverId, entityType, reviewStatus: parsed.status, reason: parsed.reason })
    } catch (e) {
      fetchFailed++
      console.error(`poll-reviews: ${entityType} ${entity.naverId} 조회 실패 (다음 실행에서 재시도):`,
        e instanceof Error ? e.message : e)
    }
  }

  const applyResult = await applyReviewResults(db, firm.id, results)

  // 차단 slug = data/blocklist.json(파일) ∪ keywords.status='blocked'(중앙 DB 상태) — 최종 리뷰 F6
  const { loadBlockedSlugs } = await import('@/lib/engine/blocklist')
  const blockedSlugs = await loadBlockedSlugs(db, readBlocklistFile())

  const pauseResult = await pauseBlockedKeywords(db, client, firm.id, blockedSlugs)

  console.log(
    `poll-reviews: checked ${pending.length}, fetch-failed ${fetchFailed}, updated ${applyResult.updated} `
    + `(live ${applyResult.wentLive}, rejected ${applyResult.wentRejected}), paused ${pauseResult.paused}`,
  )
  // 조회 실패가 있었다면 종료코드로 알린다 — DB 반영은 이미 끝난 상태라 재실행이 안전하다.
  if (fetchFailed > 0) process.exitCode = 1
}

main().catch((e) => {
  console.error('poll-reviews failed:', e)
  process.exitCode = 1
})
