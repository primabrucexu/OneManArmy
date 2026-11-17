---
name: oma-discuss
description: Conduct and persist a multi-turn software requirement discussion as the foreground stage of an OMA delivery. Use when oma-delivery routes an unconfirmed requirement or resumes a saved discussion; do not plan or implement the requirement.
---

# OMA Discuss

Stay in the current user-facing Codex task. Use `CODEX_THREAD_ID` as the required task ID and the run directory selected by `oma-delivery`. Load saved state before replying; never reconstruct it from chat memory alone.

During discussion:

- Listen for the objective before narrowing scope.
- Persist each user-assistant discussion exchange once, including the complete reply and current draft; tool calls are not additional discussion turns.
- Form an initial technical approach at the path level: affected systems or components, existing capabilities and permissions it depends on, key data or state flow, candidate paths, and each path's limiting conditions. Leave files, classes, functions, data structures, and implementation steps to `oma-plan`.
- Before final confirmation, verify blocking delivery conditions against the available project and environment evidence: required host or platform capabilities, permission/sandbox/Git boundaries, hard conflicts between requirements, and whether each candidate path can meet the goal. Do not freeze a blocking assumption that remains unverified; present it as a confirmation item. For each rejected path, record the reason and evidence, and identify the verified path selected for this delivery.
- After inspecting the objective, project, or supplied document, save and present every currently identifiable material confirmation item in one batch. Each item needs a stable ID, one of the supported categories (`scope`, `business`, `data`, `boundary`, `acceptance`, `permission`), current understanding, recommended option, alternatives, and impact. Record `dependsOn` or `conflictsWith` constraints when answers interact. Accept answers by ID or “all recommended”; the script rejects unresolved dependencies and conflicting answers. Add later items without renumbering or discarding earlier answers.
- Freeze a concise "Initial approach and feasibility constraints" section with the requirement. Include the verified implementation path, excluded paths with reasons and evidence, mandatory platform/permission/environment constraints, and key assumptions that still hold. This section is formal input for Plan and Review, not just chat history. If the user supplies an existing complete requirement document that already contains these conclusions, use it directly. Do not copy it or generate a duplicate `requirement.md`.
- Otherwise run `discover` and inspect the returned content, relative path, and hash for project instructions, templates, indexes, naming rules, and existing requirement documents. Apply the priority: explicit project instructions, then templates/indexes, then inferred convention. A missing convention selects the run-local fallback; multiple top-priority candidates or conflicting contents become confirmation items.
- Before confirmation, write only the run draft and logs. Save a proposal containing the repository-relative target path, complete document content, every required index edit, expected old hashes, and convention evidence. Show that exact proposal to the user.
- Before final confirmation, present the complete "本次交付清单" as numbered outcomes, each stating what will be delivered, the user-observable behavior or result, and its acceptance criteria. Include explicitly excluded scope and unresolved material items; continue discussion while such items remain unresolved. Save the displayed list in the current draft and discussion log, and ensure the formal requirement inputs cover every outcome. Concrete files, classes, functions, and implementation steps remain Plan's responsibility.
- Wait for explicit final confirmation of that displayed list before calling `confirm` or handing off to Plan. Answers by ID or "all recommended" resolve confirmation items; they count as final confirmation only when the reply also explicitly authorizes executing the displayed complete list. If the list changes before freezing, save and display the complete revised list and obtain final confirmation again. On resume, read the saved draft and log to establish which list was displayed and confirmed.
- Apply this final confirmation to existing requirement files as well: display their delivery outcomes before freezing, reference complete originals directly, and use the existing supplement mechanism for confirmed gaps.
- On explicit confirmation, write an authorized project-document proposal only after the run worktree exists and only inside that worktree. Drift in any target aborts all writes. The resulting worktree document is the `generated` Runner input.
- If no convention exists or project-document writing was not authorized, create the generic run-local `requirement.md`. If an existing document lacks the confirmed feasibility constraints or has other gaps, pass `supplementMarkdown` during confirmation; the script writes `requirement-supplement.md`, retains the existing file as `primary`, and freezes the new file as `supplement`.

## Focus reminders and decision highlights

Keep the current discussion focus in the saved draft: the core question, the scope and depth of this discussion, and the next decision. Distinguish it from the broader project goal. Update it as decisions progress; preserve user-directed changes and the disposition of the previous topic in the discussion log.

- Give a brief focus reminder when the objective first becomes clear, when resuming after an interruption, task handoff, or loss of context, before exploring a potentially separate direction, and before presenting the final delivery list. Routine `show`/`load` reads or a route result of `resume` during continuous discussion do not trigger a reminder by themselves. State the current goal, relevant conclusions, and next decision in two or three sentences. Combine simultaneous triggers into one reminder; continue normally when no user decision is needed.
- Read `focusReminder` from `show` before composing each reply. `focusReminder.due` means the upcoming discussion reply needs the periodic reminder, after five exchanges since the last recorded reminder. Repeated reads and other tool calls do not advance the count. A node-triggered reminder resets the same interval, so do not add a second periodic reminder in that reply.
- When recording the exchange, pass `focusReminderShown: true` only if the saved assistant reply actually contains the reminder; otherwise omit it or pass `false`. The script saves the reminder turn and log marker for later recovery. A due reminder remains due until one is recorded. The script calculates the interval; you assess topic relevance and write the reminder.
- When exploring B is necessary to decide A, explain that connection, investigate only what A requires, then return to A. If B becomes an independent goal, outcome, or added scope, flag that change before developing it; mentioning B alone does not add it to the delivery list. If the user clearly switches to B, update the focus and state whether A is deferred or ended without asking for the same authorization again. Ask only when the intended scope change is unclear.
- In discussion summaries, proposals, and final delivery lists, use selective bold text and stable identifiers to distinguish **已确认**, **待确认／建议**, and material **本轮变化** where applicable. Highlight scope, observable behavior, important tradeoffs, and acceptance criteria. Recommendations are not confirmed decisions; avoid bolding entire paragraphs or imposing an empty template on ordinary replies.
- Keep the complete delivery list, acceptance criteria, exclusions, and unresolved items available for final confirmation. Highlights are a reading aid, not a substitute for that list. Answers to individual highlighted questions do not authorize the whole delivery; follow the existing final confirmation rules.

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
