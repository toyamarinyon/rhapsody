# ADR 0012: Define Post-Run Verification Policy

## Status

Accepted

## Context

Rhapsody lets sandboxed agents perform workflow-specific GitHub writes through the run-scoped
mediator described in ADR 0005 and ADR 0008. This keeps raw GitHub credentials out of the sandbox
while preserving a natural agent workflow.

The MVP mediator cannot fully inspect git smart HTTP push bodies. In particular, it cannot prove
which branches were updated by reading packfile contents before GitHub accepts the push. The runner
therefore needs a post-run verification step after the sandbox wrapper completes and before the run
is marked successful.

ADR 0011 separates wrapper execution status from final run evaluation. A successful `codex exec`
or `after_run` command is necessary signal, but it is not enough to prove that the work was handed
to the correct repository, branch, base, issue, project item, or pull request.

## Decision

Use tiered post-run verification before finalizing a successful run.

Post-run verification checks the active run and attempt, the externally visible GitHub handoff
state, mediator decision events, and any configured sandbox export or snapshot hygiene. Verification
must finish before Rhapsody releases the claim.

Rhapsody does not define first-class saved work products in the MVP. This ADR avoids that broader
term and refers directly to GitHub handoff state, sandbox exports, and sandbox snapshots when those
concrete mechanisms are involved.

## GitHub Handoff

A GitHub handoff is the externally visible GitHub state by which Rhapsody and a human operator can
understand what the agent produced for the work item.

For the MVP, a GitHub handoff may include:

- a pull request created or updated for the work item;
- an issue comment explaining a legitimate no-change result;
- an issue comment explaining a blocker or clarification request;
- the configured GitHub ProjectV2 status for the item.

A GitHub handoff is not a separate database entity in the MVP. Rhapsody records verification events
and selected GitHub links or metadata on run and attempt records as needed for observability.

## Required Checks

These checks are required before a run can be marked completed:

- The run still exists and is not already terminal.
- The attempt belongs to the run and is the current attempt being finalized.
- The claim still exists for the work item and its fencing token matches the runner context.
- The callback payload matches the stored run, attempt, sandbox, and command metadata.
- If a pull request exists, it belongs to the configured owner and repository.
- If a pull request exists, its base branch matches the configured base branch.
- If a pull request exists, its head branch uses the configured branch prefix.
- If a pull request exists, it is linked to or clearly references the work item.
- If the run reports a no-change, blocker, or clarification outcome without a pull request, the
  corresponding issue comment exists on the work item.
- The GitHub ProjectV2 item status is consistent with the evaluated outcome when Rhapsody or the
  agent changed that status.
- Fatal mediator denial events for the attempt are absent, unless the denial reason is explicitly
  classified as non-fatal by policy.
- If Rhapsody will export sandbox filesystem state or create a sandbox snapshot, secret hygiene
  checks pass first.

Failure of a required check prevents a completed outcome. The runner may retry, mark the attempt as
failed, or move the run to a human-review outcome according to retry policy and the failure class.

## Recommended Checks

These checks should be implemented as warnings before they become required:

- Pull request body quality and completeness.
- Presence of a conventional run marker in pull request or issue comments.
- Expected labels, reviewers, or assignees.
- Exact status transition wording.
- Successful repository checks or CI status.
- Branch naming beyond the configured prefix.

Warning checks should emit structured events and dashboard-visible messages, but they do not block
a completed outcome in the MVP.

## Pull Request Identification

Rhapsody should identify candidate pull requests from GitHub state instead of trusting only sandbox
callback text.

Preferred signals, in order:

1. Pull request URLs or numbers recorded through mediator events for the run and attempt.
2. Open pull requests in the configured repository whose head branch uses the configured prefix and
   whose base branch matches the configured base branch.
3. Pull requests that mention the work item issue number or include the configured run marker when
   such markers exist.

If multiple candidate pull requests match, verification must not guess. It should mark the handoff
ambiguous and require retry or human review.

## Outcome Evaluation

Wrapper execution status, verification status, and final run outcome are separate concepts.

The wrapper reports observed execution facts such as exit code, start time, completion time, and
error summary. Verification evaluates whether the visible GitHub and sandbox state is consistent
with the active run. The runner workflow then decides the final attempt and run outcome.

MVP outcome rules:

- A successful pull request handoff can complete the run when all required checks pass.
- A legitimate no-change result can complete the run when it is documented in an issue comment and
  required checks pass.
- A blocker or clarification request can complete the agent attempt but should leave the work item
  in a workflow-defined human-review or active status rather than pretending code work was done.
- A missing, ambiguous, or inconsistent handoff is a verification failure.
- A wrong owner, repository, base branch, or branch prefix is a policy failure.
- Secret hygiene failure before sandbox export or snapshot is a policy failure.
- Transient GitHub, state-store, or sandbox inspection failures are retryable verification failures
  when retry budget remains.

## Claim Release Boundary

The runner must not release the claim until terminal verification and cleanup decisions have been
persisted.

The normal successful sequence is:

1. Receive and persist the terminal sandbox callback.
2. Evaluate wrapper execution status.
3. Verify GitHub handoff state.
4. Run secret hygiene checks for any configured sandbox export or snapshot.
5. Persist final attempt and run outcome.
6. Update GitHub Project status according to workflow policy.
7. Clean up, export, or snapshot the sandbox according to policy.
8. Release the claim.

If verification fails, the runner must persist the failure reason before releasing or extending the
claim. Reconciliation must be able to distinguish a runner that has not verified yet from a runner
that verified and failed.

## Secret Hygiene

Real ChatGPT credentials, GitHub tokens, API keys, mediator secrets, and source credentials must not
be preserved in exported sandbox filesystem state, sandbox snapshots, logs, events, callback
payloads, or dashboard projections.

Secret hygiene checks are required before any configured sandbox export or snapshot. They should
scan likely credential locations, generated configuration files, shell history, git remotes,
environment dumps, logs, and known Codex or GitHub credential paths.

The MVP may skip filesystem scanning when no sandbox export or snapshot will be retained, but logs,
events, callback payloads, and dashboard projections still require redaction.

## Consequences

Positive consequences:

- A successful run means the externally visible GitHub state matches the active Rhapsody run.
- Git smart HTTP branch uncertainty is contained by post-run verification.
- Wrapper execution success remains separate from workflow success.
- No-change and blocker outcomes can be represented without requiring a pull request.
- Claims are not released before the final run outcome is known.
- Sandbox export and snapshot retention are gated by explicit secret hygiene checks.

Negative consequences:

- Early implementations may produce false negatives while the GitHub handoff conventions mature.
- Verification adds GitHub reads and state-store work after the sandbox command completes.
- Ambiguous pull request discovery requires human review or retry rather than best-effort guessing.
- Secret hygiene checks can add latency before sandbox export or snapshot retention.

## Revisit When

- Rhapsody defines first-class saved work product storage.
- GitHub App installation tokens replace the MVP PAT and mediator model.
- Git smart HTTP mediation can enforce branch-level rules before GitHub accepts a push.
- Pull request creation moves from agent-owned behavior to a trusted-host operation.
- The workflow needs stricter CI/check gating before handoff is considered complete.
