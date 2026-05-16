# ADR 0007: Define MVP Config Boundaries

## Status

Accepted

## Context

Rhapsody has three different configuration concerns:

- deployment secrets and infrastructure values;
- the single GitHub Project that this Rhapsody deployment schedules for the MVP;
- repository-owned guidance for how the agent should work once a run has been claimed.

The boundary matters because Rhapsody should not become a deterministic workflow executor where all
completion behavior is encoded in configuration. The target model is more agentic: the agent reads
the issue, follows the team's workflow guidance, and chooses appropriate actions. Rhapsody still
defines the scheduler boundary and prevents unsafe external side effects through trusted host
components.

## Decision

Use three MVP configuration layers:

1. Environment variables define secrets and deployment infrastructure.
2. `rhapsody.config.ts` defines the single GitHub Project scheduler boundary.
3. `RHAPSODY.md`, with fallback to `WORKFLOW.md`, defines team workflow guidance for the agent.

The MVP is intentionally single-project. Do not design a partial multi-project or multi-tenant
configuration model yet. If Rhapsody later needs multiple projects or tenants, revisit the config,
auth, storage, dashboard, and mediator model together.

## Environment Variables

Environment variables are for values that should not live in source control or are inherently tied
to the deployment environment.

MVP environment variables include:

| Env var | Required | Secret | Purpose |
|---|---:|---:|---|
| `ROOT_PASSWORD` | production yes | yes | Admin login password |
| `AUTH_SECRET` | production yes | yes | Session cookie signing |
| `TURSO_DATABASE_URL` | yes | no-ish | libSQL state store URL |
| `TURSO_AUTH_TOKEN` | hosted Turso yes | yes | libSQL state store auth |
| `GITHUB_TOKEN` | yes | yes | Upstream GitHub credential held by trusted Rhapsody code |
| `MEDIATOR_SECRET` | yes | yes | Sandbox-to-mediator authentication secret |
| `CRON_SECRET` | if Cron enabled | yes | Vercel Cron endpoint auth |
| `GITHUB_WEBHOOK_SECRET` | if webhooks enabled | yes | GitHub webhook signature verification |
| `CHATGPT_ACCESS_TOKEN` and token state vars | if brokered Codex auth enabled | yes | Trusted ChatGPT/Codex credential state |
| `VERCEL_TOKEN` | if SDK/runtime requires it | yes | Vercel API/Sandbox management |
| `VERCEL_TEAM_ID` | if SDK/runtime requires it | mixed | Vercel team scope |
| `VERCEL_PROJECT_ID` | if SDK/runtime requires it | no | Vercel project scope |

`no-ish` means the value is not a credential by itself but can reveal deployment topology and should
not be logged casually.

Raw secrets MUST NOT be stored in `rhapsody.config.ts`, `RHAPSODY.md`, or `WORKFLOW.md`.

## `rhapsody.config.ts`

`rhapsody.config.ts` defines what this deployment schedules and the scheduler constraints that must
be known before claiming work.

Initial shape:

```ts
import type { RhapsodyProjectConfig } from "./lib/config";

export default {
  tracker: {
    kind: "github_project",
    owner: "toyamarinyon",
    repository: "rhapsody",
    projectNumber: 1,
    statusField: "Status",
    activeStatuses: ["Todo", "In Progress"],
    terminalStatuses: ["Done", "Canceled", "Cancelled", "Duplicate"],
  },
  repository: {
    owner: "toyamarinyon",
    name: "rhapsody",
    defaultBranch: "main",
    branchPrefix: "rhapsody/",
  },
  scheduler: {
    maxConcurrentRuns: 3,
    maxConcurrentRunsByStatus: {},
    claimTtlMs: 900000,
    maxRetryBackoffMs: 300000,
  },
} satisfies RhapsodyProjectConfig;
```

The config file owns:

- GitHub ProjectV2 owner, repository, project number, status field, active statuses, and terminal
  statuses;
- target repository, default branch, and branch prefix;
- scheduler concurrency limits, claim TTL, and retry backoff cap.

It does not own:

- raw credentials;
- team workflow prose;
- per-task completion rules such as a single `handoff_status`;
- general multi-project routing.

## `RHAPSODY.md`

`RHAPSODY.md` is repository-owned team workflow guidance. It tells the agent how to behave inside the
world that Rhapsody has already constrained.

For the MVP, `RHAPSODY.md` may be plain Markdown prompt text with no required YAML front matter.
`WORKFLOW.md` remains a fallback filename for compatibility with the original Symphony convention.

Example:

```md
You are working on this repository through Rhapsody.

When implementation changes are needed, create a branch, commit the changes, open a pull request,
and move the project item to Human Review.

If no code change is needed, explain the answer in an issue comment.

If the task is ambiguous, ask a concise clarifying question and leave the item in In Progress.
```

Do not add a first-class `handoff_status` setting in the MVP. Some tasks should move to human
review, some can be answered directly, and some should remain active with a clarifying comment. That
choice is part of the agent's contextual workflow judgment, guided by the prompt.

YAML front matter can be added later for runner-specific settings such as validation commands,
hooks, or agent limits, but the MVP does not require it.

## Mediator Checks

Agent decisions may be expressive and context-sensitive, but external side effects must pass through
trusted Rhapsody mediator code.

For the MVP, do not build a general rule engine. Implement hard-coded mediator checks for the
configured project and active run:

- allow GitHub operations only for the configured owner/repository;
- allow issue comments only on the run's issue or associated pull request;
- allow ProjectV2 status updates only for the run's configured project item;
- allow pull request creation only in the configured repository and base branch;
- require the configured branch prefix for agent-created branches;
- reject destructive or administrative GitHub operations by default;
- never forward raw upstream credentials to the sandbox.

If these checks grow complex, extract them into a policy module later. They should remain trusted
host-side enforcement, not prompt-only guidance.

## Validation

Keep MVP validation minimal and aligned with the point where a missing value matters.

Startup validation:

- production admin auth requires `ROOT_PASSWORD` and `AUTH_SECRET`;
- enabled machine triggers require their corresponding secrets;
- `rhapsody.config.ts` must load and satisfy the typed config shape.

Scheduler validation before claiming work:

- state store configuration is usable;
- GitHub credential is available;
- tracker owner, repository, project number, status field, and active statuses are present.

Mediator validation before GitHub writes:

- mediator authentication is valid;
- run and attempt exist and are active;
- the requested operation matches the configured repository, issue, project item, branch, and run
  lifecycle.

Runner-specific failures, such as a missing workflow file or invalid prompt template, may fail the
attempt instead of blocking application startup.

## Consequences

Positive consequences:

- Non-secret project configuration is visible in source as `rhapsody.config.ts`.
- Rhapsody keeps a narrow single-project MVP instead of prematurely designing multi-tenancy.
- `RHAPSODY.md` stays expressive and team-owned rather than becoming a rigid workflow program.
- Safety-critical side effects are enforced by trusted mediator checks.

Negative consequences:

- The MVP cannot configure different authority policies per project.
- Some runner behavior is fixed until `RHAPSODY.md` front matter is introduced.
- Multi-project support will require a deliberate redesign rather than a small config change.

## Revisit When

- Operators need multiple projects or tenants in one deployment.
- Mediator checks become complex enough to justify a first-class policy module.
- Repositories need configurable validation commands, hooks, or agent limits in `RHAPSODY.md`.
- GitHub App installation credentials replace the MVP GitHub token.
