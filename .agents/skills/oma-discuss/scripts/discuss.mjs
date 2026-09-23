#!/usr/bin/env node

import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { ensureWorktree, inspectGitWorkspace, withFileLock } from "../../oma-delivery/scripts/worktree.mjs";

const MODULE_PATH = fileURLToPath(import.meta.url);
const CONFIRMATION_CATEGORIES = new Set(["scope", "business", "data", "boundary", "acceptance", "permission"]);
const DEFAULT_DRAFT = `# Requirement Draft

## Goal

To be discussed.

## Confirmed scope

## Explicit exclusions

## Acceptance criteria

## Permission envelope

## Open decisions
`;

function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!command) throw new Error("Missing command.");
  const values = {};
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index];
    const value = rest[index + 1];
    if (!key?.startsWith("--") || value === undefined) throw new Error(`Invalid argument near ${key ?? "<end>"}`);
    values[key.slice(2)] = value;
  }
  return { command, values };
}

function required(values, key) {
  const value = values[key];
  if (!value) throw new Error(`Missing --${key}`);
  return value;
}

function normalizeMarkdown(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string.`);
  return `${value.trim()}\n`;
}

function validateIdentifier(value, label) {
  if (typeof value !== "string" || !value.trim() || value.length > 512) {
    throw new Error(`${label} must be a non-empty string of at most 512 characters.`);
  }
  const normalized = value.trim();
  if (["__proto__", "prototype", "constructor"].includes(normalized)) {
    throw new Error(`${label} uses a reserved value.`);
  }
  return normalized;
}

function pathsFor(runDir) {
  const root = path.resolve(runDir);
  return {
    root,
    state: path.join(root, "discussion-state.json"),
    log: path.join(root, "discussion.jsonl"),
    draft: path.join(root, "requirement-draft.md"),
    requirement: path.join(root, "requirement.md"),
    supplement: path.join(root, "requirement-supplement.md"),
    proposal: path.join(root, "requirement-proposal.json"),
  };
}

async function readOptional(filePath, encoding = "utf8") {
  try { return await readFile(filePath, encoding); } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function readJson(filePath) {
  const content = await readOptional(filePath);
  return content === null ? null : JSON.parse(content);
}

async function writeTextAtomic(filePath, content) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.next`;
  await writeFile(temporaryPath, content, "utf8");
  await rename(temporaryPath, filePath);
}

async function writeJsonAtomic(filePath, value) {
  await writeTextAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function appendTurn(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await appendFile(filePath, `${JSON.stringify(value)}\n`, "utf8");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function bindingFiles(workspace) {
  const omaRoot = path.join(path.resolve(workspace), ".oma");
  return {
    registry: path.join(omaRoot, "task-bindings.json"),
    lock: path.join(omaRoot, "locks", "task-bindings.lock"),
    runs: path.join(omaRoot, "runs"),
  };
}

function emptyRegistry() {
  return { version: 1, taskToRun: {}, runToTask: {}, updatedAt: null };
}

async function updateBinding({ workspace, taskId, runId, allowMigration = false, onBound = null }) {
  const task = validateIdentifier(taskId, "taskId");
  const run = validateIdentifier(runId, "runId");
  const files = bindingFiles(workspace);
  return withFileLock(files.lock, async () => {
    const registry = await readJson(files.registry) ?? emptyRegistry();
    const taskRun = registry.taskToRun[task];
    const runTask = registry.runToTask[run];
    if (taskRun && taskRun !== run) throw new Error(`Codex task is already bound to run ${taskRun}.`);
    if (runTask && runTask !== task && !allowMigration) throw new Error(`Run ${run} is already bound to another Codex task.`);
    if (runTask && runTask !== task) delete registry.taskToRun[runTask];
    registry.taskToRun[task] = run;
    registry.runToTask[run] = task;
    registry.updatedAt = new Date().toISOString();
    if (onBound) await onBound();
    await writeJsonAtomic(files.registry, registry);
    return registry;
  });
}

function isActive(discussion, delivery) {
  if (delivery) return delivery.status === "running" || (delivery.status === "failed" && delivery.failure?.recoverable === true);
  return ["discussing", "confirmed"].includes(discussion?.status);
}

export async function listActiveRuns({ workspace }) {
  const runsRoot = bindingFiles(workspace).runs;
  let entries;
  try { entries = await readdir(runsRoot, { withFileTypes: true }); } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const active = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const runDir = path.join(runsRoot, entry.name);
    const discussion = await readJson(path.join(runDir, "discussion-state.json"));
    const delivery = await readJson(path.join(runDir, "state.json"));
    if (isActive(discussion, delivery)) {
      active.push({ runId: entry.name, title: discussion?.title ?? entry.name, status: delivery?.status ?? discussion?.status });
    }
  }
  return active;
}

export async function resolveRunSelection({ workspace, taskId, intent = "continue", runId = null, title = null, allowMigration = false, newRequest = null, newTitle = null }) {
  const task = validateIdentifier(taskId, "taskId");
  const files = bindingFiles(workspace);
  const registry = await readJson(files.registry) ?? emptyRegistry();
  const bound = registry.taskToRun[task];
  if (intent === "new" && bound) {
    if (typeof newRequest !== "string" || !newRequest.trim()) throw new Error("newRequest is required to create a native Codex task.");
    const taskTitle = typeof newTitle === "string" && newTitle.trim() ? newTitle.trim() : `OMA: ${newRequest.trim().slice(0, 72)}`;
    return {
      action: "create-native-task",
      boundRunId: bound,
      nativeActions: [
        { tool: "fork_thread", arguments: { environment: { type: "same-directory" } }, saveAs: "child" },
        { tool: "set_thread_title", arguments: { threadId: "$child.threadId", title: taskTitle } },
        { tool: "send_message_to_thread", arguments: { threadId: "$child.threadId", prompt: `$oma-delivery 新建 OMA：${newRequest.trim()}` } },
        { tool: "navigate_to_codex_page", arguments: { threadId: "$child.threadId" } },
      ],
    };
  }
  if (bound && !runId && !title) return { action: "resume", runId: bound };
  const active = await listActiveRuns({ workspace });
  let target;
  if (runId) target = active.find((candidate) => candidate.runId === runId);
  else if (title) {
    const matches = active.filter((candidate) => candidate.title === title);
    if (matches.length > 1) throw new Error(`Multiple active runs have title ${title}. Use the exact run ID.`);
    [target] = matches;
  }
  if (runId || title) {
    if (!target) throw new Error("Requested active run was not found.");
    const oldTask = registry.runToTask[target.runId];
    const statePath = path.join(files.runs, target.runId, "discussion-state.json");
    const state = await readJson(statePath);
    await updateBinding({
      workspace,
      taskId: task,
      runId: target.runId,
      allowMigration,
      onBound: state
        ? () => writeJsonAtomic(statePath, { ...state, version: 2, runId: target.runId, codexTaskId: task, updatedAt: new Date().toISOString() })
        : null,
    });
    return { action: "resume", runId: target.runId, migrated: Boolean(oldTask && oldTask !== task) };
  }
  if (intent === "new") return { action: "create", active };
  return { action: "select", active };
}

function validateTurn(input, markdownKey) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Discussion input must be a JSON object.");
  for (const key of ["userMessage", "assistantMessage", markdownKey]) {
    if (typeof input[key] !== "string" || !input[key].trim()) throw new Error(`${key} must be a non-empty string.`);
  }
}

export async function createDiscussion({ runDir, workspace, taskId, runId = path.basename(path.resolve(runDir)), title = "Untitled requirement", explicitResume = false }) {
  const files = pathsFor(runDir);
  const resolvedWorkspace = path.resolve(workspace);
  const task = validateIdentifier(taskId, "taskId");
  const run = validateIdentifier(runId, "runId");
  const existing = await readJson(files.state);
  if (existing && path.resolve(existing.workspace) !== resolvedWorkspace) throw new Error("Existing discussion belongs to a different workspace.");
  if (existing?.codexTaskId && existing.codexTaskId !== task && !explicitResume) throw new Error("Existing discussion is bound to a different Codex task.");
  if (existing) {
    const adopted = { ...existing, version: 2, runId: run, codexTaskId: task, updatedAt: new Date().toISOString() };
    await updateBinding({
      workspace: resolvedWorkspace,
      taskId: task,
      runId: run,
      allowMigration: explicitResume,
      onBound: () => writeJsonAtomic(files.state, adopted),
    });
    return adopted;
  }
  const now = new Date().toISOString();
  const state = {
    version: 2, runId: run, codexTaskId: task, status: "discussing", workspace: resolvedWorkspace, title,
    turnCount: 0, confirmationItems: [], requirementMode: null, requirementPath: null,
    requirementInputs: [], requirementSha256: null, proposal: null, worktree: null,
    createdAt: now, updatedAt: now,
  };
  await updateBinding({
    workspace: resolvedWorkspace,
    taskId: task,
    runId: run,
    allowMigration: explicitResume,
    onBound: async () => {
      await mkdir(files.root, { recursive: true });
      await writeTextAtomic(files.draft, DEFAULT_DRAFT);
      await writeJsonAtomic(files.state, state);
    },
  });
  return state;
}

export async function loadDiscussion({ runDir }) {
  const files = pathsFor(runDir);
  const state = await readJson(files.state);
  if (!state) throw new Error("Discussion state does not exist.");
  const log = await readOptional(files.log);
  return {
    state,
    draftMarkdown: await readOptional(files.draft),
    requirementMarkdown: await readOptional(files.requirement),
    turns: log ? log.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line)) : [],
    files,
  };
}

export async function recordDiscussionTurn({ runDir, userMessage, assistantMessage, draftMarkdown }) {
  const discussion = await loadDiscussion({ runDir });
  if (discussion.state.status !== "discussing") throw new Error("Confirmed discussions cannot be changed.");
  validateTurn({ userMessage, assistantMessage, draftMarkdown }, "draftMarkdown");
  const now = new Date().toISOString();
  const sequence = discussion.state.turnCount + 1;
  await writeTextAtomic(discussion.files.draft, normalizeMarkdown(draftMarkdown, "draftMarkdown"));
  await appendTurn(discussion.files.log, { sequence, type: "discussion", timestamp: now, userMessage, assistantMessage });
  const state = { ...discussion.state, turnCount: sequence, updatedAt: now };
  await writeJsonAtomic(discussion.files.state, state);
  return state;
}

function normalizedOptions(item) {
  const alternatives = Array.isArray(item.otherOptions) ? item.otherOptions : [];
  return [item.recommendedOption, ...alternatives].map((option) => typeof option === "string" ? option : option?.value);
}

function stableConfirmationShape(item) {
  const { answer: _answer, ...shape } = item;
  return JSON.stringify(shape);
}

function validateConfirmationConsistency(items) {
  const byId = new Map(items.map((item) => [item.id, item]));
  for (const item of items) {
    for (const dependency of item.dependsOn ?? []) {
      const target = byId.get(dependency.itemId);
      if (!target) throw new Error(`Confirmation item ${item.id} depends on unknown item ${dependency.itemId}.`);
      if (item.answer && !target.answer) throw new Error(`Confirmation item ${item.id} depends on unanswered item ${dependency.itemId}.`);
      if (item.answer && Array.isArray(dependency.values) && !dependency.values.includes(target.answer)) {
        throw new Error(`Answer for ${item.id} is incompatible with dependency ${dependency.itemId}.`);
      }
    }
    for (const conflict of item.conflictsWith ?? []) {
      const target = byId.get(conflict.itemId);
      if (!target) throw new Error(`Confirmation item ${item.id} conflicts with unknown item ${conflict.itemId}.`);
      const thisValues = conflict.when ?? normalizedOptions(item);
      const targetValues = conflict.values ?? normalizedOptions(target);
      if (item.answer && target.answer && thisValues.includes(item.answer) && targetValues.includes(target.answer)) {
        throw new Error(`Answers for ${item.id} and ${target.id} conflict.`);
      }
    }
  }
}

export async function setConfirmationItems({ runDir, items }) {
  const discussion = await loadDiscussion({ runDir });
  if (discussion.state.status !== "discussing") throw new Error("Confirmed discussions cannot be changed.");
  if (!Array.isArray(items)) throw new Error("Confirmation items must be an array.");
  const ids = new Set();
  const previous = new Map(discussion.state.confirmationItems.map((item) => [item.id, item]));
  const normalized = items.map((item) => {
    for (const key of ["id", "category", "currentUnderstanding", "recommendedOption", "impact"]) {
      if (typeof item?.[key] !== "string" || !item[key].trim()) throw new Error(`Confirmation item ${key} is required.`);
    }
    if (!CONFIRMATION_CATEGORIES.has(item.category)) throw new Error(`Unsupported confirmation category ${item.category}.`);
    if (ids.has(item.id)) throw new Error(`Duplicate confirmation item ${item.id}.`);
    ids.add(item.id);
    const existing = previous.get(item.id);
    if (existing && stableConfirmationShape(existing) !== stableConfirmationShape({ ...item, answer: existing.answer })) {
      throw new Error(`Confirmation item ${item.id} changed after its stable ID was assigned.`);
    }
    return { ...item, answer: existing?.answer ?? item.answer ?? null };
  });
  const additions = normalized.filter((item) => !previous.has(item.id));
  const confirmationItems = [...discussion.state.confirmationItems, ...additions];
  validateConfirmationConsistency(confirmationItems);
  const state = { ...discussion.state, confirmationItems, updatedAt: new Date().toISOString() };
  await writeJsonAtomic(discussion.files.state, state);
  return state;
}

export async function answerConfirmationItems({ runDir, answers = {}, allRecommended = false }) {
  const discussion = await loadDiscussion({ runDir });
  if (discussion.state.status !== "discussing") throw new Error("Confirmed discussions cannot be changed.");
  const known = new Set(discussion.state.confirmationItems.map((item) => item.id));
  for (const id of Object.keys(answers)) if (!known.has(id)) throw new Error(`Unknown confirmation item ${id}.`);
  const confirmationItems = discussion.state.confirmationItems.map((item) => {
    const answer = allRecommended ? item.recommendedOption : (answers[item.id] ?? item.answer);
    if (answer !== null && !normalizedOptions(item).includes(answer)) throw new Error(`Invalid answer for confirmation item ${item.id}.`);
    return { ...item, answer };
  });
  validateConfirmationConsistency(confirmationItems);
  const state = { ...discussion.state, confirmationItems, updatedAt: new Date().toISOString() };
  await writeJsonAtomic(discussion.files.state, state);
  return state;
}

async function walkMarkdown(root, maxDepth = 3, depth = 0) {
  if (depth > maxDepth) return [];
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); } catch { return []; }
  const results = [];
  for (const entry of entries) {
    if ([".git", ".oma", "node_modules", "dist", "build"].includes(entry.name)) continue;
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) results.push(...await walkMarkdown(full, maxDepth, depth + 1));
    else if (entry.name.toLowerCase().endsWith(".md")) results.push(full);
  }
  return results;
}

export async function discoverRequirementConventions({ workspace }) {
  const root = path.resolve(workspace);
  const markdown = await walkMarkdown(root);
  const instructions = markdown.filter((file) => path.basename(file).toLowerCase() === "agents.md");
  const templates = markdown.filter((file) => /(?:requirement|feature).*(?:template)|template.*(?:requirement|feature)/i.test(path.basename(file)));
  const indexes = markdown.filter((file) => /(?:feature|requirement).*(?:index)|(?:index|readme)/i.test(path.basename(file)) && /(?:feature|requirement|docs)/i.test(file));
  const existing = markdown.filter((file) => /(?:^|[\\/])F\d{3,}[^\\/]*\.md$/i.test(file) || /(?:feature|requirement)/i.test(path.basename(file)));
  const candidateFiles = [
    ...instructions.map((file) => ({ priority: 1, kind: "instruction", path: file })),
    ...templates.map((file) => ({ priority: 2, kind: "template", path: file })),
    ...indexes.map((file) => ({ priority: 2, kind: "index", path: file })),
    ...existing.map((file) => ({ priority: 3, kind: "existing", path: file })),
  ].sort((a, b) => a.priority - b.priority || a.path.localeCompare(b.path));
  const candidates = await Promise.all(candidateFiles.map(async (candidate) => {
    const content = await readFile(candidate.path, "utf8");
    return {
      ...candidate,
      relativePath: path.relative(root, candidate.path),
      content,
      sha256: sha256(Buffer.from(content, "utf8")),
    };
  }));
  const topPriority = candidates[0]?.priority ?? null;
  const topCandidates = topPriority === null ? [] : candidates.filter((item) => item.priority === topPriority);
  return {
    workspace: root,
    candidates,
    preferred: topCandidates.length === 1 ? topCandidates[0] : null,
    ambiguous: topCandidates.length > 1,
  };
}

function safeRelativePath(value, label) {
  if (typeof value !== "string" || !value.trim() || path.isAbsolute(value)) throw new Error(`${label} must be a non-empty repository-relative path.`);
  const normalized = path.normalize(value);
  if (normalized === ".." || normalized.startsWith(`..${path.sep}`)) throw new Error(`${label} escapes the repository.`);
  return normalized;
}

export async function saveRequirementProposal({ runDir, requirementPath, changes, sources = [] }) {
  const discussion = await loadDiscussion({ runDir });
  if (discussion.state.status !== "discussing") throw new Error("Confirmed discussions cannot be changed.");
  if (!Array.isArray(changes) || changes.length === 0) throw new Error("Proposal changes must not be empty.");
  const gitInfo = await inspectGitWorkspace(discussion.state.workspace);
  const normalized = [];
  const seen = new Set();
  for (const change of changes) {
    const relativePath = safeRelativePath(change.path, "change.path");
    if (seen.has(relativePath)) throw new Error(`Duplicate proposal path ${relativePath}.`);
    seen.add(relativePath);
    const content = normalizeMarkdown(change.content, `content for ${relativePath}`);
    const current = await readOptional(path.join(gitInfo.repositoryRoot, relativePath), null);
    normalized.push({ path: relativePath, content, expectedSha256: current === null ? null : sha256(current) });
  }
  const requiredPath = safeRelativePath(requirementPath, "requirementPath");
  if (!seen.has(requiredPath)) throw new Error("Requirement path must be one of the proposed changes.");
  const proposal = { requirementPath: requiredPath, changes: normalized, sources, createdAt: new Date().toISOString() };
  proposal.sha256 = sha256(JSON.stringify(proposal));
  await writeJsonAtomic(discussion.files.proposal, proposal);
  const state = { ...discussion.state, proposal, updatedAt: new Date().toISOString() };
  await writeJsonAtomic(discussion.files.state, state);
  return state;
}

async function snapshotRequirement(filePath, role) {
  const resolved = path.resolve(filePath);
  const bytes = await readFile(resolved);
  const content = bytes.toString("utf8");
  if (!content.trim()) throw new Error(`Requirement input is empty: ${resolved}`);
  return { role, path: resolved, content, sha256: sha256(bytes) };
}

async function materializeProposal(discussion, worktreeFactory) {
  const proposal = discussion.state.proposal ?? await readJson(discussion.files.proposal);
  if (!proposal) throw new Error("No requirement document proposal has been saved.");
  const binding = await worktreeFactory({ runDir: discussion.files.root, sourceWorkspace: discussion.state.workspace, runId: discussion.state.runId });
  const pending = [];
  for (const change of proposal.changes) {
    const target = path.resolve(binding.worktreeRoot, change.path);
    if (!target.startsWith(`${path.resolve(binding.worktreeRoot)}${path.sep}`)) throw new Error("Proposal path escaped the worktree.");
    const current = await readOptional(target, null);
    const currentHash = current === null ? null : sha256(current);
    if (currentHash !== change.expectedSha256) throw new Error(`Proposal target changed before confirmation: ${change.path}`);
    pending.push({ target, content: change.content });
  }
  for (const change of pending) await writeTextAtomic(change.target, change.content);
  return { binding, requirementPath: path.join(binding.worktreeRoot, proposal.requirementPath) };
}

export async function confirmDiscussion({ runDir, userMessage, assistantMessage, requirementMarkdown = null, existingRequirementFile = null, supplementMarkdown = null, supplementFiles = [], writeProjectDocuments = false, worktreeFactory = ensureWorktree }) {
  const discussion = await loadDiscussion({ runDir });
  if (discussion.state.status !== "discussing") throw new Error("Discussion is already confirmed.");
  if (typeof userMessage !== "string" || !userMessage.trim() || typeof assistantMessage !== "string" || !assistantMessage.trim()) throw new Error("Confirmation messages must be non-empty strings.");
  const unresolved = discussion.state.confirmationItems.filter((item) => !item.answer);
  if (unresolved.length) throw new Error(`Unresolved confirmation items: ${unresolved.map((item) => item.id).join(", ")}`);
  validateConfirmationConsistency(discussion.state.confirmationItems);
  const now = new Date().toISOString();
  const sequence = discussion.state.turnCount + 1;
  let requirementPath;
  let requirementMode;
  let worktree = discussion.state.worktree;
  const inputs = [];
  if (existingRequirementFile) {
    requirementMode = "existing";
    requirementPath = path.resolve(existingRequirementFile);
    inputs.push(await snapshotRequirement(requirementPath, "primary"));
  } else if (writeProjectDocuments) {
    requirementMode = "project";
    const materialized = await materializeProposal(discussion, worktreeFactory);
    worktree = materialized.binding;
    requirementPath = materialized.requirementPath;
    inputs.push(await snapshotRequirement(requirementPath, "generated"));
  } else {
    requirementMode = "fallback";
    const requirement = normalizeMarkdown(requirementMarkdown, "requirementMarkdown");
    await writeTextAtomic(discussion.files.requirement, requirement);
    requirementPath = discussion.files.requirement;
    inputs.push(await snapshotRequirement(requirementPath, "generated"));
  }
  if (supplementMarkdown !== null) {
    if (!existingRequirementFile) throw new Error("A supplement requires an existing primary requirement file.");
    await writeTextAtomic(discussion.files.supplement, normalizeMarkdown(supplementMarkdown, "supplementMarkdown"));
    supplementFiles = [...supplementFiles, discussion.files.supplement];
    requirementMode = "existing-with-supplement";
  }
  for (const supplement of supplementFiles) inputs.push(await snapshotRequirement(supplement, "supplement"));
  await writeTextAtomic(discussion.files.draft, inputs[0].content);
  await appendTurn(discussion.files.log, { sequence, type: "confirmation", timestamp: now, userMessage, assistantMessage });
  const aggregate = sha256(inputs.map((item) => `${item.role}\0${item.path}\0${item.sha256}`).join("\0"));
  const state = {
    ...discussion.state, status: "confirmed", turnCount: sequence, requirementMode, requirementPath,
    requirementInputs: inputs, requirementSha256: aggregate, worktree, updatedAt: now,
  };
  await writeJsonAtomic(discussion.files.state, state);
  return state;
}

async function readInput(values) {
  return JSON.parse(await readFile(path.resolve(required(values, "input-file")), "utf8"));
}

async function main() {
  const { command, values } = parseArgs(process.argv.slice(2));
  const runDir = values["run-dir"] ? path.resolve(values["run-dir"]) : null;
  let result;
  if (command === "init") result = await createDiscussion({ runDir: required(values, "run-dir"), workspace: required(values, "workspace"), taskId: required(values, "task-id"), runId: values["run-id"], title: values.title, explicitResume: values["explicit-resume"] === "true" });
  else if (command === "show") result = await loadDiscussion({ runDir: required(values, "run-dir") });
  else if (command === "record") result = await recordDiscussionTurn({ runDir, ...await readInput(values) });
  else if (command === "questions") result = await setConfirmationItems({ runDir, ...await readInput(values) });
  else if (command === "answer") result = await answerConfirmationItems({ runDir, ...await readInput(values) });
  else if (command === "discover") result = await discoverRequirementConventions({ workspace: required(values, "workspace") });
  else if (command === "propose") result = await saveRequirementProposal({ runDir, ...await readInput(values) });
  else if (command === "confirm") result = await confirmDiscussion({ runDir, ...await readInput(values) });
  else if (command === "active") result = await listActiveRuns({ workspace: required(values, "workspace") });
  else if (command === "route") result = await resolveRunSelection({ workspace: required(values, "workspace"), taskId: required(values, "task-id"), ...await readInput(values) });
  else throw new Error(`Unknown command ${command}.`);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === MODULE_PATH) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}
