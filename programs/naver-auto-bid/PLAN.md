# Naver SearchAd automatic bidder

## Goal

Operate the existing `파워링크#1` exact-keyword campaign without a vendor-side
20-keyword/minute throttle. The program reads all managed ad groups, estimates
an exposure/position bid in batches, records every decision, and updates only
eligible keywords. The default mode is dry-run; provider writes require an
explicit `--live` flag.

## Safety invariants

1. Only keyword entities belonging to the requested firm and campaign are in scope.
2. Rejected, under-review, paused, blocked, archived, non-public, or user-disabled
   keywords are never raised.
3. A policy must provide a provider bid ceiling and a per-run change limit.
4. The bidder never changes campaign/ad-group delivery state or landing URLs.
5. A live write stores its decision before the request and its result after it.
6. Re-running the same run key is idempotent; concurrent runs for one firm are refused.
7. HTTP 429 pauses the shared account limiter and is retried with jittered backoff.
8. Every live batch is read back before the run is considered successful.

## Pipeline

```text
snapshot -> eligibility -> estimate -> decide -> budget gate -> apply -> verify -> report
```

### Snapshot

- Resolve encrypted SearchAd credentials from PostgreSQL.
- Find `파워링크#1`, then enumerate every non-deleted ad group and keyword.
- Join remote keywords to `firm_ad_entities`, `firm_keywords`, and `keywords`.

### Eligibility

- Require approved provider review state and unlocked keyword delivery.
- Require local `adDesired=true`, a public host, no archive, and non-blocked source.
- Preserve `useGroupBidAmt=true` in dry-run. A live keyword bid explicitly changes it
  to `false` and supplies `bidAmt`.

### Estimate and decision

- Batch `/estimate/exposure-minimum-bid/keyword` by device.
- Clamp the estimate to policy minimum/ceiling and limit one-run movement by `stepUp`.
- Apply a small configurable exposure buffer; never lower bids in v1.
- Skip unchanged values and keywords still inside their cooldown.

### Apply and verify

- Use bulk `PUT /ncc/keywords?fields=bidAmt` with complete provider rows.
- Limit total live mutations with `maxChangesPerRun`.
- Fetch affected groups again and compare `bidAmt` and `useGroupBidAmt`.

## Initial policy

- Device: mobile (configurable)
- Floor: 70 KRW
- Ceiling: required operator setting; no implicit unlimited value
- Step-up: 100 KRW
- Exposure buffer: 10 KRW
- Cooldown: 6 hours
- Batch size: discovered by a bounded probe, then configurable (safe default 50)
- Maximum changed keywords per run: required for live mode

## Orchestration

`run-orchestrated.sh` records these stages in the existing `agent_runs` ledger:

1. `auto-bid-snapshot`
2. `auto-bid-estimate`
3. `auto-bid-decide`
4. `auto-bid-apply` (skipped in dry-run)
5. `auto-bid-verify`
6. `auto-bid-report`

Failures create the existing operations alert; a run-level lease prevents overlap.

## Acceptance criteria

- Unit tests cover eligibility, clamping, step limits, cooldown, and 429 recovery.
- An integration test proves dry-run performs no PUT request.
- A live fake-provider test proves bulk update and read-back verification.
- CLI refuses live mode without a ceiling and mutation limit.
- Existing unrelated tests and TypeScript checking remain green.
- No production bid is changed during implementation verification.

## Implemented

- `src/runtime.ts`: all-group snapshot, local eligibility join, staged persistence,
  batched estimates, bounded apply, read-back verification, and terminal reporting.
- `src/naver-provider.ts`: SearchAd batch transport and complete-row keyword updates.
- `src/rate-limiter.ts`: account-shared adaptive pacing, 429/5xx backoff, and circuit breaker.
- `src/policy.ts`: fail-closed eligibility and deterministic upward-only decisions.
- `src/repository.ts` + migration `0042`: policy, run lease, and per-keyword audit ledger.
- `run-orchestrated.sh`: existing agent ledger stages plus process/host overlap protection.
- `tests/`: fake-provider dry-run/live verification, policy, limiter, config, and persistence tests.
