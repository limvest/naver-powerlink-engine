/** Persist keyword-level Naver SearchAd stats and print an exposure sweep summary. */
export {}

const CHUNK_SIZE = 100
const PACE_MS = 180

function seoulDay(offsetDays = 0, now = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now)
  const values = new Map(parts.map((part) => [part.type, part.value]))
  const date = new Date(`${values.get('year')}-${values.get('month')}-${values.get('day')}T00:00:00.000Z`)
  date.setUTCDate(date.getUTCDate() + offsetDays)
  return date.toISOString().slice(0, 10)
}

function parseArgs(argv: string[]) {
  let firm = Number.NaN
  let day = seoulDay()
  let limit: number | undefined
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--firm') firm = Number(argv[++index])
    else if (argv[index] === '--limit') limit = Number(argv[++index])
    else if (argv[index] === '--day') {
      const value = String(argv[++index])
      day = value === 'today' ? seoulDay() : value === 'yesterday' ? seoulDay(-1) : value
    }
  }
  if (!Number.isSafeInteger(firm) || firm < 1) throw new Error('REFUSED: --firm is required')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error('REFUSED: --day must be today, yesterday, or YYYY-MM-DD')
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) throw new Error('REFUSED: --limit must be positive')
  return { firm, day, limit }
}

function chunks<T>(values: T[], size: number): T[][] {
  const result: T[][] = []
  for (let offset = 0; offset < values.length; offset += size) result.push(values.slice(offset, offset + size))
  return result
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('REFUSED: DATABASE_URL not set')
  const args = parseArgs(process.argv.slice(2))
  const { and, eq, sql } = await import('drizzle-orm')
  const { getDb } = await import('@/lib/db/client')
  const { adStats, firmAdEntities, firmCredentials } = await import('@/lib/db/schema')
  const { decryptCred } = await import('@/lib/engine/cred-crypto')
  const { NaverSearchAdClient } = await import('@/lib/engine/naver/client')
  const { parseNaverStatsResponse } = await import('@/platform/integrations/naver-searchad')
  const db = getDb()
  const [credential] = await db.select().from(firmCredentials).where(and(
    eq(firmCredentials.firmId, args.firm),
    eq(firmCredentials.provider, 'naver_searchad'),
  )).limit(1)
  if (!credential) throw new Error('REFUSED: Naver credentials not installed')

  const entityQuery = db.select({
    id: firmAdEntities.id,
    naverId: firmAdEntities.naverId,
    reviewStatus: firmAdEntities.reviewStatus,
  }).from(firmAdEntities).where(and(
    eq(firmAdEntities.firmId, args.firm),
    eq(firmAdEntities.entityType, 'keyword'),
  ))
  const entities = args.limit === undefined ? await entityQuery : await entityQuery.limit(args.limit)
  const api = new NaverSearchAdClient({
    customerId: credential.customerId,
    apiKey: decryptCred(credential.apiKeyEnc),
    secret: decryptCred(credential.secretEnc),
  })
  const statsByNaverId = new Map<string, { impressions: number; clicks: number; cost: number }>()
  for (const batch of chunks(entities, CHUNK_SIZE)) {
    const response = await api.request<unknown>('GET', '/stats', {
      query: {
        ids: batch.map((entity) => entity.naverId),
        fields: JSON.stringify(['impCnt', 'clkCnt', 'salesAmt']),
        timeIncrement: 'allDays',
        timeRange: JSON.stringify({ since: args.day, until: args.day }),
      },
    })
    for (const row of parseNaverStatsResponse(response)) {
      statsByNaverId.set(row.externalId, {
        impressions: row.impressions,
        clicks: row.clicks,
        cost: row.cost,
      })
    }
    await new Promise((resolve) => setTimeout(resolve, PACE_MS))
  }

  const rows = entities.map((entity) => {
    const stat = statsByNaverId.get(entity.naverId) ?? { impressions: 0, clicks: 0, cost: 0 }
    return {
      firmId: args.firm,
      entityId: entity.id,
      day: args.day,
      impressions: stat.impressions,
      clicks: stat.clicks,
      cost: stat.cost,
    }
  })
  for (const batch of chunks(rows, 500)) {
    await db.insert(adStats).values(batch).onConflictDoUpdate({
      target: [adStats.entityId, adStats.day],
      set: {
        impressions: sql`excluded.impressions`,
        clicks: sql`excluded.clicks`,
        cost: sql`excluded.cost`,
      },
    })
  }

  const exposed = rows.filter((row) => row.impressions > 0)
  const approvedZero = rows.filter((row, index) => row.impressions === 0 && entities[index].reviewStatus === 'approved')
  const pending = entities.filter((entity) => entity.reviewStatus === 'pending').length
  const rejected = entities.filter((entity) => entity.reviewStatus === 'rejected').length
  console.log(JSON.stringify({
    firmId: args.firm,
    day: args.day,
    keywords: entities.length,
    exposed: exposed.length,
    approvedZero: approvedZero.length,
    pending,
    rejected,
    impressions: rows.reduce((sum, row) => sum + row.impressions, 0),
    clicks: rows.reduce((sum, row) => sum + row.clicks, 0),
    cost: rows.reduce((sum, row) => sum + row.cost, 0),
  }))
}

main().catch((error) => {
  console.error('sync-keyword-search-stats failed:', error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
