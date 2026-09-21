import type { ModelReasoningEffort } from "@openai/codex-sdk";

export const AGENT_ROLES = ["requirements", "planning", "coding", "review"] as const;

export type AgentRole = (typeof AGENT_ROLES)[number];
export type AgentReasoningEffort = ModelReasoningEffort;

export interface AgentProfile {
  model: string;
  reasoningEffort: AgentReasoningEffort;
}

export type AgentProfiles = Record<AgentRole, AgentProfile>;

export interface ProjectAgentConfiguration {
  version: number;
  updatedAt: string;
  agents: AgentProfiles;
}

export const RECOMMENDED_AGENT_PROFILES: AgentProfiles = {
  requirements: { model: "gpt-5.6-terra", reasoningEffort: "medium" },
  planning: { model: "gpt-6-astra", reasoningEffort: "high" },
  coding: { model: "gpt-5.6-sol", reasoningEffort: "high" },
  review: { model: "gpt-6-astra", reasoningEffort: "high" },
};

const REASONING_EFFORTS = new Set<AgentReasoningEffort>([
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
  "persistent",
]);

export function defaultAgentConfiguration(now = new Date().toISOString()): ProjectAgentConfiguration {
  return {
    version: 1,
    updatedAt: now,
    agents: cloneAgentProfiles(RECOMMENDED_AGENT_PROFILES),
  };
}

export function cloneAgentConfiguration(
  configuration: ProjectAgentConfiguration,
): ProjectAgentConfiguration {
  return structuredClone(configuration);
}

export function cloneAgentProfiles(profiles: AgentProfiles): AgentProfiles {
  return structuredClone(profiles);
}

export function agentProfilesEqual(left: AgentProfiles, right: AgentProfiles): boolean {
  return AGENT_ROLES.every(
    (role) =>
      left[role].model === right[role].model &&
      left[role].reasoningEffort === right[role].reasoningEffort,
  );
}

export function isAgentReasoningEffort(value: unknown): value is AgentReasoningEffort {
  return typeof value === "string" && REASONING_EFFORTS.has(value as AgentReasoningEffort);
}

export function parseStoredAgentConfiguration(value: unknown): ProjectAgentConfiguration {
  if (!isRecord(value)) throw new Error("Agent 配置必须是对象。");
  const version = storedPositiveInteger(value.version, "Agent 配置版本");
  const updatedAt = storedString(value.updatedAt, "Agent 配置更新时间");
  return {
    version,
    updatedAt,
    agents: parseStoredAgentProfiles(value.agents),
  };
}

export function parseStoredAgentProfiles(value: unknown): AgentProfiles {
  if (!isRecord(value)) throw new Error("Agent 配置列表必须是对象。");
  const profiles = {} as AgentProfiles;
  for (const role of AGENT_ROLES) profiles[role] = parseStoredAgentProfile(value[role]);
  return profiles;
}

function parseStoredAgentProfile(value: unknown): AgentProfile {
  if (!isRecord(value)) throw new Error("Agent 角色配置必须是对象。");
  const model = storedString(value.model, "Agent 模型");
  if (!isAgentReasoningEffort(value.reasoningEffort)) {
    throw new Error("Agent 推理等级无效。");
  }
  return { model, reasoningEffort: value.reasoningEffort };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function storedString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label}无效。`);
  return value;
}

function storedPositiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(`${label}无效。`);
  }
  return value;
}
