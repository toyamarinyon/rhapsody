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

1. `plan`
   - print the stable first-run setup map;
   - use the output to decide the next command without mutating local files or remote services.
2. `status`
   - read local files and env key presence without printing secret values;
   - recommend the next conservative command based on local setup progress;
   - do not call network CLIs or mutate local or remote state.
3. `inspect`
   - check `gh`, `vercel`, `pnpm`, and Node.js;
   - check GitHub and Vercel authentication;
   - infer Git remote, owner, repository, and current branch.
4. `configure-local`
   - confirm target GitHub owner/repository and ProjectV2 settings;
   - generate or preserve local secrets;
   - update `rhapsody.config.ts` only after explaining the intended diff;
   - create `.rhapsody/INSTRUCTIONS.md` and `.rhapsody/config.toml` only when absent, or show a diff
     and ask before modifying existing files.
5. `configure-github`
   - run the read-only GitHub Project bootstrap dry-run helper;
   - verify `gh` availability, auth, repository access, and whether local config already hints at
     the intended ProjectV2 target;
   - when authenticated, read the configured ProjectV2 target with GraphQL to confirm the project,
     status field, and configured active/terminal status options;
   - keep this phase read-only so it can prepare for GitHub Project detection or creation without
     mutating remote state.
6. `configure-deploy`
   - configure deploy-related local/remote settings only after presenting a plan;
   - ask the operator to create Turso/libSQL and provide `TURSO_DATABASE_URL` and
     `TURSO_AUTH_TOKEN`;
   - configure Vercel environment variables with values redacted.
7. `deploy-preview`
   - run the deploy readiness dry-run helper before any apply or deploy step;
   - run `pnpm install` when needed;
   - run `pnpm db:migrate`;
   - deploy a Vercel preview by default;
   - ask before production env changes or production deployment.
8. `smoke-test`
   - after preview deployment, run the read-only smoke-test helper against the preview URL;
   - verify base URL, optional login/dashboard, and `/api/v1/state` endpoint behavior;
   - if `ROOT_PASSWORD` is available and the operator opts in, verify authenticated `/api/v1/state`;
   - open `/dashboard`;
   - verify the preview is ready for the first issue handoff.
9. `seed-codex`
   - run dry-run to confirm seed endpoint + health-check endpoint targets and next actions;
   - apply only with `--apply --yes --use-root-password` so seed and health checks stay explicit.
10. `create-first-issue`
   - create one smoke-test issue and add it to the configured ProjectV2 board;
   - dry-run to confirm GitHub repository/project preconditions and planned mutations;
   - apply only with `--apply --yes`;
   - capture `issueNumber`/`issueUrl` for the subsequent manual handoff helper.
11. `first-issue`
   - run the first issue handoff helper against the preview URL and issue number;
   - dry-run to confirm the manual run request before mutation;
   - apply only with `--use-root-password` and explicit confirmation;
   - verify the manual handoff response before moving on to scheduler or PR verification.
12. `first-attempt-start`
   - use the start-attempt helper with the manual run `runId`, `attemptId`, and the run's
     `claimToken`;
   - if `RHAPSODY_CLAIM_TOKEN` is not already available in process env or `.env.local`, derive it
     from authenticated `GET /api/v1/runs/:runId` during apply;
   - dry-run first to confirm the endpoint, redacted payload shape, and whether the operator still
     needs to supply the claim token or root password;
   - apply only with `--apply --yes --use-root-password` when the claim token is available;
   - verify the attempt start response, then run the read-only run verification helper against the
     preview URL and run ID;
   - use the verification output to decide whether to wait for the runner workflow, inspect the
     dashboard for attempt and event evidence, or look for the PR handoff.
13. `verify-run`
   - run the read-only verification helper against the preview URL and run ID after
     `first-attempt-start`;
   - without `--use-root-password`, use it as a dry classification step that reports the endpoint
     and whether an authenticated fetch is available;
   - with `--use-root-password`, fetch `GET /api/v1/runs/:runId` and inspect the run, attempt,
     workflow, artifact, link, and event signals without printing raw bodies or secrets;
   - use the result to decide whether the setup flow should inspect the dashboard, or look for PR
     handoff evidence;
   - for final setup confirmation after `setup:start-attempt`, prefer
     `--use-root-password --wait` with tuned timeout/interval to poll until handoff success or failure;

## Plan And Inspect Phases

Start by running the read-only setup map:

```bash
pnpm setup:plan
```

Use its output to confirm the full phase order and the recommended next command.

Then check local setup progress without calling network CLIs:

```bash
pnpm setup:status
```

Use its output to decide whether local configuration or deploy env dry-runs should run before
authentication inspection.

Then run the read-only inspection helper:

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

After creating or confirming a GitHub ProjectV2 board, persist only the board number with:

```bash
pnpm setup:configure-local -- --dry-run --project-number <number>
pnpm setup:configure-local -- --apply --yes --project-number <number>
```

That mode updates only `rhapsody.config.ts` for local bootstrap continuity and requires no
remote state writes.

Before any GitHub Project creation or detection work, run the read-only GitHub bootstrap probe:

```bash
pnpm setup:configure-github -- --dry-run
```

This helper can now run in a narrow apply path with explicit confirmation:

```bash
pnpm setup:configure-github -- --apply --yes --project-title <title>
```

Apply mode only creates a new ProjectV2 board at the resolved owner when all of these are true:
- `gh` is available and authenticated
- the repository owner/repository is resolved
- the repository is readable
- no local configured ProjectV2 number already exists
- a non-empty `--project-title` is provided

Created project metadata is reported in `project.remote` output (`number`, `id`, `url`, `title`) for a later helper or operator to persist in `rhapsody.config.ts`.
Persist that value with `setup:configure-local -- --apply --yes --project-number <number>`.

This helper does not create fields or modify status options; field/status reconciliation remains a later/manual step.

In read-only mode it behaves as before and does not create or modify GitHub Projects, issues, fields, repository settings, files,
or environment variables.

After you have an existing configured ProjectV2 target with a missing status field, this helper can now also create the configured status field only:

```bash
pnpm setup:configure-github -- --apply --yes --create-status-field
```

That path is intentionally limited:
- it only creates the configured status field on the configured ProjectV2 number when all of these are true:
  - `gh` is available and authenticated
  - repository access is verified
  - `tracker.projectNumber` is set in `rhapsody.config.ts`
  - the configured ProjectV2 can be read
  - `tracker.statusField` is set
  - at least one configured `activeStatuses` or `terminalStatuses` value exists
- it requires the configured field to be missing
- it creates a single-select field with configured `activeStatuses` + `terminalStatuses`
- it does not modify existing fields and does not append missing options to existing fields

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

After smoke-test, seed deployed Codex credentials against the preview:

```bash
pnpm setup:seed-codex -- --url <https://your-preview-url.vercel.app>
```

Dry-run is read-only and confirms the `seed-from-env` and health-check endpoint targets on the deployed
environment.

Apply only with:

```bash
pnpm setup:seed-codex -- --url <https://your-preview-url.vercel.app> --apply --yes --use-root-password
```

The helper uses `seed-from-env` + `health-check` endpoints, and should never print or copy raw
`INITIAL_CHATGPT_AUTH_JSON` locally.

Before triggering the first issue handoff, run:

```bash
pnpm setup:create-first-issue -- --title "Rhapsody smoke test"
```

This helper is read-only by default. It prepares defaults and validates `gh`/ProjectV2 preconditions.

```bash
pnpm setup:create-first-issue -- --apply --yes --title "Rhapsody smoke test"
```

This apply mode creates a real issue and adds it to the configured ProjectV2.

Capture `facts.issue.number` (or `issueNumber` if that is the output shape) from `setup:create-first-issue` and pass it as `<issueNumber>` to `setup:first-issue`.

```bash
pnpm setup:first-issue -- --url <https://your-preview-url.vercel.app> --issue-number <issueNumber>
```

This helper is read-only in dry-run mode. It prepares the manual first issue handoff against
`POST /api/v1/runs` and, with `--apply --yes --use-root-password`, performs the manual run creation
against the deployed preview API.

After you have the resulting `runId` and `attemptId`, run:

```bash
pnpm setup:start-attempt -- --url <https://your-preview-url.vercel.app> --run-id <runId> --attempt-id <attemptId>
```

This helper is read-only in dry-run mode. It prepares the manual attempt start against
`POST /api/v1/runs/:runId/attempts/:attemptId/start` and, with `--apply --yes --use-root-password`,
performs the authenticated attempt start against the deployed preview API.

Dry-run then apply:

```bash
pnpm setup:start-attempt -- --url <https://your-preview-url.vercel.app> --run-id <runId> --attempt-id <attemptId> --apply --yes --use-root-password
```

If `RHAPSODY_CLAIM_TOKEN` is already available in process env or `.env.local`, the helper uses it
directly.

If it is missing, the helper derives it from `GET /api/v1/runs/:runId` in the same apply invocation.

After the attempt starts, verify the run detail:

```bash
pnpm setup:verify-run -- --url <https://your-preview-url.vercel.app> --run-id <runId>
```

If `ROOT_PASSWORD` is available and you want authenticated inspection, rerun with
`--use-root-password`:

```bash
pnpm setup:verify-run -- --url <https://your-preview-url.vercel.app> --run-id <runId> --use-root-password
```

## Preview First Run Runbook

Minimal sequence from remote env readiness to first PR:

1. Confirm deploy configuration readiness

```bash
pnpm setup:configure-deploy -- --dry-run
```

2. Apply preview/development Vercel env vars

```bash
pnpm setup:configure-deploy -- --apply --yes
```
By default this does not upload `INITIAL_CHATGPT_AUTH_JSON`; add `--include-codex-seed` if you want that explicit upload.

3. Deploy preview readiness

```bash
pnpm setup:deploy-preview -- --dry-run
```

4. Deploy preview

```bash
pnpm setup:deploy-preview -- --apply --yes
```

5. Smoke test deployed preview

```bash
pnpm setup:smoke-test -- --url <https://your-preview-url.vercel.app>
```

6. Seed deployed Codex credentials (dry run)

```bash
pnpm setup:seed-codex -- --url <https://your-preview-url.vercel.app>
```

7. Seed deployed Codex credentials (apply)

```bash
pnpm setup:seed-codex -- --url <https://your-preview-url.vercel.app> --apply --yes --use-root-password
```

8. Create first smoke-test issue and add it to ProjectV2

```bash
pnpm setup:create-first-issue -- --apply --yes --title "Rhapsody smoke test"
```

9. Create first run manually (dry run)

```bash
pnpm setup:first-issue -- --url <https://your-preview-url.vercel.app> --issue-number <issueNumber>
```

10. Create first run manually (apply)

```bash
pnpm setup:first-issue -- --url <https://your-preview-url.vercel.app> --issue-number <issueNumber> --apply --yes --use-root-password
```

Capture `runId` and `attemptId` from the response before continuing.

11. Start the attempt (dry run)

```bash
pnpm setup:start-attempt -- --url <https://your-preview-url.vercel.app> --run-id <runId> --attempt-id <attemptId>
```

12. Start the attempt (apply)

```bash
pnpm setup:start-attempt -- --url <https://your-preview-url.vercel.app> --run-id <runId> --attempt-id <attemptId> --apply --yes --use-root-password
```

If `RHAPSODY_CLAIM_TOKEN` is missing, it is derived from authenticated `GET /api/v1/runs/:runId`
during the same apply invocation.

13. Verify run state (no auth)

```bash
pnpm setup:verify-run -- --url <https://your-preview-url.vercel.app> --run-id <runId>
```

14. Verify run state with auth

```bash
pnpm setup:verify-run -- --url <https://your-preview-url.vercel.app> --run-id <runId> --use-root-password
```

For the final setup pass (first issue -> PR handoff), use wait mode:

```bash
pnpm setup:verify-run -- --url <https://your-preview-url.vercel.app> --run-id <runId> --use-root-password --wait
```

Success signals for this path:
- `setup:first-issue` returns `runId` and `attemptId`.
- `setup:start-attempt` returns `runnerWorkflowRunId` or an idempotent/conflict signal that directs you to inspect dashboard evidence.
- `setup:verify-run` outputs `runnerWorkflowRunId`, attempts, events, artifacts, and links; later runs should also show PR/handoff references when present.
- `setup:verify-run` with auth outputs explicit PR handoff signals: pull request artifact count, branch artifact count, pull request URL/number from artifact metadata, and pull_request_ready/pull_request_missing/pull_request_failed event presence.

Blocked handling:
- Missing Turso/Vercel/GitHub/Codex seed values → return to `setup:configure-local` or `setup:configure-github`, then resume.
- Preview, auth, or network errors during reachability checks → re-run `setup:smoke-test` and `setup:deploy-preview` checks before retrying next step.
- No claim token returned from run detail → verify `runId`, then rerun authenticated `setup:verify-run` to confirm run visibility.

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
- configure-deploy: blocked until Turso values are available

Next action:
Create a Turso/libSQL database, then provide TURSO_DATABASE_URL and TURSO_AUTH_TOKEN.
```
