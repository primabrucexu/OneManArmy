import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  AppServerAdapter,
  findNearestLocalCodex,
  runWorkflow,
} from "./runner.mjs";

const execFileAsync = promisify(execFile);

test("real App Server completes one isolated read-only planning stage", { timeout: 10 * 60 * 1000 }, async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "oma-live-runner-"));
  let adapter;
  try {
    await writeFile(path.join(workspace, ".gitignore"), ".oma/\n", "utf8");
    await writeFile(path.join(workspace, "README.md"), "# Live Runner Test\n", "utf8");
    const requirementFile = path.join(workspace, "requirement.md");
    await writeFile(
      requirementFile,
      "# Requirement\n\nAdd a short Notes section to README.md.\n\nAcceptance: the implementation plan names the file and a verification step.\n",
      "utf8",
    );
    await execFileAsync("git", ["init"], { cwd: workspace });
    await execFileAsync("git", ["config", "user.email", "oma@example.test"], { cwd: workspace });
    await execFileAsync("git", ["config", "user.name", "OMA Live Test"], { cwd: workspace });
    await execFileAsync("git", ["add", "."], { cwd: workspace });
    await execFileAsync("git", ["commit", "-m", "initial"], { cwd: workspace });

    const runDir = path.join(workspace, ".oma", "runs", "live-app-server");
    await mkdir(runDir, { recursive: true });
    const codexJs = findNearestLocalCodex(process.cwd());
    const state = await runWorkflow({
      runDir,
      workspace,
      requirementFile,
      maxStages: 1,
      adapterFactory: ({ workspace: executionWorkspace }) => {
        adapter = new AppServerAdapter({
          workspace: executionWorkspace,
          stageTimeoutMs: 8 * 60 * 1000,
          codexJs,
        });
        return adapter;
      },
    });

    assert.equal(state.status, "running");
    assert.equal(state.stage, "plan_review");
    assert.equal(state.trace.length, 1);
    assert.equal(state.trace[0].stage, "plan");
    assert.equal(typeof state.trace[0].threadId, "string");
    assert.equal(state.executionWorkspace, state.worktree.executionWorkspace);
  } finally {
    if (adapter) await adapter.close();
    await rm(workspace, { recursive: true, force: true });
  }
});
