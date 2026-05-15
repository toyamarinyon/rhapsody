# ADR 0002: Define the MVP State Model and Claim Lifecycle

## Status

Accepted

## Context

Rhapsody must prevent duplicate execution of the same GitHub Project item while preserving enough
history to debug scheduler, runner, sandbox, and agent behavior. The state model needs to support
atomic claims, run and attempt history, retry/reconciliation, and a basic dashboard without pulling
the MVP into a larger projection, logging, or artifact system too early.

ADR 0001 selected Turso/libSQL, `@libsql/client`, explicit SQL migrations, and integer epoch
milliseconds for persisted timestamps.

## Decision

Use four MVP tables:

- `claims`
- `runs`
- `attempts`
- `events`

Keep `claims` independent from `runs`. A claim is the current coordination record for a
`ProjectV2Item.id`; a run is execution history for a work item; an attempt is one execution try
within a run; an event is an append-only observability record.

Add a `claim_token` to claims and require runner state updates to include the current token. This
acts as a fencing token so an old runner cannot keep writing after its claim has expired and been
reclaimed.

Use one run per successful claim acquisition. Retries add attempts under that run instead of
creating a new run for each retry.

Use `text check (...)` constraints for run and attempt statuses in the initial SQL schema.

Use prefix-style IDs for generated records, for example `run_...`, `att_...`, and `evt_...`.

## Claim Lifecycle

The scheduler follows this lifecycle:

1. Fetch candidate GitHub Project items.
2. Check global and per-status concurrency limits using active claims/runs.
3. Atomically acquire or reclaim a `claims` row for the candidate work item.
4. Create a `runs` row only after claim acquisition succeeds.
5. Start the runner workflow only after both claim acquisition and run creation succeed.
6. Create an `attempts` row for each execution try.
7. Extend `claims.claim_expires_at` while the runner is still live.
8. Require runner updates to match both `run_id` and `claim_token`.
9. Mark the attempt and run completed, failed, canceled, timed out, or stale.
10. Release the claim after terminal runner cleanup.

If a claim is acquired but no run is created, reconciliation may release or reclaim that orphaned
claim after its TTL expires.

If a claim expires while a run is active, reconciliation may mark the old run stale and allow a new
claim/run to take over the work item.

## MVP Deferrals

Do not add these tables or mechanisms in the MVP unless a concrete implementation need appears:

- `work_items` projection table
- `artifacts` table
- separate `logs` table
- `dispatch_slots` table
- scheduler-wide lock
- status lookup tables
- tracker or GitHub metadata cache
- multi-tenant schema

The MVP stores the minimum work item snapshot needed for run history directly on `runs`.

The MVP stores short runtime logs and structured state transitions in `events`. Large logs, diffs,
and multiple artifacts can move to dedicated tables or blob storage later.

Concurrency limits are enforced by checking active claims/runs during claim acquisition. Preventing
duplicate execution of the same work item is a hard requirement; exact global/per-status slot
enforcement can be strengthened later with a `dispatch_slots` table if needed.

## Consequences

Positive consequences:

- Claim coordination SQL stays small and directly auditable.
- Run and attempt history remains separate from active scheduler coordination.
- Reclaim behavior can create a clean boundary between old and new runner workflows.
- The MVP starts with only the tables required for correctness and basic observability.

Negative consequences:

- The dashboard cannot show rich information about never-run candidate items without asking GitHub.
- Long agent logs and multiple artifacts will need a later storage design.
- Global and per-status concurrency limits are not modeled as explicit slot records in the MVP.
- Reconciliation must handle orphaned claims and active runs whose claims have expired.

## Revisit When

- Operators need a dashboard view of candidate items that have never been claimed.
- Agent logs become large enough that `events` is no longer a good storage shape.
- Multiple artifacts, diffs, or sandbox snapshots need first-class lifecycle management.
- Concurrency limits must be enforced as strict slots rather than active-count checks.
- Multi-project or multi-tenant scheduling becomes part of the target architecture.
