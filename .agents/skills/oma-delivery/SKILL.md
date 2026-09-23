---
name: oma-delivery
description: Orchestrate a software requirement from persistent interactive discussion through autonomous planning, review, implementation, and acceptance. Use as the single user entry point for starting, continuing, or resuming an OMA delivery.
---

# OMA Delivery

Act only as the workflow coordinator. Do not perform requirement discovery, planning, implementation, or review yourself.

Every OMA run is bound one-to-one to a native Codex task. Read the current task ID from `CODEX_THREAD_ID`; if it is absent, stop before creating or adopting a run. Use `node ../oma-discuss/scripts/discuss.mjs route` with that ID before choosing a run. A bound task resumes only its bound run. An unbound task may create a run, or explicitly adopt an active run by exact run ID or unique title. Never guess among candidates. A version 1 run may be adopted only through this explicit resume path.

When a user explicitly requests a new OMA from an already bound task, the route command returns a `nativeActions` list. Execute every action in order with the corresponding Codex app tool: `fork_thread` with the same-directory environment, `set_thread_title`, `send_message_to_thread`, then `navigate_to_codex_page`. Resolve `$child.threadId` from the fork result and require it to differ from the current `CODEX_THREAD_ID`. The child prompt contains the original new requirement and causes that child to create its own run. Do not create a second run in the bound parent task. If an action is unavailable or fails, leave the parent binding unchanged and report the failure; do not simulate independence with an App Server child thread.

If the selected discussion is not confirmed, read and follow `../oma-discuss/SKILL.md` in the current user-facing task. Never launch discussion in an App Server child thread.

After confirmation, pass the exact frozen input list to the Runner. Use one `--requirement-input role=<absolute-path>` argument per input. There must be exactly one `primary` or `generated` input and zero or more `supplement` inputs:

```text
node scripts/runner.mjs --run-dir <run-directory> --workspace <source-workspace> --requirement-input primary=<absolute-path>
```

The Runner freezes raw input bytes and hashes before creating or validating the run worktree. It then constructs the App Server adapter only for the recorded execution workspace. A resumed run must supply the same roles, paths, contents, and hashes.

The Runner defaults to a 30-minute limit per autonomous stage. A timed-out stage is interrupted and persisted as recoverable; resume it only with `--resume-failed true`. Do not bypass the Runner with an arbitrary prompt. Do not submit, merge, push, remove, or prune the run branch or worktree.

If Plan or Review returns `failed` because the frozen requirement, verified path, or current environment must change, stop the automatic run and preserve its evidence. Return to Discuss in a new native task and new run using the existing `route` action with `intent: "new"`; seed `newRequest` with the failed run ID, original objective, blocking evidence, and the decision to revisit. Execute its `nativeActions` as above. Do not alter the failed run's frozen input or silently try another technical path. A recoverable Runner infrastructure failure stays with the original run and follows the resume rule.

Report the final status, evidence, source workspace, execution workspace, worktree path, branch, and base commit.
