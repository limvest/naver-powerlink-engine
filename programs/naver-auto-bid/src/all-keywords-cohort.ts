import { and, eq } from 'drizzle-orm'
import { firms, naverAutoBidKeywordPolicies, naverAutoBidGroupPolicies } from '@/lib/db/schema'
import type { getDb } from '@/lib/db/client'
import type { NaverProvider } from './naver-provider'
import { compareObservationPriority, needsSettlementCheck, observationDueAt } from './continuous-scheduling'

type RemoteRow = Record<string, unknown>

/** A row may be present in Naver while review, a parent lock, or a pause makes it unservable. */
export function isServingEligibleRow(row: RemoteRow, requireApprovedReview = false): boolean {
 const status=String(row.status??'').toUpperCase()
 const review=String(row.inspectStatus??'').toUpperCase()
 const locked = (value: unknown) => [true, 1, '1', 'true'].includes(value as never)
 if(status==='DELETED'||status==='PAUSED'||status==='INELIGIBLE'||locked(row.delFlag)||locked(row.userLock))return false
 if(requireApprovedReview&&review!=='APPROVED')return false
 return !status||status==='ELIGIBLE'
}

/** Load every remotely present keyword already enabled by the control plane. */
export async function loadAllKeywordsCohort(db:ReturnType<typeof getDb>,provider:NaverProvider,firmId:number,runKey:string){
 const [firm]=await db.select().from(firms).where(eq(firms.id,firmId))
 const excluded=(firm.adConfig as any)?.operatorExcludedKeywords??{}
 const groupPolicies=await db.select().from(naverAutoBidGroupPolicies).where(and(
  eq(naverAutoBidGroupPolicies.firmId,firmId),eq(naverAutoBidGroupPolicies.enabled,true)))
 const keywordPolicies=await db.select().from(naverAutoBidKeywordPolicies).where(and(
  eq(naverAutoBidKeywordPolicies.firmId,firmId),eq(naverAutoBidKeywordPolicies.enabled,true)))
 const enabledGroups=new Set(groupPolicies.map(row=>row.naverAdgroupId))
 const enabledKeywords=new Set(keywordPolicies.map(row=>row.naverKeywordId))
 const byId = new Map(keywordPolicies.map(row=>[row.naverKeywordId,row]))
 const now = Date.now()
 const enabledCampaigns=new Set(groupPolicies.map(row=>row.naverCampaignId))
 const campaigns=await provider.getCampaigns()
 // A group id is only meaningful within its parent campaign for the runtime:
 // keep the campaign name on every work item instead of losing that scope here.
 const rows:Array<{naver_campaign_name:string;naver_adgroup_id:string;naver_keyword_id:string;keyword:string}>=[]
 for(const campaign of campaigns.filter(row=>isServingEligibleRow(row)
  && enabledCampaigns.has(String(row.nccCampaignId)))){
  const groups=(await provider.getAdGroups(String(campaign.nccCampaignId))).filter(row=>isServingEligibleRow(row)
   && enabledGroups.has(String(row.nccAdgroupId)))
  for(const group of groups){
   const groupId=String(group.nccAdgroupId)
   const remote=await provider.getKeywords(groupId)
   const entries=remote.filter(row=>row.nccKeywordId&&row.keyword&&isServingEligibleRow(row,true)
    && enabledKeywords.has(String(row.nccKeywordId))
    && !Object.hasOwn(excluded,String(row.keyword).toLowerCase().replace(/\s/g,'')))
   rows.push(...entries.map(row=>({naver_campaign_name:String(campaign.name??campaign.nccCampaignId),
    naver_keyword_id:String(row.nccKeywordId),naver_adgroup_id:groupId,keyword:String(row.keyword)})))
   console.log(JSON.stringify({phase:'inventory',runKey,campaign:String(campaign.name??campaign.nccCampaignId),
    group:groupId,keywords:rows.length}))
  }
 }
 // A restart must retain pending propagation checks, not defer them for a whole sweep.
 const due = rows.map(row=>{
  const state = byId.get(row.naver_keyword_id)!
  return {...row,readyAt:observationDueAt(state,now),recheck:needsSettlementCheck(state)}
 }).filter(row=>row.recheck || row.readyAt<=now)
 due.sort((a,b)=>compareObservationPriority(byId.get(a.naver_keyword_id)!,byId.get(b.naver_keyword_id)!,now)
  || a.naver_keyword_id.localeCompare(b.naver_keyword_id))
 console.log(JSON.stringify({phase:'cadence',runKey,eligible:rows.length,due:due.length,deferred:rows.length-due.length}))
 return {rows:due}
}
