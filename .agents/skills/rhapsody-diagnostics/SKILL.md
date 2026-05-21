---
name: rhapsody-diagnostics
description: Diagnose Rhapsody production issue/run failures before a dashboard exists. Use when the user shares a toyamarinyon/rhapsody GitHub issue, run, branch, or PR and asks why it is stuck, weird, failed, not moving, not creating a pull request, "これおかしい", "PRできてない", "動いてない", or similar. Covers GitHub issue/PR/branch checks, Rhapsody state API event inspection, Vercel production deployment/log checks, and concise user-facing incident summaries.
---

# Rhapsody Diagnostics

## Goal

Explain what happened to a Rhapsody work item using the same production surfaces Rhapsody will later expose in its dashboard: GitHub state, Rhapsody state events, Vercel deployment/log state, and runner handoff details.

Keep the answer operational and concrete. The user usually wants "why did this not create a PR?" more than a broad architecture tour.

## Safety

- Prefer read-only commands first.
- Do not run scheduler, runner, migration, retry, release, merge, or status-changing endpoints unless the user explicitly asks for that action or approves it after you explain the side effect.
- Treat `GET /api/v1/admin/scheduler/tick` without `runId` as side-effecting because it starts a scheduler tick.
- Do not pull the full Vercel production environment just to diagnose. If a secret is needed, ask for the specific token/password or use already configured safe credentials.
- Never print auth tokens, env values, cookie values, or ChatGPT credentials. Quote command stderr from run events only after checking it does not contain secrets.
- If a command fails because network access is sandboxed, rerun with normal escalation and a narrow justification.

## Quick Triage

1. Parse the target.
   - Extract `owner/repo` and issue number from a URL like `https://github.com/toyamarinyon/rhapsody/issues/44`.
   - Default repository to `toyamarinyon/rhapsody` when the user is working in this repo and the issue number is clear.

2. Check GitHub state.
   - `gh issue view <number> --repo toyamarinyon/rhapsody --json number,title,state,projectItems,url,updatedAt`
   - `gh pr list --repo toyamarinyon/rhapsody --state all --search "<number>" --json number,title,state,headRefName,baseRefName,url,createdAt,updatedAt,isDraft`
   - `git ls-remote --heads origin "rhapsody/issue-<number>-*"` or `gh api repos/toyamarinyon/rhapsody/git/matching-refs/heads/rhapsody/issue-<number>-`
   - Interpret the combination:
     - Project `Todo` with no run events: scheduler probably has not picked it up.
     - Project `In Progress` with no branch/PR: runner likely started but failed before push or handoff.
     - Branch exists with no PR: PR handoff likely failed after push.
     - PR exists but Project not moved: post-run decision/status update likely failed or was skipped.

3. Check Rhapsody state.
   - Use the production state API when you have the admin password:
     - `curl -sS -H 'Authorization: Bearer <ROOT_PASSWORD>' https://rhapsody-toyamarinyon.vercel.app/api/v1/state`
   - Search `recentEvents` for the issue number, expected branch, run id, attempt id, or event types listed below.
   - If a run detail endpoint exists and is needed, use it read-only:
     - `curl -sS -H 'Authorization: Bearer <ROOT_PASSWORD>' https://rhapsody-toyamarinyon.vercel.app/api/v1/runs/<runId>`

4. Check Vercel state when Rhapsody state is insufficient.
   - Read `.vercel/project.json` for project/team ids.
   - Use the Vercel app tools or CLI to list deployments and build/runtime logs.
   - Confirm production alias and latest production commit before assuming which code is running.

5. Report the diagnosis.
   - Lead with the concrete failure.
   - Include the run id / attempt id when available.
   - Quote the smallest useful stderr/message snippet.
   - Say what did complete, what did not, and the next operational step.

## Event Reading Guide

Useful event types:

- `manual_run.created`: Rhapsody created a run/attempt and claim.
- `scheduler.project_status_updated`: scheduler moved the Project item, usually to `In Progress`.
- `attempt.started`: runner attempt started.
- `sandbox_codex_runner.source_preparation`: sandbox cloned and checked out the assigned branch.
- `sandbox_codex_runner.prompt_rendered`: Codex prompt was rendered; includes target branch and repo.
- `sandbox_codex_runner.wrapper_started`: Codex wrapper command started in sandbox.
- `attempt.callback_received`: sandbox callback returned execution/postflight data.
- `attempt.terminal_callback`: Rhapsody recorded final attempt status.
- `sandbox_codex_runner.pull_request_ready`: PR was created or reused.
- `sandbox_codex_runner.pull_request_failed`: PR creation/reuse failed.
- `sandbox_codex_runner.post_run_decision`: post-run policy evaluated; often contains `postflightSummary`.
- `sandbox_codex_runner.post_run_action_skipped`: side effects skipped because no trusted handoff existed.

Key fields to inspect:

- `data.branchName`
- `data.prSpec`
- `data.postflight.commands.commit_count`
- `data.postflight.commands.push.stderr`
- `data.postflight.commands.verify`
- `data.postflight.changed_files`
- `data.postflightSummary`
- `data.pullRequest`
- `data.error`

## Common Diagnoses

- GitHub token lacks `workflow` scope:
  - Symptom: runner commits a change to `.github/workflows/*.yml`, then push fails.
  - Stderr includes: `refusing to allow an OAuth App to create or update workflow ... without workflow scope`.
  - User-facing answer: "The runner made the change, but GitHub rejected the branch push because the token cannot update workflow files. No remote branch means no PR."
  - Next step: update production `GITHUB_TOKEN` with `workflow` scope, then retry the issue.

- Missing branch after `In Progress`:
  - Symptom: Project item moved to `In Progress`, but no `rhapsody/issue-N-*` branch exists.
  - Check `attempt.callback_received` and `postflight` for push or commit failures.

- Branch exists but no PR:
  - Symptom: push/verify succeeded, but no PR exists.
  - Check `sandbox_codex_runner.pull_request_failed` and GitHub API errors.

- No trusted handoff:
  - Symptom: `post_run_action_skipped` says no trusted pull request handoff was available.
  - Check whether execution failed, branch push failed, or `prSpec` is missing/invalid.

- Claim/run stale or timed out:
  - Symptom: run/attempt status is `timed_out` or `stale`, active claim may be zero after reconciliation.
  - Check latest events for missing callback, sandbox command timeout, or reconcile events.

- Production code/env mismatch:
  - Symptom: GitHub state suggests work happened, but state schema/API/logs disagree with local assumptions.
  - Confirm latest production deployment commit, alias, and env presence. Do not assume local `.env.local` matches production.

## Response Shape

Prefer a compact response:

```text
原因は <one-line cause> です。

確認できた流れ:
- Issue #N は Project で <status>
- run <runId> / attempt <attemptId> が <status>
- runner は <completed step> まで進んだ
- <failed step> でこの stderr が出ています: ...

なので PR がない理由は <branch/push/handoff explanation> です。
次は <one operational next step> です。
```

Avoid over-explaining unless the user asks. If confidence is low, say what is known, what is missing, and the next read-only check.
