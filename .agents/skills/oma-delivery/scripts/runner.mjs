#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

import { ensureWorktree } from "./worktree.mjs";

const MODULE_PATH = fileURLToPath(import.meta.url);
const SCRIPT_DIR = path.dirname(MODULE_PATH);
const SKILLS_ROOT = path.resolve(SCRIPT_DIR, "..", "..");
const STAGES = ["plan", "plan_review", "code", "code_review"];
const TERMINAL = new Set(["succeeded", "failed", "cancelled"]);
const DEFAULT_STAGE_TIMEOUT_MS = 30 * 60 * 1000;
const INTERRUPT_TIMEOUT_MS = 10 * 1000;
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
    const name = key.slice(2);
    if (name === "requirement-input") {
      values[name] = [...(values[name] ?? []), value];
    } else {
      values[name] = value;
    }
  }
  return values;
}

function requiredPath(values, key) {
  const value = values[key];
  if (!value) throw new Error(`Missing --${key}`);
  return path.resolve(value);
}

function positiveInteger(values, key, fallback) {
  if (values[key] === undefined) return fallback;
  const value = Number(values[key]);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`--${key} must be a positive integer.`);
  }
  return value;
}

function booleanValue(values, key, fallback = false) {
  if (values[key] === undefined) return fallback;
  if (values[key] === "true") return true;
  if (values[key] === "false") return false;
  throw new Error(`--${key} must be true or false.`);
}

export function findNearestLocalCodex(startDirectory) {
  let current = path.resolve(startDirectory);
  while (true) {
    const candidate = path.join(current, "node_modules", "@openai", "codex", "bin", "codex.js");
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function infrastructureFailure(error, stage) {
  const message = error?.message ?? String(error);
  let kind = "infrastructure_error";
  if (error?.code === "OMA_STAGE_TIMEOUT") kind = "stage_timeout";
  else if (/requires a newer version of Codex/i.test(message)) kind = "runtime_incompatible";
  else if (/spawn EPERM/i.test(message)) kind = "runtime_spawn_failed";
  return {
    kind,
    recoverable: true,
    stage,
    message,
    timestamp: new Date().toISOString(),
  };
}

function recoverableFailure(state) {
  if (state.failure?.recoverable && STAGES.includes(state.failure.stage)) {
    return state.failure;
  }
  const legacyTimeout = [...(state.trace ?? [])].reverse().find(
    (item) => item.reason === "runner_timeout" && STAGES.includes(item.stage),
  );
  if (!legacyTimeout) return null;
  return {
    kind: "stage_timeout",
    recoverable: true,
    stage: legacyTimeout.stage,
    message: state.feedback ?? "Legacy Runner timeout.",
  };
}

async function persistInfrastructureFailure(state, statePath, error, stage) {
  const failure = infrastructureFailure(error, stage);
  state.trace.push({
    sequence: state.trace.length + 1,
    stage,
    skill: stageSkill(stage),
    status: "failed",
    failureKind: failure.kind,
  });
  state.status = "failed";
  state.stage = "failed";
  state.feedback = failure.message;
  state.failure = failure;
  state.updatedAt = failure.timestamp;
  await writeJsonAtomic(statePath, state);
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

function initialState(requirementSnapshot, sourceWorkspace) {
  const now = new Date().toISOString();
  return {
    version: 2,
    status: "running",
    stage: "plan",
    requirement: requirementSnapshot.requirement,
    requirementFile: requirementSnapshot.inputs[0]?.path ?? null,
    requirementInputs: requirementSnapshot.inputs,
    requirementSha256: requirementSnapshot.sha256,
    sourceWorkspace: path.resolve(sourceWorkspace),
    executionWorkspace: null,
    workspace: path.resolve(sourceWorkspace),
    worktree: null,
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

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function validateRoles(inputs) {
  const bases = inputs.filter((input) => ["primary", "generated"].includes(input.role));
  if (bases.length !== 1) throw new Error("Requirement inputs need exactly one primary or generated input.");
  if (inputs.some((input) => !["primary", "generated", "supplement"].includes(input.role))) {
    throw new Error("Requirement input role must be primary, generated, or supplement.");
  }
}

function parseRequirementArgument(value) {
  const separator = value.indexOf("=");
  if (separator <= 0 || separator === value.length - 1) {
    throw new Error("--requirement-input must use role=absolute-path.");
  }
  return { role: value.slice(0, separator), path: value.slice(separator + 1) };
}

export async function loadRequirementInput({ requirement, requirementFile, requirementInputs = null }) {
  const modes = Number(Boolean(requirement)) + Number(Boolean(requirementFile)) + Number(Boolean(requirementInputs?.length));
  if (modes !== 1) throw new Error("Provide exactly one requirement string, --requirement-file, or requirement input list.");
  if (requirement) {
    if (!requirement.trim()) throw new Error("Confirmed requirement is empty.");
    const content = String(requirement);
    return { requirement: content, requirementFile: null, inputs: [], sha256: hash(Buffer.from(content, "utf8")) };
  }
  const specs = requirementInputs?.length
    ? requirementInputs.map((item) => typeof item === "string" ? parseRequirementArgument(item) : item)
    : [{ role: "primary", path: requirementFile }];
  validateRoles(specs);
  const inputs = [];
  for (const spec of specs) {
    if (!path.isAbsolute(spec.path)) throw new Error("Requirement input paths must be absolute.");
    const resolved = path.resolve(spec.path);
    const bytes = await readFile(resolved);
    const content = bytes.toString("utf8");
    if (!content.trim()) throw new Error(`Confirmed requirement file is empty: ${resolved}`);
    inputs.push({ role: spec.role, path: resolved, content, sha256: hash(bytes) });
  }
  const requirementText = inputs.map((input) => `## ${input.role}\n\n${input.content}`).join("\n\n");
  return {
    requirement: requirementText,
    requirementFile: inputs[0].path,
    inputs,
    sha256: hash(inputs.map((input) => `${input.role}\0${input.path}\0${input.sha256}`).join("\0")),
  };
}

function stageSkill(stage) {
  if (stage === "plan") return "oma-plan";
  if (stage === "code") return "oma-code";
  return "oma-review";
}

function makePrompt(state) {
  const shared = `Confirmed requirement:\n${state.requirement}\n\nExecution workspace: ${state.executionWorkspace}`;
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

export class AppServerClient {
  constructor({ codexJs = null } = {}) {
    this.nextId = 1;
    this.pending = new Map();
    this.events = [];
    this.waiters = [];
    this.stderr = "";
    this.codexJs = codexJs ? path.resolve(codexJs) : null;
    this.runtime = null;
  }

  async start() {
    const localCodex = this.codexJs ?? findNearestLocalCodex(SCRIPT_DIR);
    if (this.codexJs && !existsSync(this.codexJs)) {
      throw new Error(`Configured Codex JavaScript entry does not exist: ${this.codexJs}`);
    }
    const useLocalCodex = Boolean(localCodex);
    const command = useLocalCodex
      ? process.execPath
      : process.platform === "win32" ? (process.env.ComSpec ?? "cmd.exe") : "codex";
    const args = useLocalCodex
      ? [localCodex, "app-server", "--stdio"]
      : process.platform === "win32"
        ? ["/d", "/s", "/c", "codex app-server --stdio"]
        : ["app-server", "--stdio"];
    this.runtime = useLocalCodex ? localCodex : "codex from PATH";
    this.child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk) => { this.stderr += chunk; });
    this.child.on("exit", (code) => {
      const error = new Error(`App Server exited with code ${code}. ${this.stderr}`);
      this.failAll(error);
    });
    this.child.on("error", (error) => this.failAll(error));
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
      if (pending.timer) clearTimeout(pending.timer);
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
    for (const pending of this.pending.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.waiters.length = 0;
  }

  send(message) {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(method, params, timeoutMs = null) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const pending = { resolve, reject, timer: null };
      if (timeoutMs !== null) {
        pending.timer = setTimeout(() => {
          this.pending.delete(String(id));
          reject(new Error(`Timed out waiting for response to ${method}.`));
        }, timeoutMs);
      }
      this.pending.set(String(id), pending);
      this.send({ id, method, params });
    });
  }

  notify(method, params) {
    this.send(params === undefined ? { method } : { method, params });
  }

  waitFor(method, predicate, fromIndex, timeoutMs = DEFAULT_STAGE_TIMEOUT_MS) {
    const existing = this.events.slice(fromIndex).find(
      (event) => event.method === method && predicate(event.params),
    );
    if (existing) return Promise.resolve(existing.params);
    return new Promise((resolve, reject) => {
      const waiter = { method, predicate, resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        const error = new Error(`Timed out waiting for ${method}. ${this.stderr}`);
        error.code = "OMA_STAGE_TIMEOUT";
        reject(error);
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
  constructor({ workspace, stageTimeoutMs = DEFAULT_STAGE_TIMEOUT_MS, codexJs = null, client = null }) {
    this.workspace = workspace;
    this.stageTimeoutMs = stageTimeoutMs;
    this.client = client ?? new AppServerClient({ codexJs });
  }

  async start() {
    await this.client.start();
    process.stderr.write(`OMA Runner Codex runtime: ${this.client.runtime}\n`);
  }

  async discover() {
    const response = await this.client.request("skills/list", {
      cwds: [this.workspace],
      forceReload: true,
    });
    const entry = response.data.find(
      (candidate) => path.resolve(candidate.cwd) === path.resolve(this.workspace),
    ) ?? response.data[0];
    if (entry?.errors?.length) {
      throw new Error(`Skill discovery failed: ${JSON.stringify(entry.errors)}`);
    }
    return (entry?.skills ?? []).map((skill) => skill.name);
  }

  async invoke({ stage, skill, skillPath, state }) {
    const isImplementation = stage === "code";
    const baseInstructions = isImplementation
      ? "Implement only the supplied autonomous stage. Never ask the user a question. Do not run git commit, merge, push, worktree remove, or worktree prune. Return the requested JSON object."
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
    let completed;
    try {
      completed = await this.client.waitFor(
        "turn/completed",
        (params) => params.threadId === threadId && params.turn.id === turnId,
        eventIndex,
        this.stageTimeoutMs,
      );
    } catch (error) {
      if (error?.code === "OMA_STAGE_TIMEOUT") {
        try {
          await this.client.request(
            "turn/interrupt",
            { threadId, turnId },
            INTERRUPT_TIMEOUT_MS,
          );
        } catch (interruptError) {
          error.message += ` Failed to interrupt timed-out turn: ${interruptError.message}`;
        }
      }
      throw error;
    }
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
  requirementInputs = null,
  adapter = null,
  adapterFactory = null,
  worktreeFactory = ensureWorktree,
  runId = path.basename(path.resolve(runDir)),
  maxStages = Infinity,
  maxRevisions = 2,
  resumeFailed = false,
}) {
  const statePath = path.join(runDir, "state.json");
  const sourceWorkspace = path.resolve(workspace);
  let state = await readState(statePath);
  let supplied;
  try {
    supplied = await loadRequirementInput({ requirement, requirementFile, requirementInputs });
  } catch (error) {
    if (!state) {
      const now = new Date().toISOString();
      await writeJsonAtomic(statePath, {
        version: 2,
        status: "failed",
        stage: "failed",
        sourceWorkspace,
        executionWorkspace: null,
        workspace: sourceWorkspace,
        requirement: null,
        requirementFile: null,
        requirementInputs: [],
        requirementSha256: null,
        worktree: null,
        planAttempt: 1,
        codeAttempt: 1,
        plan: null,
        implementation: null,
        feedback: error.message,
        evidence: [],
        trace: [{ sequence: 1, stage: "preflight", skill: "oma-delivery", status: "failed", failureKind: "invalid_requirement_input" }],
        failure: { kind: "invalid_requirement_input", recoverable: false, stage: "preflight", message: error.message, timestamp: now },
        createdAt: now,
        updatedAt: now,
      });
    }
    throw error;
  }
  if (!state) {
    state = initialState(supplied, sourceWorkspace);
    await writeJsonAtomic(statePath, state);
  } else {
    const stateSourceWorkspace = state.sourceWorkspace ?? state.workspace;
    if (path.resolve(stateSourceWorkspace) !== sourceWorkspace) {
      throw new Error("Existing run state does not match the supplied source workspace.");
    }
    if (state.version === 1) {
      const legacyMatches = state.requirementFile
        ? supplied.inputs.length === 1
          && path.resolve(state.requirementFile) === supplied.inputs[0].path
          && state.requirement === supplied.inputs[0].content.trim()
        : supplied.inputs.length === 0 && state.requirement === supplied.requirement.trim();
      if (!legacyMatches) throw new Error("Legacy run state does not match the supplied requirement.");
      state.version = 2;
      state.sourceWorkspace = sourceWorkspace;
      state.executionWorkspace = null;
      state.requirement = supplied.requirement;
      state.requirementInputs = supplied.inputs;
      state.requirementSha256 = supplied.sha256;
      state.worktree = null;
      await writeJsonAtomic(statePath, state);
    } else if (
      state.requirementSha256 !== supplied.sha256
      || JSON.stringify(state.requirementInputs ?? []) !== JSON.stringify(supplied.inputs)
    ) {
      throw new Error("Requirement inputs changed after the run was frozen. Start a new run or explicitly restart it.");
    }
  }
  if (TERMINAL.has(state.status)) {
    const failure = resumeFailed && state.status === "failed" ? recoverableFailure(state) : null;
    if (!failure) return state;
    const failedStage = failure.stage;
    state.trace.push({
      sequence: state.trace.length + 1,
      stage: failedStage,
      skill: stageSkill(failedStage),
      status: "resumed",
      failureKind: failure.kind,
    });
    state.status = "running";
    state.stage = failedStage;
    state.feedback = null;
    state.failure = null;
    state.updatedAt = new Date().toISOString();
    await writeJsonAtomic(statePath, state);
  }

  let worktree;
  try {
    worktree = await worktreeFactory({ runDir, sourceWorkspace, runId });
  } catch (error) {
    await persistInfrastructureFailure(state, statePath, error, state.stage);
    throw error;
  }
  if (state.worktree) {
    for (const key of ["runKey", "branch", "baseCommit", "worktreeRoot", "executionWorkspace"]) {
      if (state.worktree[key] !== worktree[key]) throw new Error(`Existing worktree binding changed for ${key}.`);
    }
  }
  state.worktree = worktree;
  state.executionWorkspace = path.resolve(worktree.executionWorkspace);
  state.workspace = state.executionWorkspace;
  state.updatedAt = new Date().toISOString();
  await writeJsonAtomic(statePath, state);

  let activeAdapter = adapter;
  if (!activeAdapter) {
    if (typeof adapterFactory !== "function") throw new Error("An adapter or adapterFactory is required.");
    try {
      activeAdapter = await adapterFactory({ workspace: state.executionWorkspace });
    } catch (error) {
      await persistInfrastructureFailure(state, statePath, error, state.stage);
      throw error;
    }
  }

  const requiredSkills = ["oma-delivery", "oma-plan", "oma-code", "oma-review"];
  let discovered;
  try {
    if (activeAdapter.start) await activeAdapter.start();
    discovered = await activeAdapter.discover();
  } catch (error) {
    await persistInfrastructureFailure(state, statePath, error, state.stage);
    throw error;
  }
  const missing = requiredSkills.filter((name) => !discovered.includes(name));
  if (missing.length) {
    const error = new Error(`Missing skills: ${missing.join(", ")}`);
    await persistInfrastructureFailure(state, statePath, error, state.stage);
    throw error;
  }

  let executed = 0;
  while (state.status === "running" && executed < maxStages) {
    if (!STAGES.includes(state.stage)) throw new Error(`Unknown stage ${state.stage}`);
    const skill = stageSkill(state.stage);
    const skillPath = path.join(SKILLS_ROOT, skill, "SKILL.md");
    let invocation;
    try {
      invocation = await activeAdapter.invoke({
        stage: state.stage,
        skill,
        skillPath,
        state,
      });
    } catch (error) {
      await persistInfrastructureFailure(state, statePath, error, state.stage);
      throw error;
    }
    advance(state, invocation, maxRevisions);
    state.updatedAt = new Date().toISOString();
    await writeJsonAtomic(statePath, state);
    executed += 1;
  }
  return state;
}

async function main() {
  const values = parseArgs(process.argv.slice(2));
  const runDir = requiredPath(values, "run-dir");
  const workspace = requiredPath(values, "workspace");
  const stageTimeoutMs = positiveInteger(values, "stage-timeout-ms", DEFAULT_STAGE_TIMEOUT_MS);
  const resumeFailed = booleanValue(values, "resume-failed");
  const codexJs = values["codex-js"] ? requiredPath(values, "codex-js") : null;
  let adapter = null;
  try {
    const state = await runWorkflow({
      runDir,
      workspace,
      requirement: values.requirement,
      requirementFile: values["requirement-file"],
      requirementInputs: values["requirement-input"],
      adapterFactory: ({ workspace: executionWorkspace }) => {
        adapter = new AppServerAdapter({ workspace: executionWorkspace, stageTimeoutMs, codexJs });
        return adapter;
      },
      maxRevisions: values["max-revisions"] ? Number(values["max-revisions"]) : 2,
      resumeFailed,
    });
    process.stdout.write(`${JSON.stringify(state, null, 2)}\n`);
    process.exitCode = state.status === "failed" ? 2 : 0;
  } finally {
    if (adapter) await adapter.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === MODULE_PATH) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}
