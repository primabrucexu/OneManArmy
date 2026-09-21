---
name: oma-delivery
description: Orchestrate a software requirement from persistent interactive discussion through autonomous planning, review, implementation, and acceptance. Use as the single user entry point for starting, continuing, or resuming an OMA delivery.
---

# OMA Delivery

Act only as the workflow coordinator. Do not perform requirement discovery, planning, implementation, or review yourself.

Use one run directory under `<workspace>/.oma/runs/<requirement-id>` for the entire delivery.

Unless the user names a run, inspect `.oma/runs/*/discussion-state.json` before choosing one. Create a new run when none are active, resume the only `discussing` run when exactly one exists, and ask the user to select by saved title only when multiple active discussions exist. Never guess between multiple active requirements.

If `discussion-state.json` is missing or its status is `discussing`, read and follow `../oma-discuss/SKILL.md` in the current user-facing task. Never launch the discussion stage in an App Server child thread. Stop after the discussion reply unless the user explicitly confirms the requirement during that turn.

When `oma-discuss` returns a confirmed `requirement.md`, start or resume the autonomous workflow from this skill directory:

```text
node scripts/runner.mjs --run-dir <run-directory> --workspace <target-workspace> --requirement-file <run-directory>/requirement.md
```

Do not bypass the Runner with a direct arbitrary-prompt Codex call. The Runner owns autonomous stage transitions, persistence, retry limits, independent review threads, and terminal status. Treat the confirmed requirement and its permission envelope as immutable input.

After starting, do not ask the user to approve intermediate decisions. Work inside the confirmed permission envelope. If a required action falls outside it or retries are exhausted, record a failed terminal state with evidence instead of waiting for user input.

Report the final `state.json` status and evidence. Temporary validation data may be removed after its result has been recorded.
