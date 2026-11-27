export interface QueryJob {
  id: string
  keyword: string
  group: string
  /** Naver campaign name; group IDs must never be executed under a different campaign. */
  campaignName?: string
  recheck: boolean
  readyAt: number
}

/** Bounded completion-order query pool; only commit may mutate bids or DB runs. */
export async function runParallelBidPipeline<T>(initial: QueryJob[], handlers: {
  query(job: QueryJob): Promise<T>
  commit(rows: { job: QueryJob; value: T }[]): Promise<QueryJob[]>
  now(): number
  sleep(ms: number): Promise<void>
  concurrency?: number
  bufferLimit?: number
  batchWaitMs?: number
  shouldStop?(): boolean
}) {
  const startedAt = handlers.now()
  const fresh = initial.filter(job=>job.readyAt<=startedAt)
  let cursor = 0
  const delayed: QueryJob[] = initial.filter(job=>job.readyAt>startedAt).sort((a,b)=>a.readyAt-b.readyAt)
  const ready: { job: QueryJob; value: T; receivedAt: number }[] = []
  const active = new Set<Promise<void>>()
  let failure: unknown
  let failed = false
  let committing: Promise<void> | null = null
  let lastWasRecheck = false
  const concurrency = handlers.concurrency ?? 24
  const limit = handlers.bufferLimit ?? 100
  const batchWait = handlers.batchWaitMs ?? 1000
  const metrics = { queries: 0, commits: 0, peakBuffered: 0, idleSleeps: 0, stopped: false }
  if (!Number.isInteger(concurrency) || concurrency < 1 || !Number.isInteger(limit) || limit < concurrency
    || !Number.isFinite(batchWait) || batchWait < 0 || batchWait > 5000) throw new Error('invalid pool limits')
  while (cursor < fresh.length || delayed.length || ready.length || active.size || committing) {
    if (failed) break
    if (handlers.shouldStop?.()) { metrics.stopped = true; break }
    while (active.size < concurrency && ready.length + active.size < limit) {
      const due = delayed[0]?.readyAt <= handlers.now()
      // Alternate when both queues have work, so neither starves.
      const job: QueryJob | undefined = due && (!lastWasRecheck || cursor >= fresh.length) ? delayed.shift()
        : cursor < fresh.length ? fresh[cursor++] : (due ? delayed.shift() : undefined)
      if (!job) break
      lastWasRecheck = job.recheck
      metrics.queries++
      const task = Promise.resolve().then(() => handlers.query(job)).then(value => { ready.push({ job, value, receivedAt: handlers.now() }) })
        .catch(error => { failed = true; failure = error }).finally(() => { active.delete(task) })
      active.add(task)
    }
    if (!committing && ready.length) {
      const first = ready.find(row => row.job.recheck) ?? ready[0]
      const batch: typeof ready = []
      const matching = ready.filter(row => row.job.group === first.job.group
        && row.job.campaignName === first.job.campaignName && row.job.recheck === first.job.recheck).length
      const flush = first.job.recheck || matching >= 50 || handlers.now() - first.receivedAt >= batchWait
        || ready.length + active.size >= limit || (cursor >= fresh.length && !active.size)
      for (let i = 0; flush && i < ready.length && batch.length < 50;) {
        if (ready[i].job.group === first.job.group
          && ready[i].job.campaignName === first.job.campaignName
          && ready[i].job.recheck === first.job.recheck)
          batch.push(...ready.splice(i, 1))
        else i++
      }
      if (batch.length) {
        metrics.commits++
        committing = Promise.resolve().then(() => handlers.commit(batch)).then(jobs => {
          delayed.push(...jobs)
          if (jobs.length) delayed.sort((a, b) => a.readyAt - b.readyAt)
        }).catch(error => { failed = true; failure = error }).finally(() => { committing = null })
      }
    }
    metrics.peakBuffered = Math.max(metrics.peakBuffered, ready.length + active.size)
    if (cursor < fresh.length || delayed.length || ready.length || active.size || committing) {
      const idle = cursor >= fresh.length && !ready.length && !active.size && !committing && delayed.length > 0
      if (idle) metrics.idleSleeps++
      await handlers.sleep(idle ? Math.max(20, Math.min(1000, delayed[0].readyAt - handlers.now())) : 20)
    }
  }
  await Promise.allSettled([...active, ...(committing ? [committing] : [])])
  if (failed) throw failure // never retry a possibly applied mutation
  return metrics
}
