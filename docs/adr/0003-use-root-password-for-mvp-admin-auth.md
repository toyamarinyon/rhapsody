# ADR 0003: Use Root Password Authentication for MVP Admin Access

## Status

Accepted

## Context

Rhapsody is initially a self-hosted or team-hosted application, not a public multi-tenant SaaS. The
first users should be able to fork or deploy the repository to Vercel and try it with minimal setup.

GitHub login with user, organization, or team allowlists is a good long-term authorization model,
but it requires configuring a GitHub OAuth App or GitHub App before the dashboard can be used. That
setup cost is too high for the MVP quickstart.

Rhapsody still exposes administrative UI and API surfaces that can trigger scheduler refreshes,
inspect run logs, and eventually start or stop work. Those surfaces must not be public by default.

## Decision

Use a single root password for MVP admin authentication.

Operators configure `ROOT_PASSWORD` in the deployment environment. Users enter that password through
the Rhapsody login screen. After a successful login, Rhapsody issues a signed, HTTP-only session
cookie using `AUTH_SECRET`.

Protect the dashboard and human-operated API routes with the session cookie. Do not send
`ROOT_PASSWORD` on every API request.

Machine-triggered endpoints use dedicated secrets instead of the root password:

- Vercel Cron requests use `CRON_SECRET`.
- GitHub webhook requests use `GITHUB_WEBHOOK_SECRET` and signature verification.

If `ROOT_PASSWORD` or `AUTH_SECRET` is missing in production, Rhapsody should fail closed by
disabling admin access or failing startup with a clear configuration error.

## Consequences

Positive consequences:

- The MVP can be deployed without creating a GitHub login application.
- The quickstart remains compatible with personal and small-team deployments.
- The authentication boundary is simple and easy to replace later.
- Machine triggers and human sessions are separated from the beginning.

Negative consequences:

- A shared root password has weaker auditability than per-user login.
- There is no built-in user identity for attributing manual actions.
- Operators must rotate the password manually if it is shared too broadly.
- Public deployments need basic brute-force protection even though Rhapsody is not intended as a
  public SaaS.

## Required Safeguards

- Store the authenticated state in a signed, HTTP-only, secure cookie.
- Add fixed delay, rate limiting, or equivalent protection for failed login attempts.
- Never log the submitted root password.
- Keep `ROOT_PASSWORD` out of client-side JavaScript.
- Keep the authentication check behind a narrow helper so GitHub login can replace it later.

## Revisit When

- Rhapsody needs per-user audit trails.
- Multiple team members need independent access or revocation.
- The admin surface becomes exposed beyond a trusted small group.
- GitHub login with user, organization, or team allowlists becomes worth the setup cost.
