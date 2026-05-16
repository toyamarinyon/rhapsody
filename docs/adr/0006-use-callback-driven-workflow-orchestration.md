# ADR 0006: Use Callback-Driven Workflow Orchestration

## Status

Accepted

## Context

Rhapsody runs on Vercel Functions and uses Vercel Workflow for durable orchestration. Vercel
Functions have bounded invocation duration, while Vercel Sandboxes can run agent commands for much
longer. A runner workflow must therefore not keep a Function invocation busy by polling a sandbox
command for the entire agent runtime.

Vercel Workflow supports pausing and resuming workflows through hooks. A workflow can create a hook,
pause while waiting for it, and later resume when an API route calls `resumeHook()` with an external
event payload. While paused, the workflow does not consume compute.

## Decision

Use callback-driven runner orchestration.

Runner workflows start sandbox work and then pause on a workflow hook. The sandbox runs a Rhapsody
wrapper command that executes Codex and posts a completion callback to Rhapsody. The callback route
validates the payload, persists it, and resumes the waiting workflow hook.

Do not implement long-running workflow polling loops for agent execution.

## Workflow Shape

Scheduler triggers start scheduler workflows and return quickly.

The scheduler workflow:

1. Reconciles stale claims and attempts.
2. Fetches GitHub Project candidates.
3. Acquires durable claims and creates runs through the state store.
4. Starts runner workflows for claimed runs.
5. Emits scheduler summary events.

The runner workflow:

1. Loads run context.
2. Creates an attempt.
3. Creates and configures a Vercel Sandbox.
4. Prepares source and credential mediators.
5. Creates a deterministic workflow hook token for the attempt.
6. Starts a detached sandbox wrapper command with callback metadata.
7. Stores sandbox ID, command ID, hook token, and callback state.
8. Awaits the completion hook.
9. Finalizes the attempt and run from the callback payload.
10. Verifies GitHub handoff and post-run policy.
11. Cleans up or snapshots the sandbox according to policy.
12. Releases the claim.

The callback route:

1. Authenticates the sandbox callback.
2. Validates `runId`, `attemptId`, `sandboxId`, and command metadata against the state store.
3. Persists the callback payload and any final event metadata.
4. Calls `resumeHook()` with the deterministic attempt hook token.
5. Returns quickly.

The watchdog workflow or cron:

1. Finds running attempts with missing callbacks, stale heartbeats, expired claims, or exceeded
   deadlines.
2. Inspects the sandbox or command when possible.
3. Resumes, finalizes, retries, times out, or marks stale attempts according to policy.

## Hook Token Design

Hook tokens should be deterministic enough for callback routes and watchdogs to reconstruct them
from state store data, while still namespaced to avoid collisions.

Use a shape like:

```text
rhapsody:attempt:<attempt_id>
```

The hook token is a routing key for Workflow, not a substitute for callback authentication.

## Sandbox Wrapper Contract

The runner starts a wrapper command inside the sandbox instead of launching Codex directly.

The wrapper is responsible for:

- running the configured Codex command,
- capturing exit code and terminal status,
- writing short local status files when helpful,
- sending periodic heartbeat callbacks when configured,
- sending exactly one terminal completion callback when possible,
- avoiding real credential logging,
- exiting with Codex's exit status or a wrapper-specific failure status.

Callback payloads include:

- `runId`
- `attemptId`
- `sandboxId`
- `commandId`
- `status`
- `exitCode`
- `startedAt`
- `completedAt`
- optional output or artifact references
- optional error summary

## Retry Boundaries

Workflow step retries handle transient infrastructure failures for short operations such as state
store writes, GitHub reads, sandbox creation, and command start.

Rhapsody attempt retries handle agent-level failures such as Codex command failure, timeout, stall,
missing handoff, validation failure, or policy failure.

External side effects must use idempotency keys derived from `runId`, `attemptId`, or Workflow step
metadata when available.

## Consequences

Positive consequences:

- Runner workflows do not hold Function invocations open for the full sandbox runtime.
- Long-running Codex executions can use the longer Vercel Sandbox lifetime.
- Completion is event-driven instead of polling-driven.
- Workflow hooks provide durable pause/resume semantics without a custom queue.
- Watchdog reconciliation can recover from missed callbacks or sandbox failures.

Negative consequences:

- Rhapsody must implement a sandbox wrapper and callback route.
- Callback authentication and replay handling are required.
- Workflow hook tokens and Rhapsody state-store records must stay consistent.
- Debugging spans multiple components: workflow, sandbox wrapper, callback route, state store, and
  watchdog.

## Required Safeguards

- Callback routes must authenticate requests and reject unknown or inactive attempts.
- Terminal callbacks must be idempotent; duplicates should not double-finalize a run.
- The state store remains the source of truth for attempt status.
- Watchdog reconciliation must not assume callbacks are reliable.
- Workflow steps should remain short enough to fit inside Vercel Function duration limits.

## Revisit When

- Vercel Workflow adds a first-class long-running external task primitive that replaces custom
  callback hooks.
- Vercel Sandbox command APIs provide durable completion events that can directly resume workflows.
- Rhapsody moves to Codex app-server plus exec-server and changes the agent execution boundary.
