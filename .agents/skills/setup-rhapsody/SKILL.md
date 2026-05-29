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
   - run `pnpm install` when needed;
   - run `pnpm db:migrate`;
   - deploy a Vercel preview by default;
   - ask before production env changes or production deployment.
6. `smoke-test`
   - guide the operator to create or choose one GitHub issue;
   - place it in the configured active Project status;
   - open `/dashboard`;
   - trigger or wait for scheduler tick;
   - verify run, attempt, branch, and pull request or handoff artifact evidence.

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
