import { sql } from 'drizzle-orm'
import { keywords } from '@/lib/db/schema'

/** Firm-scoped ad-only tombstones. Does not block source collection or public pages. */
export function notOperatorExcluded(firmId: number) {
  return sql`not exists (select 1 from firms exclusion_firm
    where exclusion_firm.id=${firmId} and jsonb_exists(
      coalesce(exclusion_firm.ad_config->'operatorExcludedKeywords', '{}'::jsonb),
      lower(regexp_replace(${keywords.name}, '[[:space:]]+', '', 'g'))))`
}
