---
name: setup-rhapsody
description: Guide first-run Rhapsody onboarding. Use when the user invokes "$setup-rhapsody" or asks to set up, deploy, configure, or connect Rhapsody to Vercel, GitHub Projects, Turso/libSQL, Codex credentials, and repository-owned .rhapsody files. Covers prerequisite inspection, safe setup phases, user handoff points, preview-first deployment, and first issue smoke testing.
---

# Setup Rhapsody

## Goal

Guide an operator from a local Rhapsody checkout to a first runnable deployment without hiding
credentials or making destructive remote changes. Prefer preview-first setup and explicit operator
confirmation before production deployment, ProjectV2 mutation, or existing file edits.

Follow [ADR 0015](../../../docs/adr/0015-use-setup-skill-for-first-run-onboarding.md) when it is
present.

## Default Flow

Treat setup as resumable phases:

1. `inspect`
   - check `gh`, `vercel`, `pnpm`, and Node.js;
   - check GitHub and Vercel authentication;
   - infer Git remote, owner, repository, and current branch.
2. `configure-local`
   - confirm target GitHub owner/repository and ProjectV2 settings;
   - generate or preserve local secrets;
   - update `rhapsody.config.ts` only after explaining the intended diff;
   - create `.rhapsody/INSTRUCTIONS.md` and `.rhapsody/config.toml` only when absent, or show a diff
     and ask before modifying existing files.
3. `configure-github`
   - run the read-only GitHub Project bootstrap dry-run helper;
   - verify `gh` availability, auth, repository access, and whether local config already hints at
     the intended ProjectV2 target;
   - when authenticated, read the configured ProjectV2 target with GraphQL to confirm the project,
     status field, and configured active/terminal status options;
   - keep this phase read-only so it can prepare for GitHub Project detection or creation without
     mutating remote state.
4. `configure-remotes`
   - create or verify GitHub ProjectV2 configuration only after presenting a plan;
   - never delete, rename, or reorder existing ProjectV2 fields/statuses;
   - ask the operator to create Turso/libSQL and provide `TURSO_DATABASE_URL` and
     `TURSO_AUTH_TOKEN`;
   - configure Vercel environment variables with values redacted.
5. `deploy-preview`
   - run the deploy readiness dry-run helper before any apply or deploy step;
   - run `pnpm install` when needed;
   - run `pnpm db:migrate`;
   - deploy a Vercel preview by default;
   - ask before production env changes or production deployment.
6. `smoke-test`
   - after preview deployment, run the read-only smoke-test helper against the preview URL;
   - verify base URL, optional login/dashboard, and `/api/v1/state` endpoint behavior;
   - if `ROOT_PASSWORD` is available and the operator opts in, verify authenticated `/api/v1/state`;
   - open `/dashboard`;
   - verify the preview is ready for the first issue handoff.
7. `first-issue`
   - run the first issue handoff helper against the preview URL and issue number;
   - dry-run to confirm the manual run request before mutation;
   - apply only with `--use-root-password` and explicit confirmation;
   - verify the manual handoff response before moving on to scheduler or PR verification.
8. `first-attempt-start`
   - use the start-attempt helper with the manual run `runId`, `attemptId`, and the run's
     `claimToken`;
   - set `RHAPSODY_CLAIM_TOKEN` in the environment before running the helper;
   - dry-run first to confirm the endpoint, redacted payload shape, and whether the operator still
     needs to supply the claim token or root password;
   - apply only with `--apply --yes --use-root-password` when the claim token is available;
   - verify the attempt start response, then run the read-only run verification helper against the
     preview URL and run ID;
   - use the verification output to decide whether to wait for the runner workflow, inspect the
     dashboard for attempt and event evidence, or look for the PR handoff.
9. `verify-run`
   - run the read-only verification helper against the preview URL and run ID after
     `first-attempt-start`;
   - without `--use-root-password`, use it as a dry classification step that reports the endpoint
     and whether an authenticated fetch is available;
   - with `--use-root-password`, fetch `GET /api/v1/runs/:runId` and inspect the run, attempt,
     workflow, artifact, link, and event signals without printing raw bodies or secrets;
   - use the result to decide whether the setup flow should wait, inspect the dashboard, or look
     for PR handoff evidence.

## Inspect Phase

Start by running the read-only helper:

```bash
pnpm setup:inspect
```

Use its output to decide the next step. If a required CLI is missing or unauthenticated, stop and ask
the operator to install or log in before continuing.

For the first local configuration pass, run the dry-run helper next:

```bash
pnpm setup:configure-local -- --dry-run
```

Use its JSON output to confirm inferred repository facts, missing env inputs, and any blocked
future write steps before attempting changes. Treat generated secrets such as `ROOT_PASSWORD`,
`AUTH_SECRET`, `CRON_SECRET`, and `MEDIATOR_SECRET` as local setup material, while treating
Turso, GitHub, Vercel, and initial Codex seed values as operator-provided external inputs.

If the operator explicitly wants to persist only missing generated local secrets, use the limited
apply mode:

```bash
pnpm setup:configure-local -- --apply --yes
```

This apply mode is intentionally narrow: it only appends missing generated local secrets to
`.env.local`, never writes external inputs, never overwrites existing keys, and requires the
explicit confirmation flags.

Before any GitHub Project creation or detection work, run the read-only GitHub bootstrap probe:

```bash
pnpm setup:configure-github -- --dry-run
```

This helper does not create or modify GitHub Projects, issues, fields, repository settings, files,
or environment variables. Use its JSON output to confirm repository access, GitHub CLI readiness,
and whether the intended ProjectV2 target and status field/options can be verified from local
config and read-only remote inspection before any apply phase.

Before any deploy-preview or remote env apply work, run the read-only deploy readiness helper:

```bash
pnpm setup:deploy-preview -- --dry-run
```

This helper does not deploy, migrate, or mutate any remote state. Use its JSON output to confirm
Vercel CLI availability, Vercel auth, local project link state, and whether the deployment-critical
env keys are present before any apply or deploy step.

After deploy-preview succeeds, run:

```bash
pnpm setup:smoke-test -- --url <https://your-preview-url.vercel.app>
```

This helper is read-only. It verifies preview reachability and API smoke behavior before the first
issue-to-run handoff and marks whether authenticated `/api/v1/state` checks are possible.

Before triggering the first issue handoff, run:

```bash
pnpm setup:first-issue -- --url <https://your-preview-url.vercel.app> --issue-number <1>
```

This helper is read-only in dry-run mode. It prepares the manual first issue handoff against
`POST /api/v1/runs` and, with `--apply --yes --use-root-password`, performs the manual run creation
against the deployed preview API.

After you have the resulting `runId`, `attemptId`, and `claimToken`, set
`RHAPSODY_CLAIM_TOKEN` in the environment and run:

```bash
pnpm setup:start-attempt -- --url <https://your-preview-url.vercel.app> --run-id <runId> --attempt-id <attemptId>
```

This helper is read-only in dry-run mode. It prepares the manual attempt start against
`POST /api/v1/runs/:runId/attempts/:attemptId/start` and, with `--apply --yes --use-root-password`,
performs the authenticated attempt start against the deployed preview API.

To apply the start after setting `RHAPSODY_CLAIM_TOKEN`, run:

```bash
pnpm setup:start-attempt -- --url <https://your-preview-url.vercel.app> --run-id <runId> --attempt-id <attemptId> --apply --yes --use-root-password
```

After the attempt starts, verify the run detail:

```bash
pnpm setup:verify-run -- --url <https://your-preview-url.vercel.app> --run-id <runId>
```

If `ROOT_PASSWORD` is available and you want authenticated inspection, rerun with
`--use-root-password`:

```bash
pnpm setup:verify-run -- --url <https://your-preview-url.vercel.app> --run-id <runId> --use-root-password
```

When using `pnpm setup:deploy-preview -- --apply --yes`, this phase is explicitly limited to:
- `pnpm db:migrate`
- `vercel deploy` to preview only (no `--prod`)
- no production env changes and no GitHub Project mutations
- no `INITIAL_CHATGPT_AUTH_JSON` upload and no raw secret output

## Safety Rules

- Do not print raw secrets.
- Do not commit real secrets.
- Do not write secrets to tracked files.
- Before writing `.env.local`, verify it is ignored by Git.
- Preserve existing env values unless the operator chooses to rotate or replace them.
- Do not copy ChatGPT browser session state.
- Do not copy Codex credential material unless the operator explicitly chooses the documented
  Rhapsody credential seed flow.
- Do not silently upload `INITIAL_CHATGPT_AUTH_JSON` to Vercel.
- Do not silently overwrite `.rhapsody/INSTRUCTIONS.md`, `.rhapsody/config.toml`, `.codex/*`, or
  `rhapsody.config.ts`.
- Present a redacted plan before changing Vercel env vars, GitHub ProjectV2 configuration, or
  production deployment.

## User Handoffs

Return control to the operator for:

- missing CLI installation;
- `gh auth login`;
- Vercel login;
- Turso/libSQL database creation and token generation;
- Codex credential seed decisions;
- production deployment confirmation.

When handing off, state exactly what value or action is needed and how setup will resume.

## Output Shape

Keep updates concise and operational:

```text
Setup status:
- inspect: done
- configure-local: needs_user (TURSO_DATABASE_URL and TURSO_AUTH_TOKEN)
- configure-remotes: blocked until Turso values are available

Next action:
Create a Turso/libSQL database, then provide TURSO_DATABASE_URL and TURSO_AUTH_TOKEN.
```
