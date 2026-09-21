---
name: oma-delivery
description: Run a confirmed software requirement through a persistent autonomous plan, review, implementation, and acceptance loop. Use after the initial human discussion is complete; do not use to discover or change requirements.
---

# OMA Delivery

Treat the confirmed requirement and its permission envelope as immutable input.

From this skill directory, run `node scripts/runner.mjs --run-dir <state-directory> --workspace <target-workspace> --requirement "<confirmed requirement>"`. This is the production entry point; do not bypass it with a direct arbitrary-prompt Codex call. The runner owns stage transitions, persistence, retry limits, independent review threads, and terminal status.

After starting, do not ask the user to approve intermediate decisions. Work inside the confirmed permission envelope. If a required action falls outside it or retries are exhausted, record a failed terminal state with evidence instead of waiting for user input.

Report the final `state.json` status and evidence. Temporary validation data may be removed after its result has been recorded.
