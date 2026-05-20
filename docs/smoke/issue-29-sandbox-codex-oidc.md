# Issue 29 Sandbox Codex OIDC Smoke

Run: `run_d1ba556f19144ec6b340b3a529c4cbda`
Attempt: `att_d40f686ed4e44daa95499efca3ff0d48`

Result:

- `sandbox-codex` launched Codex successfully in write mode with the `openai-http` provider.
- Seeded ChatGPT auth was present at `CODEX_HOME/auth.json`.
- A direct in-sandbox fetch to `https://chatgpt.com/backend-api/codex/models?client_version=0.130.0` was terminated by the sandbox network layer before returning a proxied HTTP response.

No product behavior was changed by this smoke note.
