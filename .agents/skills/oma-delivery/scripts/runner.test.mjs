import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  AppServerAdapter,
  findNearestLocalCodex,
  loadRequirementInput,
  runWorkflow,
} from "./runner.mjs";

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
  return { runDir: path.join(root, "run"), workspace: path.join(root, "workspace") };
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
  assert.equal(input.requirement, "# Confirmed Requirement\n\nDeliver it.");
  assert.equal(input.requirementFile, path.resolve(requirementFile));
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
      state: { requirement: "r", workspace: "w", stage: "plan", planAttempt: 1 },
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
