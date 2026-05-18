# ADR 0011: Use Sandbox Wrapper for MVP Runner Execution

## Status

Accepted

## Context

Rhapsody needs a concrete MVP runner architecture before implementing the first runner skeleton.
ADR 0004 selected brokered ChatGPT authentication for Codex execution sandboxes, and ADR 0006
selected callback-driven Workflow orchestration. Those decisions establish the security and
orchestration boundaries, but they do not fully define how the agent process is launched inside the
Vercel Sandbox.

Two plausible Codex runner shapes exist:

- run `codex exec` directly inside the Vercel Sandbox, launched by Rhapsody;
- run `codex exec` through a Rhapsody-owned sandbox wrapper;
- later, evaluate a trusted-host `codex app-server` with sandbox-side `codex exec-server`.

Running `codex exec` directly is simpler, but it leaves Rhapsody dependent on Sandbox command APIs
for completion detection, timeout handling, execution status, and Workflow resumption. The direct
command also has no Rhapsody-native place to emit consistent runner events and state transitions
after the Workflow has paused or timed out.

## Decision

Use a Rhapsody-owned TypeScript/Node sandbox wrapper for the MVP runner.

The runner workflow prepares the sandbox, source, environment, dummy Codex auth state, network
policy, callback metadata, and Workflow hook. It then starts the wrapper as the sandbox command and
pauses on the Workflow hook.

The wrapper is the sandbox-side attempt executor. It runs, in order:

1. emit `agent_execution_started`;
2. run `codex exec`;
3. emit `agent_execution_finished`;
4. deliver the terminal callback.

These are fixed Rhapsody runner events and state updates, not repository-configurable YAML front
matter hooks.

The wrapper is intentionally not the source of truth for run success. It reports observed execution
status. The runner workflow records that execution status, then evaluates final attempt and run
status separately from callback data, GitHub-side verification, and workflow policy.

## Wrapper Scope

The wrapper owns:

- validating its required runtime inputs;
- running from the normalized sandbox workspace path;
- emitting fixed runner events around `codex exec`;
- executing `codex exec`;
- preserving the Codex process exit code as execution status input;
- applying wrapper-level timeout behavior when configured;
- sending exactly one terminal callback when possible;
- retrying terminal callback delivery on a best-effort basis;
- avoiding intentional logging of secret values.

The wrapper does not own:

- creating dummy `auth.json`;
- holding real ChatGPT credentials, GitHub tokens, or other upstream secrets;
- deciding final attempt or run success;
- updating GitHub Project status;
- durable claim, run, retry, or scheduler state;
- durable log storage;
- artifact management beyond allowing normal git, commit, push, and PR handoff.

The MVP does not require `.rhapsody/result.json`. The wrapper may support an optional result file
later, but GitHub-side handoff verification is the primary source for evaluating work output.

## Status Model

Rhapsody separates observed execution status from evaluated run outcome.

The wrapper terminal callback reports execution facts such as:

- `execution_status`
- `exit_code`
- `started_at`
- `completed_at`
- optional error summary

The runner workflow then evaluates:

- final attempt status, such as succeeded, failed, timed out, stale, or handoff failed;
- final run status, including retrying, succeeded, failed, or abandoned.

A successful wrapper execution is necessary but not sufficient for a successful run. For example,
`codex exec` may exit successfully while GitHub handoff verification fails. In that case, execution
status is successful but the evaluated attempt or run can still fail.

## Runner Events and Workflow Timeout

Runner execution events run inside the wrapper rather than as separate runner workflow steps. The
runner workflow may be paused, timed out, retried, or otherwise unavailable while sandbox work is
active. Keeping fixed event emission inside the wrapper makes the attempt execution sequence
self-contained after the wrapper command starts.

## Heartbeats

Heartbeats are optional for the MVP.

The wrapper may later send heartbeat callbacks to improve dashboard visibility, stale attempt
detection, and watchdog decisions. Terminal callbacks remain the required MVP completion signal.
Watchdog reconciliation must still handle missing callbacks, expired claims, and sandbox or command
timeouts.

## Timeout and Cancellation

The sandbox lifetime or Sandbox command timeout is the primary MVP timeout boundary.

The wrapper may also accept a local timeout and terminate its child process if configured. Rhapsody
should use external sandbox or command cancellation APIs when they are available, but the durable
state store and watchdog must be able to mark an attempt timed out even if external cancellation
does not complete cleanly.

## GitHub and Output Handoff

The agent may attempt normal workflow-specific GitHub operations. The trusted GitHub mediator
enforces what is allowed for the active run context and prevents access to raw upstream credentials.
The wrapper does not implement GitHub authorization policy.

For the MVP, Rhapsody treats git commits, branch pushes, PRs, issue comments, or other
workflow-defined GitHub handoff as the durable work output. The wrapper should not implement
substantial log or artifact persistence. Logs may remain in Sandbox command output or future Vercel
Sandbox logging facilities.

## Alternatives Considered

### Direct `codex exec` without a wrapper

This has less code and may be useful for early spikes. It was rejected for the MVP architecture
because it does not provide a Rhapsody-owned completion contract, runner event boundary, callback
retry point, or clear place to separate execution status from run evaluation.

If Vercel Sandbox later provides durable command completion events that can directly resume Workflow
hooks and expose enough execution metadata, Rhapsody may reduce or remove the wrapper.

### Trusted `codex app-server` plus sandbox `codex exec-server`

This remains a preferred future experiment because it can keep Codex auth in the trusted control
plane while routing file and shell execution to the sandbox. It is not selected for the MVP because
it adds networking, exposure, WebSocket, and protocol integration risk before the basic runner is
working.

Rhapsody will revisit this path after the MVP wrapper runner is implemented and validated.

## Consequences

Positive consequences:

- The MVP has a concrete sandbox-side execution contract.
- Runner workflows can pause while sandbox work continues.
- Runner event emission, `codex exec`, and callback delivery execute as one sandbox-local attempt
  sequence.
- Execution facts and final run evaluation remain separate.
- The wrapper can stay small while preserving room for callback retry, timeout, and future
  heartbeat support.

Negative consequences:

- Rhapsody must build and ship a sandbox wrapper CLI.
- The wrapper becomes another component to version, test, and debug.
- Some behavior may later be replaced if Sandbox command events or Codex app-server/exec-server
  become the better integration point.

## Revisit When

- Vercel Sandbox command APIs provide durable completion events that can directly resume Workflow
  hooks and replace wrapper event emission with enough execution metadata.
- Codex app-server plus sandbox exec-server is proven viable for Rhapsody's Vercel Sandbox
  networking and security model.
- Rhapsody needs richer log, artifact, heartbeat, or cancellation behavior than the MVP wrapper
  contract supports.
