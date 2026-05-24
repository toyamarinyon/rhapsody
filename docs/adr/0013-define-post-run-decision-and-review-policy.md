# ADR 0013: Define Post-Run Decision and Review Policy

## Status

Accepted

## Context

ADR 0012 defines post-run verification: before Rhapsody marks a run successful, it checks that the
visible GitHub handoff state matches the active run, attempt, repository, branch, issue, and project
boundaries.

That verification is necessary, but it does not answer what Rhapsody should do next. A pull request
can be valid and still need code review. A small documentation-only pull request can be safe enough
to merge automatically. A failed or ambiguous handoff can need a retry, a clarifying comment, or
human intervention.

`Human Review` should not mean "a pull request was created." It should mean Rhapsody has decided
that a human needs to look at the work. Unnecessary items should not be moved into the human review
queue just because automation reached a handoff point.

## Decision

Add a post-run decision phase after GitHub handoff verification and before GitHub Project status
handoff.

The original MVP sketch placed post-run decision inside the same `runnerWorkflow` that executed the
builder. That coupling made the builder responsible for concerns that belong to later observation,
such as pending checks, repair loops, and final review status handoff.

Current Rhapsody behavior should follow the worker-graph split in ADR 0014 instead:

- builder/runner ends after trusted branch and pull request handoff plus artifact recording;
- scheduler-owned post-PR curation observes the `In Progress` item and pull request state;
- trusted Rhapsody code applies merge or Project status side effects only from that post-PR path.

The decision phase evaluates the verified run outcome and chooses the next action:

- merge the pull request and move the item to `Done`;
- request changes or leave an explanatory comment and keep the item active;
- move the item to `Human Review`;
- mark the run failed, retryable, or blocked according to policy.

`Human Review` is a decision outcome, not the default post-PR status.

## Configuration

Rhapsody reads this policy from `.rhapsody/config.toml`:

```toml
[post_run]
auto_merge_success_status = "Done"
human_review_status = "Human Review"

[[post_run.auto_merge_eligible]]
paths = ["docs/**", "!docs/adr/**"]
description = "Documentation-only changes, excluding ADR updates."
```

Status mapping semantics:

- `auto_merge_success_status` controls the Project status name used when a decision resolves to `auto_merge_candidate`.
- `human_review_status` controls the Project status name used when a decision resolves to `human_review`.

Decision semantics:

- `auto_merge_eligible` is an array-of-tables and rule evaluation is OR between each table.
- Within each rule, `paths` is the only primary matcher. `paths` supports `!`-prefixed negation entries
  for the same rule.
- A changed file matches a rule when it matches at least one positive pattern in `paths` and no negative
  `!` entry in the same list.
- The rule itself matches when every changed file matches the rule.
- `!` entries in `paths` take precedence over positive matches for that file.
- If no rule matches, default remains human review.
- Unknown/missing changed file signals are conservative (not eligible).

## Workflow Shape

The successful runner flow becomes:

1. Run Codex in the sandbox wrapper.
2. Resume the runner workflow from the wrapper callback.
3. Create or reuse trusted GitHub handoff artifacts, such as a pull request.
4. Verify the handoff according to ADR 0012.
5. Record builder outcome and handoff artifacts, then release the builder path.
6. Let a later scheduler tick observe the `In Progress` item and pull request.
7. Run post-PR checks and other curation logic from the scheduler-owned worker path.
8. Optionally run reviewer Codex for review evidence.
9. Apply deterministic policy to choose the next action.
10. Apply the action through trusted Rhapsody code.

The full story may span multiple workflows and scheduler ticks, but the worker graph should keep the
handoff, observation, repair, review, and final status changes traceable as one auditable sequence.

## Review Codex Boundary

Reviewer Codex may be used to inspect:

- the pull request diff;
- the originating issue and done criteria;
- run and attempt events;
- available CI, lint, or test output;
- repository instructions.

Reviewer Codex must return structured review evidence and a recommendation. It must not directly
merge, close, relabel, or move GitHub Project items.

Trusted Rhapsody code applies side effects after checking the recommendation against policy. This
keeps external writes auditable, idempotent, and constrained by run context.

## MVP Policy

The first implementation should be conservative.

Required deterministic inputs:

- run and attempt terminal status;
- verified pull request metadata;
- changed file list;
- base branch and head branch;
- linked issue or issue reference;
- available check or test status when implemented.

Initial decisions:

- A completed run with a valid pull request may move to `Human Review` only after post-run decision
  concludes that human review is needed.
- A documentation-only pull request may be classified as eligible for auto-merge. In the current
  MVP, trusted Rhapsody code merges that pull request and moves the Project item to `Done`.
- Code changes, low confidence, missing checks, ambiguous handoff, or reviewer uncertainty should
  move to `Human Review`.
- Clear reviewer-requested changes should produce a pull request comment and keep the item active.
- Verification failure remains a failed or retryable runner outcome, not a successful review
  handoff.

Auto-merge should start disabled or limited to a narrow allowlist until Rhapsody has enough
observability and confidence in reviewer output.

## Project Status Semantics

Project status updates are workflow-owned lifecycle transitions:

- `Todo`: candidate work not currently claimed by Rhapsody.
- `In Progress`: claimed, running, or awaiting automated follow-up.
- `Human Review`: Rhapsody has determined that a human needs to inspect the result.
- `Done`: Rhapsody or a human has accepted the result and no further scheduler action is needed.

Creating a pull request is not sufficient to move an item to `Human Review`.
Likewise, an auto-merge candidate is not complete until trusted Rhapsody code merges the pull
request and updates the Project item to `Done`.

## Consequences

Positive consequences:

- The human review queue contains work that actually needs human attention.
- Verification, review evidence, policy, and side effects stay separate.
- Future auto-merge can be added without changing the scheduler/runner handoff model.
- Operators can audit why Rhapsody merged, requested changes, retried, or escalated.

Negative consequences:

- Post-run policy spans multiple workflows and scheduler ticks instead of a single runner history.
- Post-run policy needs explicit configuration before broad auto-merge is safe.
- Reviewer Codex output introduces another model-dependent signal that must be recorded and
  bounded by deterministic policy.

## Revisit When

- Rhapsody has stable CI/check integration.
- Reviewer Codex can produce consistently useful structured review evidence.
- GitHub App permissions replace the MVP PAT model.
- Teams need repository-specific auto-merge policies, reviewer assignment, or approval rules.
