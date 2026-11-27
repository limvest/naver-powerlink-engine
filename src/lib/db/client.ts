import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import * as schema from './schema'

export type Db = ReturnType<typeof drizzle<typeof schema>>

let testDb: Db | null = null
export function setDbForTesting(db: Db | null) {
  testDb = db
}

let prodDb: Db | null = null
let prodPool: Pool | null = null
export function getDb(): Db {
  if (testDb) return testDb
  if (!prodDb) {
    const url = process.env.DATABASE_URL
    if (!url) throw new Error('DATABASE_URL is not set')
    const requestedMax = Number(process.env.DATABASE_POOL_MAX)
    const max = Number.isSafeInteger(requestedMax) && requestedMax > 0
      ? requestedMax
      : process.env.LAWFIRM_TRANSACTIONAL_DB === '1' ? 2 : 10
    prodPool = new Pool({
      connectionString: url,
      max,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 10_000,
      allowExitOnIdle: process.env.LAWFIRM_TRANSACTIONAL_DB === '1',
    })
    prodDb = drizzle(prodPool, { schema })
  }
  return prodDb
}
