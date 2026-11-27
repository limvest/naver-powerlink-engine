import { sql } from 'drizzle-orm'
import { pgTable, uuid, integer, text, jsonb, timestamp, boolean, unique, uniqueIndex, index, check } from 'drizzle-orm/pg-core'

export type FirmLawyer = {
  id?: string
  name: string
  title: string
  badges: string[]
  photo: string | null
  bio?: string
  career?: string[]
  education?: string[]
  practiceAreas?: string[]
}

// BLUEPRINT §2 — 키워드 파이프라인 (P0.5: 스키마+유형 시드, 실명 키워드·크롤 적재는 P1/P2)
export const keywords = pgTable('keywords', {
  id: uuid('id').primaryKey().defaultRandom(),
  firmId: integer('firm_id').notNull().default(1),
  name: text('name').notNull(),
  normalizedName: text('normalized_name').notNull().default(''),
  slug: text('slug').notNull().unique(),
  aliases: jsonb('aliases').$type<string[]>(),
  scamType: text('scam_type').notNull(),
  sourceUrl: text('source_url'),
  firstSeenAt: timestamp('first_seen_at', { withTimezone: true }),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
  status: text('status').notNull().default('published'), // discovered→verified→generated→published→ad_registered→live→paused|blocked
  managedBy: text('managed_by').notNull().default('curated'), // curated | competitor-sitemap | llm-extraction
  autoPublished: boolean('auto_published').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('keywords_normalized_name_idx').on(t.normalizedName)])

export const observations = pgTable('observations', {
  id: uuid('id').primaryKey().defaultRandom(),
  keywordId: uuid('keyword_id').notNull().references(() => keywords.id),
  observedAt: timestamp('observed_at', { withTimezone: true }).notNull().defaultNow(), // 수집된 날짜
  sourceUrl: text('source_url'),                                                       // 수집된 곳
  sourceType: text('source_type'),                                                     // 수집된 형태: community|news|report|sns|etc
  title: text('title'),                                                                // 게시글 제목 원문 (공개 웹 그대로)
  origin: text('origin'),                                                              // 수집 소스 표시명 (예: 백두산카페)
  sourceFamily: text('source_family'),                                                  // 동일 운영 주체/미러 그룹 (독립 근거 중복 집계 방지)
  facts: jsonb('facts').$type<ObsFacts>(),                                             // 본문 파생 구조화 사실 (원문 무저장 — dossier용). 계좌·전화 미포함
}, (t) => [
  unique('observations_keyword_source_url').on(t.keywordId, t.sourceUrl),
  index('observations_source_family_url_idx').on(t.sourceFamily, t.sourceUrl),
])

// 관측 단위 구조화 사실 — factlib.extract_facts 산출.
export type ObsFacts = {
  method: string[]                              // 수법 태그 (출금거절·선입금요구·리딩방 …)
  infra: { type: string; value: string }[]      // 사기 인프라 (company|app|site|telegram|kakao|bank|wallet) — 계좌·전화 없음
  amounts: string[]                             // 원문 명시 금액 문자열 원문 그대로 (집계·단정 금지)
}

// ── B2B 엔진 ──
// firm 1 = 샘플투. id는 운영자 부여 정수 (leads/events.firmId 기본값 1과 정합 — 시퀀스 아님)
export const firms = pgTable('firms', {
  id: integer('id').primaryKey(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  adLawyerName: text('ad_lawyer_name').notNull(),   // 광고책임변호사 (규정 §3②)
  phone: text('phone').notNull(),                    // 표기용 "031-000-0000"
  phoneIntl: text('phone_intl').notNull(),           // JSON-LD "+82-31-000-0000"
  address: text('address').notNull(),
  addressRegion: text('address_region').notNull(),
  addressLocality: text('address_locality').notNull(),
  kakaoUrl: text('kakao_url'),
  domain: text('domain').unique(),                   // Host 매핑 (소문자, www·포트 제거)
  domainAliases: jsonb('domain_aliases').$type<string[]>(), // DNS 전환·검수용 추가 Host(정본 canonical은 domain)
  status: text('status').notNull().default('pilot'), // pilot | active | paused
  planNote: text('plan_note'),
  // SaaS 데모 확장
  lawyers: jsonb('lawyers').$type<FirmLawyer[]>(),        // 변호사단 (0~4인 가변, photo null=이니셜 카드)
  wordmark: text('wordmark'),                              // 랜딩 워드마크 텍스트 (샘플투 "SAMPLE:2")
  landingReady: boolean('landing_ready').notNull().default(false), // 실자산 분리 후 공개 승인 플래그
  dashboardToken: text('dashboard_token').unique(),        // /d/[token] 접근 토큰
  siteTemplate: text('site_template').notNull().default('response-room'), // 피해자용 웹사이트 3종 중 선택
  profileIntro: text('profile_intro'),                     // 공개 변호사 소개 페이지의 사무소 안내문
  officeHistory: jsonb('office_history').$type<string[]>(), // 공개 사무소 연혁(검증된 고객 입력만)
  // 네이버 광고 통합 — 입찰가·일예산 설정 + 비즈채널 확인 캐시. 미설정 시 null(안전 기본값은 소비처가 적용)
  adConfig: jsonb('ad_config').$type<FirmAdConfig>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export type FirmAdConfig = {
  bidAmt: number
  dailyBudget: number
  useDailyBudget: boolean
  channelOk?: boolean
  channelCheckedAt?: string
  pcChannelId?: string
  mobileChannelId?: string
}

export const firmCredentials = pgTable('firm_credentials', {
  id: uuid('id').primaryKey().defaultRandom(),
  firmId: integer('firm_id').notNull().references(() => firms.id),
  provider: text('provider').notNull().default('naver_searchad'),
  customerId: text('customer_id').notNull(),
  apiKeyEnc: text('api_key_enc').notNull(),          // cred-crypto(CRED_ENC_KEY) 암호화, 평문 금지
  secretEnc: text('secret_enc').notNull(),
  verifiedAt: timestamp('verified_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [unique('firm_credentials_firm_provider').on(t.firmId, t.provider)])

// firm × keyword 구독 — firm 상태는 광고 파이프라인 소유 (중앙 keywords.status와 독립)
export const firmKeywords = pgTable('firm_keywords', {
  id: uuid('id').primaryKey().defaultRandom(),
  firmId: integer('firm_id').notNull().references(() => firms.id),
  keywordId: uuid('keyword_id').notNull().references(() => keywords.id),
  status: text('status').notNull().default('subscribed'), // src/lib/engine/state.ts 전이표가 정본
  naverAdgroupId: text('naver_adgroup_id'),
  lastError: text('last_error'),
  // 네이버 광고 통합 §B — 고객 소유 유일 컬럼(올리기/내리기 의사표시). status(엔진 소유 파이프라인)와 독립
  adDesired: boolean('ad_desired').notNull().default(false),
  // 고객 화면의 '키워드 삭제'는 중앙 키워드와 다른 법무법인 데이터를 지우지 않고
  // 이 법무법인의 목록에서만 숨기는 소프트 삭제다.
  archivedAt: timestamp('archived_at', { withTimezone: true }),
  publicHostLabel: text('public_host_label'),
  hostStatus: text('host_status').notNull().default('pending'), // pending | preview | public | paused | retired
  hostKeyVersion: integer('host_key_version').notNull().default(1),
  hostPublishedAt: timestamp('host_published_at', { withTimezone: true }),
  hostRedirectedAt: timestamp('host_redirected_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique('firm_keywords_firm_keyword').on(t.firmId, t.keywordId),
  unique('firm_keywords_firm_public_host').on(t.firmId, t.publicHostLabel),
  index('firm_keywords_firm_archived_idx').on(t.firmId, t.archivedAt),
])

// 키워드 변형 — 텍스트는 firm 무관 중앙 공유
export const keywordVariants = pgTable('keyword_variants', {
  id: uuid('id').primaryKey().defaultRandom(),
  keywordId: uuid('keyword_id').notNull().references(() => keywords.id),
  text: text('text').notNull(),
  rule: text('rule').notNull(),                      // base | alias | suffix:사기 …
  ruleVersion: text('rule_version').notNull().default('v1'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [unique('keyword_variants_keyword_text').on(t.keywordId, t.text)])

// 네이버 측 객체의 유일한 미러 — 캠페인/광고그룹/키워드/소재
export const firmAdEntities = pgTable('firm_ad_entities', {
  id: uuid('id').primaryKey().defaultRandom(),
  firmId: integer('firm_id').notNull().references(() => firms.id),
  entityType: text('entity_type').notNull(),         // campaign | adgroup | keyword | ad
  keywordId: uuid('keyword_id').references(() => keywords.id),
  variantId: uuid('variant_id').references(() => keywordVariants.id),
  naverId: text('naver_id').notNull(),
  reviewStatus: text('review_status').notNull().default('pending'), // pending | approved | rejected
  rejectReason: text('reject_reason'),
  raw: jsonb('raw'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [unique('firm_ad_entities_firm_type_naver').on(t.firmId, t.entityType, t.naverId)])

export const adStats = pgTable('ad_stats', {
  id: uuid('id').primaryKey().defaultRandom(),
  firmId: integer('firm_id').notNull().references(() => firms.id),
  entityId: uuid('entity_id').notNull().references(() => firmAdEntities.id),
  day: text('day').notNull(),                        // YYYY-MM-DD
  impressions: integer('impressions').notNull().default(0),
  clicks: integer('clicks').notNull().default(0),
  cost: integer('cost').notNull().default(0),        // KRW
}, (t) => [unique('ad_stats_entity_day').on(t.entityId, t.day)])

// ── 사건 수요 대응 OS — additive target model ──
// 기존 keywords/observations/firm_keywords는 호환 계층으로 유지하고, 아래 테이블을 새 정본으로
// 점진 도입한다. slug는 URL 별칭일 뿐 조인의 정본이 아니며 case_entities.id를 사용한다.

export type NaverAutoBidPolicyStatus = 'active' | 'paused' | 'disabled'

export type NaverAutoBidRunStatus = 'running' | 'completed' | 'succeeded' | 'partial' | 'failed' | 'cancelled'

export type NaverAutoBidDecisionStatus = 'planned' | 'pending' | 'skipped' | 'cooldown' | 'applied' | 'verified' | 'succeeded' | 'failed'

export type NaverAutoBidVerificationStatus = 'not_started' | 'not_required' | 'pending' | 'passed' | 'verified' | 'failed'

export type NaverAutoBidStrategy = 'observed_rank' | 'target_position' | 'exposure_minimum'

export type NaverAutoBidEventType = 'sync' | 'rank_observation' | 'rank_estimate' | 'bid_change' | 'bid_restore' | 'skip' | 'safety_stop' | 'error' | 'settings_change'

// Naver automatic-bid settings are kept separate from the broader firm policy:
// the bidder needs an explicit ceiling and mutation budget before live mode can
// be considered safe.
export const naverAutoBidPolicies = pgTable('naver_auto_bid_policies', {
  id: uuid('id').primaryKey().defaultRandom(),
  firmId: integer('firm_id').notNull().references(() => firms.id, { onDelete: 'cascade' }),
  status: text('status').$type<NaverAutoBidPolicyStatus>().notNull().default('active'),
  policyVersion: text('policy_version').notNull().default('naver-auto-bid-v1'),
  enabled: boolean('enabled').notNull().default(false),
  strategy: text('strategy').$type<NaverAutoBidStrategy>().notNull().default('observed_rank'),
  device: text('device').notNull().default('mobile'),
  targetPosition: integer('target_position').notNull().default(3),
  bidFloor: integer('bid_floor').notNull().default(70),
  bidCeiling: integer('bid_ceiling'),
  stepUp: integer('step_up').notNull().default(100),
  stepDown: integer('step_down').notNull().default(100),
  allowBidDecrease: boolean('allow_bid_decrease').notNull().default(true),
  exposureBuffer: integer('exposure_buffer').notNull().default(10),
  cooldownMinutes: integer('cooldown_minutes').notNull().default(360),
  batchSize: integer('batch_size').notNull().default(50),
  maxChangesPerRun: integer('max_changes_per_run'),
  schedule: jsonb('schedule').$type<{ timezone: string; weekdays: number[]; start: string; end: string }>()
    .notNull().default({ timezone: 'Asia/Seoul', weekdays: [0, 1, 2, 3, 4, 5, 6], start: '08:00', end: '22:00' }),
  consecutiveFailureLimit: integer('consecutive_failure_limit').notNull().default(3),
  revision: integer('revision').notNull().default(1),
  updatedBy: text('updated_by'),
  raw: jsonb('raw').$type<Record<string, unknown>>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique('naver_auto_bid_policies_firm').on(t.firmId),
  index('naver_auto_bid_policies_firm_status_idx').on(t.firmId, t.status),
])

export const naverAutoBidGroupPolicies = pgTable('naver_auto_bid_group_policies', {
  id: uuid('id').primaryKey().defaultRandom(),
  firmId: integer('firm_id').notNull().references(() => firms.id, { onDelete: 'cascade' }),
  naverCampaignId: text('naver_campaign_id').notNull(),
  naverAdgroupId: text('naver_adgroup_id').notNull(),
  campaignName: text('campaign_name'),
  adgroupName: text('adgroup_name'),
  enabled: boolean('enabled').notNull().default(false),
  device: text('device').notNull().default('mobile'),
  targetPosition: integer('target_position'),
  bidFloor: integer('bid_floor'),
  bidCeiling: integer('bid_ceiling'),
  stepUp: integer('step_up'),
  stepDown: integer('step_down'),
  schedule: jsonb('schedule').$type<{ timezone: string; weekdays: number[]; start: string; end: string }>(),
  blockReason: text('block_reason'),
  keywordCount: integer('keyword_count').notNull().default(0),
  enabledKeywordCount: integer('enabled_keyword_count').notNull().default(0),
  spend7d: integer('spend_7d').notNull().default(0),
  lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
  lastRunAt: timestamp('last_run_at', { withTimezone: true }),
  revision: integer('revision').notNull().default(1),
  updatedBy: text('updated_by'),
  raw: jsonb('raw').$type<Record<string, unknown>>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique('naver_auto_bid_group_policies_firm_group').on(t.firmId, t.naverAdgroupId),
  index('naver_auto_bid_group_policies_firm_enabled_idx').on(t.firmId, t.enabled, t.naverAdgroupId),
])

export const naverAutoBidKeywordPolicies = pgTable('naver_auto_bid_keyword_policies', {
  id: uuid('id').primaryKey().defaultRandom(),
  firmId: integer('firm_id').notNull().references(() => firms.id, { onDelete: 'cascade' }),
  naverAdgroupId: text('naver_adgroup_id').notNull(),
  naverKeywordId: text('naver_keyword_id').notNull(),
  keyword: text('keyword').notNull(),
  enabled: boolean('enabled').notNull().default(false),
  targetPosition: integer('target_position'),
  bidFloor: integer('bid_floor'),
  bidCeiling: integer('bid_ceiling'),
  stepUp: integer('step_up'),
  stepDown: integer('step_down'),
  /** Hot rank/bid state. One row per provider keyword; no SERP HTML is retained. */
  lastObservedRank: integer('last_observed_rank'),
  lastObservedStatus: text('last_observed_status'),
  lastObservedBid: integer('last_observed_bid'),
  lastVisibleAds: integer('last_visible_ads'),
  lastObservedAt: timestamp('last_observed_at', { withTimezone: true }),
  legalCompetitorPresent: boolean('legal_competitor_present').notNull().default(false),
  legalCompetitorCount: integer('legal_competitor_count').notNull().default(0),
  legalCompetitors: jsonb('legal_competitors').$type<Array<{
    position: number
    advertiser: string | null
    displayUrl: string | null
    title: string | null
    adId: string | null
  }>>().notNull().default([]),
  observationCount: integer('observation_count').notNull().default(0),
  foundCount: integer('found_count').notNull().default(0),
  outsideCount: integer('outside_count').notNull().default(0),
  noAdsCount: integer('no_ads_count').notNull().default(0),
  consecutiveStatusCount: integer('consecutive_status_count').notNull().default(0),
  /** Fixed-size recent evidence for agent inference; runtime keeps at most 24. */
  observationWindow: jsonb('observation_window').$type<Array<{
    at: string
    bid: number | null
    status: string
    rank: number | null
    visibleAds: number
    legalCompetitorCount: number
    targetPosition: number
  }>>().notNull().default([]),
  /** Compact good/bad bid bracket used after the target rank is reached. */
  bidLearning: jsonb('bid_learning').$type<Record<string, unknown>>().notNull().default({}),
  lastEstimatedBid: integer('last_estimated_bid'),
  lastChangedAt: timestamp('last_changed_at', { withTimezone: true }),
  revision: integer('revision').notNull().default(1),
  updatedBy: text('updated_by'),
  raw: jsonb('raw').$type<Record<string, unknown>>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique('naver_auto_bid_keyword_policies_firm_keyword').on(t.firmId, t.naverKeywordId),
  index('naver_auto_bid_keyword_policies_group_enabled_idx').on(t.firmId, t.naverAdgroupId, t.enabled),
  index('naver_auto_bid_keyword_policies_keyword_search_idx').on(t.firmId, t.keyword),
  index('naver_auto_bid_keyword_policies_rank_state_idx').on(t.firmId, t.lastObservedStatus, t.lastObservedRank),
  index('naver_auto_bid_keyword_policies_legal_competitor_idx').on(t.firmId, t.legalCompetitorPresent),
])

export const naverAutoBidRuns = pgTable('naver_auto_bid_runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  firmId: integer('firm_id').notNull().references(() => firms.id, { onDelete: 'cascade' }),
  policyId: uuid('policy_id').references(() => naverAutoBidPolicies.id, { onDelete: 'set null' }),
  runKey: text('run_key').notNull(),
  // The value is populated only while a run is active (firm:<id>), so the
  // database also rejects two concurrent runs for one firm.
  activeKey: text('active_key'),
  status: text('status').$type<NaverAutoBidRunStatus>().notNull().default('running'),
  dryRun: boolean('dry_run').notNull().default(true),
  device: text('device').notNull().default('mobile'),
  raw: jsonb('raw').$type<Record<string, unknown>>(),
  candidateCount: integer('candidate_count').notNull().default(0),
  changedCount: integer('changed_count').notNull().default(0),
  skippedCount: integer('skipped_count').notNull().default(0),
  failedCount: integer('failed_count').notNull().default(0),
  verifiedCount: integer('verified_count').notNull().default(0),
  error: text('error'),
  verificationStatus: text('verification_status').$type<NaverAutoBidVerificationStatus>().notNull().default('not_started'),
  verificationError: text('verification_error'),
  verificationRaw: jsonb('verification_raw').$type<Record<string, unknown>>(),
  verifiedAt: timestamp('verified_at', { withTimezone: true }),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  heartbeatAt: timestamp('heartbeat_at', { withTimezone: true }),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique('naver_auto_bid_runs_firm_run_key').on(t.firmId, t.runKey),
  unique('naver_auto_bid_runs_active_key').on(t.activeKey),
  index('naver_auto_bid_runs_firm_status_created_idx').on(t.firmId, t.status, t.createdAt),
  index('naver_auto_bid_runs_firm_active_idx').on(t.firmId, t.activeKey),
])

export const naverAutoBidDecisions = pgTable('naver_auto_bid_decisions', {
  id: uuid('id').primaryKey().defaultRandom(),
  firmId: integer('firm_id').notNull().references(() => firms.id, { onDelete: 'cascade' }),
  runId: uuid('run_id').notNull().references(() => naverAutoBidRuns.id, { onDelete: 'cascade' }),
  keywordId: uuid('keyword_id').references(() => keywords.id, { onDelete: 'set null' }),
  firmKeywordId: uuid('firm_keyword_id').references(() => firmKeywords.id, { onDelete: 'set null' }),
  firmAdEntityId: uuid('firm_ad_entity_id').references(() => firmAdEntities.id, { onDelete: 'set null' }),
  naverKeywordId: text('naver_keyword_id').notNull(),
  device: text('device').notNull().default('mobile'),
  status: text('status').$type<NaverAutoBidDecisionStatus>().notNull().default('planned'),
  beforeBid: integer('before_bid'),
  estimatedBid: integer('estimated_bid'),
  targetBid: integer('target_bid'),
  afterBid: integer('after_bid'),
  beforeUseGroupBid: boolean('before_use_group_bid'),
  afterUseGroupBid: boolean('after_use_group_bid'),
  reason: text('reason'),
  cooldownUntil: timestamp('cooldown_until', { withTimezone: true }),
  raw: jsonb('raw').$type<Record<string, unknown>>(),
  requestRaw: jsonb('request_raw').$type<Record<string, unknown>>(),
  responseRaw: jsonb('response_raw').$type<Record<string, unknown>>(),
  error: text('error'),
  verificationStatus: text('verification_status').$type<NaverAutoBidVerificationStatus>().notNull().default('not_started'),
  verificationError: text('verification_error'),
  verificationRaw: jsonb('verification_raw').$type<Record<string, unknown>>(),
  verifiedAt: timestamp('verified_at', { withTimezone: true }),
  appliedAt: timestamp('applied_at', { withTimezone: true }),
  decidedAt: timestamp('decided_at', { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique('naver_auto_bid_decisions_run_keyword').on(t.runId, t.naverKeywordId),
  index('naver_auto_bid_decisions_firm_run_status_idx').on(t.firmId, t.runId, t.status),
  index('naver_auto_bid_decisions_firm_keyword_created_idx').on(t.firmId, t.keywordId, t.createdAt),
  index('naver_auto_bid_decisions_firm_cooldown_idx').on(t.firmId, t.cooldownUntil),
  index('naver_auto_bid_decisions_firm_verification_idx').on(t.firmId, t.verificationStatus),
])

export const naverAutoBidEvents = pgTable('naver_auto_bid_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  firmId: integer('firm_id').notNull().references(() => firms.id, { onDelete: 'cascade' }),
  runId: uuid('run_id').references(() => naverAutoBidRuns.id, { onDelete: 'set null' }),
  decisionId: uuid('decision_id').references(() => naverAutoBidDecisions.id, { onDelete: 'set null' }),
  naverCampaignId: text('naver_campaign_id'),
  naverAdgroupId: text('naver_adgroup_id'),
  naverKeywordId: text('naver_keyword_id'),
  campaignName: text('campaign_name'),
  adgroupName: text('adgroup_name'),
  keyword: text('keyword'),
  eventType: text('event_type').$type<NaverAutoBidEventType>().notNull(),
  severity: text('severity').notNull().default('info'),
  beforeRank: integer('before_rank'),
  afterRank: integer('after_rank'),
  targetPosition: integer('target_position'),
  beforeBid: integer('before_bid'),
  afterBid: integer('after_bid'),
  message: text('message').notNull(),
  actor: text('actor').notNull().default('auto-bid-engine'),
  correlationKey: text('correlation_key'),
  raw: jsonb('raw').$type<Record<string, unknown>>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('naver_auto_bid_events_firm_created_idx').on(t.firmId, t.createdAt),
  index('naver_auto_bid_events_firm_type_created_idx').on(t.firmId, t.eventType, t.createdAt),
  index('naver_auto_bid_events_keyword_created_idx').on(t.firmId, t.naverKeywordId, t.createdAt),
  index('naver_auto_bid_events_correlation_idx').on(t.correlationKey),
])

export const naverAutoBidCommands = pgTable('naver_auto_bid_commands', {
  id: uuid('id').primaryKey().defaultRandom(),
  firmId: integer('firm_id').notNull().references(() => firms.id, { onDelete: 'cascade' }),
  command: text('command').notNull(), // sync | dry_run | live_run | pause | resume | restore
  status: text('status').notNull().default('pending'), // pending | running | succeeded | failed | cancelled
  idempotencyKey: text('idempotency_key').notNull(),
  payload: jsonb('payload').$type<Record<string, unknown>>(),
  requestedBy: text('requested_by').notNull(),
  error: text('error'),
  result: jsonb('result').$type<Record<string, unknown>>(),
  startedAt: timestamp('started_at', { withTimezone: true }),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique('naver_auto_bid_commands_idempotency').on(t.idempotencyKey),
  index('naver_auto_bid_commands_status_created_idx').on(t.status, t.createdAt),
  index('naver_auto_bid_commands_firm_created_idx').on(t.firmId, t.createdAt),
])
