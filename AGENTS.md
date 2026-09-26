# Observatory - Contributor guidance

## Code Review Rules

- Review the PR diff for actionable correctness, security, data-loss, and deployment regressions; cite the changed file/line and concrete impact.
- Preserve authentication boundaries, persisted data compatibility, and the project's documented build/test/deploy contracts. Adapt shared patterns to this project's stack.
- Report missing behavioral coverage where it would catch a specific regression; leave formatting and mechanical checks to CI.

## Codex automation

Use native Codex GitHub reviews and `@codex` PR tasks with ChatGPT sign-in.
Setup: https://github.com/mucsi96/skeleton-app/blob/main/docs/codex-automation.md
Skeleton sync: follow `.github/prompts/sync-skeleton.md` in a weekly scheduled task.

## Application contracts

Follow the current branch's README.md for architecture, authentication, testing,
and deployment conventions. Preserve its authentication boundaries, keep upstream
credentials server-side, and keep partial collector failures visible. Adapt
skeleton patterns to the existing stack rather than replacing the backend or
storage architecture just to match the reference application.
