import { describe, expect, it, vi } from 'vitest'
import { enforceSampleoneAdHours, shouldSampleoneAdsRun } from '@/lib/engine/naver/ad-hours'

function seoul(value: string): Date {
  return new Date(value)
}

describe('Sampleone Naver ad hours', () => {
  it('runs daily from 08:00 through 21:59 KST', () => {
    expect(shouldSampleoneAdsRun(seoul('2026-09-07T07:59:59+09:00'))).toBe(false)
    expect(shouldSampleoneAdsRun(seoul('2026-09-07T08:00:00+09:00'))).toBe(true)
    expect(shouldSampleoneAdsRun(seoul('2026-09-07T21:59:59+09:00'))).toBe(true)
    expect(shouldSampleoneAdsRun(seoul('2026-09-07T22:00:00+09:00'))).toBe(false)
    expect(shouldSampleoneAdsRun(seoul('2026-09-06T00:00:00+09:00'))).toBe(false)
    expect(shouldSampleoneAdsRun(seoul('2026-09-06T07:59:59+09:00'))).toBe(false)
    expect(shouldSampleoneAdsRun(seoul('2026-09-06T08:00:00+09:00'))).toBe(true)
    expect(shouldSampleoneAdsRun(seoul('2026-09-06T21:59:59+09:00'))).toBe(true)
    expect(shouldSampleoneAdsRun(seoul('2026-09-06T22:00:00+09:00'))).toBe(false)
  })

  it('updates every non-deleted group in all managed campaigns regardless of its name or count', async () => {
    const primaryGroups = [
      { nccAdgroupId: 'grp-1', nccCampaignId: 'cmp-1', name: '샘플원_사건명_01', status: 'ELIGIBLE', userLock: true },
      { nccAdgroupId: 'grp-2', nccCampaignId: 'cmp-1', name: '심사중_분리그룹', status: 'ELIGIBLE', userLock: false },
      { nccAdgroupId: 'grp-3', nccCampaignId: 'cmp-1', name: '향후_추가그룹', status: 'PAUSED', userLock: true },
      { nccAdgroupId: 'grp-4', nccCampaignId: 'cmp-1', name: '삭제그룹', status: 'DELETED', userLock: true },
    ]
    const competitorlGroups = [
      { nccAdgroupId: 'grp-5', nccCampaignId: 'cmp-2', name: '경쟁사L노출_기본형_01', status: 'ELIGIBLE', userLock: true },
      { nccAdgroupId: 'grp-6', nccCampaignId: 'cmp-2', name: '경쟁사L노출_사칭사기_01', status: 'ELIGIBLE', userLock: false },
    ]
    const restructuredGroups = [
      { nccAdgroupId: 'grp-7', nccCampaignId: 'cmp-3', name: '미노출_DB정확_01', status: 'ELIGIBLE', userLock: true },
      { nccAdgroupId: 'grp-8', nccCampaignId: 'cmp-3', name: '미노출_사기_01', status: 'ELIGIBLE', userLock: false },
    ]
    const reregisteredGroups = [
      { nccAdgroupId: 'grp-9', nccCampaignId: 'cmp-4', name: '미노출재등록_01', status: 'ELIGIBLE', userLock: true },
    ]
    const pilotGroups = [
      { nccAdgroupId: 'grp-10', nccCampaignId: 'cmp-5', name: 'TRACK718COM사기_재심사', status: 'PAUSED', userLock: true },
    ]
    const groups = [...primaryGroups, ...competitorlGroups, ...restructuredGroups, ...reregisteredGroups, ...pilotGroups]
    let reads = 0
    const request = vi.fn(async (method: string, path: string, options?: { body?: Record<string, unknown>; query?: Record<string, unknown> }) => {
      if (path === '/ncc/campaigns') return [
        { nccCampaignId: 'cmp-1', name: '파워링크#1' },
        { nccCampaignId: 'cmp-2', name: '샘플원_경쟁사L노출키워드_20260908' },
        { nccCampaignId: 'cmp-3', name: '샘플원_미노출재구성_20260909' },
        { nccCampaignId: 'cmp-4', name: '샘플원_미노출재등록_20260911' },
        { nccCampaignId: 'cmp-5', name: '샘플원_URL재심사파일럿_20260911' },
      ]
      if (path === '/ncc/adgroups') {
        reads++
        return options?.query?.nccCampaignId === 'cmp-2'
          ? competitorlGroups
          : options?.query?.nccCampaignId === 'cmp-3'
            ? restructuredGroups
            : options?.query?.nccCampaignId === 'cmp-4'
              ? reregisteredGroups
              : options?.query?.nccCampaignId === 'cmp-5'
                ? pilotGroups
                : primaryGroups
      }
      if (method === 'PUT') {
        const id = path.split('/').pop()
        const group = groups.find((row) => row.nccAdgroupId === id)!
        group.userLock = Boolean(options?.body?.userLock)
        return group
      }
      throw new Error(`unexpected ${method} ${path}`)
    })

    const result = await enforceSampleoneAdHours(
      { request } as never,
      seoul('2026-09-07T09:00:00+09:00'),
      0,
    )
    expect(result).toEqual({ active: true, groups: 9, changed: 6 })
    expect(groups.find((row) => row.nccAdgroupId === 'grp-4')?.userLock).toBe(true)
    expect(reads).toBe(10)
  })
})
