import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  confirmDiscussion,
  createDiscussion,
  loadDiscussion,
  recordDiscussionTurn,
} from "./discuss.mjs";

async function directories(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "oma-discuss-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { runDir: path.join(root, "run"), workspace: path.join(root, "workspace") };
}

test("creates a resumable discussion without product changes", async (t) => {
  const dirs = await directories(t);
  const created = await createDiscussion({ ...dirs, title: "Saved requirement" });
  const resumed = await createDiscussion({ ...dirs, title: "Ignored replacement" });
  assert.equal(created.status, "discussing");
  assert.equal(resumed.title, "Saved requirement");
  assert.match(await readFile(path.join(dirs.runDir, "requirement-draft.md"), "utf8"), /Open decisions/);
});

test("records every turn while keeping only the latest structured draft", async (t) => {
  const dirs = await directories(t);
  await createDiscussion({ ...dirs, title: "Incremental requirement" });
  await recordDiscussionTurn({
    runDir: dirs.runDir,
    userMessage: "Start with a dashboard.",
    assistantMessage: "What should it show?",
    draftMarkdown: "# Requirement Draft\n\nGoal: dashboard",
  });
  await recordDiscussionTurn({
    runDir: dirs.runDir,
    userMessage: "Exclude alerts.",
    assistantMessage: "Alerts are excluded.",
    draftMarkdown: "# Requirement Draft\n\nGoal: dashboard\n\nExclusion: alerts",
  });
  const discussion = await loadDiscussion({ runDir: dirs.runDir });
  assert.equal(discussion.state.turnCount, 2);
  assert.equal(discussion.turns.length, 2);
  assert.match(discussion.draftMarkdown, /Exclusion: alerts/);
});

test("rejects resuming a run from a different workspace", async (t) => {
  const dirs = await directories(t);
  await createDiscussion({ ...dirs, title: "Workspace-bound" });
  await assert.rejects(
    createDiscussion({
      runDir: dirs.runDir,
      workspace: path.join(dirs.workspace, "other"),
      title: "Wrong workspace",
    }),
    /different workspace/,
  );
});

test("confirmation freezes an immutable requirement artifact", async (t) => {
  const dirs = await directories(t);
  await createDiscussion({ ...dirs, title: "Confirmed requirement" });
  const state = await confirmDiscussion({
    runDir: dirs.runDir,
    userMessage: "Confirm and start delivery.",
    assistantMessage: "The requirement is frozen.",
    requirementMarkdown: "# Confirmed Requirement\n\nBuild the agreed feature.",
  });
  assert.equal(state.status, "confirmed");
  assert.equal(state.requirementSha256.length, 64);
  assert.equal(
    await readFile(state.requirementPath, "utf8"),
    "# Confirmed Requirement\n\nBuild the agreed feature.\n",
  );
  await assert.rejects(
    recordDiscussionTurn({
      runDir: dirs.runDir,
      userMessage: "Change it.",
      assistantMessage: "No.",
      draftMarkdown: "changed",
    }),
    /cannot be changed/,
  );
});
