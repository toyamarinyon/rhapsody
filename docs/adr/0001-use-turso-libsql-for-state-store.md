# ADR 0001: Use Turso/libSQL for the MVP State Store

## Status

Accepted

## Context

Rhapsody needs durable scheduler coordination because Vercel Functions and workflow workers cannot
rely on process memory for correctness. The MVP state store must support atomic work item claims,
run and attempt metadata, append-only runtime events, retry/reconciliation state, and dashboard/API
queries.

The initial storage choice should keep deployment simple on Vercel while leaving the scheduler and
runner code insulated from storage-specific details.

## Decision

Use Turso/libSQL as the initial durable state store for the MVP.

Access the database through a narrow TypeScript state-store interface instead of calling database
APIs directly from scheduler, runner, tracker, or route handler code.

Use `@libsql/client` with explicit SQL migrations for the first implementation. Keep
correctness-sensitive SQL, especially atomic claim acquisition and conditional state transitions,
visible in the repository.

Use integer epoch milliseconds for persisted timestamps unless a table has a strong reason to use a
different representation.

## Consequences

Positive consequences:

- Turso/libSQL fits the Vercel deployment model with low operational overhead.
- SQL remains easy to inspect for coordination logic such as atomic claims with TTL.
- The state-store interface keeps future storage changes possible.
- The MVP can avoid introducing an ORM before the durable scheduling model is proven.

Negative consequences:

- Query composition and migrations are more manual than with an ORM such as Drizzle.
- Some future analytical or relational queries may be less ergonomic than in Postgres.
- The implementation must be disciplined about transaction boundaries, indexes, and timestamp
  conventions.

## Revisit When

- Dashboard and projection queries become complex enough that hand-written SQL becomes repetitive.
- Multi-project or multi-tenant scheduling changes the read/write patterns materially.
- The project needs stronger relational features, richer migration tooling, or operational
  capabilities better served by Postgres.
- The state-store implementation becomes mostly conventional CRUD and would benefit from Drizzle or
  another typed query layer.
