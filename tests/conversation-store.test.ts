import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import {
  ConversationBusyError,
  ConversationStorageError,
  ConversationStore,
} from "../src/server/conversation-store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

test("persists conversations across store instances", async () => {
  const project = await temporaryDirectory("oma-project-");
  const dataDirectory = await temporaryDirectory("oma-data-");
  const firstStore = new ConversationStore(dataDirectory);

  const pending = await firstStore.beginMessage(project, "这是第一条需求消息");
  await firstStore.completeMessage(project, pending.id, {
    threadId: "thread-1",
    reply: "已记录。",
    document: {
      title: "F001 示例",
      goal: "持久化",
      scope: ["历史对话"],
      nonGoals: ["云同步"],
      behaviors: ["重启恢复"],
      acceptanceCriteria: ["数据仍存在"],
    },
    pendingDecisions: [],
  });
  await firstStore.updateUiState(project, pending.id, {
    inputDraft: "未发送草稿",
    scrollTop: 64,
    active: true,
  });

  const secondStore = new ConversationStore(dataDirectory);
  const restored = await secondStore.get(project, pending.id);
  assert.equal(restored.threadId, "thread-1");
  assert.equal(restored.inputDraft, "未发送草稿");
  assert.equal(restored.scrollTop, 64);
  assert.equal(restored.messages.length, 3);
});

test("marks only requests left running by a previous process as interrupted", async () => {
  const project = await temporaryDirectory("oma-project-");
  const dataDirectory = await temporaryDirectory("oma-data-");
  const firstStore = new ConversationStore(dataDirectory);
  const pending = await firstStore.beginMessage(project, "中断的请求");

  const restartedStore = new ConversationStore(dataDirectory);
  const restored = await restartedStore.get(project, pending.id);
  assert.equal(restored.requestStatus, "interrupted");
  assert.match(restored.messages.at(-1)?.content ?? "", /上一次请求未完成/);
});

test("keeps conversations isolated by project", async () => {
  const firstProject = await temporaryDirectory("oma-project-a-");
  const secondProject = await temporaryDirectory("oma-project-b-");
  const dataDirectory = await temporaryDirectory("oma-data-");
  const store = new ConversationStore(dataDirectory);

  await store.beginMessage(firstProject, "项目 A");
  assert.equal((await store.list(firstProject)).conversations.length, 1);
  assert.equal((await store.list(secondProject)).conversations.length, 0);
});

test("keeps Agent configurations isolated by project and does not version unchanged saves", async () => {
  const firstProject = await temporaryDirectory("oma-project-a-");
  const secondProject = await temporaryDirectory("oma-project-b-");
  const dataDirectory = await temporaryDirectory("oma-data-");
  const store = new ConversationStore(dataDirectory);
  const first = await store.getAgentConfiguration(firstProject);
  const agents = structuredClone(first.agents);
  agents.requirements.reasoningEffort = "low";

  const changed = await store.saveAgentConfiguration(firstProject, agents);
  const unchanged = await store.saveAgentConfiguration(firstProject, agents);
  const second = await store.getAgentConfiguration(secondProject);

  assert.equal(changed.version, 2);
  assert.equal(unchanged.version, 2);
  assert.equal(second.version, 1);
  assert.equal(second.agents.requirements.reasoningEffort, "medium");
});

test("rejects concurrent writes to the same conversation", async () => {
  const project = await temporaryDirectory("oma-project-");
  const dataDirectory = await temporaryDirectory("oma-data-");
  const store = new ConversationStore(dataDirectory);
  const pending = await store.beginMessage(project, "第一条消息");

  await assert.rejects(
    store.beginMessage(project, "并发消息", pending.id),
    ConversationBusyError,
  );
});

test("reports corrupt persisted data without overwriting it", async () => {
  const project = await temporaryDirectory("oma-project-");
  const dataDirectory = await temporaryDirectory("oma-data-");
  const firstStore = new ConversationStore(dataDirectory);
  await firstStore.beginMessage(project, "创建存储文件");
  const projectDirectories = await readdir(path.join(dataDirectory, "projects"));
  const statePath = path.join(dataDirectory, "projects", projectDirectories[0]!, "state.json");
  await writeFile(statePath, "{invalid json", "utf8");

  const restartedStore = new ConversationStore(dataDirectory);
  await assert.rejects(restartedStore.list(project), ConversationStorageError);
  assert.equal(await readFile(statePath, "utf8"), "{invalid json");
});

test("migrates schema v1 conversations without inventing an Agent snapshot", async () => {
  const project = await temporaryDirectory("oma-project-");
  const dataDirectory = await temporaryDirectory("oma-data-");
  const firstStore = new ConversationStore(dataDirectory);
  const pending = await firstStore.beginMessage(project, "旧需求");
  const projectDirectories = await readdir(path.join(dataDirectory, "projects"));
  const statePath = path.join(dataDirectory, "projects", projectDirectories[0]!, "state.json");
  const stored = JSON.parse(await readFile(statePath, "utf8")) as {
    schemaVersion: number;
    agentConfiguration?: unknown;
    conversations: Array<{ agentConfigSnapshot?: unknown }>;
  };
  stored.schemaVersion = 1;
  delete stored.agentConfiguration;
  for (const conversation of stored.conversations) delete conversation.agentConfigSnapshot;
  await writeFile(statePath, `${JSON.stringify(stored, null, 2)}\n`, "utf8");

  const restartedStore = new ConversationStore(dataDirectory);
  const restored = await restartedStore.get(project, pending.id);
  assert.equal(restored.agentConfigSnapshot, null);
  const migrated = JSON.parse(await readFile(statePath, "utf8")) as {
    schemaVersion: number;
    agentConfiguration: unknown;
  };
  assert.equal(migrated.schemaVersion, 2);
  assert.ok(migrated.agentConfiguration);
});

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}
