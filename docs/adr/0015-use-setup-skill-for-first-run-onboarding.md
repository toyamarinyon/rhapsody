# ADR 0015: Use a Setup Skill for First-Run Onboarding

## Status

Proposed

## Context

Rhapsody is intended to be deployable by teams as their own Vercel-hosted coding agent platform. A
README and Vercel Template can start that journey, but first-run setup crosses several systems:

- local prerequisites such as `gh`, `vercel`, `pnpm`, and Node.js;
- GitHub authentication and repository access;
- GitHub Projects v2 project, field, and status configuration;
- Vercel project linking, deployment, and environment variables;
- Turso/libSQL database creation and migration;
- Codex credentials from a local ChatGPT login;
- Rhapsody-owned deployment configuration in `rhapsody.config.ts`;
- repository-owned workflow files under `.rhapsody/`;
- a first issue smoke test that proves the scheduler can see work.

The target audience includes people who are excited by Symphony-like coding-agent orchestration,
Notion Dev-like team workflow automation, Vercel-native deployment, and Git plus Markdown workflow
definitions. Those users should not have to manually stitch every system together before seeing the
first useful Rhapsody run.

At the same time, a fully hosted SaaS is not the MVP. Rhapsody should preserve the self-hosted or
team-hosted deployment shape where operators can see which credentials are created, where they are
stored, and which services are connected.

## Decision

Provide a `$setup-rhapsody` Codex skill as the guided first-run onboarding path.

The setup skill is an operator workflow, not only a repository-file generator. It should inspect the
current machine, guide the operator through missing prerequisites, automate safe local and remote
configuration, and leave the deployment in a state where the operator can run a first issue through
Rhapsody.

The setup skill SHOULD:

1. Check whether required CLIs are installed:
   - `gh`
   - `vercel`
   - `pnpm`
   - Node.js
2. Check authentication state:
   - `gh auth status`
   - Vercel CLI login state
3. Infer or ask for:
   - GitHub owner and repository
   - default branch
   - GitHub ProjectV2 owner and project name
   - Project status field name
   - active and terminal statuses
   - Vercel team or personal scope
4. Create or reuse a GitHub ProjectV2 board when possible.
5. Create or verify expected GitHub ProjectV2 fields and statuses when possible.
6. Generate local deployment secrets:
   - `ROOT_PASSWORD`
   - `AUTH_SECRET`
   - `CRON_SECRET`
   - `MEDIATOR_SECRET`
7. Update `rhapsody.config.ts` with the selected GitHub Project and repository boundary.
8. Create or update repository-owned Rhapsody workflow files:
   - `.rhapsody/INSTRUCTIONS.md`
   - `.rhapsody/config.toml`
9. Guide the operator through Turso/libSQL database creation and wait for:
   - `TURSO_DATABASE_URL`
   - `TURSO_AUTH_TOKEN`
10. Configure local environment files without logging secret values.
11. Configure Vercel environment variables where safely automatable.
12. Run `pnpm install` when needed.
13. Run `pnpm db:migrate`.
14. Deploy a Vercel preview by default, or deploy production only after explicit operator
    confirmation.
15. Guide a first issue smoke test:
   - create or choose a GitHub issue
   - add it to the configured Project status
   - open `/dashboard`
   - trigger or wait for scheduler tick
   - confirm that a run, attempt, branch, and pull request or handoff artifact appear.

The setup skill MUST treat setup as resumable. It should report a checklist with `done`,
`needs_user`, `blocked`, or `skipped` style states so the operator can return after completing a
manual step.

Fragile or repetitive operations SHOULD live in checked-in helper scripts rather than only in skill
prose. Good candidates include:

- prerequisite inspection;
- GitHub ProjectV2 creation and field/status reconciliation;
- secret generation;
- Vercel environment synchronization;
- setup state inspection;
- first-run smoke checks.

The skill should call those helpers when available and keep the skill body focused on workflow,
branching decisions, user handoff points, and recovery behavior.

## MVP Setup Phases

The first setup skill implementation should be phased rather than a fully autonomous installer.

MVP phases:

1. `inspect`
   - check local CLIs and authentication state;
   - infer repository, Vercel, and Project defaults;
   - report missing prerequisites.
2. `configure-local`
   - generate secrets;
   - update `rhapsody.config.ts`;
   - create or propose `.rhapsody/` files;
   - write local ignored environment files.
3. `configure-remotes`
   - create or verify GitHub ProjectV2 configuration where safe;
   - configure Vercel environment variables after operator review;
   - wait for Turso/libSQL values from the operator.
4. `deploy-preview`
   - run `pnpm install` when needed;
   - run `pnpm db:migrate`;
   - create a Vercel preview deployment by default.
5. `smoke-test`
   - guide a first issue through the configured Project status;
   - trigger or wait for a scheduler tick;
   - verify dashboard evidence for a run, attempt, branch, and pull request or handoff artifact.

Production deployment, destructive Project changes, fully automated Turso provisioning, and
credential export or copy flows are not part of the MVP default path.

## Turso/libSQL Boundary

For the MVP, the setup skill SHOULD return control to the operator for Turso/libSQL database
creation.

The skill may explain what Rhapsody needs and then wait for the operator to provide:

- `TURSO_DATABASE_URL`
- `TURSO_AUTH_TOKEN`

Rhapsody should not initially automate Turso account, organization, region, billing, or token
creation.

This boundary keeps the first setup skill narrower and avoids hiding billing and data-residency
decisions behind automation. It also leaves room for later support of other libSQL-compatible
providers or Vercel Marketplace storage integrations.

## Codex Credentials Boundary

The setup skill may check whether local Codex authentication appears available, but it MUST NOT copy
ChatGPT or Codex credential material unless the operator explicitly chooses a documented Rhapsody
credential seed flow.

For the MVP, Codex credential setup remains an operator-controlled step:

- the operator obtains the supported local Codex auth JSON;
- the operator decides whether to place it in `INITIAL_CHATGPT_AUTH_JSON`;
- Rhapsody seeds server-side mediator credential state through the documented admin endpoint;
- the operator removes the initial seed value after seeding and health verification.

The setup skill and helper scripts MUST NOT:

- copy browser session state;
- copy local ChatGPT or Codex auth files into tracked repository files;
- write Codex credential material into `.rhapsody/`, `.codex/`, `rhapsody.config.ts`, or generated
  setup-state files;
- print or summarize raw credential values;
- silently upload credential material to Vercel environment variables.

If a future setup flow automates credential seeding, that flow must be documented separately and
must preserve the same no-logging and no-tracked-file requirements.

## Vercel Boundary

The setup skill SHOULD automate Vercel project setup when the operator is already authenticated and
the action is clear.

The skill may:

- check Vercel CLI availability and login state;
- link or create the Vercel project after confirmation;
- add or update environment variables without printing secret values;
- deploy a preview or production deployment after confirmation;
- report the deployment URL and dashboard URL.

The skill SHOULD ask before changing production environment variables or deploying to production.
Preview deployment can be the default first smoke-test target unless the operator explicitly wants
production.

For production deployment, the skill should present a short plan that names:

- the Vercel project and scope;
- the deployment target;
- the environment variables that will be set or updated, with values redacted;
- the command or API operation to be run.

The operator must confirm before the skill proceeds.

## GitHub Project Boundary

The setup skill SHOULD automate GitHub ProjectV2 setup where the GitHub CLI and API make it
reliable.

The MVP should support:

- finding an existing ProjectV2 by owner and title;
- creating a ProjectV2 board when one does not exist and the operator confirms;
- resolving project number and node ID;
- resolving or creating the configured status field when possible;
- ensuring expected status options exist when possible;
- writing the selected project number and status names to `rhapsody.config.ts`.

If GitHub ProjectV2 field mutation proves too fragile for a first release, the skill may fall back
to explicit operator instructions and then verify the resulting project shape.

Before mutating ProjectV2 configuration, the skill should:

- verify the authenticated account has the required permissions;
- present a redacted plan of the project, field, and status changes;
- ask for operator confirmation;
- avoid deleting, renaming, or reordering existing fields or status options;
- prefer additive changes and verification over destructive repair.

If a name collision is detected, the skill should stop and ask the operator how to proceed rather
than guessing.

## Environment and Setup State

Allowed secret destinations for the MVP are:

- ignored local environment files such as `.env.local`;
- Vercel environment variables;
- Rhapsody's encrypted server-side credential state after the documented seeding flow.

Before writing local environment files, the setup skill or helper script should verify that the file
is ignored by Git. When practical, it should write restrictive file permissions.

The setup skill should show dry-run or diff summaries with secret values redacted. It should report
which keys will be created, preserved, replaced, or skipped.

Persistent setup state, if introduced, must be redacted. It should store facts such as
`vercelProjectLinked`, `githubProjectResolved`, `tursoDatabaseUrlPresent`, or
`codexCredentialsSeeded`, not raw secret material. Idempotent probes should be preferred over
persisting setup state.

## Repository File Updates

The setup skill may create `.rhapsody/INSTRUCTIONS.md` and `.rhapsody/config.toml` when they do not
exist.

If either file already exists, the skill should preserve it by default. It may:

- show a proposed diff;
- ask before modifying the file;
- write an example or generated candidate next to the existing file when a direct edit would be too
  risky.

The skill MUST NOT silently overwrite repository-owned workflow files.

## Security Requirements

The setup skill and helper scripts MUST NOT:

- print raw secrets;
- commit real secrets;
- write secrets to repository-tracked files;
- pass broad tokens into generated `.rhapsody/` or `.codex/` files;
- assume a production deployment is safe without operator confirmation;
- silently overwrite existing user configuration.

Generated local secrets should be written only to ignored environment files or passed to Vercel
environment variable APIs. Existing values should be preserved unless the operator chooses to rotate
or replace them.

## Out of Scope for the MVP Default Path

- Fully automated Turso/libSQL account, organization, billing, region, or token creation.
- Production deployment without explicit confirmation.
- Destructive GitHub ProjectV2 edits such as deleting, renaming, or reordering existing fields.
- Silent edits to existing repository workflow files.
- Copying ChatGPT browser session data or Codex auth files outside the documented credential seed
  flow.
- Fully autonomous first pull request creation when Codex credentials and sandbox execution are not
  configured.

## Consequences

Positive consequences:

- First-run setup becomes more reproducible than README-only setup.
- The Vercel Template becomes more useful because it can be paired with an agentic setup workflow.
- Operators can get from interest to first run with fewer manual context switches.
- Setup can be resumed after Turso creation, CLI login, or other user-controlled steps.
- Fragile GitHub and Vercel API details can be centralized in helper scripts.

Negative consequences:

- `$setup-rhapsody` becomes an operational surface that must be maintained.
- GitHub ProjectV2 and Vercel CLI behavior may drift and require updates.
- Helper scripts need tests or smoke validation.
- The setup flow must be careful about secrets, shell history, and production changes.
- A broad setup skill can become too magical unless it reports each action clearly.

## Alternatives Considered

### README-only setup

This is simple to maintain, but it leaves too many users manually coordinating GitHub Projects,
Vercel, Turso, Codex credentials, environment variables, and migrations before they can see a first
run.

### Vercel Template-only setup

This improves deployment but does not create or verify GitHub ProjectV2 configuration, repository
workflow files, Codex credential setup, database migration, or first-run smoke testing.

### Fully hosted SaaS

This would reduce setup burden, but it is outside the MVP direction. Rhapsody is currently a
self-hosted or team-hosted application.

### Fully automated Turso creation

This may be useful later, but it expands the first setup surface into account, billing, region, and
provider-specific token management. The MVP should ask the operator to create the database and
provide the resulting URL and token.

### Manual GitHub Project setup

This is a reasonable fallback when ProjectV2 mutation is brittle, but it should not be the default
experience if the skill can reliably create or verify the required Project shape.
