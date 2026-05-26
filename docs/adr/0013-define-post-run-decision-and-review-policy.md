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

For the MVP worker-graph model, the builder workflow stops after sandbox execution, callback
resume, trusted pull request creation or reuse, ADR 0012 verification, and durable handoff
recording. Post-run decision is then owned by scheduler-driven post-PR curation on later ticks
while the Project item remains `In Progress`. It is not applied inline in the same builder
workflow.

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

[post_run.human_review_monitoring]
enabled = true
auto_integrate_base_before_human_activity = true
auto_integrate_base_after_human_activity = false
comment_on_conflict = true

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
- `human_review_monitoring.enabled` defaults to `true`. While enabled, open pull requests linked to
  `Human Review` work items remain eligible for lightweight curator observation.
- `auto_integrate_base_before_human_activity` defaults to `true`. The curator may request a
  non-rewriting base integration when the branch is behind and no human review activity has begun.
- `auto_integrate_base_after_human_activity` defaults to `false`. Once a human has reviewed,
  requested changes, commented substantively, or pushed to the branch, Rhapsody should avoid
  automatic branch updates unless policy explicitly allows them.
- `comment_on_conflict` defaults to `true`. When the human review decision becomes stale because of
  base movement or conflict that Rhapsody cannot safely repair, trusted Rhapsody code should leave a
  concise pull request comment.

## Workflow Shape

The successful builder-plus-curator flow becomes:

1. Run Codex in the sandbox wrapper.
2. Resume the builder workflow from the wrapper callback.
3. Create or reuse trusted GitHub handoff artifacts, such as a pull request.
4. Verify the handoff according to ADR 0012.
5. Persist the final builder outcome and release the claim while the Project item stays
   `In Progress`.
6. Let a later scheduler tick run post-PR curation against checks and policy.
7. Optionally run repairer or reviewer workers for follow-up.
8. Apply deterministic policy to choose the next action.
9. Apply the action through trusted Rhapsody code.

The durable workflow history should still let an operator read the work item as one story, but the
story is now composed from worker-graph records rather than one long builder workflow.

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
`Human Review` is also not a scheduler terminal state while the linked pull request remains open.
Later curator observations may mark the prior human review decision stale, for example when the base
branch moves, required checks are invalidated, or GitHub reports a conflict. In those cases Rhapsody
should keep the Project item in `Human Review` and surface the blocked or stale state through graph
decisions, dashboard projections, and pull request comments rather than moving the item back to
`In Progress`.

## Consequences

Positive consequences:

- The human review queue contains work that actually needs human attention.
- Verification, review evidence, policy, and side effects stay separate.
- Future auto-merge can be added without changing the builder handoff model.
- Operators can audit why Rhapsody merged, requested changes, retried, or escalated.

Negative consequences:

- The scheduler and worker graph must carry more of the post-PR state between ticks.
- Post-run policy needs explicit configuration before broad auto-merge is safe.
- Reviewer Codex output introduces another model-dependent signal that must be recorded and
  bounded by deterministic policy.

## Revisit When

- Rhapsody has stable CI/check integration.
- Reviewer Codex can produce consistently useful structured review evidence.
- GitHub App permissions replace the MVP PAT model.
- Teams need repository-specific auto-merge policies, reviewer assignment, or approval rules.
