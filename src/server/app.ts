import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  CodexExecutionError,
  CodexRunner,
  ProjectPathError,
  type CodexRunResult,
  type SandboxName,
} from "./codex-client.js";

const DEFAULT_STATIC_DIRECTORY = fileURLToPath(new URL("../static/", import.meta.url));
const MAX_BODY_BYTES = 256 * 1024;

export interface Runner {
  run(
    projectPath: string,
    prompt: string,
    sandboxName: SandboxName,
  ): Promise<CodexRunResult>;
}

interface AppOptions {
  runner?: Runner;
  defaultProjectPath?: string;
  staticDirectory?: string;
}

interface RunRequest {
  projectPath: string;
  prompt: string;
  sandbox: SandboxName;
}

export function createApp(options: AppOptions = {}): Server {
  const runner = options.runner ?? new CodexRunner();
  const defaultProjectPath = path.resolve(options.defaultProjectPath ?? process.cwd());
  const staticDirectory = options.staticDirectory ?? DEFAULT_STATIC_DIRECTORY;

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
      };
      const staticFile = staticFiles[url.pathname];
      if (request.method === "GET" && staticFile !== undefined) {
        await sendFile(response, path.join(staticDirectory, staticFile[0]), staticFile[1]);
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/config") {
        sendJson(response, 200, { default_project_path: defaultProjectPath });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/health") {
        sendJson(response, 200, { status: "ok" });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/runs") {
        await handleRun(request, response, runner);
        return;
      }

      sendJson(response, 404, { detail: "未找到请求的资源。" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendJson(response, 500, { detail: message || "服务器内部错误。" });
    }
  });
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
