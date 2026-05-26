# ADR 0012: Define Post-Run Verification Policy

## Status

Accepted

## Context

Rhapsody lets sandboxed agents perform workflow-specific GitHub writes through the run-scoped
mediator described in ADR 0005 and ADR 0008. This keeps raw GitHub credentials out of the sandbox
while preserving a natural agent workflow.

The MVP mediator cannot fully inspect git smart HTTP push bodies. In particular, it cannot prove
which branches were updated by reading packfile contents before GitHub accepts the push. Rhapsody
therefore needs follow-up verification after the sandbox wrapper completes. Under ADR 0014, the
builder first records a trusted handoff artifact, and curator-owned post-PR curation later verifies
that the visible GitHub handoff still matches the active work-item context.

ADR 0011 separates wrapper execution status from final run evaluation. Successful wrapper execution
and `codex exec` completion are necessary signals, but they are not enough to prove that the work was
handed to the correct repository, branch, base, issue, project item, or pull request.

ADR 0013 defines the next phase after this verification: curator-owned post-PR curation and review
policy. Verification success is an input to that curation. It is not by itself a decision to merge,
move an item to `Human Review`, or mark the work done.

## Decision

Use tiered post-run verification split between builder-local completion integrity and curator-owned
handoff identity verification.

Builder completion remains responsible for active run and attempt integrity, callback validation,
and secret hygiene before any retained sandbox export or snapshot. Curator-owned handoff identity
verification runs after the builder records a trusted handoff artifact and before repair, human
review, merge, or Project status decisions rely on that handoff.

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

A trusted handoff artifact is a GitHub handoff artifact that trusted Rhapsody code created or
reused and durably recorded. It is builder output, not curator verification.

## Verification Outcomes

Curator-side handoff verification should normalize its first outcomes to a small, explicit set:

- `handoff_verified`
- `handoff_missing`
- `handoff_invalid`
- `handoff_ambiguous`

These names fit the current policy shape and should be reused unless a later ADR or schema review
shows a clearer boundary.

## Builder-Local Completion Integrity Checks

These checks are required before the builder can record a successful handoff-production outcome:

- The run still exists and is not already terminal.
- The attempt belongs to the run and is the current attempt being finalized.
- The claim still exists for the work item and its fencing token matches the runner context.
- The callback payload matches the stored run, attempt, sandbox, and command metadata.
- If Rhapsody will export sandbox filesystem state or create a sandbox snapshot, secret hygiene
  checks pass first.

Failure of a builder-local completion integrity check prevents builder success. The builder may
retry, fail, or leave the work item for later reconciliation according to retry policy and the
failure class.

## Curator-Side Handoff Identity Checks

These checks are required before curator-owned post-PR curation can emit `handoff_verified` or use
the handoff as accepted input for later repair, review, merge, or Project status policy:

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

Failure of a curator-side handoff identity check prevents `handoff_verified`. The curator should
persist `handoff_missing`, `handoff_invalid`, or `handoff_ambiguous` and then choose retry,
escalation, or other follow-up according to policy.

## Recommended Checks

These checks should be implemented as warnings before they become required:

- Pull request body quality and completeness.
- Presence of a conventional run marker in pull request or issue comments.
- Expected labels, reviewers, or assignees.
- Exact status transition wording.
- Branch naming beyond the configured prefix.

Warning checks should emit structured events and dashboard-visible messages, but they do not block
handoff verification or later post-PR decisions in the MVP.

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

Wrapper execution status, builder handoff production, curator handoff verification, and later
post-PR curation resolution are separate concepts.

The wrapper reports observed execution facts such as exit code, start time, completion time, and
error summary. The builder workflow decides whether it produced and recorded a trusted handoff
artifact. Curator-owned handoff identity verification later evaluates whether the visible GitHub
state is consistent with that recorded handoff. Scheduler-owned post-PR curation then decides
whether the pull request should be repaired, escalated to human review, auto-merged, or moved to
done.

MVP outcome rules:

- A successful builder outcome means a trusted handoff artifact was produced and recorded and the
  builder-local completion integrity checks passed.
- `handoff_verified` means the curator-side handoff identity checks passed.
- A legitimate no-change result can complete the builder outcome when a trusted issue comment
  handoff artifact is recorded and builder-local completion integrity checks pass.
- A blocker or clarification request can complete the agent attempt but should leave the work item
  in a workflow-defined human-review or active status rather than pretending code work was done.
- `handoff_missing`, `handoff_invalid`, and `handoff_ambiguous` are curator verification
  outcomes, not builder-success outcomes.
- A wrong owner, repository, base branch, or branch prefix is a handoff identity failure.
- Secret hygiene failure before sandbox export or snapshot is a builder-local policy failure.
- Transient GitHub, state-store, or sandbox inspection failures are retryable verification failures
  when retry budget remains.

## Claim Release Boundary

The builder must not release its claim until callback handling, trusted handoff artifact recording,
and builder-local cleanup decisions have been persisted.

The normal successful builder sequence is:

1. Receive and persist the terminal sandbox callback.
2. Evaluate wrapper execution status and builder-local completion integrity.
3. Create or reuse trusted GitHub handoff artifacts.
4. Persist the builder handoff artifacts and builder outcome.
5. Run secret hygiene checks for any configured sandbox export or snapshot, then clean up, export,
   or snapshot according to policy.
6. Release the builder claim.
7. Let a later scheduler tick start curator-owned handoff identity verification and post-PR
   curation according to ADR 0013 and ADR 0014.

The later curator sequence is:

1. Observe the recorded handoff artifact and current GitHub state.
2. Run the handoff identity checks in this ADR.
3. Persist `handoff_verified`, `handoff_missing`, `handoff_invalid`, or `handoff_ambiguous`.
4. Apply later repair, review, merge, and Project status policy only after that verification step.

If curator verification fails, the curator must persist the failure reason before applying later
post-PR actions. Reconciliation must be able to distinguish a builder that finished handoff
production from a handoff that has not yet been curator-verified and from one that verified and
failed.

Follow-up note: the implementation should record these verification outcomes on durable curator
decisions or equivalent graph records, but this ADR does not prescribe the storage shape yet.

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

- A successful builder run means Rhapsody recorded a trusted handoff artifact; accepted-work
  outcomes still require curator verification.
- Git smart HTTP branch uncertainty is contained by post-run verification.
- Wrapper execution success remains separate from workflow success.
- No-change and blocker outcomes can be represented without requiring a pull request.
- Builder claims are not released before builder-local completion state is known.
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
- The workflow needs stricter CI/check gating before work is considered accepted.
