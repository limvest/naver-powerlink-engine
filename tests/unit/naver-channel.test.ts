import { describe, expect, it } from 'vitest'
import {
  matchChannel,
  naverChannelId,
  naverChannelReady,
  naverChannelSite,
} from '@/lib/engine/naver/channel'

describe('Naver business channel normalization', () => {
  it('recognizes the current advertiser-center response while under review', () => {
    const channel = matchChannel([{
      nccBusinessChannelId: 'bsn-a001',
      channelTp: 'SITE',
      businessInfo: { site: 'https://sampleone.attorney' },
      pcInspectStatus: 'UNDER_REVIEW',
      mobileInspectStatus: 'UNDER_REVIEW',
    }], 'sampleone.attorney')
    expect(naverChannelId(channel)).toBe('bsn-a001')
    expect(naverChannelSite(channel)).toBe('https://sampleone.attorney')
    expect(naverChannelReady(channel)).toBe(false)
  })

  it('accepts an approved current response and keeps legacy compatibility', () => {
    expect(naverChannelReady({
      nccBusinessChannelId: 'bsn-a001',
      pcInspectStatus: 'APPROVED',
      mobileInspectStatus: 'APPROVED',
    })).toBe(true)
    expect(naverChannelReady({ nccChannelId: 'legacy' })).toBe(true)
  })
})
