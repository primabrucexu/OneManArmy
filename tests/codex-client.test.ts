import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";

import {
  CodexRunner,
  parseRequirementDiscussionOutput,
  ProjectPathError,
  requirementThreadOptions,
} from "../src/server/codex-client.js";

test("applies the frozen Agent profile to both new and resumed requirement threads", () => {
  assert.deepEqual(
    requirementThreadOptions("C:\\project", {
      model: "gpt-5.6-terra",
      reasoningEffort: "medium",
    }),
    {
      workingDirectory: "C:\\project",
      sandboxMode: "read-only",
      model: "gpt-5.6-terra",
      modelReasoningEffort: "medium",
    },
  );
  assert.deepEqual(requirementThreadOptions("C:\\legacy"), {
    workingDirectory: "C:\\legacy",
    sandboxMode: "read-only",
  });
});

test("parses a structured requirement discussion response", () => {
  const result = parseRequirementDiscussionOutput(JSON.stringify({
    reply: "请确认范围。",
    document: {
      title: "F001 需求讨论",
      goal: "确认目标",
      scope: ["多轮讨论"],
      non_goals: ["编码"],
      behaviors: ["更新草稿"],
      acceptance_criteria: ["讨论可续接"],
    },
    pending_decisions: ["是否需要附件？"],
  }));

  assert.deepEqual(result, {
    reply: "请确认范围。",
    document: {
      title: "F001 需求讨论",
      goal: "确认目标",
      scope: ["多轮讨论"],
      nonGoals: ["编码"],
      behaviors: ["更新草稿"],
      acceptanceCriteria: ["讨论可续接"],
    },
    pendingDecisions: ["是否需要附件？"],
  });
});

test("rejects an invalid requirement discussion response", () => {
  assert.throws(
    () => parseRequirementDiscussionOutput("not json"),
    /无法解析/,
  );
});

test("rejects a missing project directory", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "one-man-army-"));
  const missing = path.join(parent, "missing");

  try {
    await assert.rejects(
      new CodexRunner().run(missing, "Inspect the project", "read_only"),
      (error: unknown) =>
        error instanceof ProjectPathError && /不存在/.test(error.message),
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("rejects a file used as the project path", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "one-man-army-"));
  const filePath = path.join(parent, "not-a-directory.txt");
  await writeFile(filePath, "demo", "utf8");

  try {
    await assert.rejects(
      new CodexRunner().run(filePath, "Inspect the project", "read_only"),
      (error: unknown) =>
        error instanceof ProjectPathError && /目录/.test(error.message),
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
