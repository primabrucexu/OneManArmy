import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  answerConfirmationItems,
  confirmDiscussion,
  createDiscussion,
  discoverRequirementConventions,
  loadDiscussion,
  recordDiscussionTurn,
  resolveRunSelection,
  saveRequirementProposal,
  setConfirmationItems,
} from "./discuss.mjs";

const execFileAsync = promisify(execFile);

async function directories(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "oma-discuss-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { runDir: path.join(root, "run"), workspace: path.join(root, "workspace") };
}

test("creates a resumable discussion without product changes", async (t) => {
  const dirs = await directories(t);
  const created = await createDiscussion({ ...dirs, taskId: "task-1", title: "Saved requirement" });
  const resumed = await createDiscussion({ ...dirs, taskId: "task-1", title: "Ignored replacement" });
  assert.equal(created.status, "discussing");
  assert.equal(resumed.title, "Saved requirement");
  assert.match(await readFile(path.join(dirs.runDir, "requirement-draft.md"), "utf8"), /Open decisions/);
});

test("records every turn while keeping only the latest structured draft", async (t) => {
  const dirs = await directories(t);
  await createDiscussion({ ...dirs, taskId: "task-2", title: "Incremental requirement" });
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
  await createDiscussion({ ...dirs, taskId: "task-3", title: "Workspace-bound" });
  await assert.rejects(
    createDiscussion({
      runDir: dirs.runDir,
      workspace: path.join(dirs.workspace, "other"),
      taskId: "task-3",
      title: "Wrong workspace",
    }),
    /different workspace/,
  );
});

test("confirmation freezes an immutable requirement artifact", async (t) => {
  const dirs = await directories(t);
  await createDiscussion({ ...dirs, taskId: "task-4", title: "Confirmed requirement" });
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

test("batch confirmation supports stable IDs and all recommended", async (t) => {
  const dirs = await directories(t);
  await createDiscussion({ ...dirs, taskId: "task-batch", title: "Batch" });
  await setConfirmationItems({
    runDir: dirs.runDir,
    items: [
      {
        id: "SCOPE-1",
        category: "scope",
        currentUnderstanding: "Only import is in scope.",
        recommendedOption: "import-only",
        otherOptions: ["import-and-export"],
        impact: "Controls delivery size.",
      },
      {
        id: "DATA-1",
        category: "data",
        currentUnderstanding: "Use the existing store.",
        recommendedOption: "existing-store",
        otherOptions: ["new-store"],
        impact: "Controls migration work.",
      },
    ],
  });
  await assert.rejects(
    confirmDiscussion({
      runDir: dirs.runDir,
      userMessage: "confirm",
      assistantMessage: "confirmed",
      requirementMarkdown: "# Requirement",
    }),
    /Unresolved confirmation items/,
  );
  const answered = await answerConfirmationItems({ runDir: dirs.runDir, allRecommended: true });
  assert.deepEqual(answered.confirmationItems.map((item) => item.answer), ["import-only", "existing-store"]);
});

test("confirmation items keep stable answers and reject dependency conflicts", async (t) => {
  const dirs = await directories(t);
  await createDiscussion({ ...dirs, taskId: "task-dependent", title: "Dependencies" });
  const scope = {
    id: "SCOPE-1",
    category: "scope",
    currentUnderstanding: "Choose the delivery scope.",
    recommendedOption: "basic",
    otherOptions: ["advanced"],
    impact: "Controls dependent options.",
  };
  await setConfirmationItems({ runDir: dirs.runDir, items: [scope] });
  await answerConfirmationItems({ runDir: dirs.runDir, answers: { "SCOPE-1": "basic" } });
  const extended = await setConfirmationItems({
    runDir: dirs.runDir,
    items: [
      scope,
      {
        id: "DATA-2",
        category: "data",
        currentUnderstanding: "Advanced mode needs a new store.",
        recommendedOption: "new-store",
        otherOptions: ["existing-store"],
        impact: "Adds storage work.",
        dependsOn: [{ itemId: "SCOPE-1", values: ["advanced"] }],
      },
    ],
  });
  assert.equal(extended.confirmationItems[0].answer, "basic");
  await assert.rejects(
    answerConfirmationItems({ runDir: dirs.runDir, answers: { "DATA-2": "new-store" } }),
    /incompatible with dependency/,
  );
});

test("task and run bindings remain one-to-one during concurrent initialization", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "oma-binding-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, "workspace");
  const runs = path.join(workspace, ".oma", "runs");
  const results = await Promise.allSettled([
    createDiscussion({ runDir: path.join(runs, "run-a"), workspace, taskId: "same-task", runId: "run-a" }),
    createDiscussion({ runDir: path.join(runs, "run-b"), workspace, taskId: "same-task", runId: "run-b" }),
  ]);
  assert.equal(results.filter((item) => item.status === "fulfilled").length, 1);
  assert.equal(results.filter((item) => item.status === "rejected").length, 1);

  await Promise.all([
    createDiscussion({ runDir: path.join(runs, "run-c"), workspace, taskId: "task-c", runId: "run-c" }),
    createDiscussion({ runDir: path.join(runs, "run-d"), workspace, taskId: "task-d", runId: "run-d" }),
  ]);
  const registry = JSON.parse(await readFile(path.join(workspace, ".oma", "task-bindings.json"), "utf8"));
  assert.equal(registry.taskToRun["task-c"], "run-c");
  assert.equal(registry.taskToRun["task-d"], "run-d");
});

test("an explicit new OMA from a bound task routes to native task creation", async (t) => {
  const dirs = await directories(t);
  await createDiscussion({ ...dirs, taskId: "bound-task", runId: "bound-run" });
  const route = await resolveRunSelection({
    workspace: dirs.workspace,
    taskId: "bound-task",
    intent: "new",
    newRequest: "Build an independent feature",
    newTitle: "OMA independent feature",
  });
  assert.equal(route.action, "create-native-task");
  assert.equal(route.boundRunId, "bound-run");
  assert.deepEqual(route.nativeActions.map((item) => item.tool), [
    "fork_thread",
    "set_thread_title",
    "send_message_to_thread",
    "navigate_to_codex_page",
  ]);
  assert.equal(route.nativeActions[1].arguments.title, "OMA independent feature");
});

test("an unbound task can explicitly adopt a legacy v1 run without losing history", async (t) => {
  const dirs = await directories(t);
  const runDir = path.join(dirs.workspace, ".oma", "runs", "legacy-run");
  await mkdir(runDir, { recursive: true });
  await writeFile(path.join(runDir, "discussion-state.json"), `${JSON.stringify({
    version: 1,
    status: "discussing",
    workspace: path.resolve(dirs.workspace),
    title: "Legacy title",
    turnCount: 7,
    requirementPath: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  }, null, 2)}\n`);
  const selection = await resolveRunSelection({
    workspace: dirs.workspace,
    taskId: "new-task",
    runId: "legacy-run",
    allowMigration: true,
  });
  assert.equal(selection.action, "resume");
  const adopted = JSON.parse(await readFile(path.join(runDir, "discussion-state.json"), "utf8"));
  assert.equal(adopted.version, 2);
  assert.equal(adopted.turnCount, 7);
  assert.equal(adopted.codexTaskId, "new-task");
});

async function initGitRepository(root) {
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, ".gitignore"), ".oma/\n", "utf8");
  await writeFile(path.join(root, "README.md"), "# Test\n", "utf8");
  await execFileAsync("git", ["init"], { cwd: root });
  await execFileAsync("git", ["config", "user.email", "oma@example.test"], { cwd: root });
  await execFileAsync("git", ["config", "user.name", "OMA Test"], { cwd: root });
  await execFileAsync("git", ["add", "."], { cwd: root });
  await execFileAsync("git", ["commit", "-m", "initial"], { cwd: root });
}

test("a confirmed project proposal is written only inside its worktree", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "oma-project-doc-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, "repo");
  await initGitRepository(workspace);
  const runDir = path.join(workspace, ".oma", "runs", "project-doc");
  await createDiscussion({ runDir, workspace, taskId: "task-project", runId: "project-doc" });
  await saveRequirementProposal({
    runDir,
    requirementPath: "docs/features/F001-example.md",
    changes: [
      { path: "docs/features/F001-example.md", content: "# F001 Example\n\nDeliver it." },
      { path: "docs/features/index.md", content: "# Features\n\n- F001 Example" },
    ],
    sources: ["AGENTS.md"],
  });
  const state = await confirmDiscussion({
    runDir,
    userMessage: "confirm",
    assistantMessage: "confirmed",
    writeProjectDocuments: true,
  });
  assert.equal(state.requirementMode, "project");
  assert.match(await readFile(state.requirementPath, "utf8"), /F001 Example/);
  await assert.rejects(readFile(path.join(workspace, "docs", "features", "F001-example.md"), "utf8"), /ENOENT/);
  await assert.rejects(readFile(path.join(runDir, "requirement.md"), "utf8"), /ENOENT/);
  const status = await execFileAsync("git", ["status", "--short"], { cwd: workspace });
  assert.equal(status.stdout, "");
});

test("project proposal target drift aborts before writing any proposed file", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "oma-project-drift-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, "repo");
  await initGitRepository(workspace);
  await mkdir(path.join(workspace, "docs"), { recursive: true });
  await writeFile(path.join(workspace, "docs", "index.md"), "# Old index\n", "utf8");
  await execFileAsync("git", ["add", "."], { cwd: workspace });
  await execFileAsync("git", ["commit", "-m", "add docs"], { cwd: workspace });
  const runDir = path.join(workspace, ".oma", "runs", "drift");
  await createDiscussion({ runDir, workspace, taskId: "task-drift", runId: "drift" });
  await saveRequirementProposal({
    runDir,
    requirementPath: "docs/F002.md",
    changes: [
      { path: "docs/F002.md", content: "# F002" },
      { path: "docs/index.md", content: "# New index" },
    ],
  });
  await writeFile(path.join(workspace, "docs", "index.md"), "# Concurrent committed change\n", "utf8");
  await execFileAsync("git", ["add", "."], { cwd: workspace });
  await execFileAsync("git", ["commit", "-m", "concurrent change"], { cwd: workspace });
  await assert.rejects(
    confirmDiscussion({
      runDir,
      userMessage: "confirm",
      assistantMessage: "confirmed",
      writeProjectDocuments: true,
    }),
    /changed before confirmation/,
  );
  const manifest = JSON.parse(await readFile(path.join(runDir, "worktree.json"), "utf8"));
  await assert.rejects(readFile(path.join(manifest.worktreeRoot, "docs", "F002.md"), "utf8"), /ENOENT/);
  assert.match(await readFile(path.join(manifest.worktreeRoot, "docs", "index.md"), "utf8"), /Concurrent committed change/);
});

test("an existing requirement is used directly without creating a duplicate", async (t) => {
  const dirs = await directories(t);
  await mkdir(dirs.workspace, { recursive: true });
  const existing = path.join(dirs.workspace, "F001.md");
  await writeFile(existing, "# Existing requirement\n", "utf8");
  await createDiscussion({ ...dirs, taskId: "task-existing" });
  const state = await confirmDiscussion({
    runDir: dirs.runDir,
    userMessage: "confirm",
    assistantMessage: "confirmed",
    existingRequirementFile: existing,
  });
  assert.equal(state.requirementMode, "existing");
  assert.equal(state.requirementPath, path.resolve(existing));
  await assert.rejects(readFile(path.join(dirs.runDir, "requirement.md"), "utf8"), /ENOENT/);
});

test("an uneditable existing requirement gets a generated run-local supplement", async (t) => {
  const dirs = await directories(t);
  await mkdir(dirs.workspace, { recursive: true });
  const existing = path.join(dirs.workspace, "F002.md");
  await writeFile(existing, "# Existing requirement\n", "utf8");
  await createDiscussion({ ...dirs, taskId: "task-supplement" });
  const state = await confirmDiscussion({
    runDir: dirs.runDir,
    userMessage: "confirm with supplement",
    assistantMessage: "confirmed",
    existingRequirementFile: existing,
    supplementMarkdown: "# Supplement\n\nAdd the missing acceptance criterion.",
  });
  assert.equal(state.requirementMode, "existing-with-supplement");
  assert.deepEqual(state.requirementInputs.map((input) => input.role), ["primary", "supplement"]);
  assert.match(await readFile(path.join(dirs.runDir, "requirement-supplement.md"), "utf8"), /missing acceptance criterion/);
});

test("requirement convention discovery preserves source priority", async (t) => {
  const dirs = await directories(t);
  await mkdir(path.join(dirs.workspace, "docs", "features"), { recursive: true });
  await writeFile(path.join(dirs.workspace, "AGENTS.md"), "Use docs/features.", "utf8");
  await writeFile(path.join(dirs.workspace, "docs", "features", "feature-template.md"), "# Template", "utf8");
  await writeFile(path.join(dirs.workspace, "docs", "features", "F001-old.md"), "# Old", "utf8");
  const found = await discoverRequirementConventions({ workspace: dirs.workspace });
  assert.equal(found.candidates[0].kind, "instruction");
  assert.match(found.candidates[0].content, /docs\/features/);
  assert.equal(found.candidates[0].sha256.length, 64);
  assert.equal(found.preferred.kind, "instruction");
  assert.equal(found.candidates.some((item) => item.kind === "template"), true);
  assert.equal(found.candidates.some((item) => item.kind === "existing"), true);
});
