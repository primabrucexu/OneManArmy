import { stat, realpath } from "node:fs/promises";

import { Codex, type SandboxMode, type ThreadOptions } from "@openai/codex-sdk";

import type { AgentProfile } from "./agent-configuration.js";

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

export interface RequirementDocumentDraft {
  title: string;
  goal: string;
  scope: string[];
  nonGoals: string[];
  behaviors: string[];
  acceptanceCriteria: string[];
}

export interface RequirementDiscussionResult {
  threadId: string;
  reply: string;
  document: RequirementDocumentDraft;
  pendingDecisions: string[];
}

const REQUIREMENT_DISCUSSION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["reply", "document", "pending_decisions"],
  properties: {
    reply: { type: "string" },
    document: {
      type: "object",
      additionalProperties: false,
      required: [
        "title",
        "goal",
        "scope",
        "non_goals",
        "behaviors",
        "acceptance_criteria",
      ],
      properties: {
        title: { type: "string" },
        goal: { type: "string" },
        scope: { type: "array", items: { type: "string" } },
        non_goals: { type: "array", items: { type: "string" } },
        behaviors: { type: "array", items: { type: "string" } },
        acceptance_criteria: { type: "array", items: { type: "string" } },
      },
    },
    pending_decisions: { type: "array", items: { type: "string" } },
  },
} as const;

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

  async discussRequirements(
    projectPath: string,
    message: string,
    threadId?: string,
    agentProfile?: AgentProfile,
  ): Promise<RequirementDiscussionResult> {
    const project = await this.resolveProject(projectPath);

    try {
      const codex = new Codex();
      const threadOptions = requirementThreadOptions(project, agentProfile);
      const thread = threadId === undefined
        ? codex.startThread(threadOptions)
        : codex.resumeThread(threadId, threadOptions);
      const result = await thread.run(requirementDiscussionPrompt(message), {
        outputSchema: REQUIREMENT_DISCUSSION_SCHEMA,
      });
      const resolvedThreadId = thread.id ?? threadId;

      if (resolvedThreadId === undefined || resolvedThreadId === null) {
        throw new Error("Codex 未返回 thread ID。");
      }

      return {
        threadId: resolvedThreadId,
        ...parseRequirementDiscussionOutput(result.finalResponse),
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

export function requirementThreadOptions(
  projectPath: string,
  agentProfile?: AgentProfile,
): ThreadOptions {
  return {
    workingDirectory: projectPath,
    sandboxMode: "read-only",
    ...(agentProfile === undefined ? {} : {
      model: agentProfile.model,
      modelReasoningEffort: agentProfile.reasoningEffort,
    }),
  };
}

export function parseRequirementDiscussionOutput(
  response: string,
): Omit<RequirementDiscussionResult, "threadId"> {
  let value: unknown;

  try {
    value = JSON.parse(response);
  } catch (error) {
    throw new Error("需求 Agent 返回了无法解析的结构化结果。", { cause: error });
  }

  if (!isRecord(value)) {
    throw new Error("需求 Agent 返回结果必须是对象。");
  }

  const document = value.document;
  if (!isRecord(document)) {
    throw new Error("需求 Agent 未返回有效的需求文档草稿。");
  }

  return {
    reply: outputString(value.reply, "讨论回复"),
    document: {
      title: outputString(document.title, "需求文档标题"),
      goal: outputString(document.goal, "目标"),
      scope: outputStringArray(document.scope, "范围"),
      nonGoals: outputStringArray(document.non_goals, "非目标"),
      behaviors: outputStringArray(document.behaviors, "主要行为"),
      acceptanceCriteria: outputStringArray(
        document.acceptance_criteria,
        "验收标准",
      ),
    },
    pendingDecisions: outputStringArray(value.pending_decisions, "待用户决策"),
  };
}

function requirementDiscussionPrompt(message: string): string {
  return `你是 OneManArmy 的需求 Agent。你的职责是通过讨论逐步确认“要实现什么”，并同步维护当前需求的需求文档草稿。

硬性规则：
- 先理解用户目标，再提出必要且少量的澄清问题。
- 不进入技术实现计划，不编写代码，不假设用户没有确认的事实。
- 需求文档必须持续反映已确认内容，并明确区分范围与非目标。
- 无法自行决定且会改变需求结果的事项放入 pending_decisions；已解决的事项移除。
- reply 用自然、简洁的中文直接回复用户。

用户本轮消息：
${message}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function outputString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`需求 Agent 返回的${label}无效。`);
  }
  return value.trim();
}

function outputStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`需求 Agent 返回的${label}无效。`);
  }
  return value.map((item) => item.trim()).filter((item) => item.length > 0);
}
