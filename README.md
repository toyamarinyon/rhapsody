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

Rhapsody is intended to be distributed as a Vercel Template and currently works as a reference application you can deploy yourself. It is not a hosted SaaS. You deploy it into your own Vercel project and connect it to your own GitHub Project, repository, state store, and Codex credentials.

## Why Rhapsody?

Coding agents are most useful when they fit into the development workflow a team already trusts: issues, project boards, branches, pull requests, logs, and versioned instructions.

Rhapsody is built around that idea. It does not try to move workflow policy into a separate product surface. The scheduler and runner live in a Vercel app, while the agent-facing instructions live in Git as Markdown.

This is the shape Rhapsody is exploring:

```text
GitHub Project issue
  -> scheduler workflow
  -> durable claim
  -> runner workflow
  -> Vercel Sandbox
  -> Codex
  -> branch / pull request / dashboard events
```

Long-running schedulers and isolated agent execution are awkward fits for a traditional request/response Next.js app. With Workflow DevKit for durable orchestration and Vercel Sandbox for isolated execution, the pieces are much closer to the platform shape Rhapsody needs.

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

## Can I Try It Today?

Yes—if you can run the Rhapsody setup helpers and want an early-adopter onboarding path.

Use the setup flow in `$setup-rhapsody` (or the equivalent scripts directly): `inspect`, `configure-local`, `configure-github`, `configure-deploy`, `deploy-preview`, `smoke-test`, then the first-issue handoff path.

Turso/libSQL provisioning and Codex credential seeding remain operator-controlled:
- create and provide Turso/libSQL values (`TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`) yourself.
- supply `INITIAL_CHATGPT_AUTH_JSON` through the trusted seed flow only when you explicitly opt in.

## How It Works

Rhapsody has three layers of configuration:

1. Deployment configuration in environment variables.
2. Scheduler configuration in `rhapsody.config.ts`.
3. Repository workflow instructions in `.rhapsody/INSTRUCTIONS.md` and `.rhapsody/config.toml`.

The scheduler polls or refreshes the configured GitHub Project, normalizes eligible ProjectV2 items into work items, and claims work in the durable state store. Worker workflows then create or restore a Vercel Sandbox, prepare the target repository, launch Codex with the rendered instructions, and record the resulting events and handoff artifacts.

Rhapsody keeps sensitive credentials in trusted server-side code. Sandboxed runs use mediated access for GitHub writes and Codex credential access instead of receiving broad long-lived secrets directly.

## Vercel Template First-Run Onboarding

Deploy it quickly from Vercel Template mode:

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Ftoyamarinyon%2Frhapsody&env=ROOT_PASSWORD%2CAUTH_SECRET%2CCRON_SECRET%2CTURSO_DATABASE_URL%2CTURSO_AUTH_TOKEN%2CGITHUB_TOKEN%2CMEDIATOR_SECRET%2CVERCEL_TOKEN%2CVERCEL_TEAM_ID%2CVERCEL_PROJECT_ID)

This button creates/clones a Vercel project from this repo, and you still use `$setup-rhapsody` / setup helpers to complete GitHub Project setup, add Turso values, opt into Codex seed upload, run preview smoke tests, and perform the first issue handoff.

Security note: never put secret values in this deploy URL; provide secrets only in Vercel setup flows or prompted deploy fields.

If you started from the Vercel Template, use this path after deployment:

1. Deploy your own Vercel project for this repository (use your own Vercel account and team).
2. Run the setup flow against your fresh checkout and deployment target:
   - `pnpm setup:inspect`
   - `pnpm setup:configure-local -- --dry-run`
   - `pnpm setup:configure-github -- --dry-run`
   - `pnpm setup:configure-deploy -- --dry-run`
3. Provision Turso/libSQL yourself and add `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN` to local env/secrets.
4. Finish project mapping and deploy readiness:
   - `pnpm setup:configure-local -- --apply --yes`
   - create/use a GitHub ProjectV2 with `pnpm setup:configure-github -- --apply --yes --project-title "Rhapsody"` (if needed),
     then persist the board number with `pnpm setup:configure-local -- --apply --yes --project-number <number>`
   - `pnpm setup:configure-github -- --apply --yes --create-status-field` (if your status field is missing)
   - `pnpm setup:configure-deploy -- --apply --yes`
   - use `--include-codex-seed` only if you explicitly want to upload `INITIAL_CHATGPT_AUTH_JSON` to Vercel env.
5. Deploy a preview build only (no production by default):
   - `pnpm setup:deploy-preview -- --apply --yes` (includes `pnpm db:migrate`)
6. Smoke-test the preview with the output URL:
   - `pnpm setup:smoke-test -- --url <https://your-preview-url.vercel.app>`
7. Seed Codex credentials on the deployed preview (safe dry-run, then apply):
   - `pnpm setup:seed-codex -- --url <https://your-preview-url.vercel.app>`
   - `pnpm setup:seed-codex -- --url <https://your-preview-url.vercel.app> --apply --yes --use-root-password`
8. Create and hand off a first issue:
   - `pnpm setup:create-first-issue -- --apply --yes --title "Rhapsody smoke test"`
   - `pnpm setup:first-issue -- --url <https://your-preview-url.vercel.app> --issue-number <issueNumber> --apply --yes --use-root-password`
   - `pnpm setup:start-attempt -- --url <https://your-preview-url.vercel.app> --run-id <runId> --attempt-id <attemptId> --apply --yes --use-root-password`
9. Verify PR handoff evidence:
   - `pnpm setup:verify-run -- --url <https://your-preview-url.vercel.app> --run-id <runId> [--use-root-password]`
   - `pnpm setup:verify-run -- --url <https://your-preview-url.vercel.app> --run-id <runId> --use-root-password --wait` (recommended final handoff check after `setup:start-attempt`)

This path keeps to current MVP limits: no hosted auto-onboarding service, no automatic Turso provisioning, and no production auto-deploy.

Use the `number` emitted by `setup:configure-github`, `facts.issue.number` emitted by `setup:create-first-issue`, and the `runId`/`attemptId` emitted by `setup:first-issue` in the following commands.

Admin endpoints accept `Authorization: Bearer <ROOT_PASSWORD>`. Scheduler tick also accepts `Authorization: Bearer <CRON_SECRET>` when `CRON_SECRET` is configured.

After a successful first run, you should see:

- A claimed GitHub Project item in the Rhapsody dashboard.
- A recorded runner attempt with event logs.
- A branch created in the target repository.
- A pull request or handoff artifact linked from the run detail page.

The setup experience is still early-adopter oriented, and security-sensitive actions (including secrets and credential seeding) remain operator-confirmed.

## Prerequisites

You need:

- A Vercel account with access to Workflow and Sandbox features.
- A GitHub repository to run agents against.
- A GitHub ProjectV2 board that contains the work items.
- A GitHub token with repository access and ProjectV2 read/write access.
- A Turso/libSQL database.
- Codex credentials from a local ChatGPT login.
- Node.js and pnpm for local development.

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

Required for the default `sandbox-codex` runner:

| Name | Purpose |
| --- | --- |
| `INITIAL_CHATGPT_AUTH_JSON` | Initial Codex ChatGPT auth seed used by the credential seeding endpoint. |

Common optional variables:

| Name | Purpose |
| --- | --- |
| `CRON_SECRET` | Secret expected by cron/admin refresh endpoints. |
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

| File | Purpose |
| --- | --- |
| `.rhapsody/INSTRUCTIONS.md` | Per-run workflow instructions rendered with issue, run, attempt, repository, and Project context. |
| `.rhapsody/config.toml` | Optional repository policy for post-run decisions, review destinations, and repair rules. |
| `.codex/*` | Codex-native runtime configuration and agent files discovered by Codex inside the sandbox. |

Example:

```md
# Rhapsody Instructions

You are working on this repository through Rhapsody.

Read the GitHub issue, inspect the existing code, make the smallest safe change, run relevant checks, and prepare a pull request.

When a code change is needed, create a commit, push the assigned branch, and provide a concise pull request title and body for Rhapsody's handoff.

Prefer clear commits, concise PR descriptions, and changes that a human maintainer can review quickly.
```

Optional repository policy can live in `.rhapsody/config.toml`, for example post-run review and auto-merge eligibility rules. See the repository's own `.rhapsody/config.toml` for a current example.

Codex runtime behavior should stay in Codex-native `.codex/` files. Rhapsody owns the sandbox, mediator, callback, and host-side safety constraints.

## Codex Credentials

Rhapsody is designed to run Codex inside Vercel Sandbox while keeping upstream ChatGPT-backed Codex credentials in trusted server-side storage.

This is currently an operator-managed MVP flow, not a polished OAuth installation flow.

For the MVP, operators seed the initial ChatGPT auth JSON from a local Codex login:

1. Log in to Codex locally.
2. Copy the contents of `~/.codex/auth.json`.
3. Set `INITIAL_CHATGPT_AUTH_JSON` in the trusted Rhapsody environment.
4. Run helper `setup:seed-codex` against the preview in dry-run first, then apply:

```bash
pnpm setup:seed-codex -- --url <https://your-preview-url.vercel.app>
pnpm setup:seed-codex -- --url <https://your-preview-url.vercel.app> --apply --yes --use-root-password
```

5. If successful, confirm the helper shows seeded + health check success and remove `INITIAL_CHATGPT_AUTH_JSON` from local environment after a successful seed.

This area is intentionally security-sensitive. Review [docs/SPEC.md](docs/SPEC.md) and the credential-related ADRs before exposing a deployment beyond trusted operators.

## Local Development

Install dependencies:

```bash
pnpm install
```

Run migrations:

```bash
pnpm db:migrate
```

Run the development server:

```bash
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000).

Useful checks:

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
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

- Publish a polished template onboarding walkthrough with screenshots and a short demo path.
- Add clearer database initialization docs.
- Continue hardening credential refresh, mediator authorization, and sandbox policy.

Later work:

- GitHub App support.
- Multiple projects or repositories per deployment.
- More tracker adapters.
- Richer repair and review workers.
- Better hosted-template onboarding.

## License

License information is not finalized yet.
