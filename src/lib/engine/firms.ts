import type { FirmAdConfig, FirmLawyer } from '@/lib/db/schema'

export type { FirmLawyer, FirmAdConfig }

/** The advertiser (tenant) an ad account, campaign and keyword set belongs to. */
export type Firm = {
  id: number; slug: string; name: string; adLawyerName: string
  phone: string; phoneIntl: string; address: string
  addressRegion: string; addressLocality: string
  kakaoUrl: string | null; domain: string | null; domainAliases: string[] | null; status: string
  lawyers: FirmLawyer[] | null; wordmark: string | null; landingReady: boolean; dashboardToken: string | null
  siteTemplate: string; profileIntro: string | null; officeHistory: string[] | null
  adConfig: FirmAdConfig | null
}

/** Fictional sample firm used as the fallback for firm id 1 and as a test fixture. */
export const DEFAULT_FIRM: Firm = {
  id: 1, slug: 'sampletwo', name: '법률사무소 샘플투', adLawyerName: '김일번',
  phone: '031-000-0000', phoneIntl: '+82-31-000-0000',
  address: '샘플로 1, 5층 503·504호(샘플동, 샘플빌딩)',
  addressRegion: '경기도', addressLocality: '샘플시 샘플구',
  kakaoUrl: null, domain: 'sampletwo-law.example.com', domainAliases: null, status: 'active',
  lawyers: null, wordmark: null, landingReady: true, dashboardToken: null,
  siteTemplate: 'response-room', profileIntro: null, officeHistory: null, adConfig: null,
}
