export interface PipelineBatch {
  key: string
  ids: string[]
  /** Required when a continuous run spans more than one Naver campaign. */
  campaignName?: string
}
export interface RecheckBatch extends PipelineBatch { readyAt: number }

/** One pass of mutations with interleaved due rechecks. Waiting never blocks fresh work. */
export async function runBidPipeline(
  batches: readonly PipelineBatch[],
  handlers: {
    execute(batch: PipelineBatch): Promise<RecheckBatch | null>
    recheck(batch: RecheckBatch): Promise<void>
    now(): number
    sleep(ms: number): Promise<void>
  },
) {
  const pending: RecheckBatch[] = []
  let cursor = 0
  let rechecked = 0
  while (cursor < batches.length || pending.length) {
    pending.sort((a, b) => a.readyAt - b.readyAt)
    const due = pending[0]
    if (due && due.readyAt <= handlers.now()) {
      pending.shift()
      await handlers.recheck(due)
      rechecked += due.ids.length
    } else if (cursor < batches.length) {
      const result = await handlers.execute(batches[cursor++])
      if (result) pending.push(result)
    } else if (due) {
      await handlers.sleep(Math.min(60_000, Math.max(1, due.readyAt - handlers.now())))
    }
  }
  return { batches: cursor, rechecked }
}
