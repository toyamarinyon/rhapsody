# ADR 0010: Use Rhapsody Instructions and Codex-Native Configuration

## Status

Accepted

## Context

Rhapsody is derived from Symphony, but it does not run in the same operational shape. Symphony's
`WORKFLOW.md` design assumes a robust long-running server runtime that can own polling,
configuration reloads, local workspace lifecycle, hooks, and agent process management from one
repository-owned workflow file.

Rhapsody is a serverless control plane. It uses Vercel Workflow for durable orchestration, Vercel
Sandbox for execution, a durable state store for claims and runs, and a trusted mediator for
credentialed GitHub and ChatGPT access. Scheduler, tracker, mediator, source preparation, and
sandbox safety boundaries must therefore remain owned by trusted Rhapsody configuration and code.

The repository still needs to define team-owned instructions for how Codex should work on an issue.
It should also be able to reuse normal Codex CLI configuration and subagent definitions so local
Codex usage and Rhapsody execution do not drift.

ADR 0007 introduced `RHAPSODY.md`, with `WORKFLOW.md` fallback, as the MVP workflow guidance file.
This ADR supersedes that repository workflow file portion of ADR 0007.

## Decision

Use `.rhapsody/INSTRUCTIONS.md` as the only Rhapsody-specific repository-owned instruction file for
the MVP.

Do not support `RHAPSODY.md` or `WORKFLOW.md` as MVP workflow file names.

Use Codex-native repository configuration from `.codex/` for model, CLI, and subagent behavior.
Rhapsody does not define its own repository-level Codex configuration schema.

The MVP repository contract is:

```text
.rhapsody/
  INSTRUCTIONS.md

.codex/
  config.toml
  agents/
    *.toml
```

Only `.rhapsody/INSTRUCTIONS.md` is defined by Rhapsody. The `.codex/` files are normal Codex CLI
configuration files that may already be used by developers locally. Rhapsody prepares the sandbox so
Codex runs from the checked-out repository and can read those files through the normal Codex
configuration discovery path.

## Instruction Template Contract

`.rhapsody/INSTRUCTIONS.md` is a Markdown prompt template. The runner renders it for the claimed
work item and includes the rendered text in the initial Codex prompt.

Rendering requirements:

- Use a strict template engine.
- Unknown variables must fail rendering.
- Unknown filters must fail rendering.
- YAML front matter is not part of the MVP contract.

Template variables:

- `item`: normalized `WorkItem`
- `run`: run metadata
- `attempt`: attempt metadata
- `repository`: configured repository metadata
- `project`: configured GitHub Project metadata

The runner may add a small Rhapsody-owned prompt prelude or appendix with required execution
constraints, such as using mediated GitHub access, following the configured branch prefix, reporting
completion through the wrapper callback, and avoiding raw credential handling. Those safety
constraints are host-owned; they are not delegated to repository instructions.

Minimal example:

```md
You are working on {{ item.identifier }}.

Issue URL: {{ item.url }}

Move this issue forward in the smallest useful increment. If implementation changes are needed,
create a branch, commit the changes, and open a pull request. If no code change is needed, leave a
clear issue comment instead.
```

## Codex Configuration

Repository-owned Codex settings belong in `.codex/config.toml` and `.codex/agents/*.toml`.

Rhapsody treats those files as Codex-native inputs. The runner should not parse them into a
Rhapsody-specific schema except for narrow validation or diagnostics that are needed before launch.

This keeps local and repository-native Codex behavior aligned for:

- Codex CLI settings;
- approval and tool settings that Codex owns;
- subagent definitions;
- local developer Codex behavior

through the same files.

Rhapsody sandbox runner model selection is deliberately separate. The runner reads
`.rhapsody/config.toml` for host-owned operational settings:

```toml
[runner.codex]
model = "gpt-5.2"
reasoning_effort = "medium"
```

When `[runner.codex]` is present, `model` is required and `reasoning_effort` is optional. The
`sandbox-codex` runner passes those values to `codex exec` as Rhapsody-owned configuration
overrides and records the effective values in runner metadata or events. When the section is
missing, the runner preserves Codex's normal fallback behavior, including any model selection Codex
would derive from `.codex/` or its defaults.

Rhapsody-owned safety and scheduling settings remain outside `.codex/`:

- GitHub Project and repository scheduling boundaries;
- claim TTLs, concurrency, retry, and reconciliation policy;
- trusted mediator authorization rules;
- sandbox creation, source initialization, and network policy;
- runner Codex model and reasoning effort for scheduled sandbox execution;
- GitHub handoff verification.

Those settings are defined in trusted Rhapsody configuration and code, not in repository prompt or
Codex config files.

The runner may copy or mount repository-owned `.codex/` files into the sandbox workspace so Codex can
use normal repository configuration. However, the wrapper invocation remains host-owned. Rhapsody
MUST override or constrain Codex settings that define the execution boundary for sandboxed runs:

- Codex approval/sandbox mode is fixed for Rhapsody execution. The MVP runs Codex in YOLO-style mode
  inside the Vercel Sandbox because the Sandbox is the isolation boundary.
- Network access, especially external side effects, is constrained by sandbox network policy and the
  trusted mediators.
- Real ChatGPT and GitHub credentials are never delegated to `.codex/` configuration or repository
  instructions.
- Repository-owned Codex config may tune normal local Codex behavior and subagents, but
  Rhapsody-owned runner model overrides determine scheduled sandbox execution when configured.
  Repository-owned Codex config cannot weaken Rhapsody's sandbox, mediator, credential, or post-run
  verification boundaries.

## Runner Behavior

The MVP runner sequence is:

1. Claim a GitHub Project item and create a run through the durable state store.
2. Create a Vercel Sandbox.
3. Prepare the repository source in the sandbox.
4. Verify `.rhapsody/INSTRUCTIONS.md` exists.
5. Render `.rhapsody/INSTRUCTIONS.md` with the work item context.
6. Launch Codex from the repository root through the sandbox wrapper.
7. Let Codex read `.codex/config.toml` and `.codex/agents/*.toml` normally, while applying
   Rhapsody-owned overrides for runner model selection, sandbox mode, network access, and
   credential boundaries.
8. Await the wrapper completion callback.
9. Verify GitHub handoff and post-run policy.
10. Finalize the attempt and release the claim.

If `.rhapsody/INSTRUCTIONS.md` is missing or cannot be rendered, the runner fails the attempt with a
typed workflow error. The MVP does not silently fall back to `RHAPSODY.md`, `WORKFLOW.md`, or a
default repository prompt.

## Differences from Symphony

Rhapsody intentionally does not carry over Symphony's broad `WORKFLOW.md` repository contract.

Differences from `docs/ORIGINAL_SPEC.md`:

- Symphony uses `WORKFLOW.md`; Rhapsody uses `.rhapsody/INSTRUCTIONS.md`.
- Symphony allows YAML front matter to configure tracker, polling, workspace, hooks, agent, and
  Codex runtime behavior; Rhapsody does not.
- Symphony expects a long-running runtime to reload workflow file changes; Rhapsody applies
  repository instructions per sandboxed run.
- Symphony owns local workspace lifecycle and hooks from the workflow file; Rhapsody owns source
  preparation and sandbox lifecycle from trusted runner code.
- Symphony's workflow file may contain Codex pass-through config; Rhapsody reuses native `.codex/`
  files instead.
- Symphony's issue tracker configuration can live in the workflow file; Rhapsody keeps GitHub
  Project scheduling configuration in trusted Rhapsody config.

The result is a narrower serverless contract: Rhapsody schedules and verifies work, while Codex
configuration remains Codex-native.

## Consequences

Positive consequences:

- The repository contract is small and easy to explain.
- Rhapsody avoids inventing a parallel Codex configuration schema.
- Local Codex usage and Rhapsody sandbox execution can share `.codex/` configuration.
- Scheduler and mediator safety boundaries remain host-owned and enforceable.
- The MVP avoids compatibility complexity from `RHAPSODY.md` and `WORKFLOW.md` fallback behavior.

Negative consequences:

- Existing Symphony `WORKFLOW.md` files are not directly compatible.
- Repositories must add `.rhapsody/INSTRUCTIONS.md` before Rhapsody can run them.
- Rhapsody cannot tune Codex behavior through its own repository workflow schema.
- Any Codex configuration validation mostly depends on Codex itself unless Rhapsody adds targeted
  preflight checks.

## Revisit When

- Codex changes its repository configuration discovery path materially.
- Rhapsody needs a migration helper for Symphony `WORKFLOW.md` repositories.
- Operators need Rhapsody-specific repository hooks that cannot be represented as Codex behavior.
- Multi-repository or multi-project scheduling needs repository-specific instruction discovery
  rules.
