import { expect, it, vi, afterEach } from 'vitest'
import { runParallelBidPipeline, type QueryJob } from '../src/parallel-bid-pipeline'
afterEach(() => vi.useRealTimers())
const job = (id: string): QueryJob => ({ id, keyword: id, group: 'group', recheck: false, readyAt: 0 })
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

it('commits fast results before slow queries, overlaps writes and reads, and delays rechecks', async () => {
  vi.useFakeTimers()
  let writers = 0, peakWriters = 0, queries = 0, overlap = false
  const writes: string[] = [], applied = new Map<string, number>()
  const promise = runParallelBidPipeline([job('slow'), job('fast'), job('other')], {
    now: Date.now, sleep, concurrency: 2,
    query: async task => {
      if (task.recheck) expect(Date.now()).toBeGreaterThanOrEqual(applied.get(task.id)! + 180000)
      queries++
      if (writers) overlap = true
      await sleep(task.id === 'slow' && !task.recheck ? 5000 : 100)
      queries--
      return task.id
    },
    commit: async rows => {
      writers++; peakWriters = Math.max(peakWriters, writers)
      if (queries) overlap = true
      await sleep(150)
      writers--
      if (rows[0].job.recheck) return []
      return rows.map(({ job }) => {
        writes.push(job.id); applied.set(job.id, Date.now())
        return { ...job, recheck: true, readyAt: Date.now() + 180000 }
      })
    },
  })
  await vi.runAllTimersAsync()
  await promise
  expect(writes[0]).toBe('fast')
  expect(peakWriters).toBe(1)
  expect(overlap).toBe(true)
  expect(writes).toHaveLength(3)
})

it('stops without retrying a failed mutation', async () => {
  vi.useFakeTimers()
  const commit = vi.fn(async () => { throw new Error('uncertain mutation') })
  const promise = runParallelBidPipeline([job('a')], { now: Date.now, sleep,
    query: async () => 'result', commit })
  const assertion = expect(promise).rejects.toThrow('uncertain mutation')
  await vi.runAllTimersAsync()
  await assertion
  expect(commit).toHaveBeenCalledTimes(1)
})

it('coalesces fast results, bounds buffers, and avoids polling through settlement', async()=>{
 vi.useFakeTimers();let sleeping=0;const sizes:number[]=[]
 const promise=runParallelBidPipeline(Array.from({length:200},(_,i)=>job(String(i))),{
  now:Date.now,sleep:async ms=>{sleeping++;await sleep(ms)},concurrency:4,bufferLimit:24,batchWaitMs:1000,
  query:async j=>{await sleep(60);return j.id},
  commit:async rows=>{sizes.push(rows.length);return rows[0].job.recheck?[]:[{...rows[0].job,recheck:true,readyAt:Date.now()+180000}]},
 })
 await vi.runAllTimersAsync();const result=await promise
 expect(sizes.filter(s=>s>1).length).toBeGreaterThan(0)
 expect(result.commits).toBeLessThan(35)
 expect(result.peakBuffered).toBeLessThanOrEqual(24)
 expect(sleeping).toBeLessThan(1000)
})

it('never mixes campaigns or groups when batching',async()=>{
 vi.useFakeTimers();const seen:string[]=[]
 const promise=runParallelBidPipeline(Array.from({length:80},(_,i)=>({...job(String(i)),campaignName:'c'+i%2,group:'g'+i%3})),{
  now:Date.now,sleep,query:async j=>j.id,commit:async rows=>{
   expect(new Set(rows.map(r=>r.job.campaignName)).size).toBe(1)
   expect(new Set(rows.map(r=>r.job.group)).size).toBe(1)
   seen.push(...rows.map(r=>r.job.id));return []
  },
 });await vi.runAllTimersAsync();await promise;expect(new Set(seen).size).toBe(80)
})

it('drains an in-flight writer but starts no more work after stop',async()=>{
 vi.useFakeTimers();let stop=false;const commits:string[]=[]
 const promise=runParallelBidPipeline(Array.from({length:60},(_,i)=>job(String(i))),{
  now:Date.now,sleep,concurrency:2,bufferLimit:4,shouldStop:()=>stop,
  query:async j=>{await sleep(10);return j.id},commit:async rows=>{
   stop=true;await sleep(100);commits.push(...rows.map(r=>r.job.id));return []
  },
 });await vi.runAllTimersAsync();const result=await promise
 expect(result.stopped).toBe(true);expect(result.commits).toBe(1);expect(commits.length).toBeGreaterThan(0)
})

it('restores future rechecks without querying before propagation is ready',async()=>{
 vi.useFakeTimers();const readyAt=Date.now()+180000;const order:string[]=[]
 const promise=runParallelBidPipeline([{...job('restored'),recheck:true,readyAt},job('fresh')],{
  now:Date.now,sleep,query:async j=>{if(j.recheck)expect(Date.now()).toBeGreaterThanOrEqual(readyAt);order.push(j.id);return j.id},
  commit:async()=>[],
 });await vi.runAllTimersAsync();await promise;expect(order).toEqual(['fresh','restored'])
})
