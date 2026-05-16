# ADR 0008: Define the Mediator Endpoint Contract

## Status

Accepted

## Context

Rhapsody runs coding agents in Vercel Sandboxes, but real ChatGPT credentials and GitHub tokens must
remain in the trusted Rhapsody control plane. ADR 0004 selected brokered ChatGPT authentication for
Codex execution sandboxes. ADR 0005 selected run-scoped GitHub mediation for agent-owned GitHub
writes. Those ADRs establish the trust boundaries, but not the concrete endpoint contract used by
sandbox network policy, agent commands, and mediator route handlers.

The endpoint design must balance two goals:

- Keep secrets out of the execution sandbox.
- Let the agent use GitHub and Codex in natural ways, including existing CLIs and API clients.

Rhapsody's MVP is intended for operator-trusted deployments, not arbitrary public multi-tenant use.
The mediator should therefore prioritize compatibility with existing agent behavior while still
preventing a run from operating on unrelated GitHub organizations or repositories.

## Decision

Use separate route prefixes for ChatGPT mediation, GitHub mediation, and runner callbacks:

- `/api/internal/mediator/chatgpt/*`
- `/api/internal/mediator/github/*`
- `/api/internal/runs/callback`

The mediator route prefixes share common middleware for authentication, run and attempt lookup,
request validation, redaction, and event logging.

Sandbox-to-mediator requests use these MVP headers:

```http
X-Rhapsody-Mediator-Secret: <secret>
X-Rhapsody-Run-Id: run_...
X-Rhapsody-Attempt-Id: att_...
```

`X-Rhapsody-Mediator-Secret` authenticates the request. `run_id` and `attempt_id` are authorization
context, not secrets. The mediator derives the allowed GitHub owner, repository, project item,
issue, pull request, and project resources from the active run and attempt records in the state
store. The sandbox may request operations, but it may not choose its own authorization scope.

For forwarded traffic, the mediator treats the path after the route prefix as a forwarded suffix.
The implementation must normalize forwarded paths and must not trust a sandbox-supplied absolute
upstream URL. Vercel Sandbox `forwardURL` may append the original path to the configured mediator
URL, so route handlers should identify the intended upstream target from trusted forwarding
metadata, configured host/path allowlists, and normalized suffixes instead of relying on a single
exact path.

## ChatGPT Mediation

ChatGPT mediation is transparent forwarding where possible because Codex expects native ChatGPT and
OAuth endpoints.

The ChatGPT mediator:

- forwards allowed ChatGPT backend requests after replacing dummy sandbox credentials with trusted
  server-held credentials,
- handles OAuth refresh requests in the trusted control plane,
- updates trusted token state from real OAuth refresh responses,
- returns only dummy token-shaped refresh responses to the sandbox,
- rejects unsupported upgrade or streaming behavior unless the implementation explicitly supports
  it.

The mediator must never return real ChatGPT access tokens, refresh tokens, ID tokens, account IDs,
or cookies to the sandbox.

## GitHub Mediation

GitHub mediation uses transparent forwarding as the default model.

The GitHub mediator is a GitHub-aware credential proxy, not a strict operation-level API gateway.
This preserves compatibility with `gh`, git smart HTTP, GitHub SDKs, and normal agent workflows.
The mediator still validates that each operation is scoped to the active run.

### REST

GitHub REST requests are forwarded when the mediator can determine that the request is allowed for
the active run.

Rules:

- Requests whose path contains `owner` and `repo` must match the run's allowed repository.
- GitHub Search API requests are allowed.
- Read operations are allowed when the requested resource is within the run scope or does not expose
  cross-repository write capability.
- Write operations are allowed when the requested resource is within the run scope.
- Destructive `DELETE` operations are denied by default.
- Repository administration, settings, collaborators, deploy keys, Actions secrets or variables,
  repository secrets, environments, transfer, archive, delete, release deletion, package deletion,
  and similar administrative APIs are denied.

The mediator attaches the trusted upstream `GITHUB_TOKEN` only after these checks pass.

### GraphQL

GitHub GraphQL query operations are forwarded transparently.

GitHub GraphQL mutation operations are authorized by referenced resource scope instead of operation
name allowlists. The mediator inspects the request `variables` and extracts GitHub resource IDs
from known keys and nested objects. Mutations are forwarded only when every inspectable resource ID
belongs to the active run's allowed repository, issue, pull request, ProjectV2 item, or configured
ProjectV2 project.

Mutations are rejected when:

- the request has no `variables` object,
- no inspectable resource ID is present,
- any referenced resource cannot be resolved or compared to the active run scope,
- any referenced resource belongs to a different owner, repository, project, issue, or pull
  request,
- the mutation places resource IDs only in literal GraphQL arguments instead of variables.

The MVP does not maintain GraphQL mutation operation-name allowlists. Authorization is based on the
resources referenced by the mutation variables.

### Git Smart HTTP

Git smart HTTP is supported when the mediator can extract `{owner}/{repo}.git` from the forwarded
URL and the repository matches the active run.

The mediator does not inspect packfile contents or enforce branch-level rules inside git smart HTTP
request bodies. Rhapsody relies on:

- repository-scoped GitHub credentials,
- workflow instructions such as the configured branch prefix,
- post-run verification of pull request head, base, owner, repository, and branch prefix,
- mediator event logging for audit and debugging.

If git smart HTTP mediation proves operationally unreliable, the runner may fall back to exporting a
patch, bundle, or format-patch artifact from the sandbox and pushing from the trusted control plane.

## Response and Error Shape

Successful forwarded requests should preserve upstream response status, headers, and body unless a
route has a documented transformation, such as ChatGPT OAuth refresh dummy-token responses.

Mediator-generated errors use a stable JSON shape:

```json
{
  "error": {
    "code": "mediator_forbidden",
    "message": "Request is not allowed for this run.",
    "request_id": "req_...",
    "retryable": false
  }
}
```

The mediator should distinguish authentication failures, authorization denials, validation errors,
unsupported upstream routes, upstream failures, and rate limits with stable error codes.

## Logging and Redaction

The mediator logs structured events for forwarded and denied requests.

Events include:

- request ID,
- route family,
- run ID,
- attempt ID,
- sandbox ID when known,
- operation family,
- normalized upstream host and route pattern,
- target owner and repository when known,
- decision,
- denial reason,
- upstream status,
- retryability,
- duration.

Events must not include secrets or sensitive payloads. Redaction must cover:

- `Authorization` headers,
- cookies,
- `X-Rhapsody-Mediator-Secret`,
- GitHub tokens,
- ChatGPT access tokens, refresh tokens, and ID tokens,
- OAuth request and response bodies,
- JWT-like strings,
- API keys,
- repository or environment secrets.

Mediator denial events should be visible in the dashboard through the normal events store.

## Consequences

Positive consequences:

- Agents can use existing GitHub and Codex clients with minimal wrapping.
- Real ChatGPT and GitHub credentials remain outside the execution sandbox.
- A run cannot choose an unrelated GitHub owner or repository by changing request URLs or headers.
- GitHub GraphQL mutations avoid operation-name allowlist maintenance while still checking resource
  scope.
- Git smart HTTP can support natural git workflows in the MVP.

Negative consequences:

- Transparent forwarding has a broader behavioral surface than operation-level APIs.
- GraphQL mutation validation depends on variables containing inspectable resource IDs.
- Git smart HTTP push cannot be branch-inspected before GitHub receives the request.
- Search API reads may reveal metadata outside the run repository depending on GitHub token scope.
- The mediator must carefully maintain path normalization, redaction, and denial logging.

## Required Safeguards

- Authenticate sandbox requests with `MEDIATOR_SECRET`.
- Require active run context for GitHub mediation.
- Validate supplied attempt IDs against the run.
- Derive allowed GitHub scope from the state store, not from sandbox-supplied request metadata.
- Prefer fine-grained GitHub credentials scoped to the configured repository and project.
- Deny administrative and destructive GitHub APIs by default.
- Reject GraphQL mutations that cannot be scoped through variables.
- Verify post-run GitHub handoff, especially PR owner, repository, base branch, head branch, and
  branch prefix.
- Redact secrets from logs, errors, events, artifacts, and dashboard projections.

## Revisit When

- Rhapsody becomes multi-tenant or is exposed to untrusted operators.
- GitHub App installation tokens replace PATs as the default credential model.
- Agent-owned GitHub operations need stricter auditability than transparent forwarding can provide.
- Git smart HTTP requires branch-level prevention before GitHub receives a push.
- Codex app-server plus exec-server removes the need for transparent ChatGPT backend mediation.
