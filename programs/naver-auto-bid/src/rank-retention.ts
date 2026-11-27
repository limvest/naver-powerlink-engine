import { sql } from 'drizzle-orm'
import type { Db } from '@/lib/db/client'

/** Compact redundant read-only evidence; mutation and unresolved evidence survive. */
export async function pruneRankEvidence(db: Pick<Db, 'execute'>, firmId: number) {
  if (!Number.isSafeInteger(firmId) || firmId <= 0) throw new TypeError('firmId is required')
  const decisions = await db.execute(sql`
    WITH ranked AS (
      SELECT d.id, d.created_at,
        row_number() OVER (PARTITION BY d.naver_keyword_id, d.device ORDER BY d.created_at DESC, d.id DESC) AS seq
      FROM naver_auto_bid_decisions d
      JOIN naver_auto_bid_runs r ON r.id=d.run_id AND r.firm_id=d.firm_id
      WHERE d.firm_id=${firmId} AND r.dry_run=true
        AND r.status IN ('completed','succeeded') AND r.finished_at IS NOT NULL
        AND d.applied_at IS NULL AND d.error IS NULL
        AND d.status IN ('planned','skipped','cooldown')
        AND d.verification_status NOT IN ('pending','failed')
    ), candidates AS (
      SELECT id FROM ranked WHERE seq > 3 AND created_at < now() - interval '1 day'
      ORDER BY created_at LIMIT 50000
    )
    DELETE FROM naver_auto_bid_decisions d USING candidates c
    WHERE d.id=c.id AND d.firm_id=${firmId} RETURNING d.id
  `)
  const events = await db.execute(sql`
    WITH ranked AS (
      SELECT e.id, e.created_at,
        row_number() OVER (PARTITION BY e.naver_keyword_id ORDER BY e.created_at DESC, e.id DESC) AS seq
      FROM naver_auto_bid_events e
      JOIN naver_auto_bid_runs r ON r.id=e.run_id AND r.firm_id=e.firm_id
      WHERE e.firm_id=${firmId} AND e.event_type='rank_observation'
        AND e.naver_keyword_id IS NOT NULL AND e.severity='info'
        AND r.status IN ('completed','succeeded') AND r.finished_at IS NOT NULL
    ), candidates AS (
      SELECT id FROM ranked WHERE seq > 24 AND created_at < now() - interval '30 days'
      ORDER BY created_at LIMIT 50000
    )
    DELETE FROM naver_auto_bid_events e USING candidates c
    WHERE e.id=c.id AND e.firm_id=${firmId} RETURNING e.id
  `)
  return { removedReadOnlyDecisions: decisions.rows.length, removedRankEvents: events.rows.length }
}
