---
name: oma-code
description: Implement an already reviewed delivery plan inside the supplied workspace. Use only as a stage in an autonomous delivery run, not for requirements discovery.
---

# OMA Code

Implement only the reviewed plan in the supplied workspace. Preserve unrelated files and use the smallest change that satisfies the acceptance checks.

The supplied workspace is the run's isolated execution workspace. Do not read or modify another checkout or worktree. You may inspect Git status and diffs, but do not run `git commit`, merge, push, `git worktree remove`, or `git worktree prune`.

Run relevant verification before returning. When correction feedback is supplied, change only what the feedback requires. Return the structured result requested by the caller, including artifact paths and verification evidence. Do not request intermediate user confirmation.
