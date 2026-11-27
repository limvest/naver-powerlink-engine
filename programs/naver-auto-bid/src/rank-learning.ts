import type { ObservedRank, ObservedRankStatus } from './rank-observer'

export const RANK_OBSERVATION_WINDOW = 24
export const UNEXPOSED_HOLD_BID_THRESHOLD = 1_500
const CONFIRMATION_WINDOW = 3
const BID_GRANULARITY = 10
const EVIDENCE_MAX_AGE_MS = 60 * 60 * 1_000
const BRACKET_MAX_IDLE_MS = 24 * 60 * 60 * 1_000

export interface CompactRankObservation {
  readonly biddingEligible?: boolean
  readonly device?: 'mobile' | 'pc'
  readonly at: string
  readonly bid: number | null
  readonly status: ObservedRankStatus
  readonly rank: number | null
  readonly visibleAds: number
  readonly legalCompetitorCount: number
  readonly targetPosition: number
}

export interface BidLearningState {
  readonly phase: 'observe' | 'acquire' | 'minimize' | 'hold' | 'capped' | 'unexposed'
  readonly highestBadBid: number | null
  readonly lowestGoodBid: number | null
  readonly highestBadAt: string | null
  readonly lowestGoodAt: string | null
  readonly recommendedBid: number | null
  readonly evidenceAtCurrentBid: number
  readonly goodEvidence: number
  readonly badEvidence: number
  readonly targetConfirmed: boolean
  readonly updatedAt: string
}

export interface RankLearningInput {
  readonly confirmationReads?: 1 | 3
  readonly biddingEligible?: boolean
  readonly priorWindow?: readonly CompactRankObservation[] | null
  readonly priorLearning?: Partial<BidLearningState> | null
  readonly observation: ObservedRank
  readonly currentBid: number | null
  readonly targetPosition: number
  readonly floor: number
  readonly ceiling: number
  readonly stepUp: number
  readonly stepDown: number
}

export interface RankLearningResult {
  readonly window: readonly CompactRankObservation[]
  readonly learning: BidLearningState
  readonly stateChanged: boolean
}

function safeBid(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}

function clamp(value: number, floor: number, ceiling: number): number {
  return Math.min(ceiling, Math.max(floor, value))
}

function snapDown(value: number): number {
  return Math.floor(value / BID_GRANULARITY) * BID_GRANULARITY
}

function snapUp(value: number): number {
  return Math.ceil(value / BID_GRANULARITY) * BID_GRANULARITY
}

function isGood(value: CompactRankObservation): boolean {
  return value.status === 'found' && value.rank !== null && value.rank <= value.targetPosition
}

function isBad(value: CompactRankObservation): boolean {
  return value.status === 'outside'
    || (value.status === 'found' && value.rank !== null && value.rank > value.targetPosition)
}

/**
 * Maintain a fixed-size evidence window and a bid bracket.  A bid is not
 * changed from one volatile SERP read by default: three consecutive reads at
 * the same bid and two agreeing observations are required. The operator's
 * streaming mode explicitly selects one fresh read, with bounded bid steps
 * and a delayed outcome check; historical disagreement cannot override that read.
 */
export function updateRankLearning(input: RankLearningInput): RankLearningResult {
  const requiredReads = input.confirmationReads ?? CONFIRMATION_WINDOW
  const requiredAgreement = requiredReads === 1 ? 1 : 2
  const current: CompactRankObservation = {
    biddingEligible: input.biddingEligible ?? true,
    device: input.observation.device,
    at: input.observation.observedAt,
    bid: input.currentBid,
    status: input.observation.status,
    rank: input.observation.rank,
    visibleAds: input.observation.visibleAds,
    legalCompetitorCount: input.observation.legalCompetitorCount,
    targetPosition: input.targetPosition,
  }
  const priorWindow = Array.isArray(input.priorWindow) ? input.priorWindow : []
  const previous = priorWindow.at(-1)
  const observedAt = Date.parse(current.at)
  const fresh = Number.isFinite(observedAt) && (!previous || observedAt > Date.parse(previous.at))
  const window = (fresh ? [...priorWindow, current] : priorWindow).slice(-RANK_OBSERVATION_WINDOW)

  const evidence: CompactRankObservation[] = []
  const seenTimes = new Set<number>()
  for (let index = window.length - 1; fresh && index >= 0 && evidence.length < CONFIRMATION_WINDOW; index -= 1) {
    const item = window[index]
    const at = Date.parse(item.at)
    if (!Number.isFinite(at) || at > observedAt || observedAt - at > EVIDENCE_MAX_AGE_MS) break
    if (item.biddingEligible === false || item.bid !== input.currentBid || item.targetPosition !== input.targetPosition
      || (item.device !== undefined && item.device !== input.observation.device)) break
    if (seenTimes.has(at)) continue
    seenTimes.add(at)
    evidence.unshift(item)
  }
  const goodEvidence = evidence.filter(isGood).length
  const badEvidence = evidence.filter(isBad).length
  const confirmedGood = (requiredReads === 1 ? isGood(current) : current.status !== 'no_ads')
    && evidence.length >= requiredReads && goodEvidence >= requiredAgreement
  const confirmedBad = (requiredReads === 1 ? isBad(current) : current.status !== 'no_ads')
    && evidence.length >= requiredReads && badEvidence >= requiredAgreement

  const contextChanged = previous !== undefined && (
    previous.targetPosition !== input.targetPosition
    || (previous.device !== undefined && previous.device !== input.observation.device)
    || observedAt - Date.parse(previous.at) > BRACKET_MAX_IDLE_MS
  )
  let highestBadBid = contextChanged ? null : safeBid(input.priorLearning?.highestBadBid)
  let lowestGoodBid = contextChanged ? null : safeBid(input.priorLearning?.lowestGoodBid)
  let highestBadAt = input.priorLearning?.highestBadAt ?? input.priorLearning?.updatedAt ?? previous?.at ?? current.at
  let lowestGoodAt = input.priorLearning?.lowestGoodAt ?? input.priorLearning?.updatedAt ?? previous?.at ?? current.at
  const expired = (at: string) => !Number.isFinite(Date.parse(at))
    || Date.parse(at) > observedAt || observedAt - Date.parse(at) > BRACKET_MAX_IDLE_MS
  if (expired(highestBadAt)) highestBadBid = null
  if (expired(lowestGoodAt)) lowestGoodBid = null
  if (input.currentBid !== null && confirmedGood) {
    if (lowestGoodBid === null || input.currentBid <= lowestGoodBid) lowestGoodAt = current.at
    lowestGoodBid = lowestGoodBid === null ? input.currentBid : Math.min(lowestGoodBid, input.currentBid)
    if (highestBadBid !== null && highestBadBid >= lowestGoodBid) highestBadBid = null
  }
  if (input.currentBid !== null && confirmedBad) {
    if (highestBadBid === null || input.currentBid >= highestBadBid) highestBadAt = current.at
    highestBadBid = highestBadBid === null ? input.currentBid : Math.max(highestBadBid, input.currentBid)
    if (lowestGoodBid !== null && lowestGoodBid <= highestBadBid) lowestGoodBid = null
  }

  let phase: BidLearningState['phase'] = 'observe'
  let recommendedBid = input.currentBid
  if (input.currentBid !== null && confirmedGood) {
    phase = 'minimize'
    if (highestBadBid !== null) {
      if (highestBadBid + BID_GRANULARITY >= input.currentBid) {
        phase = 'hold'
      } else {
        recommendedBid = snapDown((highestBadBid + input.currentBid) / 2)
      }
    } else {
      recommendedBid = input.currentBid - input.stepDown
    }
  } else if (input.currentBid !== null && confirmedBad
    && current.status === 'outside' && input.currentBid > UNEXPOSED_HOLD_BID_THRESHOLD) {
    // Today's safety policy: once an already-high bid is still absent from a
    // populated Powerlink result, record it as unexposed instead of buying the
    // next step. Existing bids are preserved; this is not a bulk rollback.
    phase = 'unexposed'
    recommendedBid = input.currentBid
  } else if (input.currentBid !== null && confirmedBad) {
    phase = input.currentBid >= input.ceiling ? 'capped' : 'acquire'
    if (lowestGoodBid !== null) {
      recommendedBid = snapUp((input.currentBid + lowestGoodBid) / 2)
    } else {
      recommendedBid = input.currentBid + input.stepUp
    }
  } else if (input.currentBid !== null && evidence.length >= CONFIRMATION_WINDOW) {
    phase = 'hold'
  }
  if (recommendedBid !== null) recommendedBid = clamp(recommendedBid, input.floor, input.ceiling)
  if (confirmedGood && recommendedBid === input.currentBid) phase = 'hold'

  const previousStatus = priorWindow.at(-1)?.status ?? null
  const previousRank = priorWindow.at(-1)?.rank ?? null
  const previousCompetitors = priorWindow.at(-1)?.legalCompetitorCount ?? null
  return {
    window,
    learning: {
      phase,
      highestBadBid,
      lowestGoodBid,
      highestBadAt: highestBadBid === null ? null : highestBadAt,
      lowestGoodAt: lowestGoodBid === null ? null : lowestGoodAt,
      recommendedBid,
      evidenceAtCurrentBid: evidence.length,
      goodEvidence,
      badEvidence,
      targetConfirmed: confirmedGood,
      updatedAt: fresh ? input.observation.observedAt : previous?.at ?? input.observation.observedAt,
    },
    stateChanged: fresh && (previousStatus !== current.status
      || previousRank !== current.rank
      || previousCompetitors !== current.legalCompetitorCount),
  }
}
