import { describe, expect, it } from 'vitest'
import { responsiveMaterialPayload } from '@/lib/engine/naver/responsive-material'

describe('responsiveMaterialPayload', () => {
  it('creates one RSA payload with a pinned DKI headline', () => {
    const payload = responsiveMaterialPayload({
      adgroupId: 'grp-a001-01-000000000000001',
      landingUrl: 'https://sampleone.attorney/?utm_source=naver',
    })
    expect(payload.type).toBe('RSA_AD')
    expect(payload.assets.filter((asset) => asset.linkType === 'HEADLINE')).toHaveLength(14)
    expect(payload.assets.filter((asset) => asset.linkType === 'DESCRIPTION')).toHaveLength(4)
    expect(payload.ad.pc.final).toBe('https://sampleone.attorney/?utm_source=naver')
    expect(payload.assets[0]).toEqual({
      assetData: { text: '{키워드:사기피해} 사칭사기' },
      linkType: 'HEADLINE',
      pin: '1',
    })
    const descriptions = payload.assets.filter((asset) => asset.linkType === 'DESCRIPTION')
    expect(descriptions.every((asset) => asset.assetData.text.startsWith('{키워드:사기피해}'))).toBe(true)
    expect(descriptions.every((asset) => [...asset.assetData.text.replace('{키워드:사기피해}', '사기피해')].length <= 45)).toBe(true)
    const unpinnedHeadlines = payload.assets.filter((asset) => asset.linkType === 'HEADLINE').slice(1)
    expect(unpinnedHeadlines.every((asset) => [...asset.assetData.text].length <= 15)).toBe(true)
  })
})
