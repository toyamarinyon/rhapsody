# ADR 0004: Broker ChatGPT Auth for Codex Execution Sandboxes

## Status

Accepted

## Context

Rhapsody runs coding agents in Vercel Sandboxes. The initial agent target is Codex CLI using
ChatGPT-managed authentication so operators can use their ChatGPT/Codex subscription rather than
only API-key billing.

The execution sandbox is an untrusted boundary. It contains the target repository, runs agent
commands, and may execute code influenced by issues, prompts, repository content, dependencies, or
tool output. Real ChatGPT `auth.json` contents, access tokens, refresh tokens, GitHub tokens, and
API keys must not be written into this sandbox filesystem, command arguments, logs, artifacts, or
snapshots.

An external spike on May 16, 2026 tested Codex CLI `@openai/codex@0.130.0` with Vercel Sandbox SDK
`@vercel/sandbox@2.0.0-beta.20`. The spike used two sandboxes: one credential mediator sandbox
holding real ChatGPT credentials for the experiment, and one Codex execution sandbox containing only
a dummy `~/.codex/auth.json`. In production, the mediator must be a trusted Rhapsody host component,
not an execution sandbox.

## Decision

Use brokered ChatGPT authentication for Codex execution sandboxes.

For the MVP `codex exec` path:

1. Write only a structurally valid dummy `~/.codex/auth.json` into the Codex execution sandbox.
2. Configure the execution sandbox network policy to forward ChatGPT backend traffic and OAuth
   refresh traffic to a trusted Rhapsody credential mediator.
3. Keep real ChatGPT access token, refresh token, and account ID state in the trusted mediator.
4. Replace dummy backend credentials with real `Authorization` and `ChatGPT-Account-ID` headers in
   the mediator.
5. Handle OAuth refresh in the mediator using the real refresh token.
6. Return only dummy token-shaped refresh responses to Codex so Codex may update its sandbox-local
   `auth.json` without receiving real credentials.

The mediator must never return real refreshed ChatGPT tokens to Codex running inside the execution
sandbox. Codex persists successful managed-auth refresh responses to `auth.json`; returning real
tokens would violate the sandbox secret boundary.

## Validated Findings

The spike demonstrated the following:

- `codex login status` succeeds with a structurally valid dummy ChatGPT `auth.json`.
- `codex exec` can start with the dummy auth file and reach ChatGPT backend traffic.
- An expired dummy access token triggers Codex's managed OAuth refresh path.
- Vercel Sandbox `forwardURL` can forward `auth.openai.com/oauth/token` traffic to a mediator.
- The mediator can perform the real refresh outside the Codex execution sandbox.
- The mediator can return dummy `id_token`, `access_token`, and `refresh_token` values to Codex.
- `codex exec` completed successfully in the credential-isolation prototype.
- Scanning the Codex execution sandbox after the run did not find the real access token or refresh
  token.
- Codex attempted a WebSocket request to `wss://chatgpt.com/backend-api/codex/responses`; the
  prototype mediator rejected it with `426 Upgrade Required`, after which Codex used HTTP fallback
  successfully.

## Important Implementation Details

The dummy `auth.json` must be structurally valid enough for Codex startup. The spike used this
shape:

```json
{
  "auth_mode": "chatgpt",
  "OPENAI_API_KEY": null,
  "tokens": {
    "id_token": "<dummy.jwt>",
    "access_token": "<dummy.jwt>",
    "refresh_token": "dummy-refresh-token",
    "account_id": "<account-id-like-value>"
  },
  "last_refresh": "<iso-date>"
}
```

The dummy `id_token` must be JWT-shaped and include enough ChatGPT metadata for Codex account and
plan checks, including claims such as `chatgpt_plan_type`, `chatgpt_user_id`, and
`chatgpt_account_id` under the `https://api.openai.com/auth` claim namespace.

Normal ChatGPT backend requests require these real values at the mediator boundary:

- `Authorization: Bearer <real-access-token>`
- `ChatGPT-Account-ID: <real-account-id>`
- `X-OpenAI-Fedramp: true` when applicable

Codex managed OAuth refresh sends a JSON body to `https://auth.openai.com/oauth/token` containing at
least:

```json
{
  "client_id": "...",
  "grant_type": "refresh_token",
  "refresh_token": "<refresh-token>"
}
```

Because refresh authentication is in the request body, Vercel Sandbox header transforms alone are
not sufficient. Rhapsody needs a trusted mediator or a supported external-token protocol that can
own the real refresh token and synthesize the upstream refresh request.

Vercel Sandbox `forwardURL` appends the original matched path to the configured forward URL. For
example, forwarding original `/oauth/token` to `/codex/oauth/token` may arrive at the mediator as
`/codex/oauth/token/oauth/token`. The mediator should identify sensitive forwarded traffic by
trusted forwarding metadata such as the original host plus path suffix, not by a single exact path
alone.

## Preferred Future Shape

The spike also found a cleaner long-term Codex architecture:

```text
Rhapsody trusted control plane
  - owns ChatGPT token state
  - runs or coordinates Codex app-server
  - supplies external chatgptAuthTokens
  - points Codex at a remote sandbox environment

Vercel Sandbox execution plane
  - runs codex exec-server
  - contains the repository workspace
  - receives process and filesystem RPC
  - never receives ChatGPT auth material
```

This app-server plus exec-server path may avoid proxying ordinary `codex exec` traffic and should be
evaluated after the MVP credential mediator path is working.

## Required Safeguards

- The credential mediator must live outside the Codex execution sandbox trust boundary.
- Real tokens must be stored only in trusted server-side storage.
- The execution sandbox must receive only dummy auth material.
- The sandbox network policy should default to deny-all and allow or forward only required hosts and
  paths.
- Logs must redact `Authorization`, cookies, API keys, OAuth request bodies, and JWT-like strings.
- Snapshots must not be created until token scans confirm no real credentials are present.
- The mediator must authenticate requests from the expected sandbox or workflow context.
- The mediator must rate-limit and audit refresh attempts.
- The mediator must update host-held token state from real OAuth refresh responses.
- The mediator must return only dummy token-shaped values to Codex.

## Consequences

Positive consequences:

- Rhapsody can use ChatGPT-managed Codex authentication while keeping real credentials out of the
  execution sandbox filesystem.
- The MVP can run unmodified `codex exec`.
- OAuth refresh can occur without exposing the real refresh token to sandboxed code.
- The design preserves a path toward a cleaner app-server and exec-server architecture.

Negative consequences:

- Rhapsody must implement and secure a credential mediator.
- OAuth refresh cannot be solved by header injection alone.
- The mediator needs careful request matching, redaction, rate limiting, and token-state handling.
- WebSocket behavior may require additional proxy support if HTTP fallback is removed or becomes
  insufficient.
- This design depends on current Codex CLI and Vercel Sandbox behavior and should be covered by
  integration tests.

## Revisit When

- Codex app-server external `chatgptAuthTokens` and sandbox `codex exec-server` are production-ready
  for Rhapsody's runner architecture.
- OpenAI provides a supported third-party Agent Identity or hosted token-brokering flow.
- Codex CLI changes managed-auth refresh behavior or no longer accepts dummy token-shaped auth
  state.
- Vercel Sandbox changes `forwardURL`, header transform, or WebSocket support semantics.
