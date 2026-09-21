import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createRequire } from "node:module";
import readline from "node:readline";

import {
  isAgentReasoningEffort,
  type AgentReasoningEffort,
} from "./agent-configuration.js";

export interface CodexReasoningEffortOption {
  reasoningEffort: AgentReasoningEffort;
  description: string;
}

export interface CodexModelOption {
  model: string;
  displayName: string;
  defaultReasoningEffort: AgentReasoningEffort;
  supportedReasoningEfforts: CodexReasoningEffortOption[];
}

export interface ModelCatalogProvider {
  listModels(): Promise<CodexModelOption[]>;
}

export class CodexModelCatalogError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CodexModelCatalogError";
  }
}

export class CodexModelCatalog implements ModelCatalogProvider {
  constructor(private readonly timeoutMs = 15_000) {}

  listModels(): Promise<CodexModelOption[]> {
    const require = createRequire(import.meta.url);
    let codexEntrypoint: string;
    try {
      codexEntrypoint = require.resolve("@openai/codex/bin/codex.js");
    } catch (error) {
      throw new CodexModelCatalogError("无法定位 Codex App Server。", { cause: error });
    }

    return new Promise((resolve, reject) => {
      let child: ChildProcessWithoutNullStreams;
      try {
        child = spawn(process.execPath, [codexEntrypoint, "app-server"], {
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
        });
      } catch (error) {
        reject(new CodexModelCatalogError("无法启动 Codex App Server。", { cause: error }));
        return;
      }
      const output = readline.createInterface({ input: child.stdout });
      const stderr: Buffer[] = [];
      const models: CodexModelOption[] = [];
      let finished = false;
      let requestId = 2;
      let pendingModelRequestId: number | null = null;

      const cleanup = () => {
        clearTimeout(timer);
        output.close();
        child.removeAllListeners();
        child.stderr.removeAllListeners();
        if (!child.killed) child.kill();
      };
      const finish = (error?: Error) => {
        if (finished) return;
        finished = true;
        cleanup();
        if (error) reject(error);
        else resolve(uniqueModels(models));
      };
      const fail = (message: string, cause?: unknown) => {
        const detail = Buffer.concat(stderr).toString("utf8").trim();
        finish(new CodexModelCatalogError(detail ? `${message}：${detail}` : message, { cause }));
      };
      const send = (message: unknown) => {
        if (child.stdin.destroyed) {
          fail("Codex App Server 已关闭。");
          return;
        }
        child.stdin.write(`${JSON.stringify(message)}\n`);
      };
      const requestModels = (cursor?: string) => {
        pendingModelRequestId = requestId++;
        send({
          method: "model/list",
          id: pendingModelRequestId,
          params: { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) },
        });
      };

      const timer = setTimeout(() => fail("读取 Codex 模型目录超时。"), this.timeoutMs);
      child.stderr.on("data", (chunk: Buffer) => {
        if (Buffer.concat(stderr).length < 8192) stderr.push(chunk);
      });
      child.once("error", (error) => fail("无法启动 Codex App Server。", error));
      child.once("exit", (code, signal) => {
        if (!finished) fail(`Codex App Server 提前退出（${signal ?? code ?? "unknown"}）。`);
      });
      output.on("line", (line) => {
        let message: unknown;
        try {
          message = JSON.parse(line) as unknown;
        } catch (error) {
          fail("Codex App Server 返回了无法解析的响应。", error);
          return;
        }
        if (!isRecord(message) || typeof message.id !== "number") return;
        if (message.error !== undefined) {
          fail(jsonRpcError(message.error));
          return;
        }
        if (message.id === 1) {
          send({ method: "initialized", params: {} });
          requestModels();
          return;
        }
        if (message.id !== pendingModelRequestId) return;
        try {
          const page = parseModelPage(message.result);
          models.push(...page.models);
          if (page.nextCursor) requestModels(page.nextCursor);
          else finish();
        } catch (error) {
          fail("Codex 模型目录响应无效。", error);
        }
      });

      send({
        method: "initialize",
        id: 1,
        params: {
          clientInfo: { name: "one_man_army", title: "OneManArmy", version: "0.1.0" },
        },
      });
    });
  }
}

export function parseModelPage(value: unknown): {
  models: CodexModelOption[];
  nextCursor: string | null;
} {
  if (!isRecord(value) || !Array.isArray(value.data)) throw new Error("模型列表缺失。");
  const models = value.data.map(parseModel).filter((model): model is CodexModelOption => model !== null);
  const nextCursor = value.nextCursor === null || value.nextCursor === undefined
    ? null
    : storedString(value.nextCursor, "模型目录游标");
  return { models, nextCursor };
}

function parseModel(value: unknown): CodexModelOption | null {
  if (!isRecord(value)) throw new Error("模型条目必须是对象。");
  if (value.hidden === true) return null;
  const model = storedString(value.model ?? value.id, "模型 ID");
  const displayName = typeof value.displayName === "string" && value.displayName.length > 0
    ? value.displayName
    : model;
  if (!Array.isArray(value.supportedReasoningEfforts)) return null;
  const supportedReasoningEfforts = value.supportedReasoningEfforts
    .map(parseReasoningEffort)
    .filter((effort): effort is CodexReasoningEffortOption => effort !== null);
  if (supportedReasoningEfforts.length === 0) return null;
  const configuredDefault = value.defaultReasoningEffort;
  const defaultReasoningEffort = isAgentReasoningEffort(configuredDefault) &&
    supportedReasoningEfforts.some((item) => item.reasoningEffort === configuredDefault)
    ? configuredDefault
    : supportedReasoningEfforts[0]!.reasoningEffort;
  return { model, displayName, defaultReasoningEffort, supportedReasoningEfforts };
}

function parseReasoningEffort(value: unknown): CodexReasoningEffortOption | null {
  if (!isRecord(value) || !isAgentReasoningEffort(value.reasoningEffort)) return null;
  return {
    reasoningEffort: value.reasoningEffort,
    description: typeof value.description === "string" ? value.description : "",
  };
}

function uniqueModels(models: CodexModelOption[]): CodexModelOption[] {
  return [...new Map(models.map((model) => [model.model, model])).values()];
}

function jsonRpcError(value: unknown): string {
  return isRecord(value) && typeof value.message === "string"
    ? `Codex App Server 调用失败：${value.message}`
    : "Codex App Server 调用失败。";
}

function storedString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label}无效。`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
