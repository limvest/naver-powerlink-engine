import { and, eq, inArray, sql } from 'drizzle-orm'
import { request } from 'node:http'
import type { Db } from '@/lib/db/client'
import {
  firmAdEntities,
  firmKeywords,
  naverAutoBidGroupPolicies,
  naverAutoBidKeywordPolicies,
  observations,
} from '@/lib/db/schema'
import type { Firm } from '@/lib/engine/firms'
import type { AdApi } from '@/lib/engine/register-run'
import type { BulkSearchCandidate, BulkSearchCampaignPlan } from './bulk-search-plan'
import { exactKeywordDedupeKey } from './exact-keyword'
import { RESPONSIVE_DESCRIPTIONS, RESPONSIVE_HEADLINES, responsiveMaterialPayload } from './responsive-material'

const CAMPAIGN_DATE = '20260918'
const MULTI_SOURCE_CAMPAIGN = `샘플원_N2이상_교집합_${CAMPAIGN_DATE}`
const MAX_GROUP_KEYWORDS = 1_000
const POST_CHUNK = 100
const PERMANENT_PROVIDER_REJECTIONS = new Set([3906, 3909])
const CUSTOMER_ID = 1000001
const ROOT_CHANNEL_ID = 'bsn-a001-00-000000000000001'
const PHONE_CHANNEL_ID = 'bsn-a001-00-000000000000002'
const REGISTRATION_SOURCE = 'segmented-legal-competitor-daily'

const SOURCE_LABELS: Record<string, string> = {
  'competitorj-law': '경쟁사J',
  'competitorl-law': '경쟁사L',
  'competitor-k': '경쟁사K',
  competitoro: 'COMPETITOR-O',
  report: 'REPORT',
  'competitorb-law': '경쟁사B',
  'competitore-law': '경쟁사E',
  community: 'COMMUNITY',
  'tokenpost.kr': 'TOKENPOST',
  'competitori-law': '경쟁사I',
  'competitord-law': '경쟁사D',
  'competitor-h-law': '경쟁사H',
  'competitorg-law': '경쟁사G',
  'competitora-law': '경쟁사A',
}

const EXTENSIONS = [
  { type: 'DESCRIPTION', channelId: ROOT_CHANNEL_ID, adExtension: { description: '사기피해 초기 대응' } },
  {
    type: 'POWER_LINK_IMAGE', channelId: ROOT_CHANNEL_ID,
    adExtension: {
      imagePath: '/sample/creative-image.jpg',
      imageWidth: 640, imageHeight: 640,
    },
  },
  { type: 'PHONE', channelId: PHONE_CHANNEL_ID, adExtension: null },
  {
    type: 'SUB_LINKS', channelId: ROOT_CHANNEL_ID,
    adExtension: [
      { name: '카톡바로상담', final: 'https://open.kakao.com/o/sample' },
      { name: '온라인접수', final: 'https://open.kakao.com/o/sample' },
      { name: '피해대응확인', final: 'https://open.kakao.com/o/sample' },
      { name: '변호사소개', final: 'https://open.kakao.com/o/sample' },
    ],
  },
  {
    type: 'IMAGE_SUB_LINKS', channelId: ROOT_CHANNEL_ID,
    adExtension: [
      { name: '자금동결대응', final: 'https://open.kakao.com/o/sample', imagePath: '/sample/creative-image.jpg' },
      { name: '피해회수진단', final: 'https://open.kakao.com/o/sample', imagePath: '/sample/creative-image.jpg' },
      { name: '카톡긴급상담', final: 'https://open.kakao.com/o/sample', imagePath: '/sample/creative-image.jpg' },
    ],
  },
] as const

type ApiRow = Record<string, any>
type AdmissionEvidence = {
  status?: string | null
  rank?: number | null
  visibleAds?: number | null
  legalCompetitorCount?: number | null
  legalCompetitors?: unknown[]
  observedAt?: string | null
}
type RoutedCandidate = BulkSearchCandidate & {
  sources: string[]
  campaignName: string
  tier: string
}
type GroupInventory = {
  campaign: ApiRow
  group: ApiRow
  keywords: ApiRow[]
  ads: ApiRow[]
}
type Rejection = {
  keywordId: string
  keyword: string
  code: number | null
  message: string
  permanent: boolean
}

export type SegmentedKeywordSyncResult = {
  selectedCount: number
  keywordsCreated: number
  keywordsReused: number
  keywordsRejected: number
  retryableFailures: number
  campaignIds: string[]
  rejected: Rejection[]
}

function chunks<T>(values: readonly T[], size: number): T[][] {
  const result: T[][] = []
  for (let offset = 0; offset < values.length; offset += size) result.push(values.slice(offset, offset + size))
  return result
}

function decodeHtmlText(value: string): string {
  return value
    .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&(?:nbsp|amp|lt|gt|quot|#39);/gi, (entity) => ({
      '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'",
    })[entity.toLowerCase()] ?? entity)
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function staticLandingIdentityText(html: string): string {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? ''
  const h1 = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html)?.[1] ?? ''
  return decodeHtmlText(`${title} ${h1}`)
}

async function preflightStaticLanding(entry: RoutedCandidate): Promise<void> {
  const finalUrl = new URL(entry.landingUrl)
  const origin = new URL(process.env.STATIC_LANDING_PREFLIGHT_URL || 'http://web:3000')
  const html = await new Promise<string>((resolve, reject) => {
    const req = request({
      protocol: origin.protocol,
      hostname: origin.hostname,
      port: origin.port || undefined,
      method: 'GET',
      path: `${finalUrl.pathname}${finalUrl.search}`,
      headers: {
        Host: finalUrl.host,
        'X-Forwarded-Proto': 'https',
        'User-Agent': 'LawfirmAdsNaverRegistrationPreflight/1.0',
      },
    }, (response) => {
      const body: Buffer[] = []
      let size = 0
      response.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > 2_000_000) {
          req.destroy(new Error(`static landing response too large: ${entry.landingUrl}`))
          return
        }
        body.push(chunk)
      })
      response.on('end', () => {
        const landingHeader = Array.isArray(response.headers['x-lawfirm-landing'])
          ? response.headers['x-lawfirm-landing'][0] : response.headers['x-lawfirm-landing']
        if (response.statusCode !== 200 || landingHeader !== 'static-v1') {
          reject(new Error(`static landing preflight failed (${response.statusCode}/${landingHeader ?? 'no-header'}): ${entry.landingUrl}`))
          return
        }
        resolve(Buffer.concat(body).toString('utf8'))
      })
    })
    req.setTimeout(15_000, () => req.destroy(new Error(`static landing preflight timed out: ${entry.landingUrl}`)))
    req.on('error', reject)
    req.end()
  })
  const identity = staticLandingIdentityText(html)
  if (!exactKeywordDedupeKey(identity).includes(exactKeywordDedupeKey(entry.keyword))) {
    throw new Error(`static landing identity mismatch for ${entry.keyword}: ${entry.landingUrl}`)
  }
}

async function preflightStaticLandings(entries: readonly RoutedCandidate[]): Promise<void> {
  for (const batch of chunks(entries, 25)) await Promise.all(batch.map(preflightStaticLanding))
}

function alive(row: ApiRow): boolean {
  return !row.delFlag && row.status !== 'DELETED'
}

function idFrom(row: ApiRow | undefined, key: string): string | null {
  const value = row?.[key]
  return typeof value === 'string' && value.length > 0 ? value : null
}

function keywordText(row: ApiRow): string | null {
  const value = row.keyword ?? row.name
  return typeof value === 'string' && value.length > 0 ? value : null
}

function providerReview(row: ApiRow): 'approved' | 'rejected' | 'pending' {
  const text = `${row.inspectStatus ?? ''} ${row.statusReason ?? ''}`.toUpperCase()
  if (row.inspectStatus === 'APPROVED') return 'approved'
  if (/REJECT|DISAPPROV|DENIED|INELIGIBLE/.test(text)) return 'rejected'
  return 'pending'
}

function keywordReady(row: ApiRow): boolean {
  return providerReview(row) === 'approved' && row.status === 'ELIGIBLE' && row.userLock === false
}

function assetText(asset: ApiRow): string | null {
  if (typeof asset?.assetData === 'string') {
    try { return JSON.parse(asset.assetData).text ?? null } catch { return null }
  }
  return typeof asset?.assetData?.text === 'string' ? asset.assetData.text : null
}

function apiCanonicalText(value: string): string {
  return value.replace('{키워드:', '{keyword:')
}

const desiredAssetKeys = [
  ...RESPONSIVE_HEADLINES.map((text, index) => `${index === 0 ? '1' : ''}|HEADLINE|${apiCanonicalText(text)}`),
  ...RESPONSIVE_DESCRIPTIONS.map((text) => `|DESCRIPTION|${apiCanonicalText(text)}`),
].sort()

function canonicalRsa(row: ApiRow): boolean {
  if (!alive(row) || row.type !== 'RSA_AD' || !Array.isArray(row.assets)) return false
  const keys = row.assets.map((asset: ApiRow) => `${asset.pin ?? ''}|${asset.linkType ?? ''}|${assetText(asset) ?? ''}`).sort()
  return JSON.stringify(keys) === JSON.stringify(desiredAssetKeys)
}

function selectableCanonicalRsa(rows: ApiRow[]): boolean {
  return rows.some((row) => canonicalRsa(row)
    && providerReview(row) === 'approved' && row.status === 'ELIGIBLE' && row.userLock === false)
}

function safeCampaignToken(source: string): string {
  const mapped = SOURCE_LABELS[source]
  if (mapped) return mapped
  const token = source.normalize('NFKC').replace(/[^0-9A-Za-z가-힣]+/g, '').slice(0, 12)
  if (!token) throw new Error(`unsafe observation source: ${source}`)
  return token
}

export function segmentedKeywordDestination(sourcesInput: readonly string[]): { campaignName: string; tier: string } {
  const sources = [...new Set(sourcesInput.map((value) => value.trim()).filter(Boolean))].sort()
  if (!sources.length) throw new Error('keyword has no observation source')
  if (sources.length === 1) {
    return { campaignName: `샘플원_N1_${safeCampaignToken(sources[0])}_${CAMPAIGN_DATE}`, tier: 'N01' }
  }
  const tier = sources.length === 2 ? 'N02' : sources.length === 3 ? 'N03' : sources.length === 4 ? 'N04' : 'N05P'
  return { campaignName: MULTI_SOURCE_CAMPAIGN, tier }
}

export function nextSegmentedGroupName(existingNames: readonly string[], tier: string): string {
  const pattern = new RegExp(`^${tier}_(\\d+)$`)
  const next = existingNames.reduce((highest, name) => {
    const match = pattern.exec(name)
    return match ? Math.max(highest, Number(match[1])) : highest
  }, 0) + 1
  return `${tier}_${String(next).padStart(2, '0')}`
}

async function sourceMapFor(db: Db, keywordIds: readonly string[]): Promise<Map<string, string[]>> {
  const result = new Map<string, Set<string>>()
  for (const batch of chunks([...new Set(keywordIds)], 1_000)) {
    const rows = await db.select({
      keywordId: observations.keywordId,
      source: sql<string>`coalesce(nullif(${observations.sourceFamily},''),nullif(${observations.origin},''),nullif(${observations.sourceType},''),${observations.sourceUrl},'')`,
    }).from(observations).where(inArray(observations.keywordId, batch))
    for (const row of rows) {
      if (!row.source) continue
      const values = result.get(row.keywordId) ?? new Set<string>()
      values.add(row.source)
      result.set(row.keywordId, values)
    }
  }
  return new Map([...result].map(([keywordId, values]) => [keywordId, [...values].sort()]))
}

async function mirrorEntity(db: Db, firmId: number, entityType: string, remote: ApiRow, extra: ApiRow = {}) {
  const naverId = remote.nccCampaignId ?? remote.nccAdgroupId ?? remote.nccAdId ?? remote.nccAdExtensionId
  if (typeof naverId !== 'string' || !naverId) throw new Error(`missing provider ID for ${entityType}`)
  await db.insert(firmAdEntities).values({
    firmId, entityType, naverId, reviewStatus: providerReview(remote),
    raw: { ...remote, ...extra }, updatedAt: new Date(),
  }).onConflictDoUpdate({
    target: [firmAdEntities.firmId, firmAdEntities.entityType, firmAdEntities.naverId],
    set: { reviewStatus: providerReview(remote), raw: { ...remote, ...extra }, updatedAt: new Date() },
  })
}

async function createSegmentedGroup(
  db: Db,
  api: AdApi,
  firmId: number,
  campaign: ApiRow,
  campaignName: string,
  tier: string,
  groupName: string,
  firstLandingUrl: string,
): Promise<GroupInventory> {
  let group = await api.request<ApiRow>('POST', '/ncc/adgroups', { body: {
    customerId: CUSTOMER_ID,
    nccCampaignId: campaign.nccCampaignId,
    adgroupType: 'WEB_SITE',
    name: groupName,
    pcChannelId: ROOT_CHANNEL_ID,
    mobileChannelId: ROOT_CHANNEL_ID,
    bidAmt: 70,
    useExpSearch: false,
    aiAdsOptIn: false,
    userLock: true,
    useDailyBudget: false,
    systemBiddingType: 'NONE',
  } })
  if (!idFrom(group, 'nccAdgroupId') || group.nccCampaignId !== campaign.nccCampaignId || group.userLock !== true) {
    throw new Error(`adgroup creation verification failed: ${campaignName}/${groupName}`)
  }
  await mirrorEntity(db, firmId, 'adgroup', group, { registrationSource: REGISTRATION_SOURCE, tier })

  let ad = await api.request<ApiRow>('POST', '/ncc/ads', { body: {
    customerId: CUSTOMER_ID,
    ...responsiveMaterialPayload({ adgroupId: group.nccAdgroupId, landingUrl: firstLandingUrl }),
    userLock: false,
  } })
  if (!idFrom(ad, 'nccAdId') || !canonicalRsa(ad) || ad.nccAdgroupId !== group.nccAdgroupId) {
    throw new Error(`RSA creation verification failed: ${campaignName}/${groupName}`)
  }
  await mirrorEntity(db, firmId, 'ad', ad, { registrationSource: REGISTRATION_SOURCE })

  for (const extension of EXTENSIONS) {
    const remote = await api.request<ApiRow>('POST', '/ncc/ad-extensions', { body: {
      customerId: CUSTOMER_ID,
      ownerId: group.nccAdgroupId,
      type: extension.type,
      adExtension: extension.adExtension,
      pcChannelId: extension.channelId,
      mobileChannelId: extension.channelId,
      userLock: false,
      usePeriod: false,
    } })
    if (!idFrom(remote, 'nccAdExtensionId') || remote.ownerId !== group.nccAdgroupId || remote.type !== extension.type) {
      throw new Error(`extension creation verification failed: ${campaignName}/${groupName}/${extension.type}`)
    }
    await mirrorEntity(db, firmId, 'ad_extension', remote, { registrationSource: REGISTRATION_SOURCE })
  }

  await db.insert(naverAutoBidGroupPolicies).values({
    firmId,
    naverCampaignId: campaign.nccCampaignId,
    naverAdgroupId: group.nccAdgroupId,
    campaignName,
    adgroupName: groupName,
    enabled: false,
    targetPosition: 3,
    bidFloor: 70,
    blockReason: 'pending-naver-review',
    keywordCount: 0,
    enabledKeywordCount: 0,
    updatedBy: REGISTRATION_SOURCE,
    raw: { registrationSource: REGISTRATION_SOURCE, tier, noTimeRestrictionAfterApproval: true },
    updatedAt: new Date(),
  }).onConflictDoUpdate({
    target: [naverAutoBidGroupPolicies.firmId, naverAutoBidGroupPolicies.naverAdgroupId],
    set: { enabled: false, blockReason: 'pending-naver-review', updatedBy: REGISTRATION_SOURCE,
      raw: { registrationSource: REGISTRATION_SOURCE, tier, noTimeRestrictionAfterApproval: true }, updatedAt: new Date() },
  })

  group = await api.request<ApiRow>('GET', `/ncc/adgroups/${group.nccAdgroupId}`)
  ad = await api.request<ApiRow>('GET', `/ncc/ads/${ad.nccAdId}`)
  return { campaign, group, keywords: [], ads: [ad] }
}

async function createSegmentedCampaign(
  db: Db,
  api: AdApi,
  firmId: number,
  campaignName: string,
  firstLandingUrl: string,
): Promise<GroupInventory> {
  const campaign = await api.request<ApiRow>('POST', '/ncc/campaigns', { body: {
    customerId: CUSTOMER_ID,
    campaignTp: 'WEB_SITE',
    name: campaignName,
    deliveryMethod: 'ACCELERATED',
    trackingMode: 'TRACKING_DISABLED',
    usePeriod: false,
    dailyBudget: 10_000,
    useDailyBudget: true,
    userLock: true,
  } })
  if (!idFrom(campaign, 'nccCampaignId') || campaign.name !== campaignName || campaign.userLock !== true) {
    throw new Error(`campaign creation verification failed: ${campaignName}`)
  }
  await mirrorEntity(db, firmId, 'campaign', campaign, { registrationSource: REGISTRATION_SOURCE })
  return createSegmentedGroup(db, api, firmId, campaign, campaignName, 'N01', 'N01_01', firstLandingUrl)
}

async function inventorySegmentedCampaigns(api: AdApi, paceMs: number): Promise<{ campaigns: ApiRow[]; inventory: GroupInventory[] }> {
  const campaigns = (await api.request<ApiRow[]>('GET', '/ncc/campaigns')).filter(alive)
    .filter((row) => row.name === MULTI_SOURCE_CAMPAIGN || String(row.name ?? '').startsWith('샘플원_N1_'))
  const inventory: GroupInventory[] = []
  for (const campaign of campaigns) {
    const campaignId = idFrom(campaign, 'nccCampaignId')
    if (!campaignId) continue
    const groups = (await api.request<ApiRow[]>('GET', '/ncc/adgroups', { query: { nccCampaignId: campaignId } })).filter(alive)
    for (const group of groups) {
      const groupId = idFrom(group, 'nccAdgroupId')
      if (!groupId) continue
      const keywords = (await api.request<ApiRow[]>('GET', '/ncc/keywords', { query: { nccAdgroupId: groupId } })).filter(alive)
      const ads = (await api.request<ApiRow[]>('GET', '/ncc/ads', { query: { nccAdgroupId: groupId } })).filter(alive)
      inventory.push({ campaign, group, keywords, ads })
      if (paceMs) await new Promise((resolve) => setTimeout(resolve, paceMs))
    }
  }
  return { campaigns, inventory }
}

function remoteLanding(row: ApiRow): { pc: string | null; mobile: string | null } {
  return {
    pc: typeof row.links?.pc?.final === 'string' ? row.links.pc.final : null,
    mobile: typeof row.links?.mobile?.final === 'string' ? row.links.mobile.final : null,
  }
}

async function persistAccepted(
  db: Db,
  firmId: number,
  rows: Array<{ entry: RoutedCandidate; remote: ApiRow; inventory: GroupInventory }>,
  evidenceByKeywordId: ReadonlyMap<string, AdmissionEvidence>,
): Promise<void> {
  if (!rows.length) return
  const groupIds = [...new Set(rows.map(({ inventory }) => String(inventory.group.nccAdgroupId)))]
  const groupPolicies = await db.select({
    naverAdgroupId: naverAutoBidGroupPolicies.naverAdgroupId,
    enabled: naverAutoBidGroupPolicies.enabled,
  }).from(naverAutoBidGroupPolicies).where(and(
    eq(naverAutoBidGroupPolicies.firmId, firmId),
    inArray(naverAutoBidGroupPolicies.naverAdgroupId, groupIds),
  ))
  const groupPolicyEnabled = new Map(groupPolicies.map((row) => [row.naverAdgroupId, row.enabled]))

  for (const { entry, remote, inventory } of rows) {
    const naverId = idFrom(remote, 'nccKeywordId')!
    const groupId = idFrom(inventory.group, 'nccAdgroupId')!
    const evidence = evidenceByKeywordId.get(entry.keywordId) ?? {}
    const ready = keywordReady(remote) && selectableCanonicalRsa(inventory.ads)
    await db.insert(firmAdEntities).values({
      firmId,
      entityType: 'keyword',
      keywordId: entry.keywordId,
      naverId,
      reviewStatus: providerReview(remote),
      raw: {
        ...remote,
        exactSearch: true,
        landingUrl: entry.landingUrl,
        registrationSource: 'segmented-legal-competitor-daily',
        sourceCount: entry.sources.length,
        sources: entry.sources,
        legalCompetitorPresent: true,
      },
      updatedAt: new Date(),
    }).onConflictDoUpdate({
      target: [firmAdEntities.firmId, firmAdEntities.entityType, firmAdEntities.naverId],
      set: {
        keywordId: entry.keywordId,
        reviewStatus: providerReview(remote),
        raw: {
          ...remote,
          exactSearch: true,
          landingUrl: entry.landingUrl,
          registrationSource: 'segmented-legal-competitor-daily',
          sourceCount: entry.sources.length,
          sources: entry.sources,
          legalCompetitorPresent: true,
        },
        updatedAt: new Date(),
      },
    })
    await db.update(firmKeywords).set({
      status: ready ? 'live' : 'ad_registered',
      adDesired: true,
      naverAdgroupId: groupId,
      lastError: null,
      updatedAt: new Date(),
    }).where(and(eq(firmKeywords.firmId, firmId), eq(firmKeywords.keywordId, entry.keywordId)))

    const policyEnabled = ready && groupPolicyEnabled.get(groupId) === true
    await db.insert(naverAutoBidKeywordPolicies).values({
      firmId,
      naverAdgroupId: groupId,
      naverKeywordId: naverId,
      keyword: keywordText(remote) ?? entry.keyword,
      enabled: policyEnabled,
      targetPosition: 3,
      bidFloor: 70,
      legalCompetitorPresent: true,
      legalCompetitorCount: Number(evidence.legalCompetitorCount ?? 1),
      legalCompetitors: Array.isArray(evidence.legalCompetitors) ? evidence.legalCompetitors as never[] : [],
      lastObservedRank: evidence.rank ?? null,
      lastObservedStatus: evidence.status ?? null,
      lastVisibleAds: Number(evidence.visibleAds ?? 0),
      lastObservedAt: evidence.observedAt ? new Date(evidence.observedAt) : null,
      updatedBy: 'segmented-legal-competitor-daily',
      raw: {
        sourceCount: entry.sources.length,
        sources: entry.sources,
        pendingReview: !ready,
        registrationSource: 'segmented-legal-competitor-daily',
      },
      updatedAt: new Date(),
    }).onConflictDoUpdate({
      target: [naverAutoBidKeywordPolicies.firmId, naverAutoBidKeywordPolicies.naverKeywordId],
      set: {
        naverAdgroupId: groupId,
        keyword: keywordText(remote) ?? entry.keyword,
        enabled: policyEnabled,
        targetPosition: 3,
        bidFloor: 70,
        legalCompetitorPresent: true,
        legalCompetitorCount: Number(evidence.legalCompetitorCount ?? 1),
        legalCompetitors: Array.isArray(evidence.legalCompetitors) ? evidence.legalCompetitors as never[] : [],
        lastObservedRank: evidence.rank ?? null,
        lastObservedStatus: evidence.status ?? null,
        lastVisibleAds: Number(evidence.visibleAds ?? 0),
        lastObservedAt: evidence.observedAt ? new Date(evidence.observedAt) : null,
        updatedBy: 'segmented-legal-competitor-daily',
        raw: {
          sourceCount: entry.sources.length,
          sources: entry.sources,
          pendingReview: !ready,
          registrationSource: 'segmented-legal-competitor-daily',
        },
        updatedAt: new Date(),
      },
    })
  }
}

async function persistRejected(db: Db, firmId: number, rejected: Rejection[]): Promise<void> {
  for (const row of rejected) {
    await db.update(firmKeywords).set({
      status: row.permanent ? 'rejected' : 'subscribed',
      adDesired: !row.permanent,
      lastError: JSON.stringify({
        stage: 'naver_keyword_registration',
        code: row.code,
        message: row.message,
        retryable: !row.permanent,
      }),
      updatedAt: new Date(),
    }).where(and(eq(firmKeywords.firmId, firmId), eq(firmKeywords.keywordId, row.keywordId)))
  }
}

export async function syncSegmentedLegalCompetitorKeywords(
  db: Db,
  api: AdApi,
  firm: Firm,
  plan: BulkSearchCampaignPlan,
  options: { paceMs?: number; evidenceByKeywordId?: ReadonlyMap<string, AdmissionEvidence> } = {},
): Promise<SegmentedKeywordSyncResult> {
  if (firm.id !== plan.firmId) throw new Error('법무법인과 캠페인 계획의 firmId가 다릅니다.')
  const paceMs = options.paceMs ?? 150
  const entries = plan.shards.flatMap((shard) => shard.entries)
  const sources = await sourceMapFor(db, entries.map((entry) => entry.keywordId))
  const routed: RoutedCandidate[] = entries.map((entry) => {
    const entrySources = sources.get(entry.keywordId) ?? []
    const destination = segmentedKeywordDestination(entrySources)
    return { ...entry, sources: entrySources, ...destination }
  })

  // Validate the exact final URL through the same static gateway that Cloudflare uses.
  // No provider mutation is allowed if any URL falls back to dynamic rendering or the
  // title/H1 no longer identifies the intended exact-search keyword.
  await preflightStaticLandings(routed)

  const remote = await inventorySegmentedCampaigns(api, paceMs)
  const inventory = remote.inventory
  const campaignsByName = new Map(remote.campaigns.map((campaign) => [String(campaign.name), campaign]))
  const existingByTerm = new Map<string, Array<{ remote: ApiRow; inventory: GroupInventory }>>()
  for (const item of inventory) {
    for (const remote of item.keywords) {
      const text = keywordText(remote)
      if (!text) continue
      const key = exactKeywordDedupeKey(text)
      existingByTerm.set(key, [...(existingByTerm.get(key) ?? []), { remote, inventory: item }])
    }
  }

  const reused: Array<{ entry: RoutedCandidate; remote: ApiRow; inventory: GroupInventory }> = []
  const missing: RoutedCandidate[] = []
  const rejected: Rejection[] = []
  for (const entry of routed) {
    const existing = existingByTerm.get(exactKeywordDedupeKey(entry.keyword)) ?? []
    if (existing.length > 1) throw new Error(`duplicate live exact keyword: ${entry.keyword}`)
    if (!existing.length) {
      missing.push(entry)
      continue
    }
    const landing = remoteLanding(existing[0].remote)
    if (landing.pc !== entry.landingUrl || landing.mobile !== entry.landingUrl) {
      rejected.push({
        keywordId: entry.keywordId,
        keyword: entry.keyword,
        code: null,
        message: `exact keyword already exists with a different managed landing: ${landing.pc ?? landing.mobile ?? 'missing'}`,
        permanent: true,
      })
      continue
    }
    reused.push({ entry, ...existing[0] })
  }

  // Only campaigns that still have a genuinely missing exact term are created. Existing
  // cross-record duplicates are settled locally without leaving empty provider objects.
  const requiredCampaigns = [...new Set(missing.map((entry) => entry.campaignName))]
  const missingCampaigns = requiredCampaigns.filter((name) => !campaignsByName.has(name))
  for (const campaignName of missingCampaigns) {
    const first = missing.find((entry) => entry.campaignName === campaignName)
    if (!first || first.tier !== 'N01') throw new Error(`segmented campaign missing: ${campaignName}`)
    const created = await createSegmentedCampaign(db, api, firm.id, campaignName, first.landingUrl)
    inventory.push(created)
    campaignsByName.set(campaignName, created.campaign)
  }

  const capacity = new Map<GroupInventory, number>(inventory.map((item) => [item, MAX_GROUP_KEYWORDS - item.keywords.length]))
  const assignments = new Map<GroupInventory, RoutedCandidate[]>()
  for (const entry of missing) {
    const candidates = inventory.filter((item) => item.campaign.name === entry.campaignName
      && String(item.group.name ?? '').startsWith(`${entry.tier}_`)
      && canonicalRsa(item.ads.find((row) => canonicalRsa(row)) ?? {}))
      .sort((a, b) => String(a.group.name).localeCompare(String(b.group.name)))
    let target = candidates.find((item) => (capacity.get(item) ?? 0) > 0)
    if (!target) {
      const campaign = campaignsByName.get(entry.campaignName)
      if (!campaign) throw new Error(`segmented campaign missing after creation: ${entry.campaignName}`)
      const groupName = nextSegmentedGroupName(
        inventory.filter((item) => item.campaign.name === entry.campaignName)
          .map((item) => String(item.group.name ?? '')),
        entry.tier,
      )
      target = await createSegmentedGroup(
        db, api, firm.id, campaign, entry.campaignName, entry.tier, groupName, entry.landingUrl,
      )
      inventory.push(target)
      capacity.set(target, MAX_GROUP_KEYWORDS)
    }
    capacity.set(target, (capacity.get(target) ?? 0) - 1)
    assignments.set(target, [...(assignments.get(target) ?? []), entry])
  }

  const providerResults = new Map<string, ApiRow>()
  for (const [target, assigned] of assignments) {
    const groupId = idFrom(target.group, 'nccAdgroupId')!
    for (const batch of chunks(assigned, POST_CHUNK)) {
      const response = await api.request<ApiRow[]>('POST', '/ncc/keywords', {
        query: { nccAdgroupId: groupId },
        body: batch.map((entry) => ({
          keyword: entry.keyword,
          bidAmt: firm.adConfig?.bidAmt ?? 70,
          useGroupBidAmt: false,
          userLock: false,
          links: { pc: { final: entry.landingUrl }, mobile: { final: entry.landingUrl } },
        })),
      })
      if (!Array.isArray(response) || response.length !== batch.length) {
        throw new Error(`키워드 등록 응답 개수 불일치(${batch.length}개 요청)`)
      }
      response.forEach((row, index) => {
        const text = keywordText(row) ?? batch[index].keyword
        providerResults.set(exactKeywordDedupeKey(text), row)
      })
      if (paceMs) await new Promise((resolve) => setTimeout(resolve, paceMs))
    }
    target.keywords = (await api.request<ApiRow[]>('GET', '/ncc/keywords', { query: { nccAdgroupId: groupId } })).filter(alive)
  }

  const accepted = [...reused]
  for (const [target, assigned] of assignments) {
    const reread = new Map(target.keywords.flatMap((row) => {
      const text = keywordText(row)
      return text ? [[exactKeywordDedupeKey(text), row] as const] : []
    }))
    for (const entry of assigned) {
      const key = exactKeywordDedupeKey(entry.keyword)
      const remote = reread.get(key)
      if (remote?.nccKeywordId) {
        const landing = remoteLanding(remote)
        if (landing.pc !== entry.landingUrl || landing.mobile !== entry.landingUrl) {
          throw new Error(`registered keyword landing mismatch: ${entry.keyword}`)
        }
        accepted.push({ entry, remote, inventory: target })
        continue
      }
      const result = providerResults.get(key)?.resultStatus
      const code = Number.isFinite(Number(result?.code)) ? Number(result.code) : null
      rejected.push({
        keywordId: entry.keywordId,
        keyword: entry.keyword,
        code,
        message: typeof result?.message === 'string' ? result.message : 'provider keyword missing after registration',
        permanent: code !== null && PERMANENT_PROVIDER_REJECTIONS.has(code),
      })
    }
  }

  await persistAccepted(db, firm.id, accepted, options.evidenceByKeywordId ?? new Map())
  await persistRejected(db, firm.id, rejected)
  const retryableFailures = rejected.filter((row) => !row.permanent).length
  if (retryableFailures) throw new Error(`${retryableFailures} segmented keyword registrations require retry`)

  return {
    selectedCount: routed.length,
    keywordsCreated: accepted.length - reused.length,
    keywordsReused: reused.length,
    keywordsRejected: rejected.length,
    retryableFailures,
    campaignIds: [...new Set(accepted.map(({ inventory: item }) => String(item.campaign.nccCampaignId)))],
    rejected,
  }
}

export async function settleSegmentedLegalCompetitorKeywords(
  db: Db,
  api: AdApi,
  firmId: number,
): Promise<{
  groups: number
  readyGroups: number
  waitingGroups: number
  approvedKeywords: number
  rejectedKeywords: number
  pendingKeywords: number
}> {
  const managed = await db.select({
    naverCampaignId: naverAutoBidGroupPolicies.naverCampaignId,
    naverAdgroupId: naverAutoBidGroupPolicies.naverAdgroupId,
    raw: naverAutoBidGroupPolicies.raw,
  }).from(naverAutoBidGroupPolicies).where(and(
    eq(naverAutoBidGroupPolicies.firmId, firmId),
    sql`${naverAutoBidGroupPolicies.raw}->>'registrationSource'=${REGISTRATION_SOURCE}`,
  ))
  let readyGroups = 0
  let waitingGroups = 0
  let approvedKeywords = 0
  let rejectedKeywords = 0
  let pendingKeywords = 0

  for (const managedGroup of managed) {
    let campaign = await api.request<ApiRow>('GET', `/ncc/campaigns/${managedGroup.naverCampaignId}`)
    let group = await api.request<ApiRow>('GET', `/ncc/adgroups/${managedGroup.naverAdgroupId}`)
    if (!alive(campaign) || !alive(group) || group.nccCampaignId !== campaign.nccCampaignId) {
      throw new Error(`segmented settlement identity mismatch: ${managedGroup.naverAdgroupId}`)
    }
    const [keywords, ads] = await Promise.all([
      api.request<ApiRow[]>('GET', '/ncc/keywords', { query: { nccAdgroupId: managedGroup.naverAdgroupId } }),
      api.request<ApiRow[]>('GET', '/ncc/ads', { query: { nccAdgroupId: managedGroup.naverAdgroupId } }),
    ])
    const liveKeywords = keywords.filter(alive)
    const approved = liveKeywords.filter((row) => providerReview(row) === 'approved')
    const rejected = liveKeywords.filter((row) => providerReview(row) === 'rejected')
    const pending = liveKeywords.filter((row) => providerReview(row) === 'pending')
    const approvedRsa = ads.filter(alive).find((row) => canonicalRsa(row)
      && providerReview(row) === 'approved' && row.userLock === false)
    const ready = Boolean(approvedRsa && approved.length)
    approvedKeywords += approved.length
    rejectedKeywords += rejected.length
    pendingKeywords += pending.length

    if (!ready) {
      waitingGroups += 1
      continue
    }
    readyGroups += 1
    if (campaign.userLock !== false) {
      campaign = await api.request<ApiRow>('PUT', `/ncc/campaigns/${campaign.nccCampaignId}`, {
        query: { fields: 'userLock' }, body: { ...campaign, userLock: false },
      })
      if (campaign.userLock !== false) throw new Error(`campaign unlock acknowledgement mismatch: ${campaign.nccCampaignId}`)
    }
    if (group.userLock !== false) {
      group = await api.request<ApiRow>('PUT', `/ncc/adgroups/${group.nccAdgroupId}`, {
        query: { fields: 'userLock' }, body: { ...group, userLock: false },
      })
      if (group.userLock !== false) throw new Error(`group unlock acknowledgement mismatch: ${group.nccAdgroupId}`)
    }

    const approvedIds = approved.map((row) => String(row.nccKeywordId))
    const rejectedIds = rejected.map((row) => String(row.nccKeywordId))
    const pendingIds = pending.map((row) => String(row.nccKeywordId))
    if (approvedIds.length) {
      await db.execute(sql`update naver_auto_bid_keyword_policies set enabled=true,
        raw=coalesce(raw,'{}'::jsonb)||${JSON.stringify({ pendingReview: false, segmentedSettled: true })}::jsonb,
        updated_by='segmented-legal-competitor-settlement',updated_at=now()
        where firm_id=${firmId} and naver_keyword_id in
        (select jsonb_array_elements_text(${JSON.stringify(approvedIds)}::jsonb))`)
      await db.execute(sql`update firm_keywords fk set status='live',ad_desired=true,last_error=null,updated_at=now()
        from firm_ad_entities e where e.firm_id=${firmId} and e.entity_type='keyword'
        and e.keyword_id=fk.keyword_id and fk.firm_id=e.firm_id and e.naver_id in
        (select jsonb_array_elements_text(${JSON.stringify(approvedIds)}::jsonb))`)
    }
    if (rejectedIds.length) {
      await db.execute(sql`update naver_auto_bid_keyword_policies set enabled=false,
        updated_by='segmented-legal-competitor-settlement',updated_at=now()
        where firm_id=${firmId} and naver_keyword_id in
        (select jsonb_array_elements_text(${JSON.stringify(rejectedIds)}::jsonb))`)
      await db.execute(sql`update firm_keywords fk set status='rejected',ad_desired=false,
        last_error='naver-review-rejected',updated_at=now()
        from firm_ad_entities e where e.firm_id=${firmId} and e.entity_type='keyword'
        and e.keyword_id=fk.keyword_id and fk.firm_id=e.firm_id and e.naver_id in
        (select jsonb_array_elements_text(${JSON.stringify(rejectedIds)}::jsonb))`)
    }
    if (pendingIds.length) {
      await db.execute(sql`update naver_auto_bid_keyword_policies set enabled=false,
        updated_by='segmented-legal-competitor-settlement',updated_at=now()
        where firm_id=${firmId} and naver_keyword_id in
        (select jsonb_array_elements_text(${JSON.stringify(pendingIds)}::jsonb))`)
    }
    await db.update(naverAutoBidGroupPolicies).set({
      enabled: true,
      blockReason: null,
      keywordCount: liveKeywords.length,
      enabledKeywordCount: approved.length,
      updatedBy: 'segmented-legal-competitor-settlement',
      raw: {
        registrationSource: REGISTRATION_SOURCE,
        tier: typeof managedGroup.raw?.tier === 'string' ? managedGroup.raw.tier : null,
        noTimeRestriction: true,
        settledAt: new Date().toISOString(),
      },
      updatedAt: new Date(),
    }).where(and(
      eq(naverAutoBidGroupPolicies.firmId, firmId),
      eq(naverAutoBidGroupPolicies.naverAdgroupId, managedGroup.naverAdgroupId),
    ))
  }

  return { groups: managed.length, readyGroups, waitingGroups, approvedKeywords, rejectedKeywords, pendingKeywords }
}
