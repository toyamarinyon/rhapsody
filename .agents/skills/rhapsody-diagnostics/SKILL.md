---
name: rhapsody-diagnostics
description: Diagnose Rhapsody production issue, worker graph, run, branch, PR, intake, repair, or scheduler failures. Use when the user shares a toyamarinyon/rhapsody GitHub issue/run/branch/PR and asks why it is stuck, weird, failed, not moving, not creating a pull request, blocked, waiting for repair, "これおかしい", "PRできてない", "動いてない", or similar. Covers GitHub issue/PR/branch checks, Rhapsody state and work-item graph APIs, runner/attempt events, Vercel deployment/log state, and concise user-facing incident summaries.
---

# Rhapsody Diagnostics

## Goal

Explain what happened to a Rhapsody work item using the same production surfaces Rhapsody exposes or will expose in its dashboard: GitHub state, the work-item graph, Rhapsody run/attempt events, Vercel deployment/log state, and runner handoff details.

Keep the answer operational and concrete. The user usually wants "why did this not create a PR?", "why is this still Todo/In Progress?", or "what should I retry/fix next?" more than a broad architecture tour.

## Safety

- Prefer read-only commands first.
- Do not run scheduler, runner, migration, retry, release, merge, reconcile, sandbox smoke, credential seed/probe, or status-changing endpoints unless the user explicitly asks for that action or approves it after you explain the side effect.
- Treat `GET /api/v1/admin/scheduler/tick` without `runId` as side-effecting because it starts a scheduler tick.
- Treat `GET` and `POST /api/v1/admin/reconcile` as side-effecting because they can mark attempts stale/timed out and release claims.
- Treat `POST /api/v1/runs`, `/api/v1/runs/<runId>/attempts/<attemptId>/start`, `/api/v1/runs/<runId>/attempts/<attemptId>/run`, `/api/v1/runs/<runId>/claim/release`, `/api/v1/admin/db/migrate`, `/api/v1/admin/sandbox-snapshots/*`, and `/api/v1/admin/codex-chatgpt-credentials/*` as side-effecting or sensitive.
- Do not pull the full Vercel production environment just to diagnose. If a secret is needed, ask for the specific token/password or use already configured safe credentials.
- Never print auth tokens, env values, cookie values, or ChatGPT credentials. Quote command stderr from run events only after checking it does not contain secrets.
- If a command fails because network access is sandboxed, rerun with normal escalation and a narrow justification.

## Quick Triage

1. Parse the target.
   - Extract `owner/repo` and issue number from a URL like `https://github.com/toyamarinyon/rhapsody/issues/44`.
   - Extract PR number from `pull/<number>`, run id from `run_<...>`, attempt id from `attempt_<...>`, and branch names like `rhapsody/issue-<number>-<attempt>`.
   - Default repository to `toyamarinyon/rhapsody` when the user is working in this repo and the issue number is clear.

2. Check GitHub state.
   - `gh issue view <number> --repo toyamarinyon/rhapsody --json number,title,state,projectItems,url,updatedAt`
   - `gh issue view <number> --repo toyamarinyon/rhapsody --comments --json comments,body,number,title,state,projectItems,url,updatedAt` when intake/human-response behavior matters.
   - `gh pr list --repo toyamarinyon/rhapsody --state all --search "<number>" --json number,title,state,headRefName,baseRefName,url,createdAt,updatedAt,isDraft,headRefOid`
   - `gh pr view <number> --repo toyamarinyon/rhapsody --json number,title,state,headRefName,headRefOid,baseRefName,url,mergeStateStatus,statusCheckRollup,comments,reviews,updatedAt` when a PR exists.
   - `git ls-remote --heads origin "rhapsody/issue-<number>-*"` or `gh api repos/toyamarinyon/rhapsody/git/matching-refs/heads/rhapsody/issue-<number>-`
   - Interpret the combination:
     - Project `Todo` with no graph/run events: scheduler probably has not picked it up, intake blocked it, or concurrency was full.
     - Project `Todo` with an `ask_human` or `blocked` intake decision: builder intentionally did not start.
     - Project `In Progress` with no branch/PR: builder started but failed before push or handoff.
     - Branch exists with no PR: PR handoff likely failed after push.
     - PR exists but Project not moved: post-PR curator, repairer, merge policy, or Project status update likely blocked or failed.

3. Check Rhapsody state and graph.
   - Use the production state API when you have the admin password:
     - `curl -sS -H 'Authorization: Bearer <ROOT_PASSWORD>' https://rhapsody-toyamarinyon.vercel.app/api/v1/state`
   - Search `recentEvents` for the issue number, work item id, expected branch, run id, attempt id, or event types listed below.
   - For GitHub issues, the work item id is usually `github:toyamarinyon/rhapsody#<number>`. URL-encode it for the graph route:
     - `curl -sS -H 'Authorization: Bearer <ROOT_PASSWORD>' 'https://rhapsody-toyamarinyon.vercel.app/api/v1/work-items/github%3Atoyamarinyon%2Frhapsody%23<number>/graph'`
   - Prefer the work-item graph when diagnosing scheduler/intake/post-PR/repair behavior. It should include `workerRuns`, `decisions`, `artifacts`, and `links`.
   - Use run detail for runner/attempt/event diagnosis:
     - `curl -sS -H 'Authorization: Bearer <ROOT_PASSWORD>' https://rhapsody-toyamarinyon.vercel.app/api/v1/runs/<runId>`
   - Use rendered prompt only to debug prompt/instruction problems:
     - `curl -sS -H 'Authorization: Bearer <ROOT_PASSWORD>' https://rhapsody-toyamarinyon.vercel.app/api/v1/runs/<runId>/attempts/<attemptId>/prompt`
   - Read-only scheduler workflow status is safe only when you already have its workflow run id:
     - `curl -sS -H 'Authorization: Bearer <ROOT_PASSWORD>' 'https://rhapsody-toyamarinyon.vercel.app/api/v1/admin/scheduler/tick?runId=<workflowRunId>'`

4. Check Vercel state when Rhapsody state is insufficient.
   - Read `.vercel/project.json` for project/team ids.
   - Use the Vercel app tools or CLI to list deployments and build/runtime logs.
   - Confirm production alias and latest production commit before assuming which code is running.

5. Report the diagnosis.
   - Lead with the concrete failure.
   - Include the run id / attempt id when available.
   - Quote the smallest useful stderr/message snippet.
   - Say what did complete, what did not, and the next operational step.

## Work-Item Graph Reading Guide

Use the graph before raw events when the problem might involve intake, post-PR checks, or repair.

Important node kinds:

- `workerRuns`: durable worker executions. Useful `kind` values include `intake_curator`, `builder`, `post_pr_curator`, and `repairer`.
- `decisions`: structured explanations. Inspect `phase`, `outcome`, `summary`, `nextWorkerKind`, `evidence`, and timestamps.
- `artifacts`: external or durable objects such as `pull_request`, `branch`, `check_run`, `intake_comment`, and repair outputs.
- `links`: causal edges. Use them to explain "intake decision started builder", "failed check led to repair", or "repair produced commit".

Common graph outcomes:

- Intake phase:
  - `buildable`: scheduler may start builder if concurrency allows.
  - `blocked`: dependency/blocker prevented builder start.
  - `ask_human`: Rhapsody asked for clarification and should wait for a newer human reply.
  - `skip`: issue is not actionable for the builder.
- Post-PR phase:
  - `checks_pending`: PR exists, but checks have not reached a terminal state.
  - `checks_success`: PR checks passed; remaining behavior depends on post-run policy.
  - `ci_failed`: PR checks failed; scheduler may run the repair planner next.
  - `checks_unknown`: Rhapsody could not classify PR checks confidently.
- Repair phase:
  - `repair_allowed`: planner allowed a narrow repair for a specific execution key.
  - `repair_applied`: repairer pushed a follow-up commit.
  - `repair_noop`: no allowed changed files or no needed change.
  - `repair_failed`: repair attempt ran but failed.
  - `repair_blocked`: failure class was unsafe or retry budget was exhausted.

## Event Reading Guide

Useful event types:

- `manual_run.created`: Rhapsody created a run/attempt and claim.
- `scheduler.project_status_updated`: scheduler moved the Project item, usually to `In Progress`.
- `scheduler.project_status_update_failed`: scheduler could not move the Project item.
- `scheduler.builder_worker_graph_failed`: scheduler continued legacy runner dispatch but could not persist builder graph records.
- `scheduler.post_pr_curator_failed`: post-PR curation failed while handling an `In Progress` item.
- `attempt.started`: runner attempt started.
- `attempt.progress`: sandbox sent heartbeat/progress; inspect `data.callback_type`, `data.last_codex_event_type`, and sandbox/command ids.
- `sandbox_codex_runner.source_preparation`: sandbox cloned and checked out the assigned branch.
- `sandbox_codex_runner.network_probe`: sandbox network probe result before Codex execution.
- `sandbox_codex_runner.prompt_rendered`: Codex prompt was rendered; includes target branch and repo.
- `sandbox_codex_runner.wrapper_started`: Codex wrapper command started in sandbox.
- `attempt.callback_received`: sandbox callback returned execution/postflight data.
- `attempt.workflow_resume_failed`: callback was recorded but Workflow resume failed.
- `attempt.terminal_callback`: Rhapsody recorded final attempt status.
- `sandbox_codex_runner.pull_request_ready`: PR was created or reused.
- `sandbox_codex_runner.pull_request_failed`: PR creation/reuse failed.
- `sandbox_codex_runner.post_run_decision`: post-run policy evaluated; often contains `postflightSummary`.
- `sandbox_codex_runner.post_run_action_skipped`: side effects skipped because no trusted handoff existed.
- `reconciler.attempt_timed_out`: reconciler marked a running attempt timed out/stale.
- `claim.released`: claim was released after terminal handling or reconciliation.
- `codex_local.execution_started` / `codex_local.execution_finished`: local Codex runner lifecycle.
- `fake_runner.prompt_rendered` / `sandbox_fake_runner.prompt_rendered`: non-Codex runner diagnostics.

Key fields to inspect:

- `data.branchName`
- `data.prSpec`
- `data.callback_type`
- `data.last_codex_event_type`
- `data.postflight.commands.commit_count`
- `data.postflight.commands.push.stderr`
- `data.postflight.commands.verify`
- `data.postflight.changed_files`
- `data.postflightSummary`
- `data.pullRequest`
- `data.error`
- graph `decisions[].evidence.failureFingerprint`
- graph `decisions[].evidence.repairExecutionKey`
- graph `decisions[].evidence.attemptCounts`

## Common Diagnoses

- Intake blocked the builder:
  - Symptom: Issue remains `Todo`, no builder run exists, graph has an intake decision.
  - Check graph `decisions` for phase `intake` and outcome `blocked`, `ask_human`, or `skip`.
  - User-facing answer: "Rhapsody did not start Codex because intake decided this issue needs <blocker/clarification/not-actionable>."
  - Next step: resolve the blocker or reply to the intake question, then let the next scheduler tick reclassify.

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
  - Check `sandbox_codex_runner.pull_request_failed`, graph artifacts for missing `pull_request`, and GitHub API errors.

- No trusted handoff:
  - Symptom: `post_run_action_skipped` says no trusted pull request handoff was available.
  - Check whether execution failed, branch push failed, or `prSpec` is missing/invalid.

- PR exists but Rhapsody is waiting:
  - Symptom: Project item is `In Progress`, PR exists, but no merge/status move happens.
  - Check graph `post_pr` decision. `checks_pending` means wait for CI; `ci_failed` means inspect repair planner/repairer decisions; `checks_unknown` means check GitHub status data and curator errors.

- Repair did not happen or did not finish:
  - Symptom: PR has failed checks and graph has repair decisions.
  - Check `repairExecutionKey`, `failureFingerprint`, `attemptCounts`, active `repairer` worker runs, and terminal repair outcomes.
  - If outcome is `repair_blocked`, report whether the reason was unsafe failure class or exhausted budget.
  - If outcome is `repair_failed`, quote the smallest redacted executor error.

- Claim/run stale or timed out:
  - Symptom: run/attempt status is `timed_out` or `stale`, active claim may be zero after reconciliation.
  - Check latest events for missing callback, sandbox command timeout, or reconcile events.

- Callback recorded but workflow did not resume:
  - Symptom: `attempt.callback_received` exists but workflow status or run status did not advance; event may include `attempt.workflow_resume_failed`.
  - Check callback payload, workflow run id/status, and runtime logs around the callback time.

- Production code/env mismatch:
  - Symptom: GitHub state suggests work happened, but state schema/API/logs disagree with local assumptions.
  - Confirm latest production deployment commit, alias, and env presence. Do not assume local `.env.local` matches production.

## Response Shape

Prefer a compact response:

```text
原因は <one-line cause> です。

確認できた流れ:
- Issue #N は Project で <status>
- graph では <worker/decision/artifact summary>
- run <runId> / attempt <attemptId> が <status>
- runner は <completed step> まで進んだ
- <failed step> でこの stderr が出ています: ...

なので PR がない理由は <branch/push/handoff explanation> です。
次は <one operational next step> です。
```

Avoid over-explaining unless the user asks. If confidence is low, say what is known, what is missing, and the next read-only check.
