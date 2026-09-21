import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runWorkflow } from "./runner.mjs";

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
