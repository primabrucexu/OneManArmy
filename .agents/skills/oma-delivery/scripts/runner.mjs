#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const MODULE_PATH = fileURLToPath(import.meta.url);
const SCRIPT_DIR = path.dirname(MODULE_PATH);
const SKILLS_ROOT = path.resolve(SCRIPT_DIR, "..", "..");
const STAGES = ["plan", "plan_review", "code", "code_review"];
const TERMINAL = new Set(["succeeded", "failed", "cancelled"]);
const OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["status", "summary", "evidence", "feedback", "artifact"],
  properties: {
    status: { type: "string", enum: ["completed", "revise", "failed"] },
    summary: { type: "string" },
    evidence: { type: "array", items: { type: "string" } },
    feedback: { type: ["string", "null"] },
    artifact: { type: ["string", "null"] },
  },
};

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      throw new Error(`Invalid argument near ${key ?? "<end>"}`);
    }
    values[key.slice(2)] = value;
  }
  return values;
}

function requiredPath(values, key) {
  const value = values[key];
  if (!value) throw new Error(`Missing --${key}`);
  return path.resolve(value);
}

async function writeJsonAtomic(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.next`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporaryPath, filePath);
}

async function readState(statePath) {
  try {
    return JSON.parse(await readFile(statePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function initialState(requirement, workspace, requirementFile = null) {
  const now = new Date().toISOString();
  return {
    version: 1,
    status: "running",
    stage: "plan",
    requirement,
    requirementFile: requirementFile ? path.resolve(requirementFile) : null,
    workspace,
    planAttempt: 1,
    codeAttempt: 1,
    plan: null,
    implementation: null,
    feedback: null,
    evidence: [],
    trace: [],
    createdAt: now,
    updatedAt: now,
  };
}

export async function loadRequirementInput({ requirement, requirementFile }) {
  if (Boolean(requirement) === Boolean(requirementFile)) {
    throw new Error("Provide exactly one of --requirement or --requirement-file.");
  }
  if (requirementFile) {
    const resolved = path.resolve(requirementFile);
    const content = await readFile(resolved, "utf8");
    if (!content.trim()) throw new Error("Confirmed requirement file is empty.");
    return { requirement: content.trim(), requirementFile: resolved };
  }
  if (!requirement.trim()) throw new Error("Confirmed requirement is empty.");
  return { requirement: requirement.trim(), requirementFile: null };
}

function stageSkill(stage) {
  if (stage === "plan") return "oma-plan";
  if (stage === "code") return "oma-code";
  return "oma-review";
}

function makePrompt(state) {
  const shared = `Confirmed requirement:\n${state.requirement}\n\nWorkspace: ${state.workspace}`;
  if (state.stage === "plan") {
    return `${shared}\n\nCreate attempt ${state.planAttempt} of the implementation plan. Review feedback: ${state.feedback ?? "none"}. Return only the requested JSON object.`;
  }
  if (state.stage === "plan_review") {
    return `${shared}\n\nIndependently review this plan:\n${state.plan?.artifact ?? state.plan?.summary ?? "<missing>"}\nReturn only the requested JSON object.`;
  }
  if (state.stage === "code") {
    return `${shared}\n\nImplement this reviewed plan:\n${state.plan?.summary ?? "<missing>"}\nCorrection feedback: ${state.feedback ?? "none"}. Return only the requested JSON object.`;
  }
  return `${shared}\n\nIndependently inspect the workspace and review this implementation report:\n${state.implementation?.summary ?? "<missing>"}\nReturn only the requested JSON object.`;
}

class AppServerClient {
  constructor() {
    this.nextId = 1;
    this.pending = new Map();
    this.events = [];
    this.waiters = [];
    this.stderr = "";
  }

  async start() {
    const repoRoot = path.resolve(SCRIPT_DIR, "..", "..", "..", "..");
    const localCodex = path.join(repoRoot, "node_modules", "@openai", "codex", "bin", "codex.js");
    const useLocalCodex = existsSync(localCodex);
    const command = useLocalCodex
      ? process.execPath
      : process.platform === "win32" ? (process.env.ComSpec ?? "cmd.exe") : "codex";
    const args = useLocalCodex
      ? [localCodex, "app-server", "--stdio"]
      : process.platform === "win32"
        ? ["/d", "/s", "/c", "codex app-server --stdio"]
        : ["app-server", "--stdio"];
    this.child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk) => { this.stderr += chunk; });
    this.child.on("exit", (code) => {
      const error = new Error(`App Server exited with code ${code}. ${this.stderr}`);
      this.failAll(error);
    });
    const lines = readline.createInterface({ input: this.child.stdout });
    lines.on("line", (line) => {
      if (!line.trim()) return;
      try {
        this.handle(JSON.parse(line));
      } catch (error) {
        this.failAll(new Error(`Invalid App Server message: ${line}\n${error.message}`));
      }
    });
    await this.request("initialize", {
      clientInfo: { name: "oma-delivery-validation", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    });
    this.notify("initialized");
  }

  handle(message) {
    if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
      const pending = this.pending.get(String(message.id));
      if (!pending) return;
      this.pending.delete(String(message.id));
      if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
      else pending.resolve(message.result);
      return;
    }
    if (message.id !== undefined && message.method) {
      this.send({
        id: message.id,
        error: { code: -32601, message: `OMA runner does not permit interactive request ${message.method}` },
      });
      return;
    }
    if (message.method) {
      const event = { method: message.method, params: message.params };
      this.events.push(event);
      for (const waiter of [...this.waiters]) {
        if (waiter.method === event.method && waiter.predicate(event.params)) {
          clearTimeout(waiter.timer);
          this.waiters.splice(this.waiters.indexOf(waiter), 1);
          waiter.resolve(event.params);
        }
      }
    }
  }

  failAll(error) {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    for (const waiter of this.waiters) waiter.reject(error);
    this.waiters.length = 0;
  }

  send(message) {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(String(id), { resolve, reject });
      this.send({ id, method, params });
    });
  }

  notify(method, params) {
    this.send(params === undefined ? { method } : { method, params });
  }

  waitFor(method, predicate, fromIndex, timeoutMs = 180000) {
    const existing = this.events.slice(fromIndex).find(
      (event) => event.method === method && predicate(event.params),
    );
    if (existing) return Promise.resolve(existing.params);
    return new Promise((resolve, reject) => {
      const waiter = { method, predicate, resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        reject(new Error(`Timed out waiting for ${method}. ${this.stderr}`));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  async close() {
    if (!this.child || this.child.exitCode !== null) return;
    this.child.stdin.end();
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.child.kill();
        resolve();
      }, 2000);
      this.child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

export class AppServerAdapter {
  constructor({ repoRoot, workspace }) {
    this.repoRoot = repoRoot;
    this.workspace = workspace;
    this.client = new AppServerClient();
  }

  async start() {
    await this.client.start();
  }

  async discover() {
    const response = await this.client.request("skills/list", {
      cwds: [this.repoRoot],
      forceReload: true,
    });
    const entry = response.data.find(
      (candidate) => path.resolve(candidate.cwd) === path.resolve(this.repoRoot),
    ) ?? response.data[0];
    if (entry?.errors?.length) {
      throw new Error(`Skill discovery failed: ${JSON.stringify(entry.errors)}`);
    }
    return (entry?.skills ?? []).map((skill) => skill.name);
  }

  async invoke({ stage, skill, skillPath, state }) {
    const isImplementation = stage === "code";
    const baseInstructions = isImplementation
      ? "Implement only the supplied autonomous stage. Never ask the user a question. Return the requested JSON object."
      : "Complete only the supplied read-only planning or review stage. Do not modify files. Never ask the user a question. Return the requested JSON object.";
    const threadResponse = await this.client.request("thread/start", {
      cwd: this.workspace,
      runtimeWorkspaceRoots: [this.workspace],
      approvalPolicy: "never",
      sandbox: isImplementation ? "workspace-write" : "read-only",
      ephemeral: true,
      baseInstructions,
    });
    const threadId = threadResponse.thread.id;
    const eventIndex = this.client.events.length;
    const turnResponse = await this.client.request("turn/start", {
      threadId,
      input: [
        { type: "skill", name: skill, path: skillPath },
        { type: "text", text: makePrompt(state) },
      ],
      outputSchema: OUTPUT_SCHEMA,
      approvalPolicy: "never",
      cwd: this.workspace,
    });
    const turnId = turnResponse.turn.id;
    const completed = await this.client.waitFor(
      "turn/completed",
      (params) => params.threadId === threadId && params.turn.id === turnId,
      eventIndex,
    );
    if (completed.turn.status !== "completed") {
      throw new Error(`Stage ${stage} failed: ${JSON.stringify(completed.turn.error)}`);
    }
    const message = [...completed.turn.items].reverse().find((item) => item.type === "agentMessage");
    if (!message) throw new Error(`Stage ${stage} returned no agent message.`);
    return { threadId, result: JSON.parse(message.text) };
  }

  async close() {
    await this.client.close();
  }
}

function validateResult(result, stage) {
  if (!result || !["completed", "revise", "failed"].includes(result.status)) {
    throw new Error(`Stage ${stage} returned an invalid status.`);
  }
  if (typeof result.summary !== "string" || !Array.isArray(result.evidence)) {
    throw new Error(`Stage ${stage} returned an invalid payload.`);
  }
}

function advance(state, invocation, maxRevisions) {
  const { stage } = state;
  const { result, threadId } = invocation;
  validateResult(result, stage);
  state.trace.push({
    sequence: state.trace.length + 1,
    stage,
    skill: stageSkill(stage),
    threadId,
    status: result.status,
  });
  state.evidence.push(...result.evidence.map((item) => `${stage}: ${item}`));

  if (result.status === "failed") {
    state.status = "failed";
    state.stage = "failed";
    state.feedback = result.summary;
    return;
  }
  if (stage === "plan") {
    if (result.status !== "completed") {
      throw new Error("Producer stage plan cannot request its own revision.");
    }
    state.plan = result;
    state.feedback = null;
    state.stage = "plan_review";
    return;
  }
  if (stage === "plan_review") {
    if (result.status === "completed") {
      state.feedback = null;
      state.stage = "code";
      return;
    }
    state.planAttempt += 1;
    if (state.planAttempt > maxRevisions + 1) {
      state.status = "failed";
      state.stage = "failed";
      state.feedback = `Plan review exceeded ${maxRevisions} revisions.`;
      return;
    }
    state.feedback = result.feedback ?? result.summary;
    state.stage = "plan";
    return;
  }
  if (stage === "code") {
    if (result.status !== "completed") {
      throw new Error("Producer stage code cannot request its own revision.");
    }
    state.implementation = result;
    state.feedback = null;
    state.stage = "code_review";
    return;
  }
  if (result.status === "completed") {
    state.status = "succeeded";
    state.stage = "completed";
    state.feedback = null;
    return;
  }
  state.codeAttempt += 1;
  if (state.codeAttempt > maxRevisions + 1) {
    state.status = "failed";
    state.stage = "failed";
    state.feedback = `Code review exceeded ${maxRevisions} revisions.`;
    return;
  }
  state.feedback = result.feedback ?? result.summary;
  state.stage = "code";
}

export async function runWorkflow({
  runDir,
  workspace,
  requirement,
  requirementFile = null,
  adapter,
  maxStages = Infinity,
  maxRevisions = 2,
}) {
  const statePath = path.join(runDir, "state.json");
  let state = await readState(statePath);
  if (!state) {
    state = initialState(requirement, workspace, requirementFile);
    await writeJsonAtomic(statePath, state);
  } else if (
    state.requirement !== requirement
    || (state.requirementFile ?? null) !== (requirementFile ? path.resolve(requirementFile) : null)
    || path.resolve(state.workspace) !== path.resolve(workspace)
  ) {
    throw new Error("Existing run state does not match the supplied requirement and workspace.");
  }
  if (TERMINAL.has(state.status)) return state;

  const requiredSkills = ["oma-delivery", "oma-plan", "oma-code", "oma-review"];
  const discovered = await adapter.discover();
  const missing = requiredSkills.filter((name) => !discovered.includes(name));
  if (missing.length) throw new Error(`Missing skills: ${missing.join(", ")}`);

  let executed = 0;
  while (state.status === "running" && executed < maxStages) {
    if (!STAGES.includes(state.stage)) throw new Error(`Unknown stage ${state.stage}`);
    const skill = stageSkill(state.stage);
    const skillPath = path.join(SKILLS_ROOT, skill, "SKILL.md");
    const invocation = await adapter.invoke({
      stage: state.stage,
      skill,
      skillPath,
      state,
    });
    advance(state, invocation, maxRevisions);
    state.updatedAt = new Date().toISOString();
    await writeJsonAtomic(statePath, state);
    executed += 1;
  }
  return state;
}

async function main() {
  const values = parseArgs(process.argv.slice(2));
  const repoRoot = path.resolve(SCRIPT_DIR, "..", "..", "..", "..");
  const runDir = requiredPath(values, "run-dir");
  const workspace = requiredPath(values, "workspace");
  const requirementInput = await loadRequirementInput({
    requirement: values.requirement,
    requirementFile: values["requirement-file"],
  });
  const adapter = new AppServerAdapter({ repoRoot, workspace });
  try {
    if (adapter.start) await adapter.start();
    const state = await runWorkflow({
      runDir,
      workspace,
      ...requirementInput,
      adapter,
      maxRevisions: values["max-revisions"] ? Number(values["max-revisions"]) : 2,
    });
    process.stdout.write(`${JSON.stringify(state, null, 2)}\n`);
    process.exitCode = state.status === "failed" ? 2 : 0;
  } finally {
    await adapter.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === MODULE_PATH) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}
