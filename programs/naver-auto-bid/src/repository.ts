import { and, asc, desc, eq } from 'drizzle-orm'
import type { Db } from '@/lib/db/client'
import {
  firmAdEntities,
  firmKeywords,
  firms,
  keywords,
  naverAutoBidDecisions,
  naverAutoBidPolicies,
  naverAutoBidRuns,
  type NaverAutoBidDecisionStatus,
  type NaverAutoBidPolicyStatus,
  type NaverAutoBidRunStatus,
  type NaverAutoBidVerificationStatus,
} from '@/lib/db/schema'

type RawPayload = Record<string, unknown>
type TimestampInput = Date | string | number
type PolicyRow = typeof naverAutoBidPolicies.$inferSelect
type RunRow = typeof naverAutoBidRuns.$inferSelect
type DecisionRow = typeof naverAutoBidDecisions.$inferSelect
const AUTO_BID_STALE_LEASE_MS = 3 * 60 * 60 * 1000

export class NaverAutoBidPersistenceError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NaverAutoBidPersistenceError'
  }
}

export class NaverAutoBidScopeError extends NaverAutoBidPersistenceError {
  constructor(message: string) {
    super(message)
    this.name = 'NaverAutoBidScopeError'
  }
}

export class NaverAutoBidConcurrencyError extends NaverAutoBidPersistenceError {
  constructor(message: string) {
    super(message)
    this.name = 'NaverAutoBidConcurrencyError'
  }
}

function firmIdValue(value: unknown): number {
  const normalized = typeof value === 'string' && value.trim() !== '' ? Number(value) : value
  if (!Number.isSafeInteger(normalized) || (normalized as number) < 0) {
    throw new NaverAutoBidPersistenceError('firmId must be a non-negative safe integer')
  }
  return normalized as number
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new NaverAutoBidPersistenceError(`${label} is required`)
  }
  return value.trim()
}

function optionalText(value: unknown, label: string): string | null | undefined {
  if (value === undefined) return undefined
  if (value === null) return null
  if (typeof value !== 'string') {
    throw new NaverAutoBidPersistenceError(`${label} must be a string`)
  }
  const normalized = value.trim()
  return normalized || null
}

function integerValue(value: unknown, label: string, options: {
  defaultValue?: number
  required?: boolean
  min?: number
} = {}): number {
  const candidate = value === undefined || value === null ? options.defaultValue : value
  if (candidate === undefined && options.required) {
    throw new NaverAutoBidPersistenceError(`${label} is required`)
  }
  if (!Number.isSafeInteger(candidate)) {
    throw new NaverAutoBidPersistenceError(`${label} must be a safe integer`)
  }
  const min = options.min ?? 0
  if ((candidate as number) < min) {
    throw new NaverAutoBidPersistenceError(`${label} must be at least ${min}`)
  }
  return candidate as number
}

function optionalInteger(value: unknown, label: string): number | null | undefined {
  if (value === undefined) return undefined
  if (value === null) return null
  return integerValue(value, label)
}

function timestampValue(value: TimestampInput | null | undefined, label: string): Date {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value ?? Date.now())
  if (Number.isNaN(date.getTime())) {
    throw new NaverAutoBidPersistenceError(`${label} must be a valid timestamp`)
  }
  return date
}

function optionalTimestamp(value: TimestampInput | null | undefined, label: string): Date | null | undefined {
  if (value === undefined) return undefined
  if (value === null) return null
  return timestampValue(value, label)
}

function rawPayload(value: unknown, label: string): RawPayload | null | undefined {
  if (value === undefined) return undefined
  if (value === null) return null
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new NaverAutoBidPersistenceError(`${label} must be a JSON object`)
  }
  return value as RawPayload
}

function statusValue<T extends string>(value: unknown, label: string, fallback: T): T {
  if (value === undefined || value === null) return fallback
  return requiredText(value, label) as T
}

function deviceValue(value: unknown): string {
  return optionalText(value, 'device') ?? 'mobile'
}

async function assertFirmExists(db: Db, firmId: number): Promise<void> {
  const [firm] = await db.select({ id: firms.id }).from(firms).where(eq(firms.id, firmId)).limit(1)
  if (!firm) throw new NaverAutoBidScopeError(`firm ${firmId} was not found`)
}

async function policyInFirm(db: Db, firmId: number, policyId: string): Promise<PolicyRow> {
  const [policy] = await db.select().from(naverAutoBidPolicies).where(and(
    eq(naverAutoBidPolicies.id, policyId),
    eq(naverAutoBidPolicies.firmId, firmId),
  )).limit(1)
  if (!policy) throw new NaverAutoBidScopeError(`auto-bid policy ${policyId} was not found in firm scope`)
  return policy
}

async function runInFirm(
  db: Db,
  firmId: number,
  runId?: string | null,
  runKey?: string | null,
): Promise<RunRow> {
  const normalizedRunId = runId === undefined || runId === null ? null : requiredText(runId, 'runId')
  const normalizedRunKey = runKey === undefined || runKey === null ? null : requiredText(runKey, 'runKey')
  if (!normalizedRunId && !normalizedRunKey) {
    throw new NaverAutoBidPersistenceError('runId or runKey is required')
  }
  const [run] = await db.select().from(naverAutoBidRuns).where(and(
    eq(naverAutoBidRuns.firmId, firmId),
    normalizedRunId ? eq(naverAutoBidRuns.id, normalizedRunId) : eq(naverAutoBidRuns.runKey, normalizedRunKey!),
  )).limit(1)
  if (!run) throw new NaverAutoBidScopeError('auto-bid run was not found in firm scope')
  if (normalizedRunId && normalizedRunKey && run.runKey !== normalizedRunKey) {
    throw new NaverAutoBidPersistenceError('runId and runKey identify different runs')
  }
  return run
}

async function decisionLinksInFirm(
  db: Db,
  firmId: number,
  input: {
    keywordId?: string | null
    firmKeywordId?: string | null
    firmAdEntityId?: string | null
    naverKeywordId: string
  },
): Promise<{ keywordId?: string | null; firmKeywordId?: string | null; firmAdEntityId?: string | null }> {
  let keywordId = input.keywordId === undefined || input.keywordId === null
    ? input.keywordId
    : requiredText(input.keywordId, 'keywordId')
  const firmKeywordId = input.firmKeywordId === undefined || input.firmKeywordId === null
    ? input.firmKeywordId
    : requiredText(input.firmKeywordId, 'firmKeywordId')
  const firmAdEntityId = input.firmAdEntityId === undefined || input.firmAdEntityId === null
    ? input.firmAdEntityId
    : requiredText(input.firmAdEntityId, 'firmAdEntityId')

  if (firmKeywordId) {
    const [firmKeyword] = await db.select().from(firmKeywords).where(and(
      eq(firmKeywords.id, firmKeywordId),
      eq(firmKeywords.firmId, firmId),
    )).limit(1)
    if (!firmKeyword) throw new NaverAutoBidScopeError('firm keyword was not found in firm scope')
    if (keywordId && firmKeyword.keywordId !== keywordId) {
      throw new NaverAutoBidScopeError('firm keyword and keyword links do not match')
    }
    keywordId = firmKeyword.keywordId
  }

  if (keywordId) {
    const [keyword] = await db.select({ id: keywords.id, firmId: keywords.firmId })
      .from(keywords).where(eq(keywords.id, keywordId)).limit(1)
    if (!keyword) throw new NaverAutoBidScopeError('keyword was not found')
    // Canonical keywords predate the firm subscription layer. A keyword owned
    // by another legacy firm is valid when its firm_keywords row is scoped to
    // this firm, but an unlinked cross-firm reference is not.
    if (!firmKeywordId && keyword.firmId !== firmId) {
      throw new NaverAutoBidScopeError('keyword was not found in firm scope')
    }
  }

  if (firmAdEntityId) {
    const [entity] = await db.select().from(firmAdEntities).where(and(
      eq(firmAdEntities.id, firmAdEntityId),
      eq(firmAdEntities.firmId, firmId),
    )).limit(1)
    if (!entity) throw new NaverAutoBidScopeError('firm ad entity was not found in firm scope')
    if (entity.entityType !== 'keyword') {
      throw new NaverAutoBidScopeError('firm ad entity is not a keyword entity')
    }
    if (entity.naverId !== input.naverKeywordId) {
      throw new NaverAutoBidScopeError('Naver keyword ID does not match the firm ad entity')
    }
    if (keywordId && entity.keywordId && entity.keywordId !== keywordId) {
      throw new NaverAutoBidScopeError('firm ad entity and keyword links do not match')
    }
    if (!keywordId && entity.keywordId) keywordId = entity.keywordId
  }

  return { keywordId, firmKeywordId, firmAdEntityId }
}

export type UpsertNaverAutoBidPolicyInput = {
  firmId: number | string
  status?: NaverAutoBidPolicyStatus | string
  policyVersion?: string
  strategy?: 'observed_rank' | 'target_position' | 'exposure_minimum'
  device?: string
  targetPosition?: number | null
  bidFloor?: number | null
  minimumBid?: number | null
  minBid?: number | null
  bidCeiling?: number | null
  maximumBid?: number | null
  floor?: number | null
  ceiling?: number | null
  stepUp?: number | null
  stepUpAmount?: number | null
  stepDown?: number | null
  allowBidDecrease?: boolean
  exposureBuffer?: number | null
  exposureBufferKrw?: number | null
  cooldownMinutes?: number
  cooldownMs?: number | null
  cooldownHours?: number | null
  batchSize?: number | null
  maxChangesPerRun?: number | null
  maxChanges?: number | null
  raw?: RawPayload | null
  updatedAt?: TimestampInput
}

export type UpsertNaverAutoBidPolicyResult = {
  policy: PolicyRow
  row: PolicyRow
  inserted: boolean
  updated: boolean
}

/** Persist the current bidder policy for one firm without contacting Naver. */
export async function upsertNaverAutoBidPolicy(
  db: Db,
  input: UpsertNaverAutoBidPolicyInput,
): Promise<UpsertNaverAutoBidPolicyResult> {
  const firmId = firmIdValue(input.firmId)
  await assertFirmExists(db, firmId)
  const floor = integerValue(
    input.bidFloor ?? input.minimumBid ?? input.minBid ?? input.floor,
    'bidFloor',
    { defaultValue: 70 },
  )
  const rawCeiling = input.bidCeiling ?? input.maximumBid ?? input.ceiling
  const ceiling = rawCeiling === undefined || rawCeiling === null
    ? null
    : integerValue(rawCeiling, 'bidCeiling', { min: 1 })
  if (ceiling !== null && floor > ceiling) throw new NaverAutoBidPersistenceError('bidFloor must not exceed bidCeiling')
  const stepUp = integerValue(input.stepUp ?? input.stepUpAmount, 'stepUp', { defaultValue: 100 })
  const stepDown = integerValue(input.stepDown, 'stepDown', { defaultValue: 100, min: 1 })
  const targetPosition = integerValue(input.targetPosition, 'targetPosition', { defaultValue: 3, min: 1 })
  if (targetPosition > 15) throw new NaverAutoBidPersistenceError('targetPosition must not exceed 15')
  const strategy = input.strategy ?? 'observed_rank'
  const allowBidDecrease = input.allowBidDecrease ?? true
  const exposureBuffer = integerValue(
    input.exposureBuffer ?? input.exposureBufferKrw,
    'exposureBuffer',
    { defaultValue: 10 },
  )
  const cooldownMs = input.cooldownMs === undefined || input.cooldownMs === null
    ? undefined
    : integerValue(input.cooldownMs, 'cooldownMs')
  const rawCooldownMinutes = input.cooldownMinutes
    ?? (input.cooldownHours === undefined || input.cooldownHours === null ? undefined : input.cooldownHours * 60)
    ?? (cooldownMs === undefined ? undefined : Math.ceil(cooldownMs / 60_000))
  const cooldownMinutes = integerValue(rawCooldownMinutes, 'cooldownMinutes', { defaultValue: 360 })
  const batchSize = integerValue(input.batchSize, 'batchSize', { defaultValue: 50, min: 1 })
  const rawMaxChanges = input.maxChangesPerRun ?? input.maxChanges
  const maxChangesPerRun = rawMaxChanges === undefined || rawMaxChanges === null
    ? null
    : integerValue(rawMaxChanges, 'maxChangesPerRun', { min: 1 })
  const policyVersion = optionalText(input.policyVersion, 'policyVersion') ?? 'naver-auto-bid-v1'
  const device = deviceValue(input.device)
  const status = statusValue<NaverAutoBidPolicyStatus>(input.status, 'status', 'active')
  const raw = rawPayload(input.raw, 'raw')
  const updatedAt = timestampValue(input.updatedAt, 'updatedAt')

  const [before] = await db.select().from(naverAutoBidPolicies).where(
    eq(naverAutoBidPolicies.firmId, firmId),
  ).limit(1)
  const values: typeof naverAutoBidPolicies.$inferInsert = {
    firmId,
    status,
    policyVersion,
    strategy,
    device,
    targetPosition,
    bidFloor: floor,
    bidCeiling: ceiling,
    stepUp,
    stepDown,
    allowBidDecrease,
    exposureBuffer,
    cooldownMinutes,
    batchSize,
    maxChangesPerRun,
    ...(raw === undefined ? {} : { raw }),
    updatedAt,
  }
  const [row] = await db.insert(naverAutoBidPolicies).values(values).onConflictDoUpdate({
    target: naverAutoBidPolicies.firmId,
    set: {
      status,
      policyVersion,
      strategy,
      device,
      targetPosition,
      bidFloor: floor,
      bidCeiling: ceiling,
      stepUp,
      stepDown,
      allowBidDecrease,
      exposureBuffer,
      cooldownMinutes,
      batchSize,
      maxChangesPerRun,
      ...(raw === undefined ? {} : { raw }),
      updatedAt,
    },
  }).returning()
  if (!row) throw new NaverAutoBidPersistenceError('auto-bid policy upsert returned no row')
  return { policy: row, row, inserted: !before, updated: Boolean(before) }
}

export async function getNaverAutoBidPolicy(db: Db, firmIdInput: number | string): Promise<PolicyRow | null> {
  const firmId = firmIdValue(firmIdInput)
  await assertFirmExists(db, firmId)
  const [policy] = await db.select().from(naverAutoBidPolicies)
    .where(eq(naverAutoBidPolicies.firmId, firmId)).limit(1)
  return policy ?? null
}

export type StartNaverAutoBidRunInput = {
  firmId: number | string
  runKey: string
  policyId?: string | null
  mode?: 'dry-run' | 'live'
  live?: boolean
  dryRun?: boolean
  device?: string
  raw?: RawPayload | null
  startedAt?: TimestampInput
}

export type StartNaverAutoBidRunResult = {
  run: RunRow
  row: RunRow
  inserted: boolean
  reused: boolean
}

function sameRunIntent(
  row: RunRow,
  input: { policyId?: string | null; mode?: 'dry-run' | 'live'; live?: boolean; dryRun?: boolean; device?: string },
  policyId: string | null,
): boolean {
  const requestedDryRun = input.dryRun
    ?? (input.mode === undefined ? (input.live === undefined ? undefined : !input.live) : input.mode === 'dry-run')
  return (input.policyId === undefined || row.policyId === policyId)
    && (requestedDryRun === undefined || row.dryRun === requestedDryRun)
    && (input.device === undefined || row.device === deviceValue(input.device))
}

async function existingRunAfterConflict(
  db: Db,
  firmId: number,
  runKey: string,
  input: StartNaverAutoBidRunInput,
  policyId: string | null,
): Promise<StartNaverAutoBidRunResult | null> {
  const [existing] = await db.select().from(naverAutoBidRuns).where(and(
    eq(naverAutoBidRuns.firmId, firmId),
    eq(naverAutoBidRuns.runKey, runKey),
  )).limit(1)
  if (!existing) return null
  if (!sameRunIntent(existing, input, policyId)) {
    throw new NaverAutoBidPersistenceError(`runKey collision: ${runKey}`)
  }
  return { run: existing, row: existing, inserted: false, reused: true }
}

/** Start one idempotent, firm-exclusive bidder run. */
export async function startNaverAutoBidRun(
  db: Db,
  input: StartNaverAutoBidRunInput,
): Promise<StartNaverAutoBidRunResult> {
  const firmId = firmIdValue(input.firmId)
  await assertFirmExists(db, firmId)
  const runKey = requiredText(input.runKey, 'runKey')
  const policyId = input.policyId === undefined || input.policyId === null
    ? input.policyId ?? null
    : requiredText(input.policyId, 'policyId')
  if (policyId) await policyInFirm(db, firmId, policyId)
  const [existing] = await db.select().from(naverAutoBidRuns).where(and(
    eq(naverAutoBidRuns.firmId, firmId),
    eq(naverAutoBidRuns.runKey, runKey),
  )).limit(1)
  if (existing) {
    if (!sameRunIntent(existing, input, policyId)) {
      throw new NaverAutoBidPersistenceError(`runKey collision: ${runKey}`)
    }
    return { run: existing, row: existing, inserted: false, reused: true }
  }

  const activeKey = `firm:${firmId}`
  const [active] = await db.select({
    id: naverAutoBidRuns.id,
    heartbeatAt: naverAutoBidRuns.heartbeatAt,
    startedAt: naverAutoBidRuns.startedAt,
  }).from(naverAutoBidRuns).where(and(
    eq(naverAutoBidRuns.firmId, firmId),
    eq(naverAutoBidRuns.activeKey, activeKey),
    eq(naverAutoBidRuns.status, 'running'),
  )).limit(1)
  if (active) {
    const lastSeen = active.heartbeatAt ?? active.startedAt
    const stale = Date.now() - lastSeen.getTime() >= AUTO_BID_STALE_LEASE_MS
    if (!stale) throw new NaverAutoBidConcurrencyError(`firm ${firmId} already has a running auto-bid run`)
    await db.update(naverAutoBidRuns).set({
      status: 'failed', activeKey: null, error: 'stale auto-bid lease recovered',
      finishedAt: new Date(), updatedAt: new Date(),
    }).where(eq(naverAutoBidRuns.id, active.id))
  }

  const startedAt = timestampValue(input.startedAt, 'startedAt')
  const raw = rawPayload(input.raw, 'raw')
  const dryRun = input.dryRun ?? (input.mode === undefined ? !(input.live ?? false) : input.mode === 'dry-run')
  const device = deviceValue(input.device)
  const values: typeof naverAutoBidRuns.$inferInsert = {
    firmId,
    policyId,
    runKey,
    activeKey,
    status: 'running',
    dryRun,
    device,
    ...(raw === undefined ? {} : { raw }),
    startedAt,
    heartbeatAt: startedAt,
    updatedAt: startedAt,
  }
  try {
    const [run] = await db.insert(naverAutoBidRuns).values(values).returning()
    if (!run) throw new NaverAutoBidPersistenceError('auto-bid run insert returned no row')
    return { run, row: run, inserted: true, reused: false }
  } catch (error) {
    // A concurrent worker can win either the run-key or active-key unique
    // constraint between the checks above and the insert. Resolve the run-key
    // race into the same idempotent result, and surface active-key races as a
    // firm concurrency error.
    const replay = await existingRunAfterConflict(db, firmId, runKey, input, policyId)
    if (replay) return replay
    const [racingActive] = await db.select({ id: naverAutoBidRuns.id }).from(naverAutoBidRuns).where(and(
      eq(naverAutoBidRuns.firmId, firmId),
      eq(naverAutoBidRuns.activeKey, activeKey),
      eq(naverAutoBidRuns.status, 'running'),
    )).limit(1)
    if (racingActive) throw new NaverAutoBidConcurrencyError(`firm ${firmId} already has a running auto-bid run`)
    throw error
  }
}

export type UpdateNaverAutoBidRunInput = {
  firmId: number | string
  runId?: string
  runKey?: string
  status?: NaverAutoBidRunStatus | string
  dryRun?: boolean
  device?: string
  candidateCount?: number
  changedCount?: number
  skippedCount?: number
  failedCount?: number
  verifiedCount?: number
  raw?: RawPayload | null
  error?: string | null
  verificationStatus?: NaverAutoBidVerificationStatus | string
  verificationError?: string | null
  verificationRaw?: RawPayload | null
  verifiedAt?: TimestampInput | null
  heartbeatAt?: TimestampInput | null
  finishedAt?: TimestampInput | null
  updatedAt?: TimestampInput
}

export type UpdateNaverAutoBidRunResult = { run: RunRow; row: RunRow; updated: boolean }

const terminalRunStatuses = new Set(['completed', 'succeeded', 'partial', 'failed', 'cancelled'])

/** Update a run ledger row while retaining its firm boundary and active lease. */
export async function updateNaverAutoBidRun(
  db: Db,
  input: UpdateNaverAutoBidRunInput,
): Promise<UpdateNaverAutoBidRunResult> {
  const firmId = firmIdValue(input.firmId)
  await assertFirmExists(db, firmId)
  const existing = await runInFirm(db, firmId, input.runId, input.runKey)
  const now = timestampValue(input.updatedAt, 'updatedAt')
  const patch: Partial<typeof naverAutoBidRuns.$inferInsert> = { updatedAt: now }

  if (input.status !== undefined) patch.status = statusValue<NaverAutoBidRunStatus>(input.status, 'status', existing.status as NaverAutoBidRunStatus)
  if (input.dryRun !== undefined) patch.dryRun = input.dryRun
  if (input.device !== undefined) patch.device = deviceValue(input.device)
  if (input.candidateCount !== undefined) patch.candidateCount = integerValue(input.candidateCount, 'candidateCount')
  if (input.changedCount !== undefined) patch.changedCount = integerValue(input.changedCount, 'changedCount')
  if (input.skippedCount !== undefined) patch.skippedCount = integerValue(input.skippedCount, 'skippedCount')
  if (input.failedCount !== undefined) patch.failedCount = integerValue(input.failedCount, 'failedCount')
  if (input.verifiedCount !== undefined) patch.verifiedCount = integerValue(input.verifiedCount, 'verifiedCount')
  if (input.raw !== undefined) patch.raw = rawPayload(input.raw, 'raw')
  if (input.error !== undefined) patch.error = optionalText(input.error, 'error') ?? null
  if (input.verificationStatus !== undefined) {
    patch.verificationStatus = statusValue<NaverAutoBidVerificationStatus>(
      input.verificationStatus,
      'verificationStatus',
      existing.verificationStatus as NaverAutoBidVerificationStatus,
    )
  }
  if (input.verificationError !== undefined) {
    patch.verificationError = optionalText(input.verificationError, 'verificationError') ?? null
  }
  if (input.verificationRaw !== undefined) patch.verificationRaw = rawPayload(input.verificationRaw, 'verificationRaw')
  if (input.verifiedAt !== undefined) patch.verifiedAt = optionalTimestamp(input.verifiedAt, 'verifiedAt') ?? null
  if (input.heartbeatAt !== undefined) patch.heartbeatAt = optionalTimestamp(input.heartbeatAt, 'heartbeatAt') ?? null
  if (input.finishedAt !== undefined) patch.finishedAt = optionalTimestamp(input.finishedAt, 'finishedAt') ?? null

  const nextStatus = (patch.status ?? existing.status) as string
  if (nextStatus === 'running') {
    patch.activeKey = `firm:${firmId}`
  } else if (terminalRunStatuses.has(nextStatus)) {
    patch.activeKey = null
    if (input.finishedAt === undefined && existing.finishedAt === null) patch.finishedAt = now
  }

  const [run] = await db.update(naverAutoBidRuns).set(patch).where(and(
    eq(naverAutoBidRuns.id, existing.id),
    eq(naverAutoBidRuns.firmId, firmId),
  )).returning()
  if (!run) throw new NaverAutoBidPersistenceError('auto-bid run update returned no row')
  return { run, row: run, updated: true }
}

export type RecordNaverAutoBidDecisionInput = {
  firmId: number | string
  runId?: string
  runKey?: string
  keywordId?: string | null
  firmKeywordId?: string | null
  firmAdEntityId?: string | null
  naverKeywordId?: string
  providerKeywordId?: string
  device?: string
  status?: NaverAutoBidDecisionStatus | string
  beforeBid?: number | null
  estimatedBid?: number | null
  estimatedMinimumBid?: number | null
  minimumBid?: number | null
  targetBid?: number | null
  requestedBid?: number | null
  proposedBid?: number | null
  currentBid?: number | null
  afterBid?: number | null
  beforeUseGroupBid?: boolean | null
  afterUseGroupBid?: boolean | null
  reason?: string | null
  reasonCode?: string | null
  reasonCodes?: readonly string[] | null
  cooldownActive?: boolean
  changed?: boolean
  cooldownUntil?: TimestampInput | null
  raw?: RawPayload | null
  requestRaw?: RawPayload | null
  responseRaw?: RawPayload | null
  error?: string | null
  verificationStatus?: NaverAutoBidVerificationStatus | string
  verificationError?: string | null
  verificationRaw?: RawPayload | null
  verifiedAt?: TimestampInput | null
  appliedAt?: TimestampInput | null
  decidedAt?: TimestampInput
  updatedAt?: TimestampInput
}

export type RecordNaverAutoBidDecisionResult = {
  decision: DecisionRow
  row: DecisionRow
  inserted: boolean
  updated: boolean
}

function naverKeywordIdValue(input: RecordNaverAutoBidDecisionInput): string {
  return requiredText(input.naverKeywordId ?? input.providerKeywordId, 'naverKeywordId')
}

function bidValue(value: number | null | undefined, label: string): number | null | undefined {
  return optionalInteger(value, label)
}

/** Insert or update one decision by its run/key-provider keyword idempotency key. */
export async function recordNaverAutoBidDecision(
  db: Db,
  input: RecordNaverAutoBidDecisionInput,
): Promise<RecordNaverAutoBidDecisionResult> {
  const firmId = firmIdValue(input.firmId)
  await assertFirmExists(db, firmId)
  const run = await runInFirm(db, firmId, input.runId, input.runKey)
  const naverKeywordId = naverKeywordIdValue(input)
  const links = await decisionLinksInFirm(db, firmId, {
    keywordId: input.keywordId,
    firmKeywordId: input.firmKeywordId,
    firmAdEntityId: input.firmAdEntityId,
    naverKeywordId,
  })
  const status = input.status === undefined
    ? undefined
    : statusValue<NaverAutoBidDecisionStatus>(input.status, 'status', 'planned')
  const device = input.device === undefined ? undefined : deviceValue(input.device)
  const beforeBid = bidValue(input.beforeBid ?? input.currentBid, 'beforeBid')
  const estimatedBid = bidValue(input.estimatedBid ?? input.estimatedMinimumBid ?? input.minimumBid, 'estimatedBid')
  const targetBid = bidValue(input.targetBid ?? input.requestedBid ?? input.proposedBid, 'targetBid')
  const afterBid = bidValue(input.afterBid, 'afterBid')
  const reason = input.reason === undefined
    ? optionalText(input.reasonCode, 'reasonCode')
    : optionalText(input.reason, 'reason')
  const cooldownUntil = optionalTimestamp(input.cooldownUntil, 'cooldownUntil')
  const raw = rawPayload(input.raw, 'raw')
  const requestRaw = rawPayload(input.requestRaw, 'requestRaw')
  const responseRaw = rawPayload(input.responseRaw, 'responseRaw')
  const error = input.error === undefined ? undefined : optionalText(input.error, 'error')
  const verificationStatus = input.verificationStatus === undefined
    ? undefined
    : statusValue<NaverAutoBidVerificationStatus>(input.verificationStatus, 'verificationStatus', 'not_started')
  const verificationError = input.verificationError === undefined
    ? undefined
    : optionalText(input.verificationError, 'verificationError')
  const verificationRaw = rawPayload(input.verificationRaw, 'verificationRaw')
  const verifiedAt = optionalTimestamp(input.verifiedAt, 'verifiedAt')
  const appliedAt = optionalTimestamp(input.appliedAt, 'appliedAt')
  const decidedAt = input.decidedAt === undefined
    ? undefined
    : timestampValue(input.decidedAt, 'decidedAt')
  const updatedAt = timestampValue(input.updatedAt ?? input.decidedAt, 'updatedAt')
  const reasonCodes = input.reasonCodes === undefined || input.reasonCodes === null
    ? undefined
    : input.reasonCodes.map((code, index) => requiredText(code, `reasonCodes[${index}]`))
  const rawWithDecision = raw === undefined && (input.reasonCode !== undefined || reasonCodes !== undefined || input.cooldownActive !== undefined || input.changed !== undefined)
    ? {
      ...(input.reasonCode === undefined ? {} : { reasonCode: input.reasonCode }),
      ...(reasonCodes === undefined ? {} : { reasonCodes }),
      ...(input.cooldownActive === undefined ? {} : { cooldownActive: input.cooldownActive }),
      ...(input.changed === undefined ? {} : { changed: input.changed }),
    }
    : raw

  const [before] = await db.select().from(naverAutoBidDecisions).where(and(
    eq(naverAutoBidDecisions.firmId, firmId),
    eq(naverAutoBidDecisions.runId, run.id),
    eq(naverAutoBidDecisions.naverKeywordId, naverKeywordId),
  )).limit(1)

  const values: typeof naverAutoBidDecisions.$inferInsert = {
    firmId,
    runId: run.id,
    naverKeywordId,
    ...(links.keywordId === undefined ? {} : { keywordId: links.keywordId }),
    ...(links.firmKeywordId === undefined ? {} : { firmKeywordId: links.firmKeywordId }),
    ...(links.firmAdEntityId === undefined ? {} : { firmAdEntityId: links.firmAdEntityId }),
    ...(device === undefined ? {} : { device }),
    ...(status === undefined ? {} : { status }),
    ...(beforeBid === undefined ? {} : { beforeBid }),
    ...(estimatedBid === undefined ? {} : { estimatedBid }),
    ...(targetBid === undefined ? {} : { targetBid }),
    ...(afterBid === undefined ? {} : { afterBid }),
    ...(input.beforeUseGroupBid === undefined ? {} : { beforeUseGroupBid: input.beforeUseGroupBid }),
    ...(input.afterUseGroupBid === undefined ? {} : { afterUseGroupBid: input.afterUseGroupBid }),
    ...(reason === undefined ? {} : { reason }),
    ...(cooldownUntil === undefined ? {} : { cooldownUntil }),
    ...(rawWithDecision === undefined ? {} : { raw: rawWithDecision }),
    ...(requestRaw === undefined ? {} : { requestRaw }),
    ...(responseRaw === undefined ? {} : { responseRaw }),
    ...(error === undefined ? {} : { error }),
    ...(verificationStatus === undefined ? {} : { verificationStatus }),
    ...(verificationError === undefined ? {} : { verificationError }),
    ...(verificationRaw === undefined ? {} : { verificationRaw }),
    ...(verifiedAt === undefined ? {} : { verifiedAt }),
    ...(appliedAt === undefined ? {} : { appliedAt }),
    ...(decidedAt === undefined ? {} : { decidedAt }),
    updatedAt,
  }
  const update: Partial<typeof naverAutoBidDecisions.$inferInsert> = {
    ...(links.keywordId === undefined ? {} : { keywordId: links.keywordId }),
    ...(links.firmKeywordId === undefined ? {} : { firmKeywordId: links.firmKeywordId }),
    ...(links.firmAdEntityId === undefined ? {} : { firmAdEntityId: links.firmAdEntityId }),
    ...(device === undefined ? {} : { device }),
    ...(status === undefined ? {} : { status }),
    ...(beforeBid === undefined ? {} : { beforeBid }),
    ...(estimatedBid === undefined ? {} : { estimatedBid }),
    ...(targetBid === undefined ? {} : { targetBid }),
    ...(afterBid === undefined ? {} : { afterBid }),
    ...(input.beforeUseGroupBid === undefined ? {} : { beforeUseGroupBid: input.beforeUseGroupBid }),
    ...(input.afterUseGroupBid === undefined ? {} : { afterUseGroupBid: input.afterUseGroupBid }),
    ...(reason === undefined ? {} : { reason }),
    ...(cooldownUntil === undefined ? {} : { cooldownUntil }),
    ...(rawWithDecision === undefined ? {} : { raw: rawWithDecision }),
    ...(requestRaw === undefined ? {} : { requestRaw }),
    ...(responseRaw === undefined ? {} : { responseRaw }),
    ...(error === undefined ? {} : { error }),
    ...(verificationStatus === undefined ? {} : { verificationStatus }),
    ...(verificationError === undefined ? {} : { verificationError }),
    ...(verificationRaw === undefined ? {} : { verificationRaw }),
    ...(verifiedAt === undefined ? {} : { verifiedAt }),
    ...(appliedAt === undefined ? {} : { appliedAt }),
    ...(decidedAt === undefined ? {} : { decidedAt }),
    updatedAt,
  }
  const [decision] = await db.insert(naverAutoBidDecisions).values(values).onConflictDoUpdate({
    target: [naverAutoBidDecisions.runId, naverAutoBidDecisions.naverKeywordId],
    set: update,
  }).returning()
  if (!decision) throw new NaverAutoBidPersistenceError('auto-bid decision upsert returned no row')
  return { decision, row: decision, inserted: !before, updated: Boolean(before) }
}

export async function recordNaverAutoBidDecisions(
  db: Db,
  inputs: readonly RecordNaverAutoBidDecisionInput[],
): Promise<RecordNaverAutoBidDecisionResult[]> {
  const results: RecordNaverAutoBidDecisionResult[] = []
  for (const input of inputs) results.push(await recordNaverAutoBidDecision(db, input))
  return results
}

export type UpdateNaverAutoBidDecisionInput = Omit<
  RecordNaverAutoBidDecisionInput,
  'firmId' | 'runId' | 'runKey' | 'naverKeywordId' | 'providerKeywordId'
> & {
  firmId: number | string
  decisionId: string
}

export type UpdateNaverAutoBidDecisionResult = { decision: DecisionRow; row: DecisionRow; updated: boolean }

/** Update provider/apply/verification fields for one firm-owned decision. */
export async function updateNaverAutoBidDecision(
  db: Db,
  input: UpdateNaverAutoBidDecisionInput,
): Promise<UpdateNaverAutoBidDecisionResult> {
  const firmId = firmIdValue(input.firmId)
  await assertFirmExists(db, firmId)
  const decisionId = requiredText(input.decisionId, 'decisionId')
  const [existing] = await db.select().from(naverAutoBidDecisions).where(and(
    eq(naverAutoBidDecisions.id, decisionId),
    eq(naverAutoBidDecisions.firmId, firmId),
  )).limit(1)
  if (!existing) throw new NaverAutoBidScopeError('auto-bid decision was not found in firm scope')

  const naverKeywordId = existing.naverKeywordId
  const links = await decisionLinksInFirm(db, firmId, {
    keywordId: input.keywordId,
    firmKeywordId: input.firmKeywordId,
    firmAdEntityId: input.firmAdEntityId,
    naverKeywordId,
  })
  const patch: Partial<typeof naverAutoBidDecisions.$inferInsert> = {
    updatedAt: timestampValue(input.updatedAt, 'updatedAt'),
  }
  if (links.keywordId !== undefined) patch.keywordId = links.keywordId
  if (links.firmKeywordId !== undefined) patch.firmKeywordId = links.firmKeywordId
  if (links.firmAdEntityId !== undefined) patch.firmAdEntityId = links.firmAdEntityId
  if (input.device !== undefined) patch.device = deviceValue(input.device)
  if (input.status !== undefined) patch.status = statusValue<NaverAutoBidDecisionStatus>(input.status, 'status', existing.status as NaverAutoBidDecisionStatus)
  if (input.beforeBid !== undefined || input.currentBid !== undefined) patch.beforeBid = bidValue(input.beforeBid ?? input.currentBid, 'beforeBid')
  if (input.estimatedBid !== undefined || input.estimatedMinimumBid !== undefined || input.minimumBid !== undefined) {
    patch.estimatedBid = bidValue(input.estimatedBid ?? input.estimatedMinimumBid ?? input.minimumBid, 'estimatedBid')
  }
  if (input.targetBid !== undefined || input.requestedBid !== undefined || input.proposedBid !== undefined) {
    patch.targetBid = bidValue(input.targetBid ?? input.requestedBid ?? input.proposedBid, 'targetBid')
  }
  if (input.afterBid !== undefined) patch.afterBid = bidValue(input.afterBid, 'afterBid')
  if (input.beforeUseGroupBid !== undefined) patch.beforeUseGroupBid = input.beforeUseGroupBid
  if (input.afterUseGroupBid !== undefined) patch.afterUseGroupBid = input.afterUseGroupBid
  if (input.reason !== undefined || input.reasonCode !== undefined) {
    patch.reason = optionalText(input.reason ?? input.reasonCode, 'reason') ?? null
  }
  if (input.cooldownUntil !== undefined) patch.cooldownUntil = optionalTimestamp(input.cooldownUntil, 'cooldownUntil') ?? null
  if (input.raw !== undefined) patch.raw = rawPayload(input.raw, 'raw')
  if (input.requestRaw !== undefined) patch.requestRaw = rawPayload(input.requestRaw, 'requestRaw')
  if (input.responseRaw !== undefined) patch.responseRaw = rawPayload(input.responseRaw, 'responseRaw')
  if (input.error !== undefined) patch.error = optionalText(input.error, 'error') ?? null
  if (input.verificationStatus !== undefined) patch.verificationStatus = statusValue<NaverAutoBidVerificationStatus>(input.verificationStatus, 'verificationStatus', existing.verificationStatus as NaverAutoBidVerificationStatus)
  if (input.verificationError !== undefined) patch.verificationError = optionalText(input.verificationError, 'verificationError') ?? null
  if (input.verificationRaw !== undefined) patch.verificationRaw = rawPayload(input.verificationRaw, 'verificationRaw')
  if (input.verifiedAt !== undefined) patch.verifiedAt = optionalTimestamp(input.verifiedAt, 'verifiedAt') ?? null
  if (input.appliedAt !== undefined) patch.appliedAt = optionalTimestamp(input.appliedAt, 'appliedAt') ?? null
  if (input.decidedAt !== undefined) patch.decidedAt = timestampValue(input.decidedAt, 'decidedAt')

  const [decision] = await db.update(naverAutoBidDecisions).set(patch).where(and(
    eq(naverAutoBidDecisions.id, existing.id),
    eq(naverAutoBidDecisions.firmId, firmId),
  )).returning()
  if (!decision) throw new NaverAutoBidPersistenceError('auto-bid decision update returned no row')
  return { decision, row: decision, updated: true }
}

export async function getNaverAutoBidRun(
  db: Db,
  input: { firmId: number | string; runId?: string; runKey?: string },
): Promise<RunRow | null> {
  const firmId = firmIdValue(input.firmId)
  await assertFirmExists(db, firmId)
  try {
    return await runInFirm(db, firmId, input.runId, input.runKey)
  } catch (error) {
    if (error instanceof NaverAutoBidScopeError) return null
    throw error
  }
}

export async function listNaverAutoBidRuns(
  db: Db,
  firmIdInput: number | string,
  options: { status?: string; limit?: number } = {},
): Promise<RunRow[]> {
  const firmId = firmIdValue(firmIdInput)
  await assertFirmExists(db, firmId)
  const limit = integerValue(options.limit, 'limit', { defaultValue: 100, min: 1 })
  if (limit > 1_000) throw new NaverAutoBidPersistenceError('limit must not exceed 1000')
  const filters = [eq(naverAutoBidRuns.firmId, firmId)]
  if (options.status !== undefined) filters.push(eq(naverAutoBidRuns.status, requiredText(options.status, 'status') as NaverAutoBidRunStatus))
  return db.select().from(naverAutoBidRuns)
    .where(and(...filters))
    .orderBy(desc(naverAutoBidRuns.createdAt), desc(naverAutoBidRuns.id))
    .limit(limit)
}

export async function listNaverAutoBidDecisions(
  db: Db,
  input: { firmId: number | string; runId?: string; runKey?: string; status?: string; limit?: number },
): Promise<DecisionRow[]> {
  const firmId = firmIdValue(input.firmId)
  await assertFirmExists(db, firmId)
  const run = input.runId || input.runKey
    ? await runInFirm(db, firmId, input.runId, input.runKey)
    : null
  const limit = integerValue(input.limit, 'limit', { defaultValue: 1_000, min: 1 })
  if (limit > 5_000) throw new NaverAutoBidPersistenceError('limit must not exceed 5000')
  const filters = [eq(naverAutoBidDecisions.firmId, firmId)]
  if (run) filters.push(eq(naverAutoBidDecisions.runId, run.id))
  if (input.status !== undefined) filters.push(eq(naverAutoBidDecisions.status, requiredText(input.status, 'status') as NaverAutoBidDecisionStatus))
  return db.select().from(naverAutoBidDecisions)
    .where(and(...filters))
    .orderBy(asc(naverAutoBidDecisions.decidedAt), asc(naverAutoBidDecisions.id))
    .limit(limit)
}

// Short aliases keep the program-facing surface convenient while the explicit
// names above make the Naver-specific persistence boundary clear to callers.
export const upsertAutoBidPolicy = upsertNaverAutoBidPolicy
export const getAutoBidPolicy = getNaverAutoBidPolicy
export const startAutoBidRun = startNaverAutoBidRun
export const createAutoBidRun = startNaverAutoBidRun
export const updateAutoBidRun = updateNaverAutoBidRun
export const recordAutoBidDecision = recordNaverAutoBidDecision
export const recordAutoBidDecisions = recordNaverAutoBidDecisions
export const updateAutoBidDecision = updateNaverAutoBidDecision
export const getAutoBidRun = getNaverAutoBidRun
export const listAutoBidRuns = listNaverAutoBidRuns
export const listAutoBidDecisions = listNaverAutoBidDecisions

export type { DecisionRow as NaverAutoBidDecisionRow, PolicyRow as NaverAutoBidPolicyRow, RunRow as NaverAutoBidRunRow }
