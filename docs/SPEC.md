# Rhapsody Service Specification

Status: Draft v0.1

Purpose: Define a Vercel-native agent scheduler/runner that uses GitHub Projects as the tracker,
Workflow SDK for durable orchestration, and Vercel Sandbox for isolated agent execution.

This document is derived from the Symphony service specification, but Rhapsody deliberately changes
the execution model from a long-running local daemon to a Vercel-deployed application made of
durable workflows, Vercel Functions, persistent state, and sandboxed runners.

## Normative Language

The key words `MUST`, `MUST NOT`, `REQUIRED`, `SHOULD`, `SHOULD NOT`, `RECOMMENDED`, `MAY`, and
`OPTIONAL` in this document are to be interpreted as described in RFC 2119.

`Implementation-defined` means the behavior is part of the implementation contract, but this
specification does not prescribe one universal policy. Implementations MUST document the selected
behavior.

## 1. Problem Statement

Rhapsody is a Vercel-native automation application that reads work from GitHub Projects, schedules
durable agent runs, creates an isolated Vercel Sandbox for each run, and executes a coding agent
inside that sandbox.

Rhapsody solves five operational problems:

- It turns GitHub Project item execution into a repeatable, observable workflow.
- It uses Workflow SDK to make scheduler and runner logic durable across serverless invocations.
- It isolates agent execution inside Vercel Sandbox instead of the Vercel Function filesystem.
- It keeps workflow policy in the target repository so teams version prompts and runtime settings
  with their code.
- It provides a dashboard/API surface for debugging concurrent agent runs.

Important boundary:

- Rhapsody is a scheduler/runner and tracker adapter.
- GitHub issue/project writes MAY be performed by the Rhapsody runtime or by the coding agent through
  explicitly exposed tools.
- A successful run can end at a workflow-defined handoff status, such as `Human Review`, not
  necessarily a terminal GitHub issue state.

## 2. Goals and Non-Goals

### 2.1 Goals

- Deploy as a Next.js application on Vercel.
- Use GitHub Projects v2 as the primary work tracker.
- Use Workflow SDK for durable scheduler and runner workflows.
- Use Vercel Sandbox for isolated code execution.
- Maintain durable claims, retries, run metadata, sandbox references, and observability data.
- Dispatch work with global, per-project, and per-status concurrency limits.
- Recover from Vercel Function restarts, workflow retries, sandbox failures, and transient API
  failures.
- Support both Vercel Cron polling and GitHub webhook/manual refresh triggers.
- Preserve work across attempts using Git branches, artifacts, and/or Vercel Sandbox snapshots.
- Provide operator-visible observability through a dashboard and JSON API.

### 2.2 Non-Goals

- Reimplementing Temporal.
- Running a long-lived daemon process inside Vercel Functions.
- Depending on local persistent filesystems for workspace state.
- Supporting every GitHub Projects field type in the first version.
- Supporting arbitrary issue trackers in the first version.
- Mandating a single approval or sandbox policy for all deployments.

## 3. System Overview

### 3.1 Main Components

1. `Workflow Definition Loader`
   - Reads repository-owned workflow policy, initially `RHAPSODY.md` or `WORKFLOW.md`.
   - Parses YAML front matter and prompt body.
   - Returns `{config, prompt_template}`.

2. `Config Layer`
   - Exposes typed getters for project, tracker, workflow, sandbox, agent, and GitHub settings.
   - Applies defaults and environment variable indirection.
   - Validates dispatch-critical settings before workflows start work.
   - The MVP config boundary is documented in
     [ADR 0007](adr/0007-define-mvp-config-boundaries.md).

3. `GitHub Project Tracker Client`
   - Fetches candidate ProjectV2 items.
   - Fetches current item status for reconciliation.
   - Fetches terminal/completed items for cleanup.
   - Normalizes GitHub issue/project payloads into `WorkItem`.

4. `Scheduler Workflow`
   - Durable Workflow SDK workflow triggered by Cron, webhook, or manual refresh.
   - Owns candidate selection, durable claiming, and runner workflow starts.
   - Uses database-backed leases to avoid duplicate dispatch.
   - Starts runner workflows and returns without waiting for agent completion.

5. `Runner Workflow`
   - Durable Workflow SDK workflow for one work item attempt.
   - Creates or restores a Vercel Sandbox.
   - Prepares source code.
   - Builds the agent prompt.
   - Launches the coding agent inside the sandbox through a callback-capable wrapper.
   - Pauses on a Workflow hook until the sandbox wrapper reports completion.
   - Exports logs, artifacts, snapshots, commits, and PR metadata.

6. `State Store`
   - Durable database used for claims, runs, attempts, retries, events, snapshots, and dashboard
     projections.
   - REQUIRED because Vercel Functions and workflow workers MUST NOT rely on in-memory scheduler
     state for correctness.
   - The MVP state store uses Turso/libSQL as documented in
     [ADR 0001](adr/0001-use-turso-libsql-for-state-store.md).

7. `Sandbox Manager`
   - Creates, restores, snapshots, and cleans Vercel Sandboxes.
   - Applies network policy and environment configuration.
   - Ensures commands run only in the sandbox workspace.

8. `Git Provider Client`
   - Clones repositories into sandboxes.
   - Creates branches, commits, and pull requests when the workflow asks for them.
   - May use GitHub App credentials or fine-grained tokens.

9. `Dashboard and API`
   - Next.js UI plus JSON endpoints for current state, issue details, refresh triggers, and run logs.

10. `Logging and Event Sink`
   - Stores structured runtime events in the state store and emits platform logs.

### 3.2 Abstraction Levels

1. `Policy Layer`
   - Repository-owned workflow prompt and runtime rules.

2. `Configuration Layer`
   - Typed config with defaults, secret indirection, and validation.

3. `Durability Layer`
   - Workflow SDK workflows and steps.

4. `Coordination Layer`
   - Scheduler workflow, claims, concurrency, retries, and reconciliation.

5. `Execution Layer`
   - Vercel Sandbox lifecycle, source preparation, agent process execution, and artifact export.

6. `Integration Layer`
   - GitHub Projects, GitHub Issues, GitHub Pull Requests, Vercel Sandbox, and optional Vercel
     storage services.

7. `Observability Layer`
   - Dashboard, JSON API, workflow observability, logs, events, and token/runtime metrics.

## 4. Core Domain Model

### 4.1 WorkItem

Normalized GitHub Project item used by scheduling, prompt rendering, and observability.

Fields:

- `id` (string)
  - GitHub `ProjectV2Item` node ID.
- `content_id` (string)
  - GitHub Issue or Pull Request node ID.
- `identifier` (string)
  - Human-readable key, for example `owner/repo#123`.
- `owner` (string)
- `repository` (string)
- `number` (integer)
- `content_type` (`issue` | `pull_request` | `draft_issue` | `redacted` | `unknown`)
- `title` (string)
- `body` (string or null)
- `url` (string or null)
- `state` (string)
  - GitHub issue/PR state when available.
- `project_status` (string or null)
  - Value of configured ProjectV2 status field.
- `priority` (integer or null)
  - Derived from a configured ProjectV2 field or labels.
- `labels` (list of strings)
  - Normalized to lowercase.
- `assignees` (list of strings)
- `blocked_by` (list of blocker refs)
  - Implementation-defined in v0.1; may derive from issue links, task lists, labels, or configured
    ProjectV2 fields.
- `project_fields` (map)
  - Selected ProjectV2 field values.
- `created_at` (timestamp or null)
- `updated_at` (timestamp or null)

### 4.2 Workflow Definition

- `config` (map)
  - YAML front matter root object.
- `prompt_template` (string)
  - Markdown body after front matter, trimmed.

### 4.3 Run

A durable execution record for one work item.

Fields:

- `run_id`
- `workflow_run_id`
- `work_item_id`
- `identifier`
- `title`
- `project_status`
- `status`
- `attempt_count`
- `current_attempt_id`
- `claimed_by`
- `claim_expires_at`
- `started_at`
- `updated_at`
- `completed_at`
- `last_error`

### 4.4 Claim

A durable scheduler coordination record for one GitHub Project item.

Fields:

- `work_item_id`
  - GitHub `ProjectV2Item` node ID.
- `run_id`
- `claim_token`
  - Fencing token used by runner updates.
- `claimed_by`
- `claim_expires_at`
- `created_at`
- `updated_at`

### 4.5 Attempt

One execution attempt for one work item.

Fields:

- `attempt_id`
- `run_id`
- `attempt_number`
- `sandbox_id`
- `snapshot_id`
- `branch_name`
- `commit_sha`
- `pull_request_url`
- `started_at`
- `completed_at`
- `status`
- `error`

### 4.6 Event

Append-only observability record for scheduler, runner, sandbox, and agent activity.

Fields:

- `event_id`
- `run_id` (string or null)
- `attempt_id` (string or null)
- `work_item_id` (string or null)
- `type`
- `level`
- `message`
- `data_json` (string or null)
- `created_at`

### 4.7 Sandbox Workspace

Logical workspace inside Vercel Sandbox.

Fields:

- `sandbox_id`
- `runtime`
- `workspace_path`
  - Default `/vercel/sandbox`.
- `source_kind`
  - `git`, `tarball`, `snapshot`, or implementation-defined.
- `snapshot_id` (string or null)
- `network_policy`
- `created_at`
- `expires_at` or `stopped_at`

## 5. Workflow Specification

Repository workflow files define team guidance for the agent, not scheduler eligibility. The MVP
split between environment variables, `rhapsody.config.ts`, and `RHAPSODY.md` is documented in
[ADR 0007](adr/0007-define-mvp-config-boundaries.md).

### 5.1 File Discovery

Workflow file path precedence:

1. Explicit project configuration in Rhapsody.
2. `RHAPSODY.md` in the target repository root.
3. `WORKFLOW.md` in the target repository root.

If no workflow file can be read, the run MUST fail with `missing_workflow_file` unless the project
has explicitly enabled a default workflow prompt.

The MVP does not require YAML front matter in `RHAPSODY.md`; plain Markdown prompt text is valid.
Runner-specific front matter such as hooks, validation commands, or agent limits MAY be added later.

### 5.2 Front Matter Schema

Top-level keys:

- `tracker`
- `github`
- `polling`
- `scheduler`
- `sandbox`
- `agent`
- `workflow`
- `hooks`
- `observability`

Unknown keys SHOULD be ignored for forward compatibility.

#### `tracker`

- `kind`: REQUIRED, current supported value `github_project`
- `owner`: GitHub user or organization login
- `project_number`: GitHub Projects v2 number
- `project_id`: OPTIONAL GitHub ProjectV2 node ID cache
- `status_field`: default `Status`
- `active_statuses`: default `["Todo", "In Progress"]`
- `terminal_statuses`: default `["Done", "Canceled", "Cancelled", "Duplicate"]`
- `handoff_status`: OPTIONAL, for example `Human Review`

#### `github`

- `token`: `$VAR` or implementation-defined secret reference
- `app_id`: OPTIONAL
- `installation_id`: OPTIONAL
- `default_branch`: default `main`
- `branch_prefix`: default `rhapsody/`
- `open_pull_request`: default `true`

#### `polling`

- `cron`: OPTIONAL Vercel cron expression
- `minimum_interval_ms`: default `60000`
- `webhook_enabled`: default `true`

#### `scheduler`

- `max_concurrent_runs`: default `5`
- `max_concurrent_runs_by_status`: default `{}`
- `claim_ttl_ms`: default `900000`
- `max_retry_backoff_ms`: default `300000`

#### `sandbox`

- `runtime`: default `node24`
- `workspace_path`: default `/vercel/sandbox`
- `source`: `git`, `snapshot`, or implementation-defined
- `network_policy`: default implementation-defined
- `snapshot_on_success`: default `true`
- `snapshot_on_failure`: default `true`
- `max_duration_ms`: implementation-defined

#### `agent`

- `command`: REQUIRED or default implementation-defined
- `max_turns`: default `20`
- `turn_timeout_ms`: default `3600000`
- `stall_timeout_ms`: default `300000`
- `approval_policy`: implementation-defined
- `tools`: list of advertised runtime tools

#### `workflow`

- `sdk`: default `workflow`
- `retry`: implementation-defined Workflow SDK retry policy
- `fatal_error_classes`: list of error codes that MUST NOT retry

#### `hooks`

Hooks run inside the sandbox workspace:

- `after_create`
- `before_run`
- `after_run`
- `before_snapshot`
- `before_cleanup`
- `timeout_ms`: default `60000`

### 5.3 Prompt Template Contract

The Markdown body is the per-work-item prompt template.

Rendering requirements:

- Use a strict template engine.
- Unknown variables MUST fail rendering.
- Unknown filters MUST fail rendering.

Template variables:

- `item`: normalized `WorkItem`
- `attempt`: attempt number or null
- `run`: run metadata
- `repository`: repository metadata
- `project`: GitHub Project metadata

## 6. Durable Scheduling Model

### 6.1 Trigger Sources

The scheduler MAY start from:

- Vercel Cron.
- GitHub webhook events.
- Manual `POST /api/v1/refresh`.
- Admin dashboard action.

All triggers MUST be idempotent.

Trigger routes SHOULD authenticate the request, start the scheduler workflow, and return quickly
without performing long-running scheduling or runner work inline.

### 6.2 Claiming

Before starting a runner workflow, the scheduler MUST acquire a durable claim.

Claim requirements:

- Claim key is `ProjectV2Item.id`.
- Claim acquisition MUST be atomic.
- Claims MUST have an expiration time.
- Claims MUST be stored independently from run history.
- Claims MUST include a fencing token that runner updates use to avoid stale writes after reclaim.
- Expired claims MAY be reclaimed after reconciliation.
- A work item MUST NOT have more than one active runner workflow.

The MVP claim lifecycle is:

1. Check concurrency limits using active claims and runs.
2. Atomically acquire or reclaim a claim.
3. Create a run only after claim acquisition succeeds.
4. Start the runner workflow only after the claim and run exist.
5. Extend the claim while the runner is live.
6. Release the claim after terminal runner cleanup.

The MVP state model and claim lifecycle are documented in
[ADR 0002](adr/0002-define-mvp-state-model-and-claim-lifecycle.md).

### 6.3 Candidate Selection

A work item is dispatch-eligible only if:

- It has a ProjectV2 item ID and issue/PR content ID.
- It is an Issue unless PR/Draft Issue support is explicitly enabled.
- Its configured project status is active.
- It is not terminal.
- It is not currently claimed by another live run.
- Global and per-status concurrency limits allow dispatch.
- The blocker policy passes.

Sort order:

1. Priority ascending.
2. Oldest created time.
3. `identifier` lexicographic tie-breaker.

### 6.4 Retry and Backoff

Rhapsody SHOULD use Workflow SDK retry semantics for transient step failures and durable sleep for
scheduled retries.

Failure-driven retry delay:

```text
delay = min(10000 * 2^(attempt - 1), scheduler.max_retry_backoff_ms)
```

Fatal errors MUST NOT retry.

Normal continuation MAY schedule a short retry or continue in the same runner workflow if the item
remains active.

### 6.5 Reconciliation

Reconciliation checks:

- Active claims with no live workflow heartbeat.
- Workflow runs whose sandbox has stopped unexpectedly.
- GitHub Project items that moved to terminal status.
- GitHub Project items that moved out of active status.
- Expired claims.

Terminal status MUST stop active work and trigger cleanup according to policy.

## 7. Runner Workflow

The runner workflow is a durable workflow for one item.

Required steps:

1. Load and validate project/workflow config.
2. Resolve GitHub Project item and repository metadata.
3. Create or restore a Vercel Sandbox.
4. Apply sandbox network policy and environment.
5. Prepare source code in the sandbox.
6. Run `after_create` if the sandbox/workspace was newly initialized.
7. Render prompt.
8. Run `before_run`.
9. Prepare brokered agent authentication without writing real credentials into the sandbox.
10. Create a deterministic Workflow hook token for this attempt.
11. Launch the coding agent command inside the sandbox workspace through a wrapper process.
12. Persist sandbox ID, command ID, callback metadata, and attempt status.
13. Pause on the Workflow hook until the wrapper posts a terminal callback.
14. Resume from the callback payload.
15. Run `after_run`.
16. Export artifacts, git diff, commits, PRs, and/or snapshots.
17. Verify GitHub handoff and post-run policy.
18. Update GitHub Project status according to workflow policy.
19. Release claim.

The runner MUST NOT depend on local Vercel Function filesystem state for correctness.
The runner MUST NOT poll the sandbox for the full agent runtime inside one Vercel Function
invocation. Agent execution completion is callback-driven, with watchdog reconciliation as a
fallback. See [ADR 0006](adr/0006-use-callback-driven-workflow-orchestration.md).

The MVP prepares source code with Vercel Sandbox Git source initialization. The runner resolves and
records the exact base commit SHA before sandbox creation, passes the Git source descriptor and
source credential through the Sandbox API, and validates the prepared workspace before starting the
agent wrapper. See
[ADR 0009](adr/0009-use-vercel-sandbox-git-source-initialization-for-source-preparation.md).

### 7.1 Agent Completion Callback

The sandbox wrapper MUST send a terminal callback when the agent command completes, fails, times
out, or is stopped.

Callback payloads include:

- `run_id`
- `attempt_id`
- `sandbox_id`
- `command_id`
- `status`
- `exit_code`
- `started_at`
- `completed_at`
- `error` (string or null)
- implementation-defined output or artifact references

The callback route MUST authenticate the request, validate the run and attempt against the state
store, persist the payload idempotently, and resume the runner workflow hook.

Watchdog reconciliation MUST handle missing callbacks, stale heartbeats, expired claims, and
attempts that exceed configured deadlines.

## 8. Vercel Sandbox Contract

### 8.1 Sandbox Creation

Each attempt SHOULD run in a dedicated Vercel Sandbox unless restored from a previous snapshot for
the same work item.

The sandbox MUST be created with:

- selected runtime, initially `node24`
- explicit environment variables
- configured source or restored snapshot
- configured network policy

For the MVP, `configured source` means Vercel Sandbox Git source initialization for the configured
repository and resolved base commit SHA. Private repository source credentials MAY be passed through
the Sandbox API source credential fields, but MUST NOT be exposed as agent runtime environment,
repository files, logs, artifacts, or snapshots. See
[ADR 0009](adr/0009-use-vercel-sandbox-git-source-initialization-for-source-preparation.md).

### 8.2 Workspace Safety

Mandatory invariants:

- Agent commands MUST run inside `sandbox.workspace_path`.
- The workspace path MUST be normalized and validated before command execution.
- Secrets SHOULD be brokered through environment or network policy transforms rather than written to
  repository files.
- Real ChatGPT `auth.json` contents, access tokens, refresh tokens, GitHub tokens, and API keys MUST
  NOT be written into the execution sandbox filesystem, command arguments, logs, artifacts, or
  snapshots.
- Sandbox filesystem state MUST be exported before sandbox shutdown when needed.

### 8.3 Network Policy

Network access SHOULD be least-privilege.

Common allowed destinations:

- GitHub API and git endpoints
- package registries required by the repository
- OpenAI or AI Gateway endpoints
- Vercel APIs required for sandbox management

The implementation MUST document its default network policy.

For Codex CLI with ChatGPT-managed authentication, the MVP uses a trusted credential mediator and
dummy sandbox-local auth state. ChatGPT backend and OAuth refresh traffic are forwarded or brokered
outside the execution sandbox so real ChatGPT tokens remain in trusted server-side storage. See
[ADR 0004](adr/0004-broker-chatgpt-auth-for-codex-sandboxes.md) and
[ADR 0008](adr/0008-define-mediator-endpoint-contract.md).

For GitHub operations, the MVP uses a trusted GitHub mediator. The sandboxed agent may perform
workflow-specific GitHub operations through the mediator, but the upstream `GITHUB_TOKEN` remains in
trusted Rhapsody server-side storage. Requests are authenticated with `MEDIATOR_SECRET` and
authorized against the active run context. See
[ADR 0005](adr/0005-use-run-scoped-github-mediation-for-agent-writes.md) and
[ADR 0008](adr/0008-define-mediator-endpoint-contract.md).

### 8.4 Persistence

Because sandbox filesystems are ephemeral, Rhapsody MUST persist important state externally:

- run logs/events
- generated diffs
- commits/branches/PRs
- artifact files
- sandbox snapshot IDs
- token/runtime metrics

For the MVP, this durable state is stored in Turso/libSQL through a narrow state-store interface.
Scheduler, runner, tracker, and route handler code SHOULD depend on that interface rather than on
database client APIs directly. The initial implementation uses `@libsql/client` and explicit SQL
migrations so correctness-sensitive coordination queries remain visible in source control. See
[ADR 0001](adr/0001-use-turso-libsql-for-state-store.md).

The MVP durable schema consists of `claims`, `runs`, `attempts`, and `events`. Rhapsody deliberately
defers separate work item projections, artifact tables, log tables, dispatch slot tables, tracker
caches, and multi-tenant schema until needed. See
[ADR 0002](adr/0002-define-mvp-state-model-and-claim-lifecycle.md).

## 9. GitHub Projects Integration

### 9.1 Required Operations

The GitHub tracker adapter MUST support:

1. Resolve project ID from owner and project number.
2. Resolve field IDs and single-select option IDs.
3. Fetch candidate project items.
4. Fetch current project item status by item ID.
5. Update project item status when the workflow requires it.
6. Fetch issue body, labels, assignees, repository, and URL.

### 9.2 Query Semantics

GitHub Projects v2 uses GraphQL. Implementations SHOULD keep GraphQL query construction isolated.

Important notes:

- Project item filtering by custom fields may require client-side filtering.
- `Status` is typically a ProjectV2 single-select field.
- Field and option IDs SHOULD be cached and refreshed when missing or stale.
- Redacted project items MUST be skipped or surfaced as non-dispatchable.

### 9.3 Writes

Rhapsody MAY update GitHub state directly for scheduler-owned lifecycle transitions, for example:

- mark item as `In Progress` after claim
- mark item as `Human Review` after PR creation
- mark item as `Failed` if a configured failure status exists

Agent-owned writes, such as issue comments, pull request descriptions, labels, and handoff notes,
MAY happen through advertised tools, CLI commands, or API calls inside the sandbox, but they MUST be
mediated so raw GitHub credentials are not written into the sandbox. The MVP uses a PAT in
`GITHUB_TOKEN` and a run-scoped GitHub mediator; GitHub App installation tokens are deferred. See
[ADR 0005](adr/0005-use-run-scoped-github-mediation-for-agent-writes.md).

## 10. Observability API

Rhapsody SHOULD expose a dashboard and JSON API.

Minimum endpoints:

- `GET /api/v1/state`
  - Returns running, retrying, completed, failed, token totals, recent events, and rate limits.
- `GET /api/v1/items/:identifier`
  - Returns item-specific run/debug details.
- `GET /api/v1/runs/:run_id`
  - Returns run attempts, sandbox references, logs, artifacts, and GitHub links.
- `POST /api/v1/refresh`
  - Requests an immediate scheduler tick.

Cron and webhook endpoints MUST authenticate requests.

## 11. Authentication and Authorization

Rhapsody's MVP admin surface is protected by a root-password login flow. Operators configure
`ROOT_PASSWORD` and `AUTH_SECRET`; Rhapsody exchanges a successful password login for a signed,
HTTP-only session cookie. Dashboard pages and human-operated API routes MUST require that session.

Machine-triggered endpoints use dedicated secrets:

- Vercel Cron requests use `CRON_SECRET`.
- GitHub webhook requests use `GITHUB_WEBHOOK_SECRET` and signature verification.

GitHub login with user, organization, or team allowlists is deferred until it is worth the setup
cost for team deployments. See [ADR 0003](adr/0003-use-root-password-for-mvp-admin-auth.md).

## 12. Security and Operational Safety

Rhapsody MUST document:

- GitHub authentication model.
- Mediator endpoint contract.
- Sandbox network policy.
- Secret handling policy.
- Agent approval/tool policy.
- Which GitHub writes are scheduler-owned vs agent-owned.

Recommended hardening:

- Use a fine-grained PAT with least-privilege repository/project permissions for the MVP; later use
  a GitHub App with least-privilege installation permissions.
- Restrict eligible repositories/projects/statuses.
- Restrict sandbox egress.
- Avoid exposing broad GitHub tokens inside the sandbox.
- Validate mediator requests against active run context, as documented in
  [ADR 0008](adr/0008-define-mediator-endpoint-contract.md).
- Keep admin endpoints authenticated.
- Persist enough logs to audit agent actions.

## 13. Implementation Checklist

### 13.1 MVP

- Next.js app deployable to Vercel.
- `docs/SPEC.md` and `docs/ORIGINAL_SPEC.md`.
- Root-password admin authentication.
- GitHub Project config model.
- GitHub Project item fetch and normalization.
- Workflow SDK scheduler workflow.
- Durable claim table backed by Turso/libSQL.
- Durable run, attempt, and event tables backed by Turso/libSQL.
- Runner workflow skeleton.
- Brokered ChatGPT auth for Codex execution sandboxes.
- Vercel Sandbox creation and command execution.
- Basic logs/events table.
- Dashboard showing pending/running/retrying/failed/completed.
- Manual refresh endpoint.

### 13.2 Core Conformance

- Cron-triggered scheduler.
- GitHub webhook-triggered scheduler.
- Atomic durable claims with TTL.
- Concurrency limits.
- Strict prompt rendering.
- Sandbox network policy.
- Agent timeout/stall handling.
- Retry/backoff.
- Git branch and PR creation.
- Project status updates.
- Snapshot/artifact persistence.
- Authenticated dashboard/admin endpoints.

### 13.3 Later Extensions

- Multiple GitHub Projects.
- Multi-tenant project model.
- GitHub login with user, organization, or team allowlists.
- Human-in-the-loop approvals.
- Rich run log streaming.
- Pluggable tracker adapters.
- Pluggable agent providers.
- Cost tracking.
- Advanced sandbox snapshot reuse.
- Temporal backend option if Vercel-only durability becomes insufficient.
