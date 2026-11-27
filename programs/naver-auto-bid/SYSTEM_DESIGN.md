# Naver rank and bid learning system

## Operating boundary

This system reads public Naver Powerlink results, reads/writes the advertiser's
own SearchAd account, and records compact evidence. It does not automate ad
clicks. Click boosting is intentionally outside this control plane because it
can create invalid traffic, billing, and platform-policy risk.

## Measured baseline

The 2026-09-07 production sweep observed 22,839 eligible keyword rows through
the A1 direct egress at 1,000 request starts/minute and concurrency 24. All
22,839 reads completed, with zero failed or deferred observations. The network
observation phase took about 24 minutes. The rows were already unique after
NFKC, whitespace removal, and case normalization, so query deduplication does
not materially shorten this account's full sweep.

## Fast observation path

The fast profile targets 3,000 request starts/minute and concurrency 64. It
starts at 1,000/minute, accelerates after each 250 clean responses, and doubles
the request gap after a blocked, incomplete, 403, 429, network, or server
response. A structurally invalid response fails closed and never drives a bid.
Production pilot `pilot-rank-3000-20260907-2140` on 2026-09-07:
3,000 requested, 2,994 observations saved, six request timeouts. The span
between first and last successful observation was 100.53 seconds (about
1,786 completed observations/minute, including the initial ramp). Results:
240 found, 1,927 outside, 827 no ads; 1,794 queries contained legal competitors.
All 2,994 hot rows were present, and none exceeded 24 recent observations.
These measurements do not establish sustained 3,000/minute throughput or
full-account sweep duration. Snapshot and stage-start overhead are additional.

Observations are committed in batches of 250. Each transaction writes the
decision, hot state, transition events, and run heartbeat together. Repeating
the estimate stage for the same run skips committed observations. Completed
and deferred decisions discard the snapshot's prior evidence window, avoiding
24 old observations being retained again in every run. A failure rolls back
the current batch while preserving previous committed batches.

Planned scheduling priorities (not yet implemented):

1. New keywords and keywords changed since the last observation are urgent.
2. Keywords outside the target rank are observed frequently while learning.
3. Keywords at the target are sampled enough to confirm stability and search
   for the lowest maintaining bid.
4. `no_ads` keywords are low priority unless their bid, review status, content,
   or competitor state changes.

The runtime's `rankCheckLimit` plus actual oldest-observation ordering provides the
bounded work queue. A full operator sweep keeps the 50,000 limit; scheduled
learning cycles can use a smaller limit and still rotate fairly.
Ordering uses `lastObservedAt`, not the policy update timestamp that account
sync also changes. Unobserved keywords come first, with keyword IDs breaking
ties deterministically.

## One authoritative keyword-state table

`naver_auto_bid_keyword_policies` is the hot table. There is exactly one row
per provider keyword, with:

- keyword, ad group, target position, bid floor/ceiling, and step limits;
- latest observed status/rank, bid, visible-ad count, and timestamp;
- whether another legal advertiser was present, its count, and a bounded list
  of visible advertiser/title/domain/ad-id summaries;
- total/found/outside/no-ad counters and the consecutive-state count;
- a fixed 24-observation evidence window;
- a compact good/bad bid bracket and the next recommended bid.

Raw SERP HTML is never stored. `naver_auto_bid_decisions` holds run
evidence and `naver_auto_bid_events` is a sparse audit ledger, not an alternate
current-state table. Rank events are emitted only when an established status,
rank, or competitor state changes. Bid mutations and verification failures
remain durable events. At report time, redundant dry-run decisions older than
one day are pruned while retaining the latest three per keyword/device.
Only completed successful runs and unapplied decisions without errors or
pending/failed verification qualify. Informational rank-transition events
older than 30 days retain the latest 24 per keyword. Each cleanup removes at
most 50,000 rows per table; removal counts are recorded in the run ledger.
Mutation, unresolved-error, and active-run evidence is preserved. This bounds
routine observation history after the retention windows, not all audit data:
long-term archival of mutation records and run summaries remains outstanding.

Timeouts and other transport errors without an HTTP status now enter the
bounded retry path. Exhausted rank failures produce a partial report and an
explicit observation-failure count instead of a successful-looking skipped
count. The initial pilot's six timeouts exposed both defects; a repeat pilot
is required to verify the corrected behavior in production.

The same keyword row's `raw.lastBidAction` records the last provider-verified
change (decision ID, device, bid before/after, rank before, target, applied and
verified timestamps). `raw.bidOutcomes` holds at most 12 action summaries.
Subsequent observations are associated only when the device and actual bid
match and the observation follows verification. Each summary contains first
and last observation times, sample count, target hits/misses, no-ad count,
latest rank/status, and legal competitor count. Replayed timestamps do not
increment counters. These are observed associations, not proof that a bid
change caused a rank movement. External bid changes and mismatched devices
are not attributed to the action.

## Competitor signal

Each top-level Powerlink row is parsed once. Our domain is excluded, including
protocol-free display URLs and subdomains. A competitor is classified as legal
when the visible advertiser/title/description carries law-firm, law-office,
lawyer, criminal-specialist, or legal-consultation signals. The stored summary
is sufficient for:

- legal-competitor present/absent segmentation;
- competitor count and position pressure;
- title/domain comparison for relevance analysis;
- later agent features without retaining personal or raw page data.

## Rank controller and minimum maintaining bid

One rotating SERP result cannot change a bid. The controller requires three
consecutive observations at the same bid and at least two agreeing outcomes.
Confirmation uses distinct timestamps from the latest hour. Replayed or
out-of-order observations cannot create a new recommendation. After more
than 24 hours without an observation, the previous bid bracket is discarded.
Each good/bad price bound also has its own evidence timestamp and expires
after 24 hours, even during uninterrupted observation. Reconfirming the good
bid does not refresh the old failed-price timestamp. Once that failed bound
expires, the controller can test a lower price again within configured steps
and limits. This permits adaptation when the minimum maintaining price falls.

- `acquire`: confirmed outside/below-target evidence raises the bid.
- `minimize`: confirmed at-or-above-target evidence lowers the bid.
- `hold`: mixed evidence, a confirmed floor bid, or a converged 10-won bracket
  keeps the current bid.
- `capped`: confirmed miss at the explicit operator ceiling cannot rise.

The controller records the highest confirmed bad bid and lowest confirmed good
bid. Once both exist, it tests their midpoint in 10-won increments. This is a
bounded binary search rather than an endless fixed-step walk. If only one bound
exists, it uses the configured step. The recent evidence window contains the
bid used for every observation, so an agent can infer bid elasticity, competitor
pressure, rotation variance, and confidence without an unbounded history table.
Changing the target rank or the recorded device resets the bid bracket and
confirmation evidence. Legacy observations without device metadata remain
compatible; fully separate PC/mobile hot states are still outstanding.

Observations outside the configured policy schedule remain visible in the hot
state but carry `biddingEligible: false`. They interrupt the confirmation
window, do not contribute action outcomes, and cannot produce bid proposals.
The apply stage rechecks the schedule before sending observed-rank bid writes,
covering runs that started before closing and reached apply after closing.
A current `no_ads` response cannot turn two previous misses into a raise.
The deterministic controller test starts at 70 won, simulates a market where
430 won is the minimum that attains rank 3, and verifies convergence to 430
with a 420/430 bad/good bracket and no further oscillation. This test does not
establish that a real market has a stable monotonic bid-to-rank relationship.

## Safety and verification

- Search observations are read-only.
- Live bid writes still require explicit `--live`, `--ceiling`, and
  `--max-changes` in the same command.
- Every write is read back from SearchAd and mismatches fail the run.
- Cooldown and per-run change limits remain enforced.
- A first observation establishes state only; it does not emit a mass event or
  mutate a bid.
- Production rollout requires migration, a 3,000-keyword fast dry-run, then a
  full dry-run before any bounded live experiment.
