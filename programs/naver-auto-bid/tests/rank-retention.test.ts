import { describe, expect, it } from 'vitest'
import { createTestDb } from '../../../tests/helpers/test-db'
import { firms, naverAutoBidRuns, naverAutoBidDecisions, naverAutoBidEvents } from '@/lib/db/schema'
import { pruneRankEvidence } from '../src/rank-retention'

describe('rank evidence retention', () => {
  it('bounds old redundant reads while preserving current, live, failed and other-firm evidence', async () => {
    const db = await createTestDb()
    await db.insert(firms).values([701, 702].map(id => ({ id, slug: `retention-${id}`,
      name: 'Retention', adLawyerName: 'Lawyer', phone: '00', phoneIntl: '+8200',
      address: 'Seoul', addressRegion: 'Seoul', addressLocality: 'Seoul' })))
    const old = new Date(Date.now() - 40 * 86400_000)
    const specs = [
      ...Array.from({ length: 5 }, () => ({ firmId: 701, kind: 'old' })),
      { firmId: 701, kind: 'live' }, { firmId: 701, kind: 'running' },
      { firmId: 701, kind: 'error' }, { firmId: 701, kind: 'recent' },
      { firmId: 702, kind: 'other' },
    ]
    const protectedIds: string[] = []
    let eventRun = ''
    for (const [index, spec] of specs.entries()) {
      const [run] = await db.insert(naverAutoBidRuns).values({
        firmId: spec.firmId, runKey: `retention-${index}`,
        dryRun: spec.kind !== 'live', status: spec.kind === 'running' ? 'running' : 'completed',
        finishedAt: spec.kind === 'running' ? null : old,
      }).returning()
      if (index === 0) eventRun = run.id
      const [decision] = await db.insert(naverAutoBidDecisions).values({
        firmId: spec.firmId, runId: run.id, naverKeywordId: 'same-keyword',
        status: spec.kind === 'live' ? 'verified' : 'skipped',
        appliedAt: spec.kind === 'live' ? old : null,
        error: spec.kind === 'error' ? 'unresolved' : null,
        createdAt: spec.kind === 'recent' ? new Date() : new Date(old.getTime() + index),
      }).returning()
      if (spec.kind !== 'old') protectedIds.push(decision.id)
    }
    await db.insert(naverAutoBidEvents).values(Array.from({ length: 26 }, (_, index) => ({
      firmId: 701, runId: eventRun, naverKeywordId: 'same-keyword', message: 'rank changed',
      eventType: index === 25 ? 'bid_change' as const : 'rank_observation' as const,
      createdAt: new Date(old.getTime() + index),
    })))
    expect(await pruneRankEvidence(db, 701)).toEqual({ removedReadOnlyDecisions: 3, removedRankEvents: 1 })
    const remaining = await db.select().from(naverAutoBidDecisions)
    for (const id of protectedIds) expect(remaining.some(row => row.id === id)).toBe(true)
    expect(await db.select().from(naverAutoBidEvents)).toHaveLength(25)
    expect(await pruneRankEvidence(db, 701)).toEqual({ removedReadOnlyDecisions: 0, removedRankEvents: 0 })
  })
})
