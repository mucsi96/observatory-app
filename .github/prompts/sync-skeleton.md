# Skeleton synchronization

Run weekly on Tuesday at 06:00 UTC in a ChatGPT/Codex scheduled task with this
repository selected. This file defines the task; it does not enable a schedule.

Read `AGENTS.md` and follow the **Shared synchronization procedure** in
https://github.com/mucsi96/skeleton-app/blob/main/docs/codex-automation.md
from the current skeleton-app main branch. Stop and report if it is unavailable.

Use `.github/skeleton-sync-revision` as the last merged source checkpoint.
If absent, perform the initial shared-pattern baseline comparison. Adapt changes
to this project's stack, including its existing backend language. Validate the
result, update the checkpoint in the same PR, and report applied/skipped changes
and the PR URL. Do not merge or deploy.
