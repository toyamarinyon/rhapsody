# AGENTS.md

Rhapsody is a Next.js application for a Vercel-native agent scheduler/runner. It is derived from
[Symphony](https://openai.com/index/open-source-codex-orchestration-symphony/), but the target
architecture is GitHub Projects + Workflow SDK + Vercel Sandbox rather than a long-running local
daemon.

## Project Direction

- Treat [docs/SPEC.md](docs/SPEC.md) as the working product/engineering specification.
- Treat [docs/ORIGINAL_SPEC.md](docs/ORIGINAL_SPEC.md) as the unmodified Symphony reference spec.
- Design human-facing surfaces as extensions of familiar development practice, while optimizing the
  machinery behind them for agents and automation. Rhapsody exists to help humans develop with
  coding agents, so branch names, PRs, issue comments, dashboards, logs, and operator workflows
  should remain readable and unsurprising to developers. Code is also a human-facing surface:
  even when it implements agent-optimized data structures, protocols, mediation, sandboxing,
  retries, and verification, its naming, module boundaries, and control flow should stay readable
  and understandable to human maintainers. The product facade should feel familiar; the internal
  contracts should be explicit and structured for agents; the implementation should make both
  legible.
- Prefer Vercel-native primitives:
  - Workflow SDK for durable scheduler/runner workflows.
  - Vercel Sandbox for isolated agent execution.
  - Vercel Cron and GitHub webhooks for triggers.
  - A durable store for claims, runs, attempts, events, and dashboard projections.
- Use GitHub Projects v2 as the first issue tracker, not Linear.
- Keep the initial target narrow: GitHub Issues in a configured ProjectV2 board. Add PRs, draft
  issues, and other trackers later.

## Near-Term Work

1. Define the config shape for GitHub Project, scheduler, sandbox, and agent settings.
2. Add a GitHub Project tracker client that can resolve project/field IDs and normalize ProjectV2
   items into Rhapsody work items.
3. Add durable claim/run/attempt/event persistence.
4. Add a Workflow SDK scheduler workflow that polls GitHub Projects and starts runner workflows.
5. Add a runner workflow skeleton that creates a Vercel Sandbox and runs a simple command.
6. Add dashboard/API endpoints for state, item detail, run detail, and manual refresh.

## Engineering Notes

- Do not rely on in-memory state for scheduler correctness; Vercel Functions are not daemon
  processes.
- Agent commands must run inside a Vercel Sandbox workspace, not directly in the Vercel Function
  environment.
- Secrets should be passed through documented environment or brokered access patterns and must not
  be logged.
- Project status, claims, and retries must be idempotent because Cron, webhooks, and manual refresh
  can overlap.
- Keep docs updated as implementation decisions become concrete.

<!-- eslint-plugin-raula-start -->
<!-- Managed by `eslint-plugin-raula install` -->
# raula: opnionated linting
Before editing files that touch styling, JSX className usage, global CSS selectors, or Next.js layout files, read:
`./node_modules/eslint-plugin-raula/REFERENCE.md`
This block is supplemental and should complement, not override, local project instructions.
<!-- eslint-plugin-raula-end -->


<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->
