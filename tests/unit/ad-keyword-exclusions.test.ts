import { expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { createTestDb } from '../helpers/test-db'
import { keywords } from '@/lib/db/schema'
import { notOperatorExcluded } from '@/lib/engine/ad-keyword-exclusions'

it('excludes only operator-listed names for this firm, retaining keyword data', async () => {
  const db = await createTestDb()
  try {
    await db.execute(sql`insert into firms (id,slug,name,ad_lawyer_name,phone,phone_intl,address,address_region,address_locality,ad_config)
      values (701,'exclude-test','test','test','0','0','a','a','a',
      '{"operatorExcludedKeywords":{"링크드인":{"reason":"operator-approved"}}}'::jsonb)`)
    await db.insert(keywords).values([
      {firmId:701,name:'링크 드인',slug:'exclusion-test-1',scamType:'other'},
      {firmId:701,name:'유효업체명',slug:'exclusion-test-2',scamType:'other'},
    ])
    expect((await db.select().from(keywords).where(notOperatorExcluded(701))).map(k=>k.name)).toEqual(['유효업체명'])
    expect(await db.select().from(keywords).where(notOperatorExcluded(999))).toHaveLength(2)
    expect(await db.select().from(keywords)).toHaveLength(2)
  } finally { await (db.$client as unknown as {close():Promise<void>}).close() }
})
