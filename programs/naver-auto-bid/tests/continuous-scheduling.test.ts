import {expect,it} from 'vitest'
import {observationDueAt,compareObservationPriority,needsSettlementCheck} from '../src/continuous-scheduling'
const now=Date.parse('2026-09-13T03:00:00Z')
const state={lastObservedAt:null,lastChangedAt:null,lastObservedStatus:null,consecutiveStatusCount:0}
it('new keywords are due, recently observed keywords wait five minutes',()=>{
 expect(observationDueAt(state,now)).toBe(0)
 expect(observationDueAt({...state,lastObservedAt:new Date(now)},now)).toBe(now+300000)
})
it('repeated empty surfaces are probed again after thirty minutes',()=>{
 expect(observationDueAt({...state,lastObservedAt:new Date(now),lastObservedStatus:'no_ads',consecutiveStatusCount:3},now)).toBe(now+1800000)
})
it('post-change settlement takes priority over cadence and survives restart',()=>{
 const changed={...state,lastObservedAt:new Date(now-1000),lastChangedAt:new Date(now)}
 expect(observationDueAt(changed,now)).toBe(now+180000)
 expect(needsSettlementCheck(changed)).toBe(true)
 expect(needsSettlementCheck({...changed,lastObservedAt:new Date(now+180001)})).toBe(false)
 expect(compareObservationPriority(changed,state,now+180001)).toBeLessThan(0)
})
it('oldest observations precede newer ones',()=>{
 expect(compareObservationPriority({...state,lastObservedAt:new Date(now-10000)},{...state,lastObservedAt:new Date(now)},now)).toBeLessThan(0)
})
