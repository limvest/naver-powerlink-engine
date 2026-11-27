import { describe, expect, it } from 'vitest'
import { parseArgs } from '../src/config'
import { runStages } from '../src/cli'

describe('auto-bid stage failure propagation', () => {
  it('preserves the partial report in logs and rejects so the worker and shell record failure', async () => {
    const config = parseArgs(['--firm', '701', '--stage', 'report'], { env: {} })
    const logs: string[] = []
    await expect(runStages(config, {
      report: async () => ({ status: 'partial', observationFailures: 6 }),
    }, line => logs.push(line))).rejects.toThrow('report ended with partial')
    expect(JSON.parse(logs[0]).result).toEqual({ status: 'partial', observationFailures: 6 })
  })
})
