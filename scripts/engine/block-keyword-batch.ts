import { readFileSync } from 'node:fs'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { getDb } from '@/lib/db/client'
import { firmAdEntities, firmCredentials, firmKeywords, keywords } from '@/lib/db/schema'
import { decryptCred } from '@/lib/engine/cred-crypto'
import { NaverSearchAdClient } from '@/lib/engine/naver/client'

type Raw = Record<string, unknown>
type Manifest = { slugs?: unknown }

function args(argv: string[]): { file: string; firmId: number; live: boolean } {
  const fileIndex = argv.indexOf('--file')
  const firmIndex = argv.indexOf('--firm')
  const file = fileIndex >= 0 ? argv[fileIndex + 1] : ''
  const firmId = Number(firmIndex >= 0 ? argv[firmIndex + 1] : '')
  if (!file || !Number.isSafeInteger(firmId) || firmId <= 0) {
    throw new Error('usage: --file <manifest.json> --firm <id> [--live]')
  }
  return { file, firmId, live: argv.includes('--live') }
}

function record(value: unknown): Raw {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Raw : {}
}

function chunks<T>(items: T[], size = 100): T[][] {
  const output: T[][] = []
  for (let index = 0; index < items.length; index += size) output.push(items.slice(index, index + size))
  return output
}

async function main(): Promise<void> {
  const options = args(process.argv.slice(2))
  const manifest = JSON.parse(readFileSync(options.file, 'utf8')) as Manifest
  if (!Array.isArray(manifest.slugs)) throw new Error('manifest.slugs must be an array')
  const slugs = [...new Set(manifest.slugs.map((value) => String(value).trim()).filter(Boolean))]
  if (!slugs.length || slugs.some((slug) => !/^[a-z0-9-]{2,80}$/.test(slug))) {
    throw new Error('manifest contains no slugs or an invalid slug')
  }

  const db = getDb()
  const keywordRows = await db.select({ id: keywords.id, slug: keywords.slug, name: keywords.name })
    .from(keywords).where(inArray(keywords.slug, slugs))
  if (keywordRows.length !== slugs.length) {
    const found = new Set(keywordRows.map((row) => row.slug))
    throw new Error(`keyword manifest mismatch: expected ${slugs.length}, found ${keywordRows.length}, missing ${slugs.filter((slug) => !found.has(slug)).join(',')}`)
  }
  const keywordIds = keywordRows.map((row) => row.id)
  const entities = await db.select({ naverId: firmAdEntities.naverId, raw: firmAdEntities.raw })
    .from(firmAdEntities).where(and(
      eq(firmAdEntities.firmId, options.firmId),
      eq(firmAdEntities.entityType, 'keyword'),
      inArray(firmAdEntities.keywordId, keywordIds),
    ))

  if (!options.live) {
    console.log(JSON.stringify({ mode: 'dry-run', keywords: keywordRows.length, naverEntities: entities.length }, null, 2))
    return
  }

  const [credential] = await db.select().from(firmCredentials).where(and(
    eq(firmCredentials.firmId, options.firmId),
    eq(firmCredentials.provider, 'naver_searchad'),
  )).limit(1)
  if (!credential) throw new Error('naver_credentials_missing')
  const client = new NaverSearchAdClient({
    customerId: credential.customerId,
    apiKey: decryptCred(credential.apiKeyEnc),
    secret: decryptCred(credential.secretEnc),
  })

  const targetNaverIds = new Set(entities.map((entity) => entity.naverId))
  const groupIds = [...new Set(entities.flatMap((entity) => {
    const groupId = record(entity.raw).nccAdgroupId
    return typeof groupId === 'string' && groupId ? [groupId] : []
  }))]
  const remoteTargets: Raw[] = []
  for (const groupId of groupIds) {
    const rows = await client.request<unknown>('GET', '/ncc/keywords', { query: { nccAdgroupId: groupId } })
    for (const row of Array.isArray(rows) ? rows.map(record) : []) {
      const id = typeof row.nccKeywordId === 'string' ? row.nccKeywordId : ''
      if (targetNaverIds.has(id) && row.status !== 'DELETED') remoteTargets.push(row)
    }
  }

  const unlocked = remoteTargets.filter((row) => row.userLock === false || row.userLock === 0)
  let locked = 0
  for (const batch of chunks(unlocked)) {
    const response = await client.request<unknown>('PUT', '/ncc/keywords', {
      query: { fields: 'userLock' },
      body: batch.map((row) => ({ ...row, userLock: true })),
    })
    const rows = Array.isArray(response) ? response.map(record) : []
    if (rows.length !== batch.length || rows.some((row) => row.userLock !== true && row.userLock !== 1)) {
      throw new Error(`Naver keyword lock verification failed: requested ${batch.length}, returned ${rows.length}`)
    }
    locked += rows.length
  }

  await db.transaction(async (tx) => {
    await tx.update(keywords).set({ status: 'blocked' }).where(inArray(keywords.id, keywordIds))
    await tx.update(firmKeywords).set({
      adDesired: false,
      status: sql`case when ${firmKeywords.status} in ('subscribed','ad_registered','live') then 'paused' else ${firmKeywords.status} end`,
      hostStatus: 'paused',
      updatedAt: new Date(),
    }).where(and(eq(firmKeywords.firmId, options.firmId), inArray(firmKeywords.keywordId, keywordIds)))
    if (entities.length) {
      await tx.update(firmAdEntities).set({
        raw: sql`jsonb_set(coalesce(${firmAdEntities.raw}, '{}'::jsonb), '{userLock}', 'true'::jsonb, true)`,
        updatedAt: new Date(),
      }).where(and(
        eq(firmAdEntities.firmId, options.firmId),
        eq(firmAdEntities.entityType, 'keyword'),
        inArray(firmAdEntities.keywordId, keywordIds),
      ))
    }
  })

  console.log(JSON.stringify({
    mode: 'live', keywordsBlocked: keywordRows.length, naverEntities: entities.length,
    remotePresent: remoteTargets.length, remoteAlreadyLocked: remoteTargets.length - unlocked.length,
    remoteLockedNow: locked, remoteAbsentOrDeleted: entities.length - remoteTargets.length,
  }, null, 2))
}

main().catch((error) => {
  console.error('block-keyword-batch failed:', error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
