import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, test } from "node:test";

import { createApp, type Runner } from "../src/server/app.js";
import type { CodexRunResult, SandboxName } from "../src/server/codex-client.js";

class FakeRunner implements Runner {
  readonly calls: Array<[string, string, SandboxName]> = [];

  async run(
    projectPath: string,
    prompt: string,
    sandboxName: SandboxName,
  ): Promise<CodexRunResult> {
    this.calls.push([projectPath, prompt, sandboxName]);
    return { threadId: "thread-demo", response: "Demo response" };
  }
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

test("serves the page and default project configuration", async () => {
  const directory = await temporaryDirectory();
  await withApp(new FakeRunner(), directory, async (baseUrl) => {
    const page = await fetch(`${baseUrl}/`);
    const config = await fetch(`${baseUrl}/api/config`);

    assert.equal(page.status, 200);
    assert.match(await page.text(), /OneManArmy/);
    assert.deepEqual(await config.json(), {
      default_project_path: path.resolve(directory),
    });
  });
});

test("passes a run request to the configured runner", async () => {
  const directory = await temporaryDirectory();
  const runner = new FakeRunner();

  await withApp(runner, directory, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project_path: directory,
        prompt: "Inspect this project",
        sandbox: "read_only",
      }),
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      thread_id: "thread-demo",
      response: "Demo response",
    });
    assert.deepEqual(runner.calls, [[directory, "Inspect this project", "read_only"]]);
  });
});

test("rejects a blank prompt", async () => {
  const directory = await temporaryDirectory();

  await withApp(new FakeRunner(), directory, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project_path: directory,
        prompt: "   ",
        sandbox: "read_only",
      }),
    });

    assert.equal(response.status, 422);
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "one-man-army-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function withApp(
  runner: Runner,
  defaultProjectPath: string,
  callback: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const app = createApp({
    runner,
    defaultProjectPath,
    staticDirectory: path.resolve("src/static"),
  });
  await new Promise<void>((resolve, reject) => {
    app.once("error", reject);
    app.listen(0, "127.0.0.1", resolve);
  });

  const address = app.address() as AddressInfo;
  try {
    await callback(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      app.close((error) => (error === undefined ? resolve() : reject(error)));
    });
  }
}
