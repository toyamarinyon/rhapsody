# ADR 0009: Use Vercel Sandbox Git Source Initialization for Source Preparation

## Status

Accepted

## Context

Rhapsody must prepare repository source code inside a Vercel Sandbox before running Codex. The
runner needs a normal workspace with Git metadata so the agent can inspect history, create commits,
push branches when allowed, and open pull requests.

The source preparation strategy also affects the GitHub credential boundary. Rhapsody's trusted
control plane owns the upstream `GITHUB_TOKEN`, while the execution sandbox should not receive raw
credentials as agent-facing environment variables, repository files, logs, artifacts, or snapshots.

Vercel Sandbox supports source initialization when creating a sandbox, including Git repository
sources with revision and credential fields. This is the intended product boundary for private Git
source ingress.

## Decision

Use Vercel Sandbox Git source initialization as the MVP source preparation strategy.

The runner resolves the configured repository and base revision before creating the sandbox, then
passes a Git source descriptor to the Sandbox API. For private repositories, the runner may pass the
required GitHub source credential to the Sandbox API source credential fields. This is acceptable
because the credential is used for source initialization, not exposed as an agent runtime secret.

The runner records the resolved source metadata on the attempt, including:

- source strategy, initially `vercel_sandbox_git_source`;
- repository owner and name;
- base ref;
- resolved base commit SHA;
- source depth;
- redacted source URL;
- sandbox ID and source initialization outcome.

Do not run a separate `git clone` command from the sandbox wrapper for the initial checkout in the
MVP. The wrapper starts after source initialization and runs in the prepared sandbox workspace.

## Source Preparation Sequence

The MVP runner source sequence is:

1. Load `rhapsody.config.ts`.
2. Resolve the target repository from the config and work item.
3. Resolve the base ref, initially the configured default branch unless a later policy explicitly
   selects another ref.
4. Resolve and record the exact base commit SHA before sandbox creation.
5. Create the sandbox with Git source initialization using the configured repository URL, resolved
   revision, source depth, and source credential when required.
6. Validate that the sandbox workspace exists and points at the expected repository and base commit.
7. Start the sandbox wrapper from the prepared workspace.

The base commit SHA, not only a mutable branch name, is the reproducibility boundary for an attempt.
Retries should either reuse the recorded base SHA for the same attempt lineage or explicitly record a
new source resolution event when policy chooses to refresh the base.

## Credential Boundary

The source credential may cross the trusted Rhapsody control plane boundary only through the Vercel
Sandbox source initialization API.

The runner and sandbox manager must ensure:

- the GitHub credential is not written to repository files;
- the GitHub credential is not exposed as an agent-facing environment variable;
- command lines, logs, artifacts, events, and callback payloads redact source credentials;
- sandbox snapshots are not created from workspaces that may contain credential residue;
- post-run GitHub writes still use the run-scoped GitHub mediator from ADR 0005 unless a later ADR
  replaces that model.

The source initialization credential is not a general-purpose sandbox GitHub credential. Agent-owned
GitHub reads and writes remain mediated by the endpoint contract in ADR 0008.

## Failure and Retry Behavior

Source preparation failures are attempt failures unless the failing operation is a short,
infrastructure-level step that Workflow SDK can safely retry.

Retryable failures include transient GitHub API errors, transient Sandbox API errors, and temporary
network failures during source initialization.

Non-retryable or policy failures include missing repository configuration, missing credentials for a
private repository, unresolved base refs, unsupported ProjectV2 item repository targets, and
workspace validation mismatches.

Every source preparation failure must emit a structured event with a redacted error summary. Events
must include enough source metadata to debug revision selection without exposing credentials.

## Fallbacks and Deferrals

Trusted-host tarball or source archive upload is the preferred fallback if Sandbox Git source
initialization cannot satisfy a deployment's private repository requirements. This fallback keeps
GitHub credentials entirely in the trusted control plane, but it is not the MVP default because it
weakens the normal Git workspace experience and complicates push and pull request flows.

Snapshot restore is deferred. Rhapsody should not restore or create source snapshots in the MVP
until it has explicit snapshot hygiene, credential scanning, retention, invalidation, and audit
rules.

Exec-server filesystem source preparation is deferred until Rhapsody selects an app-server and
exec-server architecture.

## Consequences

Positive consequences:

- The MVP uses the Vercel Sandbox source ingress feature designed for this purpose.
- Codex starts in a normal Git workspace with repository metadata available.
- Rhapsody records an exact base SHA for repeatable attempts.
- Source initialization stays separate from agent-owned GitHub mediation.
- The implementation avoids building a custom source archive pipeline before it is needed.

Negative consequences:

- The source credential is entrusted to the Vercel Sandbox source initialization boundary.
- Deployments that require credentials to remain only in the Rhapsody control plane must use a later
  tarball/source archive path.
- Branch-level enforcement still happens through workflow guidance, mediator checks where possible,
  and post-run verification rather than during source initialization.
- Snapshot acceleration is unavailable in the MVP.

## Required Safeguards

- Resolve and persist the exact base commit SHA before creating the sandbox.
- Redact source credentials from logs, events, command arguments, errors, artifacts, and callback
  payloads.
- Validate the prepared workspace before launching Codex.
- Keep agent-owned GitHub operations behind the run-scoped mediator.
- Verify post-run that any created branch or pull request belongs to the configured repository,
  targets the configured base branch, and follows the configured branch prefix.
- Do not create source snapshots until snapshot hygiene is specified.

## Revisit When

- Vercel Sandbox source initialization cannot support a required private repository deployment.
- Operators require GitHub credentials to remain exclusively inside the Rhapsody control plane.
- Rhapsody adopts GitHub App installation tokens or per-run source credentials.
- Snapshot restore becomes necessary for retry speed or cost.
- Rhapsody moves to an app-server plus exec-server source preparation model.
