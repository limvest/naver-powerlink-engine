// src/lib/engine/naver/channel.ts — 비즈채널 매칭 공용 로직. saveCredentialsForFirm(대시보드
// 자격증명 검증 캐시, src/lib/dashboard/ad-settings.ts)과 ensureChannel(엔진 실행기,
// register-run.ts)이 동일 계약을 공유한다 — 두 곳이 다른 채널을 매칭하면 캐시된 채널과 실제
// 등록에 쓰이는 채널이 어긋나는 사고가 난다.
// 신규 광고주센터(2026-09 실계정)는 nccBusinessChannelId/businessInfo.site를 반환한다.
// 구형 응답(nccChannelId/url)도 기존 계정·테스트 호환을 위해 함께 받는다.
export type NaverChannelRaw = {
  nccChannelId?: string
  nccBusinessChannelId?: string
  channelTp?: string
  url?: string
  businessInfo?: { site?: string }
  pcInspectStatus?: string
  mobileInspectStatus?: string
  enabled?: boolean
}

export function naverChannelId(channel: NaverChannelRaw | undefined): string | undefined {
  return channel?.nccBusinessChannelId ?? channel?.nccChannelId
}

export function naverChannelSite(channel: NaverChannelRaw | undefined): string | undefined {
  return channel?.businessInfo?.site ?? channel?.url
}

export function naverChannelReady(channel: NaverChannelRaw | undefined): boolean {
  if (!naverChannelId(channel)) return false
  const states = [channel?.pcInspectStatus, channel?.mobileInspectStatus].filter(Boolean)
  if (!states.length) return true
  return states.every((state) => state === 'APPROVED' || state === 'ELIGIBLE')
}

export function matchChannel(channels: unknown, domain: string | null): NaverChannelRaw | undefined {
  if (!Array.isArray(channels) || !domain) return undefined
  return (channels as NaverChannelRaw[]).find(
    (c) => c && c.channelTp === 'SITE' && naverChannelSite(c)?.includes(domain),
  )
}
