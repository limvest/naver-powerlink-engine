import { describe, expect, it } from 'vitest'
import {
  nextSegmentedGroupName,
  segmentedKeywordDestination,
  staticLandingIdentityText,
} from '@/lib/engine/naver/segmented-search-run'

describe('ongoing legal-competitor campaign segmentation', () => {
  it('routes one source to its existing source campaign', () => {
    expect(segmentedKeywordDestination(['competitorj-law'])).toEqual({
      campaignName: '샘플원_N1_경쟁사J_20260918',
      tier: 'N01',
    })
    expect(segmentedKeywordDestination(['naver-blog:sampleblog77'])).toEqual({
      campaignName: '샘플원_N1_naverblogsam_20260918',
      tier: 'N01',
    })
  })

  it('routes source intersections to the shared campaign and correct tier', () => {
    expect(segmentedKeywordDestination(['competitor-k', 'competitoro'])).toEqual({
      campaignName: '샘플원_N2이상_교집합_20260918',
      tier: 'N02',
    })
    expect(segmentedKeywordDestination(['a', 'b', 'c', 'd', 'e'])).toEqual({
      campaignName: '샘플원_N2이상_교집합_20260918',
      tier: 'N05P',
    })
  })

  it('deduplicates sources and refuses an unclassified keyword', () => {
    expect(segmentedKeywordDestination(['report', 'report'])).toEqual({
      campaignName: '샘플원_N1_REPORT_20260918',
      tier: 'N01',
    })
    expect(() => segmentedKeywordDestination([])).toThrow('no observation source')
  })

  it('allocates the next group inside a full source or intersection tier', () => {
    expect(nextSegmentedGroupName(['N01_01', 'N01_02', 'N02_01'], 'N01')).toBe('N01_03')
    expect(nextSegmentedGroupName(['N02_05', 'N03_03'], 'N02')).toBe('N02_06')
    expect(nextSegmentedGroupName([], 'N05P')).toBe('N05P_01')
  })

  it('extracts the static landing identity from title and H1', () => {
    expect(staticLandingIdentityText('<title>Mock Nexus 피해 대응 &amp; 상담</title><h1>Mock <b>Nexus</b></h1>'))
      .toBe('Mock Nexus 피해 대응 & 상담 Mock Nexus')
  })
})
