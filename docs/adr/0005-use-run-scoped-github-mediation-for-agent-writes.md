# ADR 0005: Use Run-Scoped GitHub Mediation for Agent-Owned Writes

## Status

Accepted

## Context

Rhapsody's MVP should be easy to deploy from the public repository. Requiring every operator to
create and configure a GitHub App before the first run would make the quickstart too heavy.

Symphony's original model treats issue tracker and pull request updates as workflow-specific work
that the coding agent usually performs through available tools. Rhapsody should preserve that
agent-owned workflow style where practical, but the execution sandbox must not receive the raw
GitHub credential.

The MVP GitHub credential is a PAT stored in the trusted Rhapsody deployment environment. GitHub App
installation tokens remain the preferred later architecture.

## Decision

Use a trusted GitHub mediator for agent-owned GitHub reads and writes.

The sandboxed agent may perform workflow-specific GitHub operations, such as creating comments,
creating or updating pull requests, adding allowed labels, and updating project status, but those
operations go through the Rhapsody mediator. The mediator owns the upstream `GITHUB_TOKEN` and
forwards allowed requests to GitHub.

Use a shared `MEDIATOR_SECRET` for MVP sandbox-to-mediator authentication. Use `runId` as the
authorization context, not as a secret.

Sandbox requests to the GitHub mediator include:

- `X-Rhapsody-Mediator-Secret`
- `X-Rhapsody-Run-Id`
- `X-Rhapsody-Attempt-Id` when available

The mediator validates the shared secret, loads the run from the state store, and checks that the
requested GitHub operation matches the run's configured owner, repository, work item, issue number,
and current lifecycle state before attaching the upstream GitHub PAT.

## Authorization Rules

The mediator should allow only requests that are consistent with the active run.

Minimum checks:

- The mediator secret matches `MEDIATOR_SECRET`.
- The run exists and is active.
- The attempt, when supplied, belongs to the run.
- The requested owner and repository match the run's work item.
- Issue comment operations target the run's issue number or a pull request associated with the run.
- Pull request creation uses the configured repository and base branch.
- Pull request updates target a pull request whose head/base/repository are consistent with the run.
- ProjectV2 mutations target the configured project item or fields for the run.

The mediator rejects:

- Requests outside the configured owner/repository.
- Repository administration, settings, collaborators, deploy keys, secrets, environments, Actions
  secrets/variables, transfer, archive, delete, release deletion, package deletion, or similar
  administrative APIs.
- Destructive `DELETE` operations by default.
- GraphQL mutations that are not on an allowlist.
- Requests for inactive, completed, failed, or unknown runs.

## Git Push Policy

MVP policy is intentionally pragmatic.

The sandboxed agent may create local commits. Git push may be agent-owned through the mediator if
the GitHub transport works with the mediator and request checks can at least restrict the target
owner/repository.

Fine-grained branch enforcement for Git smart HTTP is deferred because push bodies are packfiles and
are difficult to inspect in the mediator. Rhapsody relies on:

- workflow instructions to use the configured branch prefix,
- repository-scoped PAT permissions,
- post-run verification that the resulting pull request branch, base, owner, and repository match
  the run,
- event logging for GitHub mediator decisions.

If agent-owned push is not operationally viable, the runner may fall back to exporting a patch,
format-patch, or bundle from the sandbox and pushing from the trusted host.

## PAT Permissions

Prefer a fine-grained PAT scoped only to the configured repository and project.

The MVP needs permissions for:

- reading repository metadata and contents,
- pushing branches or otherwise writing contents,
- creating and updating pull requests,
- reading and writing issue comments and labels,
- reading and updating the configured GitHub ProjectV2 item/status,
- reading checks and commit status for validation/handoff.

Classic PATs may be used as a quickstart fallback when fine-grained PAT behavior is insufficient,
but operators should scope credentials as narrowly as GitHub allows.

## Consequences

Positive consequences:

- The MVP can use a simple PAT while keeping the raw GitHub token out of the execution sandbox.
- The agent can own workflow-specific PR/comment/status behavior in the spirit of Symphony.
- `runId` gives the mediator enough context to restrict requests to the current work item.
- A shared `MEDIATOR_SECRET` keeps the initial implementation simple.
- GitHub App installation tokens can replace PATs later without changing the agent-facing model.

Negative consequences:

- A shared mediator secret cannot be revoked per run.
- If the mediator secret leaks, other run IDs could be attempted until the secret is rotated.
- Git smart HTTP push cannot be fully branch-inspected by a simple mediator.
- The mediator must carefully redact logs and avoid returning upstream credentials.
- Post-run verification is required to catch branch/base/repository drift.

## Required Safeguards

- Prefer injecting `MEDIATOR_SECRET` through Vercel Sandbox network policy transforms rather than
  writing it to sandbox files.
- If the secret must be exposed as sandbox environment for an MVP client path, treat it as sensitive
  and never log it.
- Log mediator decisions with run, attempt, operation, target owner/repository, status, and denial
  reason, but never log tokens.
- Store the upstream `GITHUB_TOKEN` only in trusted Rhapsody environment variables or secret storage.
- Verify post-run that any created PR belongs to the configured repository, targets the configured
  base branch, and uses an expected branch prefix.

## Revisit When

- GitHub App installation tokens become part of the default setup.
- Rhapsody needs per-run mediator token revocation.
- Multiple repositories or tenants share one deployment.
- Agent-owned git push needs stronger branch-level prevention before GitHub receives the request.
- GitHub mediator operations become broad enough that operation-specific tools are safer than
  transparent forwarding.
