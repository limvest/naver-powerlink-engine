/**
 * Creates one RSA_AD material in every existing exact-search group.
 *
 * It never deletes or pauses an approved material: both remain during Naver
 * review, avoiding a blank group. Re-running is idempotent because the pinned
 * keyword RSA is detected by its first headline asset.
 *
 * Usage:
 * ENGINE_LIVE=1 node --import tsx scripts/engine/upgrade-responsive-materials.ts --firm 1001 --live
 */
import { and, eq } from 'drizzle-orm'
import { getDb } from '@/lib/db/client'
import { firmAdEntities, firmCredentials, firms } from '@/lib/db/schema'
import { decryptCred } from '@/lib/engine/cred-crypto'
import { NaverSearchAdClient } from '@/lib/engine/naver/client'
import { responsiveMaterialPayload } from '@/lib/engine/naver/responsive-material'

type ApiRow = Record<string, unknown>

type ApiAsset = {
  linkType?: unknown
  pin?: unknown
  assetData?: { text?: unknown } | string
}

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

const live = process.argv.includes('--live')
const firmId = Number(arg('--firm') ?? '1001')

function stringId(row: ApiRow, field: string): string | null {
  const value = row[field]
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function isPinnedKeywordRsa(row: ApiRow): boolean {
  if (row.type !== 'RSA_AD' || row.status === 'DELETED' || !Array.isArray(row.assets)) return false
  return (row.assets as ApiAsset[]).some((asset) => {
    let data = asset.assetData
    if (typeof data === 'string') {
      try {
        data = JSON.parse(data) as { text?: unknown }
      } catch {
        return false
      }
    }
    return asset.linkType === 'HEADLINE'
      && asset.pin === '1'
      && data?.text === '{keyword:금융사기} 사칭사기'
  })
}

async function main(): Promise<void> {
  if (!Number.isSafeInteger(firmId) || firmId < 1) throw new Error('invalid --firm')
  if (live && process.env.ENGINE_LIVE !== '1') throw new Error('--live requires ENGINE_LIVE=1')

  const db = getDb()
  const [firm] = await db.select().from(firms).where(eq(firms.id, firmId))
  if (!firm?.domain) throw new Error('firm domain is required')
  const groups = await db.select({ naverId: firmAdEntities.naverId })
    .from(firmAdEntities)
    .where(and(eq(firmAdEntities.firmId, firmId), eq(firmAdEntities.entityType, 'adgroup')))
  const ids = [...new Set(groups.map((row) => row.naverId))]
  if (ids.length === 0) throw new Error('no adgroups found')

  const landingUrl = `https://${firm.domain}/?utm_source=naver&utm_medium=cpc&utm_campaign=sampleone_case_search`
  if (!live) {
    console.log(JSON.stringify({ dryRun: true, adgroups: ids.length, type: 'RSA_AD', landingUrl }, null, 2))
    return
  }

  const [credential] = await db.select().from(firmCredentials).where(and(
    eq(firmCredentials.firmId, firmId),
    eq(firmCredentials.provider, 'naver_searchad'),
  ))
  if (!credential) throw new Error('naver_searchad credentials are required')
  const api = new NaverSearchAdClient({
    customerId: credential.customerId,
    apiKey: decryptCred(credential.apiKeyEnc),
    secret: decryptCred(credential.secretEnc),
  })

  let created = 0
  let reused = 0
  const failures: Array<{ adgroupId: string; message: string }> = []
  for (const adgroupId of ids) {
    try {
      const ads = await api.request<ApiRow[]>('GET', '/ncc/ads', { query: { nccAdgroupId: adgroupId } })
      const existing = ads.find(isPinnedKeywordRsa)
      if (existing) {
        reused++
        continue
      }
      const createdAd = await api.request<ApiRow>('POST', '/ncc/ads', {
        body: responsiveMaterialPayload({ adgroupId, landingUrl }),
      })
      const adId = stringId(createdAd, 'nccAdId')
      if (!adId) throw new Error('Naver response omitted nccAdId')
      created++
    } catch (error) {
      failures.push({ adgroupId, message: error instanceof Error ? error.message : String(error) })
    }
  }
  console.log(JSON.stringify({ created, reused, failed: failures.length, failures }, null, 2))
  if (failures.length > 0) process.exitCode = 1
}

void main().catch((error) => {
  console.error('upgrade-responsive-materials failed:', error)
  process.exitCode = 1
})
