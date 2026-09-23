import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  AppServerAdapter,
  findNearestLocalCodex,
  loadRequirementInput,
  runWorkflow,
} from "./runner.mjs";
import { ensureWorktree } from "./worktree.mjs";
import {
  confirmDiscussion,
  createDiscussion,
  discoverRequirementConventions,
  saveRequirementProposal,
} from "../../oma-discuss/scripts/discuss.mjs";

const execFileAsync = promisify(execFile);

class FakeAdapter {
  constructor(scenario = "happy") {
    this.scenario = scenario;
    this.sequence = 0;
  }

  async discover() {
    return ["oma-delivery", "oma-plan", "oma-code", "oma-review"];
  }

  async invoke({ stage, state }) {
    this.sequence += 1;
    const threadId = `scripted-${stage}-${this.sequence}`;
    if (this.scenario === "fail" && stage === "plan_review") {
      return {
        threadId,
        result: {
          status: "failed",
          summary: "Requirement is contradictory.",
          evidence: ["scripted terminal failure"],
        },
      };
    }
    if (this.scenario === "revise-once" && stage === "plan_review" && state.planAttempt === 1) {
      return {
        threadId,
        result: {
          status: "revise",
          summary: "Plan needs one correction.",
          feedback: "Add the missing acceptance check.",
          evidence: ["scripted review finding"],
        },
      };
    }
    return {
      threadId,
      result: {
        status: "completed",
        summary: `${stage} completed.`,
        evidence: [`scripted ${stage} evidence`],
      },
    };
  }
}

class ThrowingAdapter extends FakeAdapter {
  constructor() {
    super("happy");
    this.failed = false;
  }

  async invoke(args) {
    if (!this.failed) {
      this.failed = true;
      const error = new Error("Timed out waiting for turn/completed.");
      error.code = "OMA_STAGE_TIMEOUT";
      throw error;
    }
    return super.invoke(args);
  }
}

class StartupFailAdapter extends FakeAdapter {
  async start() {
    throw new Error("spawn EPERM");
  }
}

async function directories(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "oma-runner-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, "workspace");
  const executionWorkspace = path.join(root, "execution");
  await mkdir(executionWorkspace, { recursive: true });
  return {
    runDir: path.join(root, "run"),
    workspace,
    worktreeFactory: async () => ({
      runKey: "fake-key",
      branch: "oma/fake-key",
      baseCommit: "a".repeat(40),
      sourceWorkspace: workspace,
      sourceRepository: workspace,
      commonGitDir: path.join(workspace, ".git"),
      repoRelativeWorkspace: "",
      worktreeRoot: executionWorkspace,
      executionWorkspace,
      createdAt: "2026-01-01T00:00:00.000Z",
    }),
  };
}

test("happy path reaches succeeded with independent stage threads", async (t) => {
  const dirs = await directories(t);
  const state = await runWorkflow({
    ...dirs,
    requirement: "validate happy path",
    adapter: new FakeAdapter("happy"),
  });
  assert.equal(state.status, "succeeded");
  assert.equal(state.stage, "completed");
  assert.deepEqual(
    state.trace.map((item) => item.stage),
    ["plan", "plan_review", "code", "code_review"],
  );
  assert.equal(new Set(state.trace.map((item) => item.threadId)).size, 4);
});

test("review can return work for automatic revision", async (t) => {
  const dirs = await directories(t);
  const state = await runWorkflow({
    ...dirs,
    requirement: "validate revision",
    adapter: new FakeAdapter("revise-once"),
  });
  assert.equal(state.status, "succeeded");
  assert.deepEqual(
    state.trace.map((item) => item.stage),
    ["plan", "plan_review", "plan", "plan_review", "code", "code_review"],
  );
  assert.equal(state.planAttempt, 2);
});

test("review feedback survives producer revisions and a Runner resume", async (t) => {
  const dirs = await directories(t);
  const seen = [];
  const adapter = new FakeAdapter();
  adapter.invoke = async ({ stage, state }) => {
    seen.push({ stage, planFeedback: state.lastPlanReviewFeedback, codeFeedback: state.lastCodeReviewFeedback });
    const firstReview = (stage === "plan_review" && state.planAttempt === 1)
      || (stage === "code_review" && state.codeAttempt === 1);
    return {
      threadId: `thread-${seen.length}`,
      result: firstReview
        ? { status: "revise", summary: "Correction needed.", feedback: `${stage} blocking issue`, evidence: [] }
        : { status: "completed", summary: `${stage} completed.`, artifact: `${stage} artifact`, evidence: [] },
    };
  };
  const partial = await runWorkflow({ ...dirs, requirement: "review history", adapter, maxStages: 3 });
  assert.equal(partial.stage, "plan_review");
  assert.equal(partial.lastPlanReviewFeedback, "plan_review blocking issue");

  const finished = await runWorkflow({ ...dirs, requirement: "review history", adapter });
  assert.equal(finished.status, "succeeded");
  assert.equal(seen.filter((item) => item.stage === "plan_review")[1].planFeedback, "plan_review blocking issue");
  assert.equal(seen.filter((item) => item.stage === "code_review")[1].codeFeedback, "code_review blocking issue");
  assert.equal(finished.lastCodeReviewFeedback, "code_review blocking issue");
});

test("review prompts contain prior blocking feedback and the approved plan", async () => {
  const prompts = [];
  let sequence = 0;
  const client = {
    events: [],
    request: async (method, params) => {
      if (method === "thread/start") return { thread: { id: `thread-${++sequence}` } };
      if (method === "turn/start") {
        prompts.push(params.input[1].text);
        return { turn: { id: `turn-${sequence}` } };
      }
      throw new Error(`Unexpected request ${method}`);
    },
    waitFor: async () => ({ turn: { status: "completed", items: [{ type: "agentMessage", text: JSON.stringify({ status: "completed", summary: "ok", evidence: [], feedback: null, artifact: null }) }] } }),
  };
  const adapter = new AppServerAdapter({ workspace: "C:\\workspace", client });
  const state = {
    requirement: "frozen requirement", executionWorkspace: "C:\\workspace",
    plan: { artifact: "approved full plan", summary: "plan summary" },
    implementation: { summary: "implementation report" },
    lastPlanReviewFeedback: "plan blocker", lastCodeReviewFeedback: "code blocker",
  };
  for (const stage of ["plan_review", "code", "code_review"]) {
    await adapter.invoke({ stage, skill: "oma-review", skillPath: "skill", state: { ...state, stage } });
  }
  assert.match(prompts[0], /Previous plan review blocking feedback: plan blocker/);
  assert.match(prompts[1], /Implement this reviewed plan:\napproved full plan/);
  assert.match(prompts[2], /Approved plan:\napproved full plan/);
  assert.match(prompts[2], /Previous code review blocking feedback: code blocker/);
});

test("persisted state resumes without repeating a completed stage", async (t) => {
  const dirs = await directories(t);
  const requirement = "validate resume";
  const interrupted = await runWorkflow({
    ...dirs,
    requirement,
    adapter: new FakeAdapter("happy"),
    maxStages: 1,
  });
  assert.equal(interrupted.stage, "plan_review");
  assert.equal(interrupted.trace.length, 1);
  const resumed = await runWorkflow({
    ...dirs,
    requirement,
    adapter: new FakeAdapter("happy"),
  });
  assert.equal(resumed.status, "succeeded");
  assert.deepEqual(
    resumed.trace.map((item) => item.stage),
    ["plan", "plan_review", "code", "code_review"],
  );
  const stored = JSON.parse(
    await readFile(path.join(dirs.runDir, "state.json"), "utf8"),
  );
  assert.equal(stored.status, "succeeded");
});

test("unrecoverable review reaches failed without user input", async (t) => {
  const dirs = await directories(t);
  const state = await runWorkflow({
    ...dirs,
    requirement: "validate failure",
    adapter: new FakeAdapter("fail"),
  });
  assert.equal(state.status, "failed");
  assert.equal(state.stage, "failed");
  assert.equal(state.trace.at(-1).status, "failed");
  assert.match(state.feedback, /contradictory/i);
});

test("loads the frozen requirement artifact used by discussion handoff", async (t) => {
  const dirs = await directories(t);
  const requirementFile = path.join(dirs.runDir, "requirement.md");
  await mkdir(dirs.runDir, { recursive: true });
  await writeFile(requirementFile, "# Confirmed Requirement\n\nDeliver it.\n", "utf8");
  const input = await loadRequirementInput({ requirementFile });
  assert.match(input.requirement, /Deliver it/);
  assert.equal(input.inputs[0].path, path.resolve(requirementFile));
  await assert.rejects(
    loadRequirementInput({ requirement: "duplicate", requirementFile }),
    /exactly one/,
  );
});

test("infrastructure failure is persisted and can be explicitly resumed", async (t) => {
  const dirs = await directories(t);
  const requirement = "validate recoverable failure";
  const adapter = new ThrowingAdapter();
  await assert.rejects(
    runWorkflow({ ...dirs, requirement, adapter }),
    /turn\/completed/,
  );
  const stored = JSON.parse(await readFile(path.join(dirs.runDir, "state.json"), "utf8"));
  assert.equal(stored.status, "failed");
  assert.equal(stored.stage, "failed");
  assert.equal(stored.failure.kind, "stage_timeout");
  assert.equal(stored.failure.stage, "plan");
  assert.equal(stored.failure.recoverable, true);

  const unchanged = await runWorkflow({ ...dirs, requirement, adapter });
  assert.equal(unchanged.status, "failed");

  const resumed = await runWorkflow({
    ...dirs,
    requirement,
    adapter,
    resumeFailed: true,
  });
  assert.equal(resumed.status, "succeeded");
  assert.equal(resumed.trace.some((item) => item.status === "resumed"), true);
});

test("startup failure is persisted before stage execution", async (t) => {
  const dirs = await directories(t);
  await assert.rejects(
    runWorkflow({ ...dirs, requirement: "validate startup failure", adapter: new StartupFailAdapter() }),
    /spawn EPERM/,
  );
  const stored = JSON.parse(await readFile(path.join(dirs.runDir, "state.json"), "utf8"));
  assert.equal(stored.status, "failed");
  assert.equal(stored.failure.kind, "runtime_spawn_failed");
  assert.equal(stored.failure.stage, "plan");
});

test("legacy runner timeout can be explicitly resumed", async (t) => {
  const dirs = await directories(t);
  const requirement = "validate legacy timeout recovery";
  const adapter = new ThrowingAdapter();
  await assert.rejects(runWorkflow({ ...dirs, requirement, adapter }), /turn\/completed/);
  const statePath = path.join(dirs.runDir, "state.json");
  const stored = JSON.parse(await readFile(statePath, "utf8"));
  delete stored.failure;
  stored.trace.at(-1).reason = "runner_timeout";
  await writeFile(statePath, `${JSON.stringify(stored, null, 2)}\n`, "utf8");

  const resumed = await runWorkflow({
    ...dirs,
    requirement,
    adapter: new FakeAdapter("happy"),
    resumeFailed: true,
  });
  assert.equal(resumed.status, "succeeded");
  assert.equal(resumed.trace.some((item) => item.status === "resumed"), true);
});

test("timeout interrupts the exact App Server turn", async () => {
  const calls = [];
  const timeout = new Error("Timed out waiting for turn/completed.");
  timeout.code = "OMA_STAGE_TIMEOUT";
  const client = {
    events: [],
    request: async (method, params, timeoutMs) => {
      calls.push({ method, params, timeoutMs });
      if (method === "thread/start") return { thread: { id: "thread-1" } };
      if (method === "turn/start") return { turn: { id: "turn-1" } };
      if (method === "turn/interrupt") return {};
      throw new Error(`Unexpected request ${method}`);
    },
    waitFor: async (method, predicate, fromIndex, timeoutMs) => {
      calls.push({ method, predicate, fromIndex, timeoutMs });
      throw timeout;
    },
  };
  const adapter = new AppServerAdapter({
    workspace: "C:\\workspace",
    stageTimeoutMs: 1234,
    client,
  });
  await assert.rejects(
    adapter.invoke({
      stage: "plan",
      skill: "oma-plan",
      skillPath: "skill",
      state: { requirement: "r", executionWorkspace: "w", stage: "plan", planAttempt: 1 },
    }),
    /turn\/completed/,
  );
  assert.equal(calls.find((call) => call.method === "turn/completed").timeoutMs, 1234);
  assert.deepEqual(
    calls.find((call) => call.method === "turn/interrupt").params,
    { threadId: "thread-1", turnId: "turn-1" },
  );
});

test("local Codex discovery walks ancestors instead of assuming an install depth", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "oma-runtime-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const scriptDir = path.join(root, ".agents", "skills", "oma-delivery", "scripts");
  const codex = path.join(root, "node_modules", "@openai", "codex", "bin", "codex.js");
  await mkdir(path.dirname(codex), { recursive: true });
  await mkdir(scriptDir, { recursive: true });
  await writeFile(codex, "", "utf8");
  assert.equal(findNearestLocalCodex(scriptDir), codex);

  const installedRoot = await mkdtemp(path.join(os.tmpdir(), "oma-installed-runtime-test-"));
  t.after(() => rm(installedRoot, { recursive: true, force: true }));
  const installed = path.join(installedRoot, ".codex", "skills", "oma-delivery", "scripts");
  await mkdir(installed, { recursive: true });
  assert.equal(findNearestLocalCodex(installed), null);
});

async function initGitRepository(t, name = "repo") {
  const root = await mkdtemp(path.join(os.tmpdir(), `oma-worktree-${name}-`));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, ".gitignore"), ".oma/\n", "utf8");
  await writeFile(path.join(root, "shared.txt"), "base\n", "utf8");
  await execFileAsync("git", ["init"], { cwd: root });
  await execFileAsync("git", ["config", "user.email", "oma@example.test"], { cwd: root });
  await execFileAsync("git", ["config", "user.name", "OMA Test"], { cwd: root });
  await execFileAsync("git", ["add", "."], { cwd: root });
  await execFileAsync("git", ["commit", "-m", "initial"], { cwd: root });
  return root;
}

async function runConfirmedState({ runDir, workspace, discussionState }) {
  return runWorkflow({
    runDir,
    workspace,
    requirementInputs: discussionState.requirementInputs.map(({ role, path: inputPath }) => ({ role, path: inputPath })),
    adapter: new FakeAdapter(),
  });
}

test("existing requirement flows from discussion through Runner without duplication", async (t) => {
  const workspace = await initGitRepository(t, "existing-e2e");
  const requirementFile = path.join(workspace, "docs", "F001.md");
  await mkdir(path.dirname(requirementFile), { recursive: true });
  await writeFile(requirementFile, "# Existing requirement\n", "utf8");
  const runDir = path.join(workspace, ".oma", "runs", "existing-e2e");
  await createDiscussion({ runDir, workspace, taskId: "task-existing-e2e", runId: "existing-e2e" });
  const discussionState = await confirmDiscussion({
    runDir,
    userMessage: "confirm",
    assistantMessage: "confirmed",
    existingRequirementFile: requirementFile,
  });
  const state = await runConfirmedState({ runDir, workspace, discussionState });
  assert.equal(state.status, "succeeded");
  assert.equal(state.requirementInputs[0].path, path.resolve(requirementFile));
  await assert.rejects(readFile(path.join(runDir, "requirement.md"), "utf8"), /ENOENT/);
});

test("project-generated requirement flows through Runner using the same worktree", async (t) => {
  const workspace = await initGitRepository(t, "project-e2e");
  await writeFile(path.join(workspace, "AGENTS.md"), "Requirements live under docs/features and update docs/features/index.md.\n", "utf8");
  await execFileAsync("git", ["add", "."], { cwd: workspace });
  await execFileAsync("git", ["commit", "-m", "add project instructions"], { cwd: workspace });
  const runDir = path.join(workspace, ".oma", "runs", "project-e2e");
  await createDiscussion({ runDir, workspace, taskId: "task-project-e2e", runId: "project-e2e" });
  const conventions = await discoverRequirementConventions({ workspace });
  assert.match(conventions.preferred.content, /docs\/features/);
  await saveRequirementProposal({
    runDir,
    requirementPath: "docs/features/F002.md",
    changes: [
      { path: "docs/features/F002.md", content: "# F002\n\nDeliver it." },
      { path: "docs/features/index.md", content: "# Features\n\n- F002" },
    ],
    sources: [conventions.preferred.relativePath],
  });
  const discussionState = await confirmDiscussion({
    runDir,
    userMessage: "confirm",
    assistantMessage: "confirmed",
    writeProjectDocuments: true,
  });
  const state = await runConfirmedState({ runDir, workspace, discussionState });
  assert.equal(state.status, "succeeded");
  assert.equal(state.worktree.worktreeRoot, discussionState.worktree.worktreeRoot);
  assert.equal(state.requirementInputs[0].path, discussionState.requirementPath);
  await assert.rejects(readFile(path.join(runDir, "requirement.md"), "utf8"), /ENOENT/);
});

test("no-convention fallback flows through Runner from the run-local requirement", async (t) => {
  const workspace = await initGitRepository(t, "fallback-e2e");
  const runDir = path.join(workspace, ".oma", "runs", "fallback-e2e");
  await createDiscussion({ runDir, workspace, taskId: "task-fallback-e2e", runId: "fallback-e2e" });
  const conventions = await discoverRequirementConventions({ workspace });
  assert.equal(conventions.candidates.length, 0);
  const discussionState = await confirmDiscussion({
    runDir,
    userMessage: "confirm",
    assistantMessage: "confirmed",
    requirementMarkdown: "# Fallback requirement\n\nDeliver it.",
  });
  const state = await runConfirmedState({ runDir, workspace, discussionState });
  assert.equal(state.status, "succeeded");
  assert.equal(discussionState.requirementMode, "fallback");
  assert.equal(state.requirementInputs[0].path, path.join(runDir, "requirement.md"));
});

test("two runs receive isolated worktrees and one run reuses its binding", async (t) => {
  const workspace = await initGitRepository(t, "isolation");
  const runA = path.join(workspace, ".oma", "runs", "run-a");
  const runB = path.join(workspace, ".oma", "runs", "run-b");
  const [a, b] = await Promise.all([
    ensureWorktree({ runDir: runA, sourceWorkspace: workspace, runId: "run-a" }),
    ensureWorktree({ runDir: runB, sourceWorkspace: workspace, runId: "run-b" }),
  ]);
  assert.notEqual(a.worktreeRoot, b.worktreeRoot);
  assert.notEqual(a.branch, b.branch);
  await writeFile(path.join(a.executionWorkspace, "shared.txt"), "run-a\n", "utf8");
  assert.equal((await readFile(path.join(b.executionWorkspace, "shared.txt"), "utf8")).trim(), "base");
  assert.equal((await readFile(path.join(workspace, "shared.txt"), "utf8")).trim(), "base");
  await writeFile(path.join(workspace, "later.txt"), "later\n", "utf8");
  await execFileAsync("git", ["add", "."], { cwd: workspace });
  await execFileAsync("git", ["commit", "-m", "advance source"], { cwd: workspace });
  const resumed = await ensureWorktree({ runDir: runA, sourceWorkspace: workspace, runId: "run-a" });
  assert.equal(resumed.worktreeRoot, a.worktreeRoot);
  assert.equal(resumed.baseCommit, a.baseCommit);
});

test("worktree recovery adopts an exact add that was interrupted before manifest persistence", async (t) => {
  const workspace = await initGitRepository(t, "recovery");
  const runDir = path.join(workspace, ".oma", "runs", "recover");
  await assert.rejects(
    ensureWorktree({
      runDir,
      sourceWorkspace: workspace,
      runId: "recover",
      afterAdd: async () => { throw new Error("simulated interruption"); },
    }),
    /simulated interruption/,
  );
  const recovered = await ensureWorktree({ runDir, sourceWorkspace: workspace, runId: "recover" });
  assert.equal(recovered.recoveredAfterInterruption, true);
});

test("a leftover branch without its bound worktree fails instead of choosing another path", async (t) => {
  const workspace = await initGitRepository(t, "branch-conflict");
  const runDir = path.join(workspace, ".oma", "runs", "branch-conflict");
  const binding = await ensureWorktree({ runDir, sourceWorkspace: workspace, runId: "branch-conflict" });
  await execFileAsync("git", ["worktree", "remove", "--force", binding.worktreeRoot], { cwd: workspace });
  await unlink(path.join(runDir, "worktree.json"));
  await assert.rejects(
    ensureWorktree({ runDir, sourceWorkspace: workspace, runId: "branch-conflict" }),
    /branch already exists without a matching worktree/,
  );
});

test("same local run ID in different repository subdirectories gets different global keys", async (t) => {
  const workspace = await initGitRepository(t, "subdirs");
  await mkdir(path.join(workspace, "app-a"));
  await mkdir(path.join(workspace, "app-b"));
  const a = await ensureWorktree({
    runDir: path.join(workspace, ".oma", "runs", "sub-a"),
    sourceWorkspace: path.join(workspace, "app-a"),
    runId: "same-id",
  });
  const b = await ensureWorktree({
    runDir: path.join(workspace, ".oma", "runs", "sub-b"),
    sourceWorkspace: path.join(workspace, "app-b"),
    runId: "same-id",
  });
  assert.notEqual(a.runKey, b.runKey);
  assert.equal(a.executionWorkspace, path.join(a.worktreeRoot, "app-a"));
  assert.equal(b.executionWorkspace, path.join(b.worktreeRoot, "app-b"));
});

test("preflight failure happens before adapter construction", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "oma-preflight-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let constructions = 0;
  await assert.rejects(
    runWorkflow({
      runDir: path.join(root, "run"),
      workspace: path.join(root, "not-git"),
      requirement: "must not start an adapter",
      adapterFactory: () => { constructions += 1; return new FakeAdapter(); },
    }),
    /git rev-parse/,
  );
  assert.equal(constructions, 0);
  const state = JSON.parse(await readFile(path.join(root, "run", "state.json"), "utf8"));
  assert.equal(state.status, "failed");
});

test("invalid requirement input is persisted before adapter construction", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "oma-input-preflight-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let constructions = 0;
  const runDir = path.join(root, "run");
  await assert.rejects(
    runWorkflow({
      runDir,
      workspace: path.join(root, "workspace"),
      requirementFile: path.join(root, "missing.md"),
      adapterFactory: () => { constructions += 1; return new FakeAdapter(); },
    }),
    /ENOENT/,
  );
  assert.equal(constructions, 0);
  const state = JSON.parse(await readFile(path.join(runDir, "state.json"), "utf8"));
  assert.equal(state.failure.kind, "invalid_requirement_input");
  assert.equal(state.failure.recoverable, false);
});

test("adapter factory receives only the execution workspace", async (t) => {
  const dirs = await directories(t);
  let received;
  const state = await runWorkflow({
    ...dirs,
    requirement: "use isolated execution",
    adapter: null,
    adapterFactory: ({ workspace }) => {
      received = workspace;
      return new FakeAdapter();
    },
  });
  assert.equal(received, state.executionWorkspace);
  assert.notEqual(received, path.resolve(dirs.workspace));
});

test("requirement input roles preserve bytes and detect drift before resume", async (t) => {
  const dirs = await directories(t);
  const primary = path.join(dirs.runDir, "feature.md");
  const supplement = path.join(dirs.runDir, "supplement.md");
  await mkdir(dirs.runDir, { recursive: true });
  await writeFile(primary, "# Feature\n\nKeep trailing spaces.  \n", "utf8");
  await writeFile(supplement, "# Supplement\n", "utf8");
  const inputs = [
    { role: "primary", path: path.resolve(primary) },
    { role: "supplement", path: path.resolve(supplement) },
  ];
  const first = await runWorkflow({
    ...dirs,
    requirementInputs: inputs,
    adapter: new FakeAdapter(),
    maxStages: 1,
  });
  assert.equal(first.requirementInputs[0].content.endsWith("  \n"), true);
  await writeFile(primary, "# Feature changed\n", "utf8");
  await assert.rejects(
    runWorkflow({ ...dirs, requirementInputs: inputs, adapter: new FakeAdapter() }),
    /changed after the run was frozen/,
  );
});

test("a real legacy version 1 runner state is safely upgraded", async (t) => {
  const dirs = await directories(t);
  await mkdir(dirs.runDir, { recursive: true });
  const legacy = {
    version: 1,
    status: "running",
    stage: "plan",
    requirement: "legacy requirement",
    requirementFile: null,
    workspace: path.resolve(dirs.workspace),
    planAttempt: 1,
    codeAttempt: 1,
    plan: null,
    implementation: null,
    feedback: null,
    evidence: [],
    trace: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  await writeFile(path.join(dirs.runDir, "state.json"), `${JSON.stringify(legacy, null, 2)}\n`, "utf8");
  const upgraded = await runWorkflow({ ...dirs, requirement: "legacy requirement", adapter: new FakeAdapter(), maxStages: 1 });
  assert.equal(upgraded.version, 2);
  assert.equal(upgraded.sourceWorkspace, path.resolve(dirs.workspace));
  assert.equal(upgraded.trace.length, 1);
});
