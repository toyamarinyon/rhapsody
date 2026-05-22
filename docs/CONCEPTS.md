# Rhapsody Concepts

Rhapsody is a Vercel-native agent runner that turns GitHub Project items into sandboxed Codex runs.

This document defines the core concepts Rhapsody uses to describe what it does and how it does it.
It is not a complete specification. For normative behavior, see [SPEC.md](SPEC.md). For decision
history, see [adr/](adr/).

## Product Model

A Work Item is a GitHub issue represented by a GitHub ProjectV2 item.

A Project Boundary is the configured GitHub owner, repository, ProjectV2 board, status field, and
eligible statuses that Rhapsody is allowed to schedule.

A Repository is the GitHub repository where Codex reads source, edits files, commits changes, and
creates human-reviewable handoff state.

Repository Instructions are the team-owned instructions in `.rhapsody/INSTRUCTIONS.md` that tell
Codex how to work on a Work Item.

Codex Configuration is the repository-owned `.codex/` configuration that Rhapsody lets Codex read
inside the sandbox while Rhapsody still owns sandbox, network, credential, and verification
boundaries.

## Scheduling Model

A Scheduler is a durable workflow that finds eligible Work Items and creates Claims.

A Claim is a database-backed lease that gives one Run temporary ownership of one Work Item.

A Run is Rhapsody's durable record of trying to move one Work Item forward.

An Attempt is one execution of a Run inside one Vercel Sandbox.

A Retry is a new Attempt for the same Run after a previous Attempt failed, timed out, or became
stale according to Rhapsody policy.

## Execution Model

A Runner Workflow is a durable workflow that prepares one Attempt, starts sandboxed execution, waits
for a callback, verifies the result, and finalizes the Run.

A Vercel Sandbox is the isolation boundary where Codex may edit files and run commands.

Source Initialization is the process that prepares the target repository inside the Vercel Sandbox
at a specific base commit.

A Sandbox Wrapper is the Rhapsody-owned command that runs inside the Vercel Sandbox, launches Codex,
emits runner events, and sends a terminal callback.

A Runner Event is a Rhapsody-owned observation or state transition emitted while a Run is
progressing.

A Terminal Callback is the message from the Sandbox Wrapper that tells the Runner Workflow that
sandboxed execution has completed, failed, timed out, or stopped.

Execution Status is the observed result of sandboxed command execution.

Run Outcome is Rhapsody's final evaluation of a Run after execution, mediation, and verification.

## Authority Model

A Mediator is a trusted Rhapsody endpoint that lets sandboxed Codex perform approved external side
effects without receiving raw upstream credentials.

A Scheduler-owned Write is a GitHub write performed by trusted Rhapsody code for lifecycle
management, such as moving a ProjectV2 item after a successful handoff.

An Agent-owned Write is a GitHub write initiated by Codex, such as pushing a branch, opening a pull
request, or leaving an issue comment.

A Mediated Write is an Agent-owned Write that passes through the Mediator and is checked against the
active Run, Attempt, Project Boundary, and repository policy.

A Credential Boundary is the rule that real upstream credentials stay in trusted Rhapsody code and
are not written into the sandbox filesystem, command arguments, logs, callback payloads, exports, or
snapshots.

## Handoff Model

A GitHub Handoff is the externally visible GitHub state that shows what Codex produced for a Work
Item.

A Pull Request Handoff is a GitHub Handoff where Codex creates or updates a pull request linked to
the Work Item.

A Comment Handoff is a GitHub Handoff where Codex leaves an issue comment explaining a no-change
result, blocker, or clarification request.

Post-run Verification is the process that decides whether a completed Attempt created an acceptable
GitHub Handoff.

Claim Release is the point where Rhapsody gives up ownership of the Work Item after the Run has been
finalized or abandoned.

## Observability Model

An Event is an append-only record of scheduler, runner, sandbox, mediator, verification, or
dashboard activity.

Dashboard State is the queryable projection of Claims, Runs, Attempts, Events, sandbox references,
and GitHub Handoffs that helps a human understand what Rhapsody is doing.

Preview Verification is a low-risk run used to confirm that intake, dispatch, handoff, and
post-run graph data are visible in a deployed preview environment.

Reconciliation is the background process that repairs or finalizes stale Claims, missing callbacks,
expired Attempts, stopped sandboxes, and Work Items that moved outside the active Project Boundary.
