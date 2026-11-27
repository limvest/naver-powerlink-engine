/**
 * Sync one Seoul calendar day of keyword-level SearchAd stats for the exact
 * 사건명 campaign. Credentials are read encrypted from A1 PostgreSQL and are
 * never printed. Default day is yesterday in Korea.
 */
export {}

function previousSeoulDay(now = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now)
  const values = new Map(parts.map((part) => [part.type, part.value]))
  const today = new Date(`${values.get('year')}-${values.get('month')}-${values.get('day')}T00:00:00.000Z`)
  return new Date(today.getTime() - 86_400_000).toISOString().slice(0, 10)
}

function parseArgs(argv: string[]) {
  let firm = Number.NaN
  let day = previousSeoulDay()
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--firm') firm = Number(argv[++i])
    else if (argv[i] === '--day') day = String(argv[++i])
  }
  if (!Number.isSafeInteger(firm) || firm < 1) throw new Error('REFUSED: --firm is required')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error('REFUSED: --day must be YYYY-MM-DD')
  return { firm, day }
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('REFUSED: DATABASE_URL not set')
  const args = parseArgs(process.argv.slice(2))
  const { and, eq, sql } = await import('drizzle-orm')
  const { getDb } = await import('@/lib/db/client')
  const { adStats, firmAdEntities, firmCredentials } = await import('@/lib/db/schema')
  const { decryptCred } = await import('@/lib/engine/cred-crypto')
  const { NaverSearchAdClient } = await import('@/lib/engine/naver/client')
  const { NaverSearchAdAdapter } = await import('@/platform/integrations/naver-searchad')
  const db = getDb()
  const [credential] = await db.select().from(firmCredentials).where(and(
    eq(firmCredentials.firmId, args.firm),
    eq(firmCredentials.provider, 'naver_searchad'),
  )).limit(1)
  if (!credential) throw new Error('REFUSED: Naver credentials not installed')

  // Naver /stats is keyed by an ad-group ID. Keyword IDs are valid for keyword
  // management but not for this aggregate performance endpoint.
  const entities = await db.select({ id: firmAdEntities.id, naverId: firmAdEntities.naverId })
    .from(firmAdEntities).where(and(
      eq(firmAdEntities.firmId, args.firm),
      eq(firmAdEntities.entityType, 'adgroup'),
    ))
  if (!entities.length) {
    console.log(JSON.stringify({ firmId: args.firm, day: args.day, targets: 0, persisted: 0 }))
    return
  }

  const client = new NaverSearchAdClient({
    customerId: credential.customerId,
    apiKey: decryptCred(credential.apiKeyEnc),
    secret: decryptCred(credential.secretEnc),
  })
  const adapter = new NaverSearchAdAdapter(client, { chunkSize: 100 })
  const rows = await adapter.fetchDailyStats({
    day: args.day,
    targets: entities.map((entity) => ({
      firmId: args.firm,
      adExecutionId: entity.id,
      adGroupId: entity.naverId,
    })),
  })
  for (let offset = 0; offset < rows.length; offset += 500) {
    const values = rows.slice(offset, offset + 500).map((row) => ({
      firmId: args.firm,
      entityId: row.adExecutionId,
      day: args.day,
      impressions: row.impressions,
      clicks: row.clicks,
      cost: row.cost,
    }))
    await db.insert(adStats).values(values).onConflictDoUpdate({
      target: [adStats.entityId, adStats.day],
      set: {
        impressions: sql`excluded.impressions`,
        clicks: sql`excluded.clicks`,
        cost: sql`excluded.cost`,
      },
    })
  }
  console.log(JSON.stringify({ firmId: args.firm, day: args.day, targets: entities.length, persisted: rows.length }))
}

main().catch((error) => {
  console.error('sync-exact-search-stats failed:', error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
