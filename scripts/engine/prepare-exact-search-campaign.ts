/**
 * Build or resume the real Naver exact-name campaign for one firm.
 *
 * Dry run (default): reads DB only and prints source/filter/dedupe/shard counts.
 * Live: creates a PAUSED campaign, PAUSED adgroups, PAUSED exact keywords with
 * keyword-level subdomain links, and one generic creative per non-empty shard.
 * It never enables delivery; activation is a separate budget-approval operation.
 *
 * DATABASE_URL=... tsx scripts/engine/prepare-exact-search-campaign.ts --firm 1001
 * DATABASE_URL=... ENGINE_LIVE=1 tsx scripts/engine/prepare-exact-search-campaign.ts --firm 1001 --live
 */
export {}

type Args = { firm: number; live: boolean; paceMs: number }

function parseArgs(argv: string[]): Args {
  const out: Args = { firm: Number.NaN, live: false, paceMs: 150 }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--firm') out.firm = Number(argv[++i])
    else if (argv[i] === '--live') out.live = true
    else if (argv[i] === '--pace-ms') out.paceMs = Number(argv[++i])
  }
  return out
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('REFUSED: DATABASE_URL not set')
  const args = parseArgs(process.argv.slice(2))
  if (!Number.isFinite(args.firm)) throw new Error('REFUSED: --firm is required')
  if (!Number.isFinite(args.paceMs) || args.paceMs < 0) throw new Error('REFUSED: invalid --pace-ms')

  const { getDb } = await import('@/lib/db/client')
  const { firms, firmCredentials } = await import('@/lib/db/schema')
  const { and, eq } = await import('drizzle-orm')
  const { buildBulkSearchCampaignPlan } = await import('@/lib/engine/naver/bulk-search-plan')
  const db = getDb()
  const [firm] = await db.select().from(firms).where(eq(firms.id, args.firm)).limit(1)
  if (!firm) throw new Error(`REFUSED: firm ${args.firm} not found`)

  const plan = await buildBulkSearchCampaignPlan(db, firm)
  const rejectCounts = Object.fromEntries(
    [...new Set(plan.rejected.map((row) => row.reason))]
      .sort()
      .map((reason) => [reason, plan.rejected.filter((row) => row.reason === reason).length]),
  )
  const shardSizes = plan.shards.map((shard) => shard.entries.length)
  console.log(JSON.stringify({
    mode: args.live ? 'live-paused' : 'dry',
    firm: { id: firm.id, slug: firm.slug, domain: firm.domain },
    sourceCount: plan.sourceCount,
    acceptedBeforeDedupe: plan.acceptedBeforeDedupe,
    selectedCount: plan.selectedCount,
    rejectedCount: plan.rejected.length,
    duplicateCount: plan.duplicates.length,
    rejectionReasons: rejectCounts,
    shards: { count: shardSizes.filter(Boolean).length, min: Math.min(...shardSizes), max: Math.max(...shardSizes) },
    rejectedSample: plan.rejected.slice(0, 20).map((row) => ({ name: row.sourceName, reason: row.reason })),
  }, null, 2))
  if (!args.live) return
  if (process.env.ENGINE_LIVE !== '1') throw new Error('REFUSED: --live requires ENGINE_LIVE=1')

  const [cred] = await db.select().from(firmCredentials).where(and(
    eq(firmCredentials.firmId, firm.id),
    eq(firmCredentials.provider, 'naver_searchad'),
  )).limit(1)
  if (!cred) throw new Error(`REFUSED: firm ${firm.id} has no Naver Search Ads credentials`)

  const { decryptCred } = await import('@/lib/engine/cred-crypto')
  const { NaverSearchAdClient } = await import('@/lib/engine/naver/client')
  const { prepareBulkSearchCampaign } = await import('@/lib/engine/naver/bulk-search-run')
  const api = new NaverSearchAdClient({
    customerId: cred.customerId,
    apiKey: decryptCred(cred.apiKeyEnc),
    secret: decryptCred(cred.secretEnc),
  })
  const result = await prepareBulkSearchCampaign(db, api, firm, plan, {
    paceMs: args.paceMs,
    onProgress: ({ completed, total, shard }) => {
      if (shard !== undefined) console.log(`progress ${completed}/${total} shard=${shard + 1}`)
    },
  })
  console.log(JSON.stringify({ ...result, campaignId: `${result.campaignId.slice(0, 8)}…` }, null, 2))
}

main().catch((error) => {
  console.error('prepare-exact-search-campaign failed:', error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
