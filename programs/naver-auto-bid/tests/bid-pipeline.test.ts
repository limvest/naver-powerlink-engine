import { describe, expect, it } from 'vitest'
import { runBidPipeline } from '../src/bid-pipeline'

describe('streaming bid pipeline', () => {
  it('changes early batches immediately and rechecks them while other batches remain', async () => {
    let now = 0
    const events: string[] = []
    const result = await runBidPipeline(['a', 'b', 'c', 'd'].map(key => ({ key, ids: [key] })), {
      now: () => now,
      execute: async batch => {
        events.push(`write:${batch.key}`)
        now += 90_000
        return { ...batch, readyAt: now + 180_000 }
      },
      recheck: async batch => {
        expect(now).toBeGreaterThanOrEqual(batch.readyAt)
        events.push(`read:${batch.key}`)
      },
      sleep: async ms => {
        expect(ms).toBeLessThanOrEqual(60_000)
        expect(events).toContain('write:d')
        now += ms
      },
    })
    expect(events.slice(0, 5)).toEqual(['write:a', 'write:b', 'write:c', 'read:a', 'write:d'])
    expect(result).toEqual({ batches: 4, rechecked: 4 })
  })

  it('does not recheck unchanged keywords or retry uncertain mutations', async () => {
    let writes = 0
    await expect(runBidPipeline([{ key: 'a', ids: ['a'] }, { key: 'b', ids: ['b'] }], {
      now: Date.now,
      execute: async batch => {
        writes++
        if (batch.key === 'b') throw new Error('uncertain write')
        return null
      },
      recheck: async () => { throw new Error('unexpected recheck') },
      sleep: async () => { throw new Error('unexpected sleep') },
    })).rejects.toThrow('uncertain write')
    expect(writes).toBe(2)
  })
})
