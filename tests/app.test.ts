import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, test } from "node:test";

import { createApp, type Runner } from "../src/server/app.js";
import type { AgentProfile } from "../src/server/agent-configuration.js";
import type {
  CodexRunResult,
  RequirementDiscussionResult,
  SandboxName,
} from "../src/server/codex-client.js";
import type {
  CodexModelOption,
  ModelCatalogProvider,
} from "../src/server/codex-model-catalog.js";

const AVAILABLE_MODELS: CodexModelOption[] = [
  {
    model: "gpt-5.6-terra",
    displayName: "GPT-5.6 Terra",
    defaultReasoningEffort: "medium",
    supportedReasoningEfforts: [
      { reasoningEffort: "low", description: "" },
      { reasoningEffort: "medium", description: "" },
      { reasoningEffort: "high", description: "" },
    ],
  },
  {
    model: "gpt-5.6-sol",
    displayName: "GPT-5.6 Sol",
    defaultReasoningEffort: "high",
    supportedReasoningEfforts: [{ reasoningEffort: "high", description: "" }],
  },
  {
    model: "gpt-6-astra",
    displayName: "GPT-6 Astra",
    defaultReasoningEffort: "high",
    supportedReasoningEfforts: [{ reasoningEffort: "high", description: "" }],
  },
];

class FakeModelCatalog implements ModelCatalogProvider {
  async listModels(): Promise<CodexModelOption[]> {
    return structuredClone(AVAILABLE_MODELS);
  }
}

class FakeRunner implements Runner {
  readonly calls: Array<[string, string, SandboxName]> = [];
  readonly discussionCalls: Array<[
    string,
    string,
    string | undefined,
    AgentProfile | undefined,
  ]> = [];

  async run(
    projectPath: string,
    prompt: string,
    sandboxName: SandboxName,
  ): Promise<CodexRunResult> {
    this.calls.push([projectPath, prompt, sandboxName]);
    return { threadId: "thread-demo", response: "Demo response" };
  }

  async discussRequirements(
    projectPath: string,
    message: string,
    threadId?: string,
    agentProfile?: AgentProfile,
  ): Promise<RequirementDiscussionResult> {
    this.discussionCalls.push([projectPath, message, threadId, agentProfile]);
    return {
      threadId: threadId ?? "discussion-demo",
      reply: "请继续说明验收标准。",
      document: {
        title: "F001 示例需求",
        goal: "确认需求",
        scope: ["需求讨论"],
        nonGoals: ["编码"],
        behaviors: ["持续更新文档"],
        acceptanceCriteria: ["可以续接讨论"],
      },
      pendingDecisions: ["是否需要历史版本？"],
    };
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
    const pageHtml = await page.text();
    assert.match(pageHtml, /OneManArmy/);
    assert.match(pageHtml, /id="workbench-view"/);
    assert.match(pageHtml, /id="requirement-view"/);
    assert.match(pageHtml, /id="settings-view"/);
    const configPayload = await config.json() as Record<string, unknown>;
    assert.equal(configPayload.default_project_path, path.resolve(directory));
    assert.equal(configPayload.project_name, path.basename(directory));
    assert.equal(typeof configPayload.conversation_data_directory, "string");
  });
});

test("lists current Codex models and saves a valid project Agent configuration", async () => {
  const directory = await temporaryDirectory();
  await withApp(new FakeRunner(), directory, async (baseUrl) => {
    const modelsResponse = await fetch(`${baseUrl}/api/codex/models`);
    assert.equal(modelsResponse.status, 200);
    const models = await modelsResponse.json() as { models: Array<{ model: string }> };
    assert.deepEqual(models.models.map((model) => model.model), [
      "gpt-5.6-terra",
      "gpt-5.6-sol",
      "gpt-6-astra",
    ]);

    const getResponse = await fetch(
      `${baseUrl}/api/agent-config?project_path=${encodeURIComponent(directory)}`,
    );
    const initial = await getResponse.json() as {
      configuration: { version: number; agents: Record<string, { model: string }> };
    };
    assert.equal(initial.configuration.version, 1);
    assert.equal(initial.configuration.agents.requirements?.model, "gpt-5.6-terra");

    const saveResponse = await fetch(`${baseUrl}/api/agent-config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project_path: directory,
        agents: agentConfigurationPayload("low"),
      }),
    });
    assert.equal(saveResponse.status, 200);
    const saved = await saveResponse.json() as {
      configuration: { version: number; agents: Record<string, { reasoning_effort: string }> };
    };
    assert.equal(saved.configuration.version, 2);
    assert.equal(saved.configuration.agents.requirements?.reasoning_effort, "low");
  });
});

test("rejects model and reasoning combinations absent from the live catalog", async () => {
  const directory = await temporaryDirectory();
  await withApp(new FakeRunner(), directory, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/agent-config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project_path: directory,
        agents: agentConfigurationPayload("ultra"),
      }),
    });
    assert.equal(response.status, 422);
    assert.match((await response.json() as { detail: string }).detail, /不支持/);
  });
});

test("freezes Agent configuration for a discussion while later changes affect new discussions", async () => {
  const directory = await temporaryDirectory();
  const runner = new FakeRunner();
  await withApp(runner, directory, async (baseUrl) => {
    await saveAgentConfiguration(baseUrl, directory, "low");
    const firstResponse = await postDiscussion(baseUrl, directory, "第一项需求");
    const first = await firstResponse.json() as {
      conversation: { id: string; agent_config_snapshot: { agents: Record<string, { reasoning_effort: string }> } };
    };
    assert.equal(first.conversation.agent_config_snapshot.agents.requirements?.reasoning_effort, "low");

    await saveAgentConfiguration(baseUrl, directory, "high");
    await postDiscussion(baseUrl, directory, "继续原需求", first.conversation.id);
    await postDiscussion(baseUrl, directory, "第二项需求");

    assert.equal(runner.discussionCalls[0]?.[3]?.reasoningEffort, "low");
    assert.equal(runner.discussionCalls[1]?.[3]?.reasoningEffort, "low");
    assert.equal(runner.discussionCalls[2]?.[3]?.reasoningEffort, "high");
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

test("persists a requirement discussion and returns the complete conversation", async () => {
  const directory = await temporaryDirectory();
  const runner = new FakeRunner();

  await withApp(runner, directory, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/discussions/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project_path: directory,
        message: "我想讨论新的结果页面",
      }),
    });

    assert.equal(response.status, 200);
    const payload = await response.json() as { conversation: Record<string, unknown> };
    assert.equal(payload.conversation.title, "我想讨论新的结果页面");
    assert.equal(payload.conversation.thread_id, "discussion-demo");
    assert.equal(payload.conversation.document_version, 1);
    assert.equal(payload.conversation.request_status, "idle");
    assert.deepEqual(payload.conversation.pending_decisions, ["是否需要历史版本？"]);
    assert.equal((payload.conversation.messages as unknown[]).length, 3);
    assert.deepEqual(runner.discussionCalls, [
      [directory, "我想讨论新的结果页面", undefined, {
        model: "gpt-5.6-terra",
        reasoningEffort: "medium",
      }],
    ]);
  });
});

test("continues a persisted discussion using its server-owned thread id", async () => {
  const directory = await temporaryDirectory();
  const runner = new FakeRunner();

  await withApp(runner, directory, async (baseUrl) => {
    const firstResponse = await fetch(`${baseUrl}/api/discussions/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project_path: directory,
        message: "先讨论结果页面",
      }),
    });
    const first = await firstResponse.json() as { conversation: { id: string } };

    const response = await fetch(`${baseUrl}/api/discussions/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project_path: directory,
        message: "还需要支持筛选",
        conversation_id: first.conversation.id,
      }),
    });

    assert.equal(response.status, 200);
    assert.deepEqual(runner.discussionCalls, [
      [directory, "先讨论结果页面", undefined, {
        model: "gpt-5.6-terra",
        reasoningEffort: "medium",
      }],
      [directory, "还需要支持筛选", "discussion-demo", {
        model: "gpt-5.6-terra",
        reasoningEffort: "medium",
      }],
    ]);

    const listResponse = await fetch(
      `${baseUrl}/api/discussions?project_path=${encodeURIComponent(directory)}`,
    );
    const list = await listResponse.json() as {
      active_conversation_id: string;
      conversations: Array<{ id: string; status: string }>;
    };
    assert.equal(list.active_conversation_id, first.conversation.id);
    assert.equal(list.conversations.length, 1);
    assert.equal(list.conversations[0]?.id, first.conversation.id);
    assert.equal(list.conversations[0]?.status, "pending_decision");
  });
});

test("restores and updates persisted conversation UI state", async () => {
  const directory = await temporaryDirectory();
  const runner = new FakeRunner();

  await withApp(runner, directory, async (baseUrl) => {
    const createdResponse = await fetch(`${baseUrl}/api/discussions/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project_path: directory, message: "持久化讨论" }),
    });
    const created = await createdResponse.json() as { conversation: { id: string } };
    const id = created.conversation.id;

    const patchResponse = await fetch(
      `${baseUrl}/api/discussions/${id}?project_path=${encodeURIComponent(directory)}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input_draft: "尚未发送", scroll_top: 128, active: true }),
      },
    );
    assert.equal(patchResponse.status, 200);

    const detailResponse = await fetch(
      `${baseUrl}/api/discussions/${id}?project_path=${encodeURIComponent(directory)}`,
    );
    const detail = await detailResponse.json() as {
      conversation: { input_draft: string; scroll_top: number };
    };
    assert.equal(detail.conversation.input_draft, "尚未发送");
    assert.equal(detail.conversation.scroll_top, 128);
  });
});

test("rejects a blank discussion message", async () => {
  const directory = await temporaryDirectory();

  await withApp(new FakeRunner(), directory, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/discussions/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project_path: directory,
        message: "   ",
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

function agentConfigurationPayload(requirementsEffort: "low" | "high" | "ultra") {
  return {
    requirements: { model: "gpt-5.6-terra", reasoning_effort: requirementsEffort },
    planning: { model: "gpt-6-astra", reasoning_effort: "high" },
    coding: { model: "gpt-5.6-sol", reasoning_effort: "high" },
    review: { model: "gpt-6-astra", reasoning_effort: "high" },
  };
}

function saveAgentConfiguration(
  baseUrl: string,
  projectPath: string,
  requirementsEffort: "low" | "high",
): Promise<Response> {
  return fetch(`${baseUrl}/api/agent-config`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      project_path: projectPath,
      agents: agentConfigurationPayload(requirementsEffort),
    }),
  });
}

function postDiscussion(
  baseUrl: string,
  projectPath: string,
  message: string,
  conversationId?: string,
): Promise<Response> {
  return fetch(`${baseUrl}/api/discussions/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      project_path: projectPath,
      message,
      ...(conversationId === undefined ? {} : { conversation_id: conversationId }),
    }),
  });
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
    dataDirectory: path.join(await temporaryDirectory(), "data"),
    modelCatalog: new FakeModelCatalog(),
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
