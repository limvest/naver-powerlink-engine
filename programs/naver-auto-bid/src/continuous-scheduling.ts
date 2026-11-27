import { bidReadyAt, rankQueuePriority } from './bid-settlement'

export type ObservationState = {
 lastObservedAt: Date | null
 lastChangedAt: Date | null
 lastObservedStatus: string | null
 consecutiveStatusCount: number
}

export function needsSettlementCheck(state: ObservationState): boolean {
 return !!state.lastChangedAt && (state.lastObservedAt?.getTime() ?? 0) < bidReadyAt(state.lastChangedAt)
}

/** Read cadence only; never changes bids, limits, eligibility or deletion state. */
export function observationDueAt(state: ObservationState, now: number): number {
 const observed = state.lastObservedAt?.getTime()
 if (needsSettlementCheck(state)) return bidReadyAt(state.lastChangedAt)
 if (!observed || !Number.isFinite(observed) || observed > now) return 0
 // Repeated empty ad surfaces merit a slower probe, never permanent exclusion.
 const interval = state.lastObservedStatus === 'no_ads' && state.consecutiveStatusCount >= 3 ? 30 * 60_000 : 5 * 60_000
 return observed + interval
}

export function compareObservationPriority(a: ObservationState, b: ObservationState, now: number): number {
 return rankQueuePriority(a.lastChangedAt,a.lastObservedAt,now) - rankQueuePriority(b.lastChangedAt,b.lastObservedAt,now)
  || (a.lastObservedAt?.getTime() ?? 0) - (b.lastObservedAt?.getTime() ?? 0)
}
