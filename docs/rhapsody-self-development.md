# Rhapsody Self-Development

Rhapsody can be used to develop Rhapsody itself through the same workflow it provides for project
work. A GitHub Issue in the configured Project board is picked up by scheduler ticks, executed by a
Workflow runner in a Vercel Sandbox, and completed by an agent-created pull request back to the
repository.

This keeps even small Rhapsody changes reviewable as normal development artifacts: issue, branch,
commit, pull request, and run history.
