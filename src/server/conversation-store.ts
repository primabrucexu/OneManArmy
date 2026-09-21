import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  agentProfilesEqual,
  cloneAgentConfiguration,
  cloneAgentProfiles,
  defaultAgentConfiguration,
  parseStoredAgentConfiguration,
  type AgentProfiles,
  type ProjectAgentConfiguration,
} from "./agent-configuration.js";
import type { RequirementDocumentDraft } from "./codex-client.js";

const SCHEMA_VERSION = 2;

export type ConversationRole = "user" | "agent" | "system";
export type RequestStatus = "idle" | "running" | "interrupted";
export type ConversationStatus =
  | "discussion"
  | "pending_decision"
  | "draft_updated"
  | "interrupted";

export interface ConversationMessage {
  id: string;
  role: ConversationRole;
  content: string;
  createdAt: string;
}

export interface PersistedConversation {
  id: string;
  title: string;
  threadId: string | null;
  messages: ConversationMessage[];
  document: RequirementDocumentDraft | null;
  pendingDecisions: string[];
  documentVersion: number;
  inputDraft: string;
  scrollTop: number;
  requestStatus: RequestStatus;
  lastError: string | null;
  agentConfigSnapshot: ProjectAgentConfiguration | null;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationSummary {
  id: string;
  title: string;
  status: ConversationStatus;
  createdAt: string;
  updatedAt: string;
}

interface ProjectConversationState {
  schemaVersion: number;
  projectPath: string;
  agentConfiguration: ProjectAgentConfiguration;
  activeConversationId: string | null;
  conversations: PersistedConversation[];
}

export interface ConversationListResult {
  activeConversationId: string | null;
  conversations: ConversationSummary[];
}

export interface ConversationUiPatch {
  inputDraft?: string;
  scrollTop?: number;
  active?: boolean;
}

export class ConversationNotFoundError extends Error {
  constructor() {
    super("未找到指定的需求对话。");
    this.name = "ConversationNotFoundError";
  }
}

export class ConversationBusyError extends Error {
  constructor() {
    super("当前需求对话正在处理中，请等待本轮完成。");
    this.name = "ConversationBusyError";
  }
}

export class ConversationProjectError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ConversationProjectError";
  }
}

export class ConversationStorageError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ConversationStorageError";
  }
}

export function defaultConversationDataDirectory(): string {
  const override = process.env.ONEMANARMY_DATA_DIR?.trim();
  if (override) return path.resolve(override);

  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA?.trim();
    return path.join(localAppData || path.join(os.homedir(), "AppData", "Local"), "OneManArmy");
  }

  const stateHome = process.env.XDG_STATE_HOME?.trim();
  return path.join(stateHome || path.join(os.homedir(), ".local", "state"), "OneManArmy");
}

export class ConversationStore {
  readonly dataDirectory: string;
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly initializedProjects = new Set<string>();

  constructor(dataDirectory = defaultConversationDataDirectory()) {
    this.dataDirectory = path.resolve(dataDirectory);
  }

  async getAgentConfiguration(projectPath: string): Promise<ProjectAgentConfiguration> {
    return this.serialized(projectPath, async (context) => {
      const state = await this.readState(context.projectPath, context.filePath, context.key);
      await this.writeState(context.filePath, state);
      return cloneAgentConfiguration(state.agentConfiguration);
    });
  }

  async saveAgentConfiguration(
    projectPath: string,
    agents: AgentProfiles,
  ): Promise<ProjectAgentConfiguration> {
    return this.serialized(projectPath, async (context) => {
      const state = await this.readState(context.projectPath, context.filePath, context.key);
      if (agentProfilesEqual(state.agentConfiguration.agents, agents)) {
        return cloneAgentConfiguration(state.agentConfiguration);
      }

      state.agentConfiguration = {
        version: state.agentConfiguration.version + 1,
        updatedAt: new Date().toISOString(),
        agents: cloneAgentProfiles(agents),
      };
      await this.writeState(context.filePath, state);
      return cloneAgentConfiguration(state.agentConfiguration);
    });
  }

  async list(projectPath: string): Promise<ConversationListResult> {
    return this.serialized(projectPath, async (context) => {
      const state = await this.readState(context.projectPath, context.filePath, context.key);

      return {
        activeConversationId: state.activeConversationId,
        conversations: state.conversations
          .map(conversationSummary)
          .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
      };
    });
  }

  async get(projectPath: string, conversationId: string): Promise<PersistedConversation> {
    return this.serialized(projectPath, async (context) => {
      const state = await this.readState(context.projectPath, context.filePath, context.key);
      return cloneConversation(findConversation(state, conversationId));
    });
  }

  async beginMessage(
    projectPath: string,
    message: string,
    conversationId?: string,
  ): Promise<PersistedConversation> {
    return this.serialized(projectPath, async (context) => {
      const state = await this.readState(context.projectPath, context.filePath, context.key);
      const now = new Date().toISOString();
      let conversation: PersistedConversation;

      if (conversationId === undefined) {
        conversation = newConversation(message, now, state.agentConfiguration);
        state.conversations.push(conversation);
      } else {
        conversation = findConversation(state, conversationId);
        if (conversation.requestStatus === "running") {
          throw new ConversationBusyError();
        }
        conversation.messages.push(newMessage("user", message, now));
        conversation.updatedAt = now;
        conversation.requestStatus = "running";
        conversation.lastError = null;
      }

      state.activeConversationId = conversation.id;
      await this.writeState(context.filePath, state);
      return cloneConversation(conversation);
    });
  }

  async completeMessage(
    projectPath: string,
    conversationId: string,
    result: {
      threadId: string;
      reply: string;
      document: RequirementDocumentDraft;
      pendingDecisions: string[];
    },
  ): Promise<PersistedConversation> {
    return this.serialized(projectPath, async (context) => {
      const state = await this.readState(context.projectPath, context.filePath, context.key);
      const conversation = findConversation(state, conversationId);
      const now = new Date().toISOString();

      conversation.threadId = result.threadId;
      conversation.messages.push(newMessage("agent", result.reply, now));
      conversation.document = result.document;
      conversation.pendingDecisions = [...result.pendingDecisions];
      conversation.documentVersion += 1;
      conversation.requestStatus = "idle";
      conversation.lastError = null;
      conversation.updatedAt = now;
      state.activeConversationId = conversation.id;

      await this.writeState(context.filePath, state);
      return cloneConversation(conversation);
    });
  }

  async failMessage(
    projectPath: string,
    conversationId: string,
    errorMessage: string,
  ): Promise<void> {
    await this.serialized(projectPath, async (context) => {
      const state = await this.readState(context.projectPath, context.filePath, context.key);
      const conversation = findConversation(state, conversationId);
      const now = new Date().toISOString();
      const message = errorMessage.trim() || "上一次请求未完成，可继续发送。";

      conversation.requestStatus = "interrupted";
      conversation.lastError = message;
      conversation.messages.push(newMessage("system", `请求未完成：${message}`, now));
      conversation.updatedAt = now;
      await this.writeState(context.filePath, state);
    });
  }

  async updateUiState(
    projectPath: string,
    conversationId: string,
    patch: ConversationUiPatch,
  ): Promise<PersistedConversation> {
    return this.serialized(projectPath, async (context) => {
      const state = await this.readState(context.projectPath, context.filePath, context.key);
      const conversation = findConversation(state, conversationId);

      if (patch.inputDraft !== undefined) conversation.inputDraft = patch.inputDraft;
      if (patch.scrollTop !== undefined) conversation.scrollTop = patch.scrollTop;
      if (patch.active === true) state.activeConversationId = conversation.id;

      await this.writeState(context.filePath, state);
      return cloneConversation(conversation);
    });
  }

  private async serialized<T>(
    projectPath: string,
    action: (context: { projectPath: string; filePath: string; key: string }) => Promise<T>,
  ): Promise<T> {
    const normalizedProject = await normalizeProjectPath(projectPath);
    const key = projectKey(normalizedProject);
    const previous = this.queues.get(key) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(() =>
      action({
        projectPath: normalizedProject,
        filePath: path.join(this.dataDirectory, "projects", key, "state.json"),
        key,
      }),
    );
    this.queues.set(key, current);

    try {
      return await current;
    } finally {
      if (this.queues.get(key) === current) this.queues.delete(key);
    }
  }

  private async readState(
    projectPath: string,
    filePath: string,
    key: string,
  ): Promise<ProjectConversationState> {
    let content: string;
    try {
      content = await readFile(filePath, "utf8");
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        this.initializedProjects.add(key);
        return emptyState(projectPath);
      }
      throw new ConversationStorageError("无法读取需求对话数据。", { cause: error });
    }

    try {
      const stored = JSON.parse(content) as unknown;
      const legacy = isRecord(stored) && stored.schemaVersion === 1;
      const state = parseState(stored, projectPath);
      if (!this.initializedProjects.has(key)) {
        this.initializedProjects.add(key);
        if (legacy || recoverInterruptedRequests(state)) await this.writeState(filePath, state);
      }
      return state;
    } catch (error) {
      if (error instanceof ConversationStorageError) throw error;
      throw new ConversationStorageError("需求对话数据损坏或格式不受支持。", {
        cause: error,
      });
    }
  }

  private async writeState(
    filePath: string,
    state: ProjectConversationState,
  ): Promise<void> {
    const directory = path.dirname(filePath);
    const temporaryPath = path.join(
      directory,
      `.state.${process.pid}.${randomUUID()}.tmp`,
    );

    try {
      await mkdir(directory, { recursive: true });
      await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
      await rename(temporaryPath, filePath);
    } catch (error) {
      try {
        await unlink(temporaryPath);
      } catch {
        // The temporary file may not have been created.
      }
      throw new ConversationStorageError("无法保存需求对话数据。", { cause: error });
    }
  }
}

async function normalizeProjectPath(projectPath: string): Promise<string> {
  try {
    const project = await realpath(projectPath);
    if (!(await stat(project)).isDirectory()) {
      throw new ConversationProjectError("项目路径必须指向一个目录。");
    }
    return project;
  } catch (error) {
    if (error instanceof ConversationProjectError) throw error;
    throw new ConversationProjectError("项目目录不存在或无法访问。", { cause: error });
  }
}

function projectKey(projectPath: string): string {
  const value = process.platform === "win32" ? projectPath.toLowerCase() : projectPath;
  return createHash("sha256").update(value).digest("hex");
}

function emptyState(projectPath: string): ProjectConversationState {
  return {
    schemaVersion: SCHEMA_VERSION,
    projectPath,
    agentConfiguration: defaultAgentConfiguration(),
    activeConversationId: null,
    conversations: [],
  };
}

function newConversation(
  message: string,
  now: string,
  agentConfiguration: ProjectAgentConfiguration,
): PersistedConversation {
  return {
    id: randomUUID(),
    title: conversationTitle(message),
    threadId: null,
    messages: [
      newMessage(
        "agent",
        "你好，我会和你一起把需求讨论清楚，并持续整理为需求文档。先告诉我：这次想解决什么问题？",
        now,
      ),
      newMessage("user", message, now),
    ],
    document: null,
    pendingDecisions: [],
    documentVersion: 0,
    inputDraft: "",
    scrollTop: 0,
    requestStatus: "running",
    lastError: null,
    agentConfigSnapshot: cloneAgentConfiguration(agentConfiguration),
    createdAt: now,
    updatedAt: now,
  };
}

function newMessage(
  role: ConversationRole,
  content: string,
  createdAt: string,
): ConversationMessage {
  return { id: randomUUID(), role, content, createdAt };
}

function conversationTitle(message: string): string {
  const characters = Array.from(message.trim());
  const title = characters.slice(0, 24).join("");
  return characters.length > 24 ? `${title}…` : title;
}

function conversationSummary(conversation: PersistedConversation): ConversationSummary {
  let status: ConversationStatus = "discussion";
  if (conversation.requestStatus === "interrupted") {
    status = "interrupted";
  } else if (conversation.pendingDecisions.length > 0) {
    status = "pending_decision";
  } else if (conversation.documentVersion > 0) {
    status = "draft_updated";
  }

  return {
    id: conversation.id,
    title: conversation.title,
    status,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
  };
}

function findConversation(
  state: ProjectConversationState,
  conversationId: string,
): PersistedConversation {
  const conversation = state.conversations.find((item) => item.id === conversationId);
  if (conversation === undefined) throw new ConversationNotFoundError();
  return conversation;
}

function recoverInterruptedRequests(state: ProjectConversationState): boolean {
  let changed = false;
  const now = new Date().toISOString();
  for (const conversation of state.conversations) {
    if (conversation.requestStatus !== "running") continue;
    conversation.requestStatus = "interrupted";
    conversation.lastError = "上一次请求未完成，可继续发送。";
    conversation.messages.push(
      newMessage("system", "上一次请求未完成，可继续发送。", now),
    );
    conversation.updatedAt = now;
    changed = true;
  }
  return changed;
}

function cloneConversation(conversation: PersistedConversation): PersistedConversation {
  return structuredClone(conversation);
}

function parseState(value: unknown, projectPath: string): ProjectConversationState {
  if (!isRecord(value) || (value.schemaVersion !== 1 && value.schemaVersion !== SCHEMA_VERSION)) {
    throw new ConversationStorageError("需求对话数据版本不受支持。");
  }
  if (value.projectPath !== projectPath || !Array.isArray(value.conversations)) {
    throw new ConversationStorageError("需求对话数据与当前项目不匹配。");
  }
  if (
    value.activeConversationId !== null &&
    typeof value.activeConversationId !== "string"
  ) {
    throw new ConversationStorageError("当前需求对话标识无效。");
  }

  const legacy = value.schemaVersion === 1;
  const conversations = value.conversations.map((conversation) =>
    parseConversation(conversation, legacy),
  );
  if (
    value.activeConversationId !== null &&
    !conversations.some((item) => item.id === value.activeConversationId)
  ) {
    throw new ConversationStorageError("当前需求对话不存在。");
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    projectPath,
    agentConfiguration: legacy
      ? defaultAgentConfiguration()
      : parseStoredAgentConfiguration(value.agentConfiguration),
    activeConversationId: value.activeConversationId,
    conversations,
  };
}

function parseConversation(value: unknown, legacy: boolean): PersistedConversation {
  if (!isRecord(value)) throw new Error("对话记录必须是对象。");
  const requestStatus = value.requestStatus;
  if (requestStatus !== "idle" && requestStatus !== "running" && requestStatus !== "interrupted") {
    throw new Error("对话请求状态无效。");
  }

  return {
    id: storedString(value.id),
    title: storedString(value.title),
    threadId: value.threadId === null ? null : storedString(value.threadId),
    messages: storedArray(value.messages).map(parseMessage),
    document: value.document === null ? null : parseDocument(value.document),
    pendingDecisions: storedArray(value.pendingDecisions).map((item) => storedString(item)),
    documentVersion: storedNonNegativeNumber(value.documentVersion),
    inputDraft: storedString(value.inputDraft, true),
    scrollTop: storedNonNegativeNumber(value.scrollTop),
    requestStatus,
    lastError: value.lastError === null ? null : storedString(value.lastError),
    agentConfigSnapshot: legacy || value.agentConfigSnapshot === null
      ? null
      : parseStoredAgentConfiguration(value.agentConfigSnapshot),
    createdAt: storedString(value.createdAt),
    updatedAt: storedString(value.updatedAt),
  };
}

function parseMessage(value: unknown): ConversationMessage {
  if (!isRecord(value)) throw new Error("消息记录必须是对象。");
  if (value.role !== "user" && value.role !== "agent" && value.role !== "system") {
    throw new Error("消息角色无效。");
  }
  return {
    id: storedString(value.id),
    role: value.role,
    content: storedString(value.content),
    createdAt: storedString(value.createdAt),
  };
}

function parseDocument(value: unknown): RequirementDocumentDraft {
  if (!isRecord(value)) throw new Error("需求文档必须是对象。");
  return {
    title: storedString(value.title),
    goal: storedString(value.goal),
    scope: storedArray(value.scope).map((item) => storedString(item)),
    nonGoals: storedArray(value.nonGoals).map((item) => storedString(item)),
    behaviors: storedArray(value.behaviors).map((item) => storedString(item)),
    acceptanceCriteria: storedArray(value.acceptanceCriteria).map((item) => storedString(item)),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function storedArray(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("持久化字段必须是数组。");
  return value;
}

function storedString(value: unknown, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
    throw new Error("持久化字段必须是字符串。");
  }
  return value;
}

function storedNonNegativeNumber(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error("持久化字段必须是非负数字。");
  }
  return value;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
