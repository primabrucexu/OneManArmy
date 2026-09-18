import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";

import { CodexRunner, ProjectPathError } from "../src/server/codex-client.js";

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
