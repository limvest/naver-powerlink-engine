import { and, eq, sql } from 'drizzle-orm'
import type { Db } from '@/lib/db/client'
import { firmAdEntities, firmCredentials } from '@/lib/db/schema'
import { decryptCred } from '@/lib/engine/cred-crypto'
import { NaverSearchAdClient } from '@/lib/engine/naver/client'

type Raw = Record<string, unknown>
type KeywordMirror = { id: string; naverId: string; raw: Raw | null }

export type ExactReviewSyncResult = {
  groups: number
  failedGroups: number
  matchedKeywords: number
  updatedKeywords: number
}

function record(value: unknown): Raw {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Raw : {}
}

function reviewStatus(raw: Raw): 'pending' | 'approved' | 'rejected' {
  if (String(raw.statusReason ?? '').toUpperCase() === 'KEYWORD_DISAPPROVED') return 'rejected'
  switch (String(raw.inspectStatus ?? '').toUpperCase()) {
    case 'APPROVED':
    case 'ELIGIBLE': return 'approved'
    case 'DENIED':
    case 'INELIGIBLE':
    case 'REJECTED': return 'rejected'
    default: return 'pending'
  }
}

function rejectReason(raw: Raw): string | null {
  if (typeof raw.rejectReason === 'string' && raw.rejectReason.trim()) return raw.rejectReason
  return String(raw.statusReason ?? '').toUpperCase() === 'KEYWORD_DISAPPROVED'
    ? 'KEYWORD_DISAPPROVED'
    : null
}

function chunks<T>(items: T[], size: number): T[][] {
  const output: T[][] = []
  for (let index = 0; index < items.length; index += size) output.push(items.slice(index, index + size))
  return output
}

async function mapConcurrent<T, R>(items: T[], limit: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const output = new Array<R>(items.length)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = next++
      if (index >= items.length) return
      output[index] = await task(items[index])
    }
  }))
  return output
}

/**
 * Reads the exact-search keyword lists from Naver and refreshes only the
 * local mirror. It never changes a Naver campaign, ad group, or keyword.
 */
export async function syncExactKeywordReviews(db: Db, firmId: number): Promise<ExactReviewSyncResult> {
  const [credential] = await db.select().from(firmCredentials).where(and(
    eq(firmCredentials.firmId, firmId),
    eq(firmCredentials.provider, 'naver_searchad'),
  )).limit(1)
  if (!credential) throw new Error('naver_credentials_missing')

  const entities = await db.select({ id: firmAdEntities.id, naverId: firmAdEntities.naverId, raw: firmAdEntities.raw })
    .from(firmAdEntities)
    .where(and(eq(firmAdEntities.firmId, firmId), eq(firmAdEntities.entityType, 'keyword')))
  const keywordEntities = entities as KeywordMirror[]
  const groupIds = [...new Set(keywordEntities.flatMap((entity) => {
    const groupId = record(entity.raw).nccAdgroupId
    return typeof groupId === 'string' && groupId ? [groupId] : []
  }))]
  if (!groupIds.length) return { groups: 0, failedGroups: 0, matchedKeywords: 0, updatedKeywords: 0 }

  const client = new NaverSearchAdClient({
    customerId: credential.customerId,
    apiKey: decryptCred(credential.apiKeyEnc),
    secret: decryptCred(credential.secretEnc),
  })
  const localByNaverId = new Map(keywordEntities.map((entity) => [entity.naverId, entity]))
  const responses = await mapConcurrent(groupIds, 4, async (groupId) => {
    try {
      const payload = await client.request<unknown>('GET', '/ncc/keywords', { query: { nccAdgroupId: groupId } })
      return { ok: true as const, rows: Array.isArray(payload) ? payload.map(record) : [] }
    } catch {
      return { ok: false as const, rows: [] as Raw[] }
    }
  })
  const patches: Array<{ id: string; review_status: string; reject_reason: string | null; raw: Raw }> = []
  for (const response of responses) {
    if (!response.ok) continue
    for (const remote of response.rows) {
      const naverId = typeof remote.nccKeywordId === 'string' ? remote.nccKeywordId : null
      const local = naverId ? localByNaverId.get(naverId) : null
      if (!local) continue
      const previous = record(local.raw)
      patches.push({
        id: local.id,
        review_status: reviewStatus(remote),
        reject_reason: rejectReason(remote),
        raw: { ...previous, ...remote, exactSearch: true, ...(previous.landingUrl ? { landingUrl: previous.landingUrl } : {}) },
      })
    }
  }
  for (const batch of chunks(patches, 400)) {
    await db.execute(sql`update firm_ad_entities as entity
      set review_status = patch.review_status,
          reject_reason = patch.reject_reason,
          raw = patch.raw,
          updated_at = now()
      from jsonb_to_recordset(${JSON.stringify(batch)}::jsonb)
        as patch(id uuid, review_status text, reject_reason text, raw jsonb)
      where entity.id = patch.id`)
  }
  return {
    groups: groupIds.length,
    failedGroups: responses.filter((response) => !response.ok).length,
    matchedKeywords: patches.length,
    updatedKeywords: patches.length,
  }
}
