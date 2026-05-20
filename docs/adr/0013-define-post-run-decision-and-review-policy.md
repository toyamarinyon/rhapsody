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

For the MVP, post-run decision runs as the next step in the same `runnerWorkflow` after sandbox
execution, callback resume, trusted pull request creation or reuse, and ADR 0012 verification. It is
not a separate workflow triggered by pull request creation.

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

[[post_run.auto_merge_eligible]]
paths = ["docs/**", "!docs/adr/**"]
description = "Documentation-only changes, excluding ADR updates."
```

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
5. Run post-run checks.
6. Optionally run reviewer Codex for review evidence.
7. Apply deterministic policy to choose the next action.
8. Apply the action through trusted Rhapsody code.
9. Persist the final run outcome and release the claim.

The runner workflow may implement these as separate helper modules, but the durable workflow history
should keep them in one flow so the operator can read the run as a single story.

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
- A documentation-only pull request may be classified as eligible for auto-merge once reviewer
  Codex and repository checks are available.
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

## Consequences

Positive consequences:

- The human review queue contains work that actually needs human attention.
- Verification, review evidence, policy, and side effects stay separate.
- Future auto-merge can be added without changing the scheduler/runner handoff model.
- Operators can audit why Rhapsody merged, requested changes, retried, or escalated.

Negative consequences:

- Runner workflows become longer because review and decision happen after handoff.
- Post-run policy needs explicit configuration before broad auto-merge is safe.
- Reviewer Codex output introduces another model-dependent signal that must be recorded and
  bounded by deterministic policy.

## Revisit When

- Rhapsody has stable CI/check integration.
- Reviewer Codex can produce consistently useful structured review evidence.
- GitHub App permissions replace the MVP PAT model.
- Teams need repository-specific auto-merge policies, reviewer assignment, or approval rules.
