/**
 * Secure one-shot credential installer. JSON is read only from stdin and never
 * logged. The API key and secret are encrypted before database persistence.
 *
 * printf '{...}' | tsx scripts/engine/store-naver-credentials-from-stdin.ts --firm 1001
 */
export {}

type Input = { customerId?: unknown; apiKey?: unknown; secret?: unknown }

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8')
}

function firmId(argv: string[]): number {
  const index = argv.indexOf('--firm')
  return index >= 0 ? Number(argv[index + 1]) : Number.NaN
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('REFUSED: DATABASE_URL not set')
  const id = firmId(process.argv.slice(2))
  if (!Number.isFinite(id)) throw new Error('REFUSED: --firm is required')
  let parsed: Input
  try { parsed = JSON.parse(await readStdin()) as Input } catch { throw new Error('REFUSED: invalid credential JSON') }
  const customerId = text(parsed.customerId)
  const apiKey = text(parsed.apiKey)
  const secret = text(parsed.secret)
  if (!customerId || !apiKey || !secret) throw new Error('REFUSED: incomplete credentials')

  const { getDb } = await import('@/lib/db/client')
  const { firms } = await import('@/lib/db/schema')
  const { eq } = await import('drizzle-orm')
  const { saveCredentialsForFirm } = await import('@/lib/dashboard/ad-settings')
  const db = getDb()
  const [firm] = await db.select().from(firms).where(eq(firms.id, id)).limit(1)
  if (!firm) throw new Error(`REFUSED: firm ${id} not found`)
  const result = await saveCredentialsForFirm(db, firm, { customerId, apiKey, secret })
  console.log(JSON.stringify({ ok: result.ok, verified: result.verified, channelOk: result.channelOk }))
  if (!result.ok || !result.verified) process.exitCode = 1
}

main().catch((error) => {
  console.error('credential install failed:', error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
