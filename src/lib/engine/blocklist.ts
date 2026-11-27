// src/lib/engine/blocklist.ts — 차단 slug 집합의 단일 정의 (최종 리뷰 F6).
//
// 차단 상태는 두 곳에 있다: 운영자가 손으로 적는 data/blocklist.json(파일)과 중앙 keywords 테이블의
// status='blocked'(에이전트·어드민이 갱신). CLI가 파일만 읽으면 DB에서 blocked로 내려간 키워드가
// blockedSlugs 경로(재등록 방지·pause 훅)에 잡히지 않는다 — registration-plan의 선별 where에는
// 이미 keywords.status='published' 조건이 있어 계획에는 안 들어오지만, poll-reviews의 사후 중지와
// 재등록 방지 훅은 중앙 상태를 봐야 한다. 그래서 두 소스의 합집합을 쓴다.
//
// 파일 I/O는 호출부(CLI)에 남긴다 — 이 모듈이 node:fs를 끌어오면 Next 번들에 섞일 수 있다.
import { eq } from 'drizzle-orm'
import type { Db } from '@/lib/db/client'
import { keywords } from '@/lib/db/schema'

export async function loadBlockedSlugs(
  db: Db, fileSlugs: Iterable<string> = [],
): Promise<Set<string>> {
  const out = new Set<string>(fileSlugs)
  const rows = await db.select({ slug: keywords.slug }).from(keywords)
    .where(eq(keywords.status, 'blocked'))
  for (const r of rows) out.add(r.slug)
  return out
}
