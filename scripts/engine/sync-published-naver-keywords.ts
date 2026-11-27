/** Sync published, publicly hosted keywords into the existing 64-group campaign. */
export {}

import { existsSync, readFileSync } from 'node:fs'

type AdmissionObservation = {
  keywordId?: unknown
  status?: string | null
  rank?: number | null
  visibleAds?: number | null
  legalCompetitorPresent?: boolean
  legalCompetitorCount?: number | null
  legalCompetitors?: unknown[]
  observedAt?: string | null
}

function admissionManifest(): { keywordIds: string[]; observations: AdmissionObservation[] } {
  const inboxKey = process.env.KEYWORD_INBOX_KEY || process.env.SYNC_SOURCE_DAY
  if (!inboxKey) return { keywordIds: [], observations: [] }
  const path = process.env.COLLECTION_MANIFEST_PATH || `data/keyword-inbox/${inboxKey}-collection-manifest.json`
  if (!existsSync(path)) return { keywordIds: [], observations: [] }
  try {
    const manifest = JSON.parse(readFileSync(path, 'utf8')) as {
      naverCompetitorAdmissionGate?: { eligibleKeywordIds?: unknown; observations?: unknown }
    }
    const ids = manifest.naverCompetitorAdmissionGate?.eligibleKeywordIds
    return {
      keywordIds: Array.isArray(ids)
        ? [...new Set(ids.filter((id): id is string => typeof id === 'string' && id.length > 0))]
        : [],
      observations: Array.isArray(manifest.naverCompetitorAdmissionGate?.observations)
        ? manifest.naverCompetitorAdmissionGate.observations as AdmissionObservation[]
        : [],
    }
  } catch { return { keywordIds: [], observations: [] } }
}

async function main() {
  if (process.env.ENGINE_LIVE !== '1') throw new Error('REFUSED: ENGINE_LIVE=1 is required')
  const firmId = Number(process.argv[process.argv.indexOf('--firm') + 1])
  const paceMs = Number(process.argv[process.argv.indexOf('--pace-ms') + 1] || 150)
  const admissionOnly = process.argv.includes('--admission-eligible')
  const skipAdHours = process.argv.includes('--skip-ad-hours')
  if (!Number.isSafeInteger(firmId)) throw new Error('REFUSED: --firm is required')
  if (!Number.isFinite(paceMs) || paceMs < 0) throw new Error('REFUSED: invalid --pace-ms')

  const { and, eq, inArray, sql } = await import('drizzle-orm')
  const { getDb } = await import('@/lib/db/client')
  const { firmCredentials, firmKeywords, firms } = await import('@/lib/db/schema')
  const { decryptCred } = await import('@/lib/engine/cred-crypto')
  const { NaverSearchAdClient } = await import('@/lib/engine/naver/client')
  const { enforceSampleoneAdHours } = await import('@/lib/engine/naver/ad-hours')
  const { buildBulkSearchCampaignPlan } = await import('@/lib/engine/naver/bulk-search-plan')
  const { syncSegmentedLegalCompetitorKeywords } = await import('@/lib/engine/naver/segmented-search-run')
  const db = getDb()
  const [firm] = await db.select().from(firms).where(eq(firms.id, firmId)).limit(1)
  if (!firm?.domain) throw new Error(`REFUSED: firm ${firmId} not found or domain missing`)
  const [credential] = await db.select().from(firmCredentials).where(and(
    eq(firmCredentials.firmId, firmId),
    eq(firmCredentials.provider, 'naver_searchad'),
  )).limit(1)
  if (!credential) {
    console.log(JSON.stringify({ skipped: 'naver_credential_missing', firmId }))
    return
  }

  const api = new NaverSearchAdClient({
    customerId: credential.customerId,
    apiKey: decryptCred(credential.apiKeyEnc),
    secret: decryptCred(credential.secretEnc),
  })
  const manifest = admissionManifest()
  let keywordIds = admissionOnly ? manifest.keywordIds : undefined
  if (admissionOnly) {
    const backlog = (await db.execute(sql`select fk.keyword_id::text as keyword_id
      from firm_keywords fk join keywords k on k.id=fk.keyword_id
      where fk.firm_id=${firmId} and fk.status='subscribed' and fk.host_status='public'
        and fk.archived_at is null and k.status='published'
        and (fk.last_error like '{"stage":"naver_keyword_registration"%'
          or fk.last_error like '{"stage":"naver_keyword_registration_pending"%')
        and not exists (select 1 from firm_ad_entities e where e.firm_id=fk.firm_id
          and e.keyword_id=fk.keyword_id and e.entity_type='keyword')`)).rows
      .map((row) => String(row.keyword_id))
    keywordIds = [...new Set([...(keywordIds ?? []), ...backlog])]
  }
  if (admissionOnly && !keywordIds?.length) {
    console.log(JSON.stringify({ skipped: 'no_admission_eligible_keywords', firmId }))
    return
  }
  const plan = await buildBulkSearchCampaignPlan(db, firm, { keywordIds })
  for (const row of plan.rejected) {
    await db.update(firmKeywords).set({
      status: 'rejected', adDesired: false,
      lastError: JSON.stringify({ stage: 'naver_keyword_plan', reason: row.reason, candidate: row.candidate }),
      updatedAt: new Date(),
    }).where(and(eq(firmKeywords.firmId, firmId), eq(firmKeywords.keywordId, row.keywordId)))
  }
  for (const row of plan.duplicates) {
    await db.update(firmKeywords).set({
      status: 'rejected', adDesired: false,
      lastError: JSON.stringify({ stage: 'naver_keyword_plan', reason: 'duplicate', selectedKeywordId: row.selectedKeywordId }),
      updatedAt: new Date(),
    }).where(and(eq(firmKeywords.firmId, firmId), eq(firmKeywords.keywordId, row.keywordId)))
  }
  // Persist the exact registration cohort before the first provider mutation. If the
  // process or API fails between Naver acceptance and the local mirror write, the next
  // run retries only this explicitly admitted cohort instead of every public keyword.
  const selectedIds = [...new Set(plan.shards.flatMap((shard) => shard.entries.map((entry) => entry.keywordId)))]
  for (let offset = 0; offset < selectedIds.length; offset += 1_000) {
    const batch = selectedIds.slice(offset, offset + 1_000)
    await db.update(firmKeywords).set({
      lastError: JSON.stringify({ stage: 'naver_keyword_registration_pending', retryable: true }),
      updatedAt: new Date(),
    }).where(and(
      eq(firmKeywords.firmId, firmId),
      eq(firmKeywords.status, 'subscribed'),
      inArray(firmKeywords.keywordId, batch),
    ))
  }
  const evidenceByKeywordId = new Map<string, AdmissionObservation>()
  for (const observation of manifest.observations) {
    if (typeof observation.keywordId !== 'string' || observation.legalCompetitorPresent !== true) continue
    evidenceByKeywordId.set(observation.keywordId, observation)
  }
  const result = await syncSegmentedLegalCompetitorKeywords(db, api, firm, plan, { paceMs, evidenceByKeywordId })
  // URL preflight and keyword registration complete before this account-wide provider
  // mutation. A bad landing therefore cannot change any campaign/group operating state.
  const adHours = skipAdHours
    ? { skipped: 'manual_registration' }
    : await enforceSampleoneAdHours(api, new Date(), paceMs, { unlimited: true })
  console.log(JSON.stringify({ ...result, admissionOnly, admissionCandidates: manifest.keywordIds.length,
    retryBacklogCandidates: (keywordIds?.length ?? 0) - manifest.keywordIds.length,
    planRejected: plan.rejected.length, planDuplicates: plan.duplicates.length, adHours }))
}

main().catch((error) => {
  console.error('sync-published-naver-keywords failed:', error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
