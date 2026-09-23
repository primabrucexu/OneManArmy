---
name: oma-discuss
description: Conduct and persist a multi-turn software requirement discussion as the foreground stage of an OMA delivery. Use when oma-delivery routes an unconfirmed requirement or resumes a saved discussion; do not plan or implement the requirement.
---

# OMA Discuss

Stay in the current user-facing Codex task. Use `CODEX_THREAD_ID` as the required task ID and the run directory selected by `oma-delivery`. Load saved state before replying; never reconstruct it from chat memory alone.

During discussion:

- Listen for the objective before narrowing scope.
- Persist every user turn, reply, and complete current draft.
- After inspecting the objective, project, or supplied document, save and present every currently identifiable material confirmation item in one batch. Each item needs a stable ID, one of the supported categories (`scope`, `business`, `data`, `boundary`, `acceptance`, `permission`), current understanding, recommended option, alternatives, and impact. Record `dependsOn` or `conflictsWith` constraints when answers interact. Accept answers by ID or “all recommended”; the script rejects unresolved dependencies and conflicting answers. Add later items without renumbering or discarding earlier answers.
- If the user supplies an existing complete requirement document, use it directly. Do not copy it or generate a duplicate `requirement.md`.
- Otherwise run `discover` and inspect the returned content, relative path, and hash for project instructions, templates, indexes, naming rules, and existing requirement documents. Apply the priority: explicit project instructions, then templates/indexes, then inferred convention. A missing convention selects the run-local fallback; multiple top-priority candidates or conflicting contents become confirmation items.
- Before confirmation, write only the run draft and logs. Save a proposal containing the repository-relative target path, complete document content, every required index edit, expected old hashes, and convention evidence. Show that exact proposal to the user.
- On explicit confirmation, write an authorized project-document proposal only after the run worktree exists and only inside that worktree. Drift in any target aborts all writes. The resulting worktree document is the `generated` Runner input.
- If no convention exists or project-document writing was not authorized, create the generic run-local `requirement.md`. If an existing document has gaps but cannot be edited, pass `supplementMarkdown` during confirmation; the script writes `requirement-supplement.md`, retains the existing file as `primary`, and freezes the new file as `supplement`.

Useful commands:

```text
node scripts/discuss.mjs init --run-dir <run> --workspace <workspace> --task-id <CODEX_THREAD_ID> --run-id <run-id> --title <title>
node scripts/discuss.mjs show --run-dir <run>
node scripts/discuss.mjs record --run-dir <run> --input-file <turn.json>
node scripts/discuss.mjs questions --run-dir <run> --input-file <questions.json>
node scripts/discuss.mjs answer --run-dir <run> --input-file <answers.json>
node scripts/discuss.mjs discover --workspace <workspace>
node scripts/discuss.mjs propose --run-dir <run> --input-file <proposal.json>
node scripts/discuss.mjs confirm --run-dir <run> --input-file <confirmation.json>
```

After confirmation, return the recorded requirement input roles, absolute paths, hashes, and worktree binding to `oma-delivery`.
