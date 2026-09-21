---
name: oma-discuss
description: Conduct and persist a multi-turn software requirement discussion as the foreground stage of an OMA delivery. Use when oma-delivery routes an unconfirmed requirement or resumes a saved discussion; do not plan or implement the requirement.
---

# OMA Discuss

Stay in the current user-facing Codex task. Do not start an App Server child thread for this stage because the user must be able to answer incrementally.

Use the run directory selected by `oma-delivery` under `<workspace>/.oma/runs/<requirement-id>`. From this skill directory, use `node scripts/discuss.mjs` to create, inspect, update, and confirm the discussion. If the run already exists, load it before responding; never reconstruct saved facts from chat memory alone.

During discussion:

- Listen for the user's objective before narrowing scope or proposing implementation.
- Distinguish confirmed facts, current proposals, open decisions, explicit exclusions, acceptance criteria, and the permission envelope.
- Keep `requirement-draft.md` as the current structured understanding. Rejected or superseded ideas stay only in `discussion.jsonl`.
- Before sending each reply, record the current user message, the reply, and the complete updated draft with `record`. Use a UTF-8 JSON input file containing `userMessage`, `assistantMessage`, and `draftMarkdown`.
- Ask only questions whose answers can materially change the requirement. Do not plan code or modify product files.

Treat confirmation as explicit only. When the user clearly confirms the requirement and no unresolved product choice prevents execution, call `confirm` with a UTF-8 JSON input file containing `userMessage`, `assistantMessage`, and `requirementMarkdown`. This freezes `requirement.md`; do not change it afterward. Return the confirmed requirement path and control to `oma-delivery` so it can start the autonomous stages.

Useful commands:

```text
node scripts/discuss.mjs init --run-dir <run-directory> --workspace <workspace> --title <title>
node scripts/discuss.mjs show --run-dir <run-directory>
node scripts/discuss.mjs record --run-dir <run-directory> --input-file <turn.json>
node scripts/discuss.mjs confirm --run-dir <run-directory> --input-file <confirmation.json>
```
