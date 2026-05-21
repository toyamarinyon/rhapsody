# ADR 0014: Use a Worker Graph for Build and Curation

## Status

Accepted

## Context

The current MVP model describes one runner workflow that claims a work item, runs Codex, creates or
reuses a pull request, verifies the handoff, evaluates post-run policy, and applies follow-up GitHub
actions. ADR 0012 and ADR 0013 intentionally separated verification, review evidence, and final
decision-making inside that runner flow.

That shape is useful for an initial vertical implementation, but it makes the runner responsible for
too many phases of work. Creating a pull request is not the same responsibility as deciding whether
the pull request is healthy, whether CI failures are automatically repairable, whether an agent
review should run, whether a human should be asked a clarifying question, or whether the work can be
merged.

Rhapsody should model the development process as a set of durable worker decisions over human-facing
artifacts:

- an issue may first need intake and clarification before any code is written;
- a builder may produce a branch and pull request;
- a curator may inspect checks, reviews, comments, and project state after the pull request exists;
- a repairer may make a narrow follow-up commit when a deterministic failure is safe to fix;
- a reviewer may produce structured review evidence without applying external side effects.

Operators also need to understand why Rhapsody did something. A flat event log can show what
happened, but it is weak at answering why a builder started, which pull request came from which
worker run, which failed check caused a repair, or why Rhapsody escalated to a human.

## Decision

Represent Rhapsody execution as a worker graph centered on work items, decisions, worker runs,
artifacts, and links.

The scheduler remains the single dispatcher for the GitHub Project. On each tick, it observes the
board and graph state, then starts the next appropriate worker when a concurrency slot is available:

- for candidate `Todo` items, start intake curation before building;
- for buildable items, start a builder worker;
- for `In Progress` items with pull requests, start post-PR curation;
- for failed checks classified as safely repairable, start a repairer worker;
- for reviewable pull requests, optionally start a reviewer worker;
- when a decision requires human input or exceeds retry policy, comment and escalate instead of
  starting more automated work.

The builder worker owns only the build handoff:

- understand the accepted work item context;
- make the required repository changes;
- push the configured branch;
- create or reuse a pull request;
- record the produced artifacts and finish.

The curator worker owns decision-making around readiness and next action:

- intake curation before the builder runs;
- post-PR curation after a pull request exists;
- check and CI observation;
- deterministic failure classification;
- repair budget enforcement;
- agent review orchestration;
- human clarification or human review escalation;
- project status transitions and merge decisions through trusted Rhapsody code.

This ADR supersedes the parts of ADR 0012 and ADR 0013 that place post-run verification, post-run
decision, review, and project status handoff inside the same runner workflow. The verification and
decision policies remain valid, but they move into curator-owned worker runs and graph decisions.

## Core Model

The preferred durable model is:

- `work_items`: normalized projections of GitHub Project items and their current Rhapsody phase.
- `worker_runs`: durable executions of scheduler-started workers.
- `decisions`: structured explanations of what a worker observed, decided, and intends next.
- `artifacts`: observed or produced external objects such as issues, branches, pull requests,
  check runs, commits, comments, sandboxes, and snapshots.
- `links`: graph edges connecting work items, worker runs, decisions, and artifacts.

`worker_runs.kind` should include at least:

- `intake_curator`
- `builder`
- `post_pr_curator`
- `repairer`
- `reviewer`

Worker kinds are an extensibility point, not a closed taxonomy. The state model and scheduler should
allow additional worker kinds without schema rewrites. New workers may be introduced for repository
setup, dependency analysis, security scanning, release preparation, deployment verification,
documentation follow-up, issue deduplication, backlog grooming, or other bounded automation tasks.

Worker dispatch should therefore avoid hard-coding all behavior behind one enum switch. A worker
kind should be accompanied by metadata that describes:

- which graph inputs can trigger it;
- which phases it participates in;
- which artifact kinds it may observe or produce;
- which decision outcomes it may emit;
- which side effects it is trusted to request or apply;
- what concurrency, retry, and budget limits apply.

The scheduler may still maintain a known registry of worker kinds for safety and implementation
clarity, but that registry should be data-shaped and policy-driven enough that adding a worker is a
local extension rather than a redesign of the graph.

`decisions` should store enough structured information for an operator and a later worker to
understand the decision without replaying raw logs:

- phase, such as `intake`, `build`, `post_pr`, `repair`, or `review`;
- outcome, such as `buildable`, `ask_human`, `pr_created`, `checks_pending`, `ci_failed`,
  `repair_allowed`, `repair_blocked`, `human_review`, `auto_merge_allowed`, or `done`;
- whether the decision was deterministic;
- policy version or rule ID when a deterministic classifier was used;
- evidence, including relevant artifact IDs, check names, logs, fingerprints, and summaries;
- next action, including the worker kind to start or the human-facing comment to write.

`artifacts` should model both outputs and observations. A failed check run is as important as a pull
request because it can drive a repair decision.

`links` should make causal relationships explicit, for example:

- a scheduler decision started a worker run;
- a builder worker produced a pull request;
- a curator observed a check run;
- a failed check led to a repair decision;
- a repairer produced a commit;
- a decision escalated to a comment or human review status.

## Workflow Shape

The intended happy path is:

1. Scheduler observes a `Todo` work item.
2. Scheduler starts an intake curator when no fresh intake decision exists.
3. Intake curator records either `buildable` or `ask_human`.
4. Scheduler starts a builder for a `buildable` decision.
5. Builder produces a branch and pull request, records artifacts, and exits.
6. Scheduler observes the `In Progress` item and pull request.
7. Scheduler starts a post-PR curator when checks or review state need evaluation.
8. Post-PR curator records `checks_pending`, `repair_allowed`, `human_review`,
   `auto_merge_allowed`, `done`, or another policy outcome.
9. Scheduler starts any follow-up worker required by the curator decision.

Long waits should usually be represented by durable graph state and a future scheduler tick rather
than by keeping one workflow asleep for every pending check or human response. Workflow `sleep` and
hooks remain useful for bounded worker-local waits, but the Project board, pull requests, checks,
comments, and graph are the primary durable coordination surface.

## Intake Curation

Before code is written, Rhapsody should determine whether an issue is buildable.

An intake curator may inspect:

- issue title and body;
- comments and prior Rhapsody decisions;
- labels, assignees, and project fields;
- nearby repository context when needed;
- configured workflow instructions.

If the task cannot be implemented without an unsafe or arbitrary assumption, the curator should
mention the requester or relevant assignee with a concise clarifying question and record an
`ask_human` decision. The builder should not start for that work item until a later scheduler tick
observes a new human response or changed issue state and a fresh intake decision marks it buildable.

## Post-PR Curation

After a pull request exists, Rhapsody should treat checks, reviews, and comments as external
artifacts that may require follow-up.

The post-PR curator should:

- identify the pull request associated with the work item and builder worker;
- observe check suites, check runs, statuses, preview deployments, reviews, and comments;
- classify failures with deterministic rules before using model judgment;
- start repair only when the failure class is safe and the repair budget allows it;
- avoid infinite loops by recording failure fingerprints, head SHAs, and repair attempt counts;
- escalate with a clear comment when the failure is not safely repairable or the budget is
  exhausted.

Initial deterministic repair classes should be conservative. Formatting failures such as Biome or
Prettier check failures are good first candidates. Type errors, failing tests, dependency changes,
and ambiguous behavior changes may require human review or a reviewer worker before repair.

## Scheduler Semantics

The scheduler should be a dispatcher, not the owner of all business logic.

It may evaluate lightweight eligibility rules, such as:

- whether a work item already has an active worker claim;
- whether a fresh decision already exists for the current artifact state;
- whether the relevant worker concurrency slot is available;
- whether a prior decision requests a specific next worker;
- whether retry and repair budgets are exhausted.

The detailed reasoning belongs in curator, builder, repairer, and reviewer decisions. Scheduler
decisions should still be recorded when they start or skip work so operators can see why nothing
happened.

## Dashboard Requirements

The dashboard should present the graph as a human-readable story, not only as raw rows.

For a work item, an operator should be able to trace:

- which intake decision made it buildable or asked a human question;
- which builder produced which branch and pull request;
- which checks, reviews, or comments were observed;
- which curator decision started a repairer or escalated to a human;
- which repair commits correspond to which failed check fingerprints;
- why the current Project status is `Todo`, `In Progress`, `Human Review`, or `Done`.

The first UI may be a timeline projection of the graph. A visual graph is optional. The important
product contract is traceability of decisions and causal links.

## Migration Strategy

The implementation may proceed as a thin vertical slice rather than a deep rewrite.

Recommended first slice:

1. Add the graph-oriented durable tables or compatible projections.
2. Treat the existing runner implementation as the initial `builder` worker.
3. Stop adding new post-run responsibilities to the builder.
4. Add intake curator and post-PR curator workers with shallow initial policies.
5. Record decisions and links for every scheduler dispatch and worker outcome.
6. Implement post-PR check observation before automatic repair.
7. Add a narrow repairer for deterministic formatting failures.

Existing `runs`, `attempts`, and `events` may be migrated, wrapped, or replaced. If the schema is
reset during early development, the new model should be optimized for worker graph traceability
rather than preserving the old runner-centric shape.

## Consequences

Positive consequences:

- Builder responsibility becomes small and understandable.
- Clarification before implementation becomes a first-class workflow.
- CI/check repair becomes separate from initial code generation.
- Reviewer and repairer workers can evolve without changing builder semantics.
- Dashboard traceability improves because decisions and artifacts are causally linked.
- The scheduler can dispatch different worker kinds from one board scan without duplicating
  scheduling machinery.

Negative consequences:

- The state model is more complex than a linear run/attempt/event log.
- Workers need explicit decision schemas and policy versions.
- The scheduler must reason over graph freshness and active worker claims.
- Early implementations need discipline to avoid hiding important edges inside unstructured JSON.
- ADR 0012 and ADR 0013 require follow-up edits to remove runner-centric sequencing.

## Revisit When

- The first curator and repairer workers are implemented.
- The dashboard can show a useful work-item story from graph data.
- Rhapsody supports multiple repositories or trackers.
- Repair policies expand beyond deterministic formatting failures.
- GitHub App credentials replace the MVP PAT model.
