/**
 * Powerlink responsive-search-ad (RSA_AD) payloads.
 *
 * Naver chooses up to three headline assets and two description assets.  The
 * individual asset limits still apply, so keep every phrase independently
 * meaningful rather than relying on one fixed, long headline.
 */
export const RESPONSIVE_HEADLINES = [
  '{키워드:사기피해} 사칭사기',
  '사칭 피해 대응 검토',
  '추가 송금 전 상담',
  '출금 지연 긴급 대응',
  '피해금 회수 절차 검토',
  '계좌 대화 증거 보전',
  '자금 동결 대응 검토',
  '변호사 직접 검토',
  '피해 회복 가능성 확인',
  '온라인 사기 피해 상담',
  '피해 대응 방법 확인',
  '피해 접수 상담 안내',
  '사건 대응 절차 확인',
  '긴급 초기 상담 신청',
] as const

export const RESPONSIVE_DESCRIPTIONS = [
  '{키워드:사기피해} 피해 회복 가능성을 변호사가 직접 검토합니다',
  '{키워드:사기피해} 추가 송금 전 계좌와 대화 기록을 보전하세요',
  '{키워드:사기피해} 출금 지연 피해 대응 절차를 지금 확인하세요',
  '{키워드:사기피해} 자금 동결과 형사 대응 방향을 변호사가 검토합니다',
] as const

export type ResponsiveMaterialPayload = {
  nccAdgroupId: string
  type: 'RSA_AD'
  ad: {
    headline: string
    description: string
    pc: { final: string }
    mobile: { final: string }
  }
  assets: Array<{
    assetData: { text: string }
    linkType: 'HEADLINE' | 'DESCRIPTION'
    pin?: '1' | '2'
  }>
}

function validUrl(value: string): string {
  const url = new URL(value)
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new TypeError('landing URL must be http(s)')
  return url.toString()
}

/** Creates one reviewable RSA without changing the group or keyword landing mapping. */
export function responsiveMaterialPayload(input: {
  adgroupId: string
  landingUrl: string
}): ResponsiveMaterialPayload {
  if (!input.adgroupId.trim()) throw new TypeError('adgroupId is required')
  const final = validUrl(input.landingUrl)
  return {
    nccAdgroupId: input.adgroupId,
    type: 'RSA_AD',
    // Naver's API requires the normal creative shell as well as the asset set.
    ad: {
      headline: RESPONSIVE_HEADLINES[0],
      description: RESPONSIVE_DESCRIPTIONS[0],
      pc: { final },
      mobile: { final },
    },
    assets: [
      ...RESPONSIVE_HEADLINES.map((text, index) => ({
        assetData: { text },
        linkType: 'HEADLINE' as const,
        ...(index === 0 && { pin: '1' as const }),
      })),
      ...RESPONSIVE_DESCRIPTIONS.map((text) => ({ assetData: { text }, linkType: 'DESCRIPTION' as const })),
    ],
  }
}
