import { stat, realpath } from "node:fs/promises";

import { Codex, type SandboxMode } from "@openai/codex-sdk";

export type SandboxName = "read_only" | "workspace_write";

export class ProjectPathError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ProjectPathError";
  }
}

export class CodexExecutionError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CodexExecutionError";
  }
}

export interface CodexRunResult {
  threadId: string;
  response: string;
}

export class CodexRunner {
  async run(
    projectPath: string,
    prompt: string,
    sandboxName: SandboxName,
  ): Promise<CodexRunResult> {
    const project = await this.resolveProject(projectPath);

    try {
      const codex = new Codex();
      const thread = codex.startThread({
        workingDirectory: project,
        sandboxMode: this.sandbox(sandboxName),
      });
      const result = await thread.run(prompt);

      if (thread.id === null) {
        throw new Error("Codex 未返回 thread ID。");
      }

      return {
        threadId: thread.id,
        response: result.finalResponse.trim(),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message.trim() : String(error);
      throw new CodexExecutionError(message || "Codex 执行失败。", { cause: error });
    }
  }

  private async resolveProject(projectPath: string): Promise<string> {
    let project: string;

    try {
      project = await realpath(projectPath);
    } catch (error) {
      throw new ProjectPathError("项目目录不存在或无法访问。", { cause: error });
    }

    if (!(await stat(project)).isDirectory()) {
      throw new ProjectPathError("项目路径必须指向一个目录。");
    }

    return project;
  }

  private sandbox(sandboxName: SandboxName): SandboxMode {
    if (sandboxName === "read_only") {
      return "read-only";
    }
    if (sandboxName === "workspace_write") {
      return "workspace-write";
    }
    throw new Error(`不支持的沙盒模式：${sandboxName satisfies never}`);
  }
}
