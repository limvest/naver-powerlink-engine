/** User-specified propagation allowance; API read-back is not SERP settlement. */
export const BID_SETTLEMENT_MS = 3 * 60_000

export function bidReadyAt(changedAt: unknown): number {
  if (changedAt === null || changedAt === undefined) return 0
  const at = changedAt instanceof Date ? changedAt.getTime() : Date.parse(String(changedAt))
  return Number.isFinite(at) ? at + BID_SETTLEMENT_MS : Infinity
}

export function bidIsSettled(changedAt: unknown, now: number): boolean {
  return now >= bidReadyAt(changedAt)
}

/** Due post-change checks precede ordinary oldest-first coverage. No sleeping. */
export function rankQueuePriority(changedAt: unknown, observedAt: unknown, now: number): number {
  const ready = bidReadyAt(changedAt)
  if (ready > now) return 2
  const observed = Date.parse(String(observedAt ?? ''))
  return ready > 0 && (!Number.isFinite(observed) || observed < ready) ? 0 : 1
}
