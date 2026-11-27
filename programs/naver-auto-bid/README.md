# Naver SearchAd automatic bidder

> Note: this program was extracted from a larger service. The systemd units (`deploy/a1/...`), the staged orchestration wrapper (`run-orchestrated.sh` / `naver:auto-bid:orchestrated`), the operator web console and the local strategy dashboard mentioned below are not part of this repository. Firm IDs, domains and campaign owners in examples are fictional.

This directory is the operator boundary for the `파워링크#1` exact-keyword
bidder described in [PLAN.md](./PLAN.md). Its default strategy reads the actual
Naver PC or mobile Powerlink result, identifies the configured firm domain,
and adjusts toward the target position. Provider bid estimates remain optional
fallback strategies. The command is deliberately safe by
default: it selects dry-run, does not issue provider writes, and records no
credentials in its output.

The executable wires the production adapter in `src/runtime.ts`: encrypted
credentials, the SearchAd provider, policy evaluation, and ledger-backed
decisions are connected end to end. Tests may still inject a fake
`NaverAutoBidAdapter` through `src/cli.ts` without network access.

## Operator commands

From the repository root:

```sh
# Safe preview; no provider write is issued. Without an explicit ceiling the
# preview uses one upward step as a non-writing comparison bound.
DATABASE_URL=… npm run naver:auto-bid -- --firm 1001

# Preview one stage.
DATABASE_URL=… npm run naver:auto-bid -- \
  --firm 1001 --stage decide

# A live invocation must state both bounds on the command line.
DATABASE_URL=… npm run naver:auto-bid -- \
  --firm 1001 --live --ceiling 800 --max-changes 10
```

`--live` is not enabled by an environment variable. It is refused unless the
same command explicitly includes `--ceiling` and `--max-changes`; the latter
is a per-run mutation limit. The normal scheduled command never passes
`--live`. The ceiling must be at least the floor (70 KRW by default). The
observed-rank strategy can raise, keep, or lower a bid within those bounds.

Useful tuning flags are `--device mobile|pc`, `--floor`, `--step-up`,
`--exposure-buffer`, `--cooldown-hours`, `--batch-size`, `--stage`, and
`--run-key`. `--run-key` is the idempotency/ledger key; an orchestrated run
passes the same key to every stage.

`--strategy observed_rank` is the default. Mobile observations use Naver's
ad-only result (`m.ad.search.naver.com`, `where=m_expd`) and count only
top-level Powerlink rows. Each run can inspect up to 50,000 keyword policies.
The fast profile warms up at 1,000 request starts/minute and can reach
3,000/minute with at most 64 in flight after clean response samples; results
and failures are persisted in 500-row batches. Rank, current bid, visible legal
competitors, bounded observation history, and the learned good/bad bid bracket
are kept in the keyword-policy row. Three same-bid observations are required
before a bid can move. After the target is confirmed, the controller searches
for the lowest maintaining bid. Use `--rank-check-limit`, `--rank-rpm`, and
`--rank-concurrency` to tune the sweep. See [SYSTEM_DESIGN.md](./SYSTEM_DESIGN.md).

Set `NAVER_RANK_PROXY_URL` to route observations through one fixed,
operator-controlled HTTP(S) proxy gateway. If it is absent, the worker uses
the server's direct network path. Retryable or incomplete responses slow the
shared request pace; successful reads gradually restore the configured rate.
Any blocked, incomplete, or structurally invalid search response fails closed
for that keyword and cannot produce a bid change.

## Orchestrated operation

The A1 entrypoint is:

```sh
zsh programs/naver-auto-bid/run-orchestrated.sh
```

It sources the existing `scripts/agent/orchestration-shell.sh`, acquires the
existing agent lock implementation, and records this exact ledger sequence:

```text
auto-bid-snapshot -> auto-bid-estimate -> auto-bid-decide
                  -> auto-bid-apply -> auto-bid-verify -> auto-bid-report
```

In dry-run, `auto-bid-apply` is recorded as `stage-skipped`; all other stages
remain visible to the ledger. A stage failure is left as a failure so the
existing operations alert path can handle it. The shell lock refuses an
overlapping run, and the A1 systemd unit adds a host-side `flock` as a second
guard.

The shell accepts the same CLI flags, for example:

```sh
zsh programs/naver-auto-bid/run-orchestrated.sh \
  --firm 1001 --live --ceiling 800 --max-changes 10
```

Do not place API keys, decrypted credentials, or provider response bodies in
arguments or logs. Credentials remain the responsibility of the eventual
provider adapter and encrypted database integration.

## A1 schedule

`deploy/a1/lawfirm-ads-naver-auto-bid.timer` intentionally runs only four
low-frequency previews on weekdays—09:15, 13:15, 17:15, and 21:15 KST—with a
small randomized delay. It has no persistent catch-up, so a missed run is not
replayed outside the Mon–Fri 08:00–22:00 operating window. The paired service
uses `/run/lock/lawfirm-ads-naver-auto-bid.lock` with non-blocking `flock`.

The scheduled unit executes the real read/estimate/decision pipeline but stays
in dry-run, so it cannot issue a keyword PUT. A live command remains a manual,
bounded operation and must include both explicit live bounds.

## Stage integration contract

### Observed-rank propagation delay (2026-09-08)

The `competitor-pipeline.ts` one-shot entrypoint implements the operator's streaming
workflow for the fixed 13,003-keyword competitor cohort, excluding the 195 already
mutated by the first pilot. It uses same-group batches of at most 50, scoped DB reads,
one shared 1,000 RPM observer, and a 60-second campaign/group metadata cache. Each
batch executes observation → bounded decision → apply → API read-back immediately;
then its changed IDs join the 180-second delayed recheck queue while fresh batches
continue. Due rechecks take priority at batch boundaries. It explicitly uses one
fresh observation for immediate decisions; standard three-read mode remains the
default elsewhere. Each keyword is changed at most once during this requested trial.
Rechecks record outcomes without another write. Completed batch run keys prevent
duplicate application on restart; incomplete/error batches require reconciliation.
The standalone trial does not activate the scheduled master switch. A process-wide
flock and the DB run lease serialize account mutations. Historical retention is
excluded from the execution path. Snapshot reads are restricted by `keywordIds`;
current competitor presence is enforced at the decision stage, so the fixed cohort
is fully queried even when a stored competitor label has changed.

- Use a conservative **180-second minimum** after the bid-write batch response,
  based on the operator's reported 2–3 minute Naver propagation delay. This is
  an allowance, not a guarantee that every SERP has propagated after 180 seconds.
- No per-keyword sleep: pending keywords are deferred with `bid_settlement_pending`;
  other ready keywords continue. Due post-change checks precede ordinary coverage.
- Enabled live observed-rank commands use two-minute scheduling buckets and at most
  1,000 observations per cycle. The existing serial worker/lock remains; full
  read-only sweeps keep their configured limit. Rechecks occur on the next eligible
  cycle, **not exactly at second 180**; cycle duration and polling add latency.
- For observed-rank, the 180-second gate replaces the estimate strategy's hour-based
  cooldown. Repeated evidence, floors/ceilings and mutation caps still apply.
- Pre-settlement evidence is excluded from learning and action outcomes. Before
  applying a decision, reload the keyword state and reject stale/pre-change evidence
  or another still-settling change. API read-back remains immediate and separate from
  the delayed SERP outcome check.
- This code change does not enable the production master switch.

An adapter receives `AutoBidStageContext` for each selected stage. The context
contains the parsed firm/campaign/device policy knobs, `mode`, `runKey`, the
current stage, and the preceding in-process stage result as `input`. An adapter
may implement one `runStage(stage, context)` method or named methods such as
`snapshot(context)` and `apply(context)`. The CLI itself never imports a
concrete HTTP client, policy module, schema, or database.
# Completion-order parallel trial (2026-09-08)

`competitor-pipeline.ts --confirm-live --fast-acquire-4000 --parallel-queries --run-key=<unique>`
uses 48 query tasks and a bounded 192-result/inflight queue. Newly completed observations
are committed in available same-group batches of at most 50, without waiting for a slow sibling.
Only one commit runs at once (DB firm lease and bid mutations remain serial). Queries continue
during commits. The shared observer warms up at 1000 RPM and ramps toward 3000 RPM
after clean responses, backing off on throttling/incomplete responses. These are configured
targets, not measured sustained throughput. Delayed rechecks return to this observer no earlier than
applied_at + 180 seconds. Pending rechecks and fresh work alternate when both are available.
Cached observations expire after 30 seconds; stale ones are fetched again. Ambiguous mutations
are never automatically retried; parallel run keys cannot be reused because completion-order
batch composition is nondeterministic. This is a bounded single pass plus outcome checks,
not an endless rebidding daemon. `start-parallel-after-current.sh` requires the account flock
and a successful predecessor completion log before starting the next pass.
