# Rhapsody

Rhapsody is a serverless coding agent platform for teams that want GitHub Project issues to become observable Codex runs and pull requests.

It started from excitement about [OpenAI Symphony](https://openai.com/index/open-source-codex-orchestration-symphony/) as a reference implementation for coding-agent orchestration. Rhapsody explores what that shape can look like when it is deployed like a Vercel application: durable workflows, isolated sandboxes, GitHub Projects as the work queue, and repository-owned Markdown as the workflow definition.

The goal is to make team-facing coding-agent operations feel familiar:

- GitHub Projects are the work queue.
- `.rhapsody/INSTRUCTIONS.md` is the agent workflow prompt.
- Codex-native `.codex/` files stay with the target repository.
- Vercel Workflow coordinates scheduler and worker runs.
- Vercel Sandbox isolates each Codex execution.
- Rhapsody records claims, runs, attempts, events, decisions, branches, and pull requests.

Rhapsody is a template and reference application, not a hosted SaaS. You deploy it into your own Vercel project and connect it to your own GitHub Project, repository, state store, and Codex credentials.

## Why Rhapsody?

Coding agents are most useful when they fit into the development workflow a team already trusts: issues, project boards, branches, pull requests, logs, and versioned instructions.

Rhapsody is built around that idea. It does not try to move workflow policy into a separate product surface. The scheduler and runner live in a Vercel app, while the agent-facing instructions live in Git as Markdown.

This is the shape Rhapsody is exploring:

```text
GitHub Project issue
  -> scheduler workflow
  -> durable claim
  -> worker workflow
  -> Vercel Sandbox
  -> Codex
  -> branch / pull request / dashboard events
```

Earlier Vercel and Next.js stacks made parts of this hard to model as a serverless application. With Workflow DevKit for durable orchestration and Vercel Sandbox for isolated execution, the pieces are much closer to the platform shape Rhapsody needs.

## Current Status

Rhapsody is an MVP. It is intended for people who are comfortable configuring GitHub Projects, Vercel projects, environment variables, and a durable database.

The current implementation focuses on:

- GitHub Projects v2 as the tracker.
- A single configured GitHub repository and Project board.
- Turso/libSQL as the state store.
- Root-password admin access for the dashboard.
- PAT-based GitHub access held by trusted Rhapsody server-side code.
- Vercel Sandbox execution for Codex workers.
- ChatGPT-backed Codex credential brokering for sandboxed Codex runs.
- Dashboard and JSON API surfaces for operators.

Known MVP boundaries:

- Rhapsody is not multi-tenant.
- GitHub App installation tokens are deferred; the MVP uses `GITHUB_TOKEN`.
- GitHub Projects v2 is the only tracker.
- Operators are expected to review generated pull requests.
- Production-critical use requires careful review of the security model, credential handling, and sandbox policy.

See [docs/SPEC.md](docs/SPEC.md) for the working product and engineering specification.

## How It Works

Rhapsody has three layers of configuration:

1. Deployment configuration in environment variables.
2. Scheduler configuration in `rhapsody.config.ts`.
3. Repository workflow instructions in `.rhapsody/INSTRUCTIONS.md` and `.rhapsody/config.toml`.

The scheduler polls or refreshes the configured GitHub Project, normalizes eligible ProjectV2 items into work items, and claims work in the durable state store. Worker workflows then create or restore a Vercel Sandbox, prepare the target repository, launch Codex with the rendered instructions, and record the resulting events and handoff artifacts.

Rhapsody keeps sensitive credentials in trusted server-side code. Sandboxed runs use mediated access for GitHub writes and Codex credential access instead of receiving broad long-lived secrets directly.

## Quick Start

This is the expected happy path for a first run:

1. Deploy Rhapsody to Vercel.
2. Create a Turso/libSQL database for durable state.
3. Create or choose a GitHub ProjectV2 board.
4. Configure `rhapsody.config.ts` for your GitHub owner, repository, Project number, status field, and eligible statuses.
5. Add the required environment variables in Vercel.
6. Seed Codex ChatGPT credentials for sandboxed Codex runs.
7. Add `.rhapsody/INSTRUCTIONS.md` to the target repository.
8. Create one GitHub issue and place it in an eligible Project status.
9. Open the Rhapsody dashboard.
10. Trigger a manual scheduler refresh or wait for the configured cron.
11. Watch Rhapsody create a run, execute Codex in Sandbox, and hand the result back as a branch and pull request.

The setup experience is still being refined. Until the template flow and setup skill are complete, expect to read the configuration files and docs alongside this README.

## Prerequisites

You need:

- A Vercel account with access to Workflow and Sandbox features.
- A GitHub repository to run agents against.
- A GitHub ProjectV2 board that contains the work items.
- A GitHub token with repository access and ProjectV2 read/write access.
- A Turso/libSQL database.
- Codex credentials from a local ChatGPT login.
- Node.js and npm for local development.

## Environment Variables

Copy `.env.example` and fill in the values locally, then add the same values to your Vercel project.

Required for the MVP:

| Name | Purpose |
| --- | --- |
| `ROOT_PASSWORD` | Password for the Rhapsody admin dashboard and bearer-protected admin endpoints. |
| `AUTH_SECRET` | Secret used to sign admin session cookies. |
| `TURSO_DATABASE_URL` | libSQL state store URL. |
| `TURSO_AUTH_TOKEN` | libSQL auth token. |
| `GITHUB_TOKEN` | Server-side GitHub credential for repository and ProjectV2 access. |
| `MEDIATOR_SECRET` | Shared secret for sandbox-to-Rhapsody mediator calls. |
| `VERCEL_TOKEN` | Vercel API token used for Sandbox operations. |
| `VERCEL_TEAM_ID` | Vercel team scope for Sandbox operations. |
| `VERCEL_PROJECT_ID` | Vercel project scope for Sandbox operations. |

Common optional variables:

| Name | Purpose |
| --- | --- |
| `CRON_SECRET` | Secret expected by cron/admin refresh endpoints. |
| `INITIAL_CHATGPT_AUTH_JSON` | Initial Codex ChatGPT auth seed used by the credential seeding endpoint. |
| `RHAPSODY_CODEX_BASE_SNAPSHOT_ID` | Optional Sandbox snapshot ID used as a Codex-ready base image. |
| `VERCEL_PROTECTION_BYPASS_SECRET` | Optional Vercel Deployment Protection bypass for callback brokering. |
| `VERCEL_OIDC_ISSUER` | Optional issuer for Vercel OIDC verification. |
| `VERCEL_OIDC_AUDIENCE` | Optional audience for Vercel OIDC verification. |
| `VERCEL_TEAM_SLUG` | Optional team slug for Vercel OIDC verification. |

Do not expose these values to client components or commit real values to Git.

## Project Configuration

Edit `rhapsody.config.ts` to point Rhapsody at your GitHub repository and Project board:

```ts
import type { RhapsodyProjectConfig } from "./lib/config";

export default {
  tracker: {
    kind: "github_project",
    owner: "your-org",
    repository: "your-repo",
    projectNumber: 1,
    statusField: "Status",
    activeStatuses: ["Todo", "In Progress"],
    terminalStatuses: ["Done", "Canceled", "Cancelled", "Duplicate"],
  },
  repository: {
    owner: "your-org",
    name: "your-repo",
    defaultBranch: "main",
    branchPrefix: "rhapsody/",
  },
  scheduler: {
    maxConcurrentRuns: 3,
    maxConcurrentRunsByStatus: {},
    maxRetryBackoffMs: 300000,
  },
  runner: {
    kind: "sandbox-codex",
    timeoutMs: 60 * 60 * 1000,
  },
} satisfies RhapsodyProjectConfig;
```

For the MVP, one Rhapsody deployment schedules one configured GitHub Project and repository.

## Repository Workflow Files

The target repository should contain `.rhapsody/INSTRUCTIONS.md`. This Markdown file is rendered into the Codex prompt for each claimed work item.

Example:

```md
# Rhapsody Instructions

You are working on this repository through Rhapsody.

Read the GitHub issue, inspect the existing code, make the smallest safe change, run relevant checks, and prepare a pull request.

Prefer clear commits, concise PR descriptions, and changes that a human maintainer can review quickly.
```

Optional repository policy can live in `.rhapsody/config.toml`, for example post-run review and auto-merge eligibility rules. See the repository's own `.rhapsody/config.toml` for a current example.

Codex runtime behavior should stay in Codex-native `.codex/` files. Rhapsody owns the sandbox, mediator, callback, and host-side safety constraints.

## Codex Credentials

Rhapsody is designed to run Codex inside Vercel Sandbox while keeping upstream ChatGPT-backed Codex credentials in trusted server-side storage.

For the MVP, operators seed the initial ChatGPT auth JSON from a local Codex login:

1. Log in to Codex locally.
2. Copy the contents of `~/.codex/auth.json`.
3. Set `INITIAL_CHATGPT_AUTH_JSON` in the trusted Rhapsody environment.
4. Call the admin seeding endpoint described in `.env.example`.
5. Remove the seed value after the current credentials have been stored and refresh health is confirmed.

This area is intentionally security-sensitive. Review [docs/SPEC.md](docs/SPEC.md) and the credential-related ADRs before exposing a deployment beyond trusted operators.

## Local Development

Install dependencies:

```bash
npm install
```

Run the development server:

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

Useful checks:

```bash
npm run lint
npm run typecheck
npm run test
npm run build
```

## Dashboard

The dashboard is protected by the configured root password. It is intended to help operators answer:

- Which work items are eligible?
- Which item is currently claimed?
- Which worker runs and attempts exist?
- What happened inside a run?
- Which branch or pull request was produced?
- Why did Rhapsody stop, retry, ask for human review, or release a claim?

The dashboard is an operational surface, not the primary workflow definition surface. The durable workflow policy should remain in Git and Markdown.

## Security Model

Rhapsody's MVP security model is intentionally narrow:

- Admin UI access is protected by `ROOT_PASSWORD` and signed session cookies.
- Cron and internal endpoints use shared secrets where applicable.
- GitHub writes are mediated by trusted server-side code.
- The upstream `GITHUB_TOKEN` stays in the Rhapsody deployment environment.
- Codex runs happen inside Vercel Sandbox.
- Secrets must not be logged or passed into arbitrary repository code.
- Generated code should be reviewed through normal pull request review.

This is not yet a hardened multi-tenant SaaS architecture. Treat a Rhapsody deployment as trusted team infrastructure.

## Documentation

- [docs/SPEC.md](docs/SPEC.md): working product and engineering specification.
- [docs/CONCEPTS.md](docs/CONCEPTS.md): core domain concepts.
- [docs/ORIGINAL_SPEC.md](docs/ORIGINAL_SPEC.md): unmodified Symphony reference spec.
- [docs/adr](docs/adr): architecture decisions.

## Roadmap

Near-term work:

- Publish a Vercel Template flow.
- Add a setup skill for target repositories.
- Improve the first-run setup guide.
- Add clearer database initialization docs.
- Add a setup/doctor command for environment and Project validation.
- Add screenshots and a short demo walkthrough.
- Continue hardening credential refresh, mediator authorization, and sandbox policy.

Later work:

- GitHub App support.
- Multiple projects or repositories per deployment.
- More tracker adapters.
- Richer repair and review workers.
- Better hosted-template onboarding.

## License

License information is not finalized yet.
