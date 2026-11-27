import type { ObservedRank } from './rank-observer'
import { bidIsSettled } from './bid-settlement'

export const BID_OUTCOME_LIMIT = 12

export interface VerifiedBidAction {
  decisionId: string
  device: 'mobile' | 'pc'
  appliedAt: string
  verifiedAt: string
  beforeBid: number | null
  afterBid: number
  beforeRank: number | null
  targetPosition: number
}

export interface BidOutcome extends VerifiedBidAction {
  firstObservedAt: string
  lastObservedAt: string
  observations: number
  targetHits: number
  targetMisses: number
  noAds: number
  latestRank: number | null
  latestStatus: ObservedRank['status']
  legalCompetitorCount: number
}

/** Associates subsequent observations with a verified action, not causal proof. */
export function recordBidOutcome(
  action: VerifiedBidAction | null,
  previous: readonly BidOutcome[],
  observation: ObservedRank,
  currentBid: number | null,
): BidOutcome[] {
  const history = previous.slice(-BID_OUTCOME_LIMIT)
  if (!action || action.device !== observation.device || currentBid !== action.afterBid
    || !bidIsSettled(action.appliedAt, Date.parse(observation.observedAt))
    || !(Date.parse(observation.observedAt) > Date.parse(action.verifiedAt))) return history
  const existing = history.find(item => item.decisionId === action.decisionId)
  if (existing && Date.parse(observation.observedAt) <= Date.parse(existing.lastObservedAt)) return history
  const hit = observation.status === 'found' && observation.rank !== null
    && observation.rank <= action.targetPosition
  const outcome: BidOutcome = {
    ...action,
    firstObservedAt: existing?.firstObservedAt ?? observation.observedAt,
    lastObservedAt: observation.observedAt,
    observations: (existing?.observations ?? 0) + 1,
    targetHits: (existing?.targetHits ?? 0) + Number(hit),
    targetMisses: (existing?.targetMisses ?? 0) + Number(!hit && observation.status !== 'no_ads'),
    noAds: (existing?.noAds ?? 0) + Number(observation.status === 'no_ads'),
    latestRank: observation.rank,
    latestStatus: observation.status,
    legalCompetitorCount: observation.legalCompetitorCount,
  }
  return [...history.filter(item => item.decisionId !== action.decisionId), outcome].slice(-BID_OUTCOME_LIMIT)
}
