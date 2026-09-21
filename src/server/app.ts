import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  AgentConfigurationService,
  AgentConfigurationValidationError,
} from "./agent-configuration-service.js";
import {
  AGENT_ROLES,
  isAgentReasoningEffort,
  type AgentProfile,
  type AgentProfiles,
  type ProjectAgentConfiguration,
} from "./agent-configuration.js";
import {
  CodexExecutionError,
  CodexRunner,
  ProjectPathError,
  type CodexRunResult,
  type RequirementDiscussionResult,
  type SandboxName,
} from "./codex-client.js";
import {
  CodexModelCatalog,
  CodexModelCatalogError,
  type CodexModelOption,
  type ModelCatalogProvider,
} from "./codex-model-catalog.js";
import {
  ConversationBusyError,
  ConversationNotFoundError,
  ConversationProjectError,
  ConversationStorageError,
  ConversationStore,
  type ConversationUiPatch,
  type PersistedConversation,
} from "./conversation-store.js";
import { DiscussionService } from "./discussion-service.js";

const DEFAULT_STATIC_DIRECTORY = fileURLToPath(new URL("../static/", import.meta.url));
const MAX_BODY_BYTES = 256 * 1024;

export interface Runner {
  run(
    projectPath: string,
    prompt: string,
    sandboxName: SandboxName,
  ): Promise<CodexRunResult>;
  discussRequirements(
    projectPath: string,
    message: string,
    threadId?: string,
    agentProfile?: AgentProfile,
  ): Promise<RequirementDiscussionResult>;
}

interface AppOptions {
  runner?: Runner;
  modelCatalog?: ModelCatalogProvider;
  defaultProjectPath?: string;
  staticDirectory?: string;
  dataDirectory?: string;
}

interface RunRequest {
  projectPath: string;
  prompt: string;
  sandbox: SandboxName;
}

interface DiscussionRequest {
  projectPath: string;
  message: string;
  conversationId?: string;
}

export function createApp(options: AppOptions = {}): Server {
  const runner = options.runner ?? new CodexRunner();
  const defaultProjectPath = path.resolve(options.defaultProjectPath ?? process.cwd());
  const staticDirectory = options.staticDirectory ?? DEFAULT_STATIC_DIRECTORY;
  const conversationStore = new ConversationStore(options.dataDirectory);
  const discussionService = new DiscussionService(runner, conversationStore);
  const modelCatalog = options.modelCatalog ?? new CodexModelCatalog();
  const agentConfigurationService = new AgentConfigurationService(
    conversationStore,
    modelCatalog,
  );

  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");

      if (request.method === "GET" && url.pathname === "/") {
        await sendFile(response, path.join(staticDirectory, "index.html"), "text/html; charset=utf-8");
        return;
      }

      const staticFiles: Record<string, [string, string]> = {
        "/static/app.js": ["app.js", "text/javascript; charset=utf-8"],
        "/static/styles.css": ["styles.css", "text/css; charset=utf-8"],
        "/static/icons/phosphor.css": [
          "icons/phosphor.css",
          "text/css; charset=utf-8",
        ],
        "/static/icons/Phosphor.woff2": [
          "icons/Phosphor.woff2",
          "font/woff2",
        ],
      };
      const staticFile = staticFiles[url.pathname];
      if (request.method === "GET" && staticFile !== undefined) {
        await sendFile(response, path.join(staticDirectory, staticFile[0]), staticFile[1]);
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/config") {
        sendJson(response, 200, {
          default_project_path: defaultProjectPath,
          project_name: path.basename(defaultProjectPath),
          conversation_data_directory: conversationStore.dataDirectory,
        });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/health") {
        sendJson(response, 200, { status: "ok" });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/codex/models") {
        await handleModelList(response, modelCatalog);
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/agent-config") {
        await handleAgentConfigurationGet(response, agentConfigurationService, url);
        return;
      }

      if (request.method === "PUT" && url.pathname === "/api/agent-config") {
        await handleAgentConfigurationSave(request, response, agentConfigurationService);
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/runs") {
        await handleRun(request, response, runner);
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/discussions") {
        await handleDiscussionList(response, discussionService, url);
        return;
      }

      const conversationMatch = url.pathname.match(/^\/api\/discussions\/([^/]+)$/);
      if (conversationMatch !== null && request.method === "GET") {
        await handleDiscussionGet(
          response,
          discussionService,
          url,
          decodeURIComponent(conversationMatch[1]!),
        );
        return;
      }

      if (conversationMatch !== null && request.method === "PATCH") {
        await handleDiscussionPatch(
          request,
          response,
          discussionService,
          url,
          decodeURIComponent(conversationMatch[1]!),
        );
        return;
      }

      if (
        request.method === "POST" &&
        url.pathname === "/api/discussions/messages"
      ) {
        await handleDiscussion(request, response, discussionService);
        return;
      }

      sendJson(response, 404, { detail: "未找到请求的资源。" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendJson(response, 500, { detail: message || "服务器内部错误。" });
    }
  });
}

async function handleModelList(
  response: ServerResponse,
  modelCatalog: ModelCatalogProvider,
): Promise<void> {
  try {
    const models = await modelCatalog.listModels();
    sendJson(response, 200, { models: models.map(serializeModel) });
  } catch (error) {
    handleAgentConfigurationError(response, error);
  }
}

async function handleAgentConfigurationGet(
  response: ServerResponse,
  service: AgentConfigurationService,
  url: URL,
): Promise<void> {
  try {
    const projectPath = requiredQuery(url, "project_path", "项目路径", 4096);
    const configuration = await service.get(projectPath);
    sendJson(response, 200, { configuration: serializeAgentConfiguration(configuration) });
  } catch (error) {
    handleAgentConfigurationError(response, error);
  }
}

async function handleAgentConfigurationSave(
  request: IncomingMessage,
  response: ServerResponse,
  service: AgentConfigurationService,
): Promise<void> {
  let values: { projectPath: string; agents: AgentProfiles };
  try {
    const body = JSON.parse(await readBody(request)) as unknown;
    values = validateAgentConfigurationRequest(body);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sendJson(response, 422, { detail: message || "请求内容无效。" });
    return;
  }

  try {
    const configuration = await service.save(values.projectPath, values.agents);
    sendJson(response, 200, { configuration: serializeAgentConfiguration(configuration) });
  } catch (error) {
    handleAgentConfigurationError(response, error);
  }
}

async function handleDiscussion(
  request: IncomingMessage,
  response: ServerResponse,
  service: DiscussionService,
): Promise<void> {
  let discussionRequest: DiscussionRequest;

  try {
    const body = JSON.parse(await readBody(request)) as unknown;
    discussionRequest = validateDiscussionRequest(body);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sendJson(response, 422, { detail: message || "请求内容无效。" });
    return;
  }

  try {
    const conversation = await service.sendMessage(
      discussionRequest.projectPath,
      discussionRequest.message,
      discussionRequest.conversationId,
    );
    sendJson(response, 200, { conversation: serializeConversation(conversation) });
  } catch (error) {
    handleDiscussionError(response, error);
  }
}

async function handleDiscussionList(
  response: ServerResponse,
  service: DiscussionService,
  url: URL,
): Promise<void> {
  try {
    const projectPath = requiredQuery(url, "project_path", "项目路径", 4096);
    const result = await service.list(projectPath);
    sendJson(response, 200, {
      active_conversation_id: result.activeConversationId,
      conversations: result.conversations.map((conversation) => ({
        id: conversation.id,
        title: conversation.title,
        status: conversation.status,
        created_at: conversation.createdAt,
        updated_at: conversation.updatedAt,
      })),
    });
  } catch (error) {
    handleDiscussionError(response, error);
  }
}

async function handleDiscussionGet(
  response: ServerResponse,
  service: DiscussionService,
  url: URL,
  conversationId: string,
): Promise<void> {
  try {
    const projectPath = requiredQuery(url, "project_path", "项目路径", 4096);
    const conversation = await service.get(projectPath, conversationId);
    sendJson(response, 200, { conversation: serializeConversation(conversation) });
  } catch (error) {
    handleDiscussionError(response, error);
  }
}

async function handleDiscussionPatch(
  request: IncomingMessage,
  response: ServerResponse,
  service: DiscussionService,
  url: URL,
  conversationId: string,
): Promise<void> {
  try {
    const projectPath = requiredQuery(url, "project_path", "项目路径", 4096);
    const patch = validateUiPatch(JSON.parse(await readBody(request)) as unknown);
    const conversation = await service.updateUiState(projectPath, conversationId, patch);
    sendJson(response, 200, { conversation: serializeConversation(conversation) });
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof TypeError) {
      sendJson(response, 422, { detail: error.message || "请求内容无效。" });
      return;
    }
    handleDiscussionError(response, error);
  }
}

async function handleRun(
  request: IncomingMessage,
  response: ServerResponse,
  runner: Runner,
): Promise<void> {
  let runRequest: RunRequest;

  try {
    const body = JSON.parse(await readBody(request)) as unknown;
    runRequest = validateRunRequest(body);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sendJson(response, 422, { detail: message || "请求内容无效。" });
    return;
  }

  try {
    const result = await runner.run(
      runRequest.projectPath,
      runRequest.prompt,
      runRequest.sandbox,
    );
    sendJson(response, 200, {
      thread_id: result.threadId,
      response: result.response,
    });
  } catch (error) {
    if (error instanceof ProjectPathError) {
      sendJson(response, 400, { detail: error.message });
      return;
    }
    if (error instanceof CodexExecutionError) {
      sendJson(response, 502, { detail: `Codex 调用失败：${error.message}` });
      return;
    }
    throw error;
  }
}

function validateRunRequest(body: unknown): RunRequest {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new Error("请求内容必须是 JSON 对象。");
  }

  const values = body as Record<string, unknown>;
  const projectPath = requiredString(values.project_path, "项目路径", 4096);
  const prompt = requiredString(values.prompt, "任务内容", 20_000);
  const sandbox = values.sandbox ?? "read_only";

  if (sandbox !== "read_only" && sandbox !== "workspace_write") {
    throw new Error("不支持的沙盒模式。");
  }

  return { projectPath, prompt, sandbox };
}

function validateDiscussionRequest(body: unknown): DiscussionRequest {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new Error("请求内容必须是 JSON 对象。");
  }

  const values = body as Record<string, unknown>;
  const projectPath = requiredString(values.project_path, "项目路径", 4096);
  const message = requiredString(values.message, "讨论内容", 20_000);
  const conversationId = optionalString(values.conversation_id, "对话 ID", 512);

  return { projectPath, message, conversationId };
}

function validateAgentConfigurationRequest(body: unknown): {
  projectPath: string;
  agents: AgentProfiles;
} {
  if (!isRecord(body)) throw new TypeError("请求内容必须是 JSON 对象。");
  const projectPath = requiredString(body.project_path, "项目路径", 4096);
  if (!isRecord(body.agents)) throw new TypeError("Agent 配置必须是对象。");
  const keys = Object.keys(body.agents);
  if (
    keys.length !== AGENT_ROLES.length ||
    keys.some((role) => !AGENT_ROLES.includes(role as (typeof AGENT_ROLES)[number]))
  ) {
    throw new TypeError("必须且只能配置 requirements、planning、coding、review 四个 Agent。");
  }

  const agents = {} as AgentProfiles;
  for (const role of AGENT_ROLES) {
    const value = body.agents[role];
    if (!isRecord(value)) throw new TypeError(`${role} Agent 配置必须是对象。`);
    const profileKeys = Object.keys(value);
    if (
      profileKeys.length !== 2 ||
      profileKeys.some((key) => key !== "model" && key !== "reasoning_effort")
    ) {
      throw new TypeError(`${role} Agent 只能配置模型和推理等级。`);
    }
    const model = requiredString(value.model, `${role} Agent 模型`, 256);
    if (!isAgentReasoningEffort(value.reasoning_effort)) {
      throw new TypeError(`${role} Agent 推理等级无效。`);
    }
    agents[role] = { model, reasoningEffort: value.reasoning_effort };
  }
  return { projectPath, agents };
}

function validateUiPatch(body: unknown): ConversationUiPatch {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new TypeError("请求内容必须是 JSON 对象。");
  }
  const values = body as Record<string, unknown>;
  const patch: ConversationUiPatch = {};

  if (values.input_draft !== undefined) {
    if (typeof values.input_draft !== "string" || values.input_draft.length > 20_000) {
      throw new TypeError("输入草稿必须是最多 20000 个字符的字符串。");
    }
    patch.inputDraft = values.input_draft;
  }
  if (values.scroll_top !== undefined) {
    if (
      typeof values.scroll_top !== "number" ||
      !Number.isFinite(values.scroll_top) ||
      values.scroll_top < 0
    ) {
      throw new TypeError("滚动位置必须是非负数字。");
    }
    patch.scrollTop = values.scroll_top;
  }
  if (values.active !== undefined) {
    if (values.active !== true) throw new TypeError("active 只能为 true。");
    patch.active = true;
  }
  if (Object.keys(patch).length === 0) {
    throw new TypeError("至少需要提供一个可更新字段。");
  }
  return patch;
}

function requiredQuery(
  url: URL,
  name: string,
  label: string,
  maxLength: number,
): string {
  return requiredString(url.searchParams.get(name), label, maxLength);
}

function serializeConversation(conversation: PersistedConversation): unknown {
  return {
    id: conversation.id,
    title: conversation.title,
    thread_id: conversation.threadId,
    messages: conversation.messages.map((message) => ({
      id: message.id,
      role: message.role,
      content: message.content,
      created_at: message.createdAt,
    })),
    document: conversation.document === null ? null : {
      title: conversation.document.title,
      goal: conversation.document.goal,
      scope: conversation.document.scope,
      non_goals: conversation.document.nonGoals,
      behaviors: conversation.document.behaviors,
      acceptance_criteria: conversation.document.acceptanceCriteria,
    },
    pending_decisions: conversation.pendingDecisions,
    document_version: conversation.documentVersion,
    input_draft: conversation.inputDraft,
    scroll_top: conversation.scrollTop,
    request_status: conversation.requestStatus,
    last_error: conversation.lastError,
    agent_config_snapshot: conversation.agentConfigSnapshot === null
      ? null
      : serializeAgentConfiguration(conversation.agentConfigSnapshot),
    created_at: conversation.createdAt,
    updated_at: conversation.updatedAt,
  };
}

function serializeAgentConfiguration(configuration: ProjectAgentConfiguration): unknown {
  return {
    version: configuration.version,
    updated_at: configuration.updatedAt,
    agents: Object.fromEntries(
      AGENT_ROLES.map((role) => [role, {
        model: configuration.agents[role].model,
        reasoning_effort: configuration.agents[role].reasoningEffort,
      }]),
    ),
  };
}

function serializeModel(model: CodexModelOption): unknown {
  return {
    model: model.model,
    display_name: model.displayName,
    default_reasoning_effort: model.defaultReasoningEffort,
    supported_reasoning_efforts: model.supportedReasoningEfforts.map((option) => ({
      reasoning_effort: option.reasoningEffort,
      description: option.description,
    })),
  };
}

function handleAgentConfigurationError(response: ServerResponse, error: unknown): void {
  if (error instanceof AgentConfigurationValidationError) {
    sendJson(response, 422, { detail: error.message });
    return;
  }
  if (error instanceof ConversationProjectError || error instanceof ProjectPathError) {
    sendJson(response, 400, { detail: error.message });
    return;
  }
  if (error instanceof ConversationStorageError) {
    sendJson(response, 500, { detail: error.message });
    return;
  }
  if (error instanceof CodexModelCatalogError) {
    sendJson(response, 503, { detail: error.message });
    return;
  }
  throw error;
}

function handleDiscussionError(response: ServerResponse, error: unknown): void {
  if (error instanceof ConversationProjectError || error instanceof ProjectPathError) {
    sendJson(response, 400, { detail: error.message });
    return;
  }
  if (error instanceof ConversationNotFoundError) {
    sendJson(response, 404, { detail: error.message });
    return;
  }
  if (error instanceof ConversationBusyError) {
    sendJson(response, 409, { detail: error.message });
    return;
  }
  if (error instanceof ConversationStorageError) {
    sendJson(response, 500, { detail: error.message });
    return;
  }
  if (error instanceof CodexExecutionError) {
    sendJson(response, 502, { detail: `Codex 调用失败：${error.message}` });
    return;
  }
  throw error;
}

function requiredString(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== "string") {
    throw new Error(`${label}必须是字符串。`);
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(`${label}不能为空。`);
  }
  if (trimmed.length > maxLength) {
    throw new Error(`${label}不能超过 ${maxLength} 个字符。`);
  }
  return trimmed;
}

function optionalString(
  value: unknown,
  label: string,
  maxLength: number,
): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  return requiredString(value, label, maxLength);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      throw new Error("请求内容过大。");
    }
    chunks.push(buffer);
  }

  return Buffer.concat(chunks).toString("utf8");
}

async function sendFile(
  response: ServerResponse,
  filePath: string,
  contentType: string,
): Promise<void> {
  const content = await readFile(filePath);
  response.writeHead(200, {
    "Content-Type": contentType,
    "Content-Length": content.length,
  });
  response.end(content);
}

function sendJson(response: ServerResponse, statusCode: number, value: unknown): void {
  if (response.headersSent) {
    response.end();
    return;
  }

  const content = Buffer.from(JSON.stringify(value));
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": content.length,
  });
  response.end(content);
}
