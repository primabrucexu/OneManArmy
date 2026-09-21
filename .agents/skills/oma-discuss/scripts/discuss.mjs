#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  appendFile,
  mkdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const MODULE_PATH = fileURLToPath(import.meta.url);
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
    if (!key?.startsWith("--") || value === undefined) {
      throw new Error(`Invalid argument near ${key ?? "<end>"}`);
    }
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
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return `${value.trim()}\n`;
}

function pathsFor(runDir) {
  const root = path.resolve(runDir);
  return {
    root,
    state: path.join(root, "discussion-state.json"),
    log: path.join(root, "discussion.jsonl"),
    draft: path.join(root, "requirement-draft.md"),
    requirement: path.join(root, "requirement.md"),
  };
}

async function readOptional(filePath) {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
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
  const temporaryPath = `${filePath}.next`;
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

function validateTurn(input, markdownKey) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Discussion input must be a JSON object.");
  }
  for (const key of ["userMessage", "assistantMessage", markdownKey]) {
    if (typeof input[key] !== "string" || !input[key].trim()) {
      throw new Error(`${key} must be a non-empty string.`);
    }
  }
}

export async function createDiscussion({ runDir, workspace, title = "Untitled requirement" }) {
  const files = pathsFor(runDir);
  const resolvedWorkspace = path.resolve(workspace);
  const existing = await readJson(files.state);
  if (existing) {
    if (path.resolve(existing.workspace) !== resolvedWorkspace) {
      throw new Error("Existing discussion belongs to a different workspace.");
    }
    return existing;
  }
  const now = new Date().toISOString();
  const state = {
    version: 1,
    status: "discussing",
    workspace: resolvedWorkspace,
    title,
    turnCount: 0,
    requirementPath: null,
    requirementSha256: null,
    createdAt: now,
    updatedAt: now,
  };
  await mkdir(files.root, { recursive: true });
  await writeTextAtomic(files.draft, DEFAULT_DRAFT);
  await writeJsonAtomic(files.state, state);
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
    turns: log
      ? log.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
      : [],
    files,
  };
}

export async function recordDiscussionTurn({
  runDir,
  userMessage,
  assistantMessage,
  draftMarkdown,
}) {
  const discussion = await loadDiscussion({ runDir });
  if (discussion.state.status !== "discussing") {
    throw new Error("Confirmed discussions cannot be changed.");
  }
  validateTurn({ userMessage, assistantMessage, draftMarkdown }, "draftMarkdown");
  const now = new Date().toISOString();
  const sequence = discussion.state.turnCount + 1;
  await writeTextAtomic(
    discussion.files.draft,
    normalizeMarkdown(draftMarkdown, "draftMarkdown"),
  );
  await appendTurn(discussion.files.log, {
    sequence,
    type: "discussion",
    timestamp: now,
    userMessage,
    assistantMessage,
  });
  const state = {
    ...discussion.state,
    turnCount: sequence,
    updatedAt: now,
  };
  await writeJsonAtomic(discussion.files.state, state);
  return state;
}

export async function confirmDiscussion({
  runDir,
  userMessage,
  assistantMessage,
  requirementMarkdown,
}) {
  const discussion = await loadDiscussion({ runDir });
  if (discussion.state.status !== "discussing") {
    throw new Error("Discussion is already confirmed.");
  }
  validateTurn(
    { userMessage, assistantMessage, requirementMarkdown },
    "requirementMarkdown",
  );
  const now = new Date().toISOString();
  const sequence = discussion.state.turnCount + 1;
  const requirement = normalizeMarkdown(requirementMarkdown, "requirementMarkdown");
  await writeTextAtomic(discussion.files.draft, requirement);
  await writeTextAtomic(discussion.files.requirement, requirement);
  await appendTurn(discussion.files.log, {
    sequence,
    type: "confirmation",
    timestamp: now,
    userMessage,
    assistantMessage,
  });
  const state = {
    ...discussion.state,
    status: "confirmed",
    turnCount: sequence,
    requirementPath: discussion.files.requirement,
    requirementSha256: createHash("sha256").update(requirement).digest("hex"),
    updatedAt: now,
  };
  await writeJsonAtomic(discussion.files.state, state);
  return state;
}

async function readInput(values) {
  const inputPath = path.resolve(required(values, "input-file"));
  return JSON.parse(await readFile(inputPath, "utf8"));
}

async function main() {
  const { command, values } = parseArgs(process.argv.slice(2));
  const runDir = path.resolve(required(values, "run-dir"));
  let result;
  if (command === "init") {
    result = await createDiscussion({
      runDir,
      workspace: required(values, "workspace"),
      title: values.title,
    });
  } else if (command === "show") {
    result = await loadDiscussion({ runDir });
  } else if (command === "record") {
    result = await recordDiscussionTurn({ runDir, ...await readInput(values) });
  } else if (command === "confirm") {
    result = await confirmDiscussion({ runDir, ...await readInput(values) });
  } else {
    throw new Error(`Unknown command ${command}.`);
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === MODULE_PATH) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}
