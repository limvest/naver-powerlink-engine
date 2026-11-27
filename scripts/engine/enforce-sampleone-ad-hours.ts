/** Keep every live campaign active on the legacy window or all day when explicitly requested. */
export {}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('REFUSED: DATABASE_URL not set')
  const firmId = Number(process.argv[process.argv.indexOf('--firm') + 1])
  if (!Number.isSafeInteger(firmId) || firmId < 1) throw new Error('REFUSED: --firm is required')
  const unlimited = process.argv.includes('--unlimited')

  const { and, eq, sql } = await import('drizzle-orm')
  const { getDb } = await import('@/lib/db/client')
  const { firmCredentials, naverAutoBidGroupPolicies, naverAutoBidPolicies } = await import('@/lib/db/schema')
  const { decryptCred } = await import('@/lib/engine/cred-crypto')
  const { NaverSearchAdClient } = await import('@/lib/engine/naver/client')
  const { enforceSampleoneAdHours } = await import('@/lib/engine/naver/ad-hours')
  const db = getDb()
  const [credential] = await db.select().from(firmCredentials).where(and(
    eq(firmCredentials.firmId, firmId),
    eq(firmCredentials.provider, 'naver_searchad'),
  )).limit(1)
  if (!credential) throw new Error('REFUSED: Naver credentials not installed')

  const api = new NaverSearchAdClient({
    customerId: credential.customerId,
    apiKey: decryptCred(credential.apiKeyEnc),
    secret: decryptCred(credential.secretEnc),
  })
  const schedule = { timezone: 'Asia/Seoul', weekdays: [0, 1, 2, 3, 4, 5, 6], start: unlimited ? '00:00' : '08:00', end: unlimited ? '24:00' : '22:00' }
  const masterSchedules = await db.update(naverAutoBidPolicies).set({
    schedule,
    updatedAt: new Date(),
    updatedBy: 'ad-hours-enforcer',
  }).where(and(
    eq(naverAutoBidPolicies.firmId, firmId),
    sql`${naverAutoBidPolicies.schedule} is distinct from ${JSON.stringify(schedule)}::jsonb`,
  )).returning({ id: naverAutoBidPolicies.id })
  const groupSchedules = await db.update(naverAutoBidGroupPolicies).set({
    schedule,
    updatedAt: new Date(),
    updatedBy: 'ad-hours-enforcer',
  }).where(and(
    eq(naverAutoBidGroupPolicies.firmId, firmId),
    sql`${naverAutoBidGroupPolicies.schedule} is distinct from ${JSON.stringify(schedule)}::jsonb`,
  )).returning({ id: naverAutoBidGroupPolicies.id })
  const result = await enforceSampleoneAdHours(api, new Date(), 150, { unlimited })
  console.log(JSON.stringify({
    firmId, timeZone: 'Asia/Seoul', hours: unlimited ? 'Daily 00:00-24:00' : 'Daily 08:00-22:00', unlimited, ...result,
    autoBidSchedules: { masterChanged: masterSchedules.length, groupsChanged: groupSchedules.length },
  }))
}

main().catch((error) => {
  console.error('enforce-sampleone-ad-hours failed:', error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
