import { describe, expect, it } from 'vitest'
import { assembleBulkSearchCampaignPlan } from '@/lib/engine/naver/bulk-search-plan'
import { DEFAULT_FIRM } from '@/lib/engine/firms'

const SAMPLEONE_FIRM = {
  ...DEFAULT_FIRM,
  id: 1001,
  slug: 'sampleone',
  name: '법무법인 샘플원',
  domain: 'sampleone.attorney',
}

describe('bulk exact-search campaign plan', () => {
  it('selects one exact term and its keyword-specific subdomain URL', () => {
    const plan = assembleBulkSearchCampaignPlan(SAMPLEONE_FIRM, [
      { keywordId: 'a', sourceName: '가상마켓A 출금 지연', slug: 'mockmarket-delay', hostLabel: 'mockmarket-a', sourceStatus: 'discovered', observationCount: 1 },
      { keywordId: 'b', sourceName: '가상마켓A', slug: 'mockmarket', hostLabel: 'mockmarket-b', sourceStatus: 'published', observationCount: 3 },
      { keywordId: 'c', sourceName: 'x7qkzvwpjrtmgbhdf', slug: 'junk', hostLabel: 'junk-c', sourceStatus: 'discovered', observationCount: 2 },
    ], new Date('2026-09-02T00:00:00.000Z'))

    expect(plan.sourceCount).toBe(3)
    expect(plan.acceptedBeforeDedupe).toBe(2)
    expect(plan.selectedCount).toBe(1)
    expect(plan.duplicates).toHaveLength(1)
    expect(plan.rejected).toEqual([expect.objectContaining({ keywordId: 'c', reason: 'random_ascii' })])
    const selected = plan.shards.flatMap((shard) => shard.entries)
    expect(selected[0].keywordId).toBe('b')
    expect(selected[0].landingUrl).toContain('https://mockmarket-b.sampleone.attorney/')
  })

  it('keeps a supplied admission set isolated from the rest of the corpus', () => {
    const plan = assembleBulkSearchCampaignPlan(SAMPLEONE_FIRM, [
      { keywordId: 'admitted', sourceName: '실제 경쟁광고 업체', slug: 'admitted', hostLabel: 'admitted-a', sourceStatus: 'published', observationCount: 1 },
    ])
    expect(plan.sourceCount).toBe(1)
    expect(plan.selectedCount).toBe(1)
    expect(plan.shards.flatMap((shard) => shard.entries).map((entry) => entry.keywordId)).toEqual(['admitted'])
  })
})
