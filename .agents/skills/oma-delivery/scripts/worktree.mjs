import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function canonical(filePath) {
  const resolved = path.resolve(filePath);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function samePath(left, right) {
  return canonical(left) === canonical(right);
}

function isInside(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function git(args, cwd, { allowFailure = false } = {}) {
  try {
    const result = await execFileAsync("git", args, {
      cwd,
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    });
    return { ok: true, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
  } catch (error) {
    if (allowFailure) {
      return {
        ok: false,
        stdout: String(error.stdout ?? "").trim(),
        stderr: String(error.stderr ?? error.message).trim(),
      };
    }
    throw new Error(`git ${args.join(" ")} failed: ${error.stderr ?? error.message}`);
  }
}

async function readJson(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function writeJsonAtomic(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.next`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporaryPath, filePath);
}

export async function withFileLock(
  lockPath,
  action,
  { timeoutMs = 5000, retryMs = 25 } = {},
) {
  await mkdir(path.dirname(lockPath), { recursive: true });
  const deadline = Date.now() + timeoutMs;
  let handle;
  while (!handle) {
    try {
      handle = await open(lockPath, "wx");
      await handle.writeFile(`${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for lock ${lockPath}.`);
      }
      await new Promise((resolve) => setTimeout(resolve, retryMs));
    }
  }
  try {
    return await action();
  } finally {
    await handle.close();
    await unlink(lockPath).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
  }
}

function parseWorktreeList(output) {
  if (!output.trim()) return [];
  return output.trim().split(/\r?\n\r?\n/).map((block) => {
    const item = {};
    for (const line of block.split(/\r?\n/)) {
      const separator = line.indexOf(" ");
      if (separator === -1) item[line] = true;
      else item[line.slice(0, separator)] = line.slice(separator + 1);
    }
    return item;
  });
}

export async function inspectGitWorkspace(sourceWorkspace) {
  const workspace = path.resolve(sourceWorkspace);
  const topLevel = path.resolve((await git(["rev-parse", "--show-toplevel"], workspace)).stdout);
  const commonRaw = (await git(["rev-parse", "--git-common-dir"], workspace)).stdout;
  const commonGitDir = path.resolve(workspace, commonRaw);
  const baseCommit = (await git(["rev-parse", "HEAD"], workspace)).stdout;
  const repoRelativeWorkspace = path.relative(topLevel, workspace);
  if (!isInside(topLevel, workspace)) {
    throw new Error("Source workspace is outside the Git repository root.");
  }
  return { sourceWorkspace: workspace, repositoryRoot: topLevel, commonGitDir, baseCommit, repoRelativeWorkspace };
}

function bindingFor(info, runId) {
  const key = createHash("sha256")
    .update(`${canonical(info.commonGitDir)}\0${canonical(info.sourceWorkspace)}\0${runId}`)
    .digest("hex")
    .slice(0, 20);
  const worktreeRoot = path.join(info.repositoryRoot, ".oma", "worktrees", key);
  return {
    runKey: key,
    sourceWorkspace: info.sourceWorkspace,
    sourceRepository: info.repositoryRoot,
    commonGitDir: info.commonGitDir,
    repoRelativeWorkspace: info.repoRelativeWorkspace,
    worktreeRoot,
    executionWorkspace: path.join(worktreeRoot, info.repoRelativeWorkspace),
    branch: `oma/${key}`,
    baseCommit: info.baseCommit,
  };
}

async function assertIgnored(info, candidate) {
  const relative = path.relative(info.repositoryRoot, candidate).split(path.sep).join("/");
  const result = await git(["check-ignore", "-q", "--", relative], info.repositoryRoot, { allowFailure: true });
  if (!result.ok) {
    throw new Error(`Worktree path must be ignored by Git: ${candidate}`);
  }
}

async function verifyRegisteredWorktree(expected, { requireBase = false } = {}) {
  const listed = parseWorktreeList((await git(["worktree", "list", "--porcelain"], expected.sourceRepository)).stdout);
  const entry = listed.find((item) => samePath(item.worktree, expected.worktreeRoot));
  if (!entry) return false;
  const expectedBranch = `refs/heads/${expected.branch}`;
  if (entry.branch !== expectedBranch) {
    throw new Error(`Worktree path is registered to ${entry.branch ?? "a detached HEAD"}, not ${expectedBranch}.`);
  }
  if (requireBase && entry.HEAD !== expected.baseCommit) {
    throw new Error("Unbound worktree HEAD does not match the recorded base commit.");
  }
  return true;
}

function assertBinding(expected, actual) {
  for (const key of [
    "sourceWorkspace",
    "sourceRepository",
    "commonGitDir",
    "worktreeRoot",
    "executionWorkspace",
  ]) {
    if (!samePath(expected[key], actual[key])) throw new Error(`Worktree binding mismatch for ${key}.`);
  }
  for (const key of ["runKey", "repoRelativeWorkspace", "branch"]) {
    if (expected[key] !== actual[key]) throw new Error(`Worktree binding mismatch for ${key}.`);
  }
  if (typeof actual.baseCommit !== "string" || !/^[0-9a-f]{40}$/i.test(actual.baseCommit)) {
    throw new Error("Recorded worktree base commit is invalid.");
  }
}

export async function ensureWorktree({
  runDir,
  sourceWorkspace,
  runId = path.basename(path.resolve(runDir)),
  afterAdd = null,
  lockTimeoutMs = 5000,
}) {
  if (typeof runId !== "string" || !runId.trim()) throw new Error("runId must be non-empty.");
  const info = await inspectGitWorkspace(sourceWorkspace);
  const expected = bindingFor(info, runId);
  if (!isInside(info.repositoryRoot, expected.worktreeRoot)) {
    throw new Error("Computed worktree path escaped the repository root.");
  }
  await assertIgnored(info, expected.worktreeRoot);
  const manifestPath = path.join(path.resolve(runDir), "worktree.json");
  const lockPath = path.join(info.repositoryRoot, ".oma", "locks", "worktrees.lock");

  return withFileLock(lockPath, async () => {
    const existing = await readJson(manifestPath);
    if (existing) {
      assertBinding(expected, existing);
      if (!(await verifyRegisteredWorktree(expected))) {
        throw new Error("Recorded worktree is no longer registered; refusing to recreate it.");
      }
      return existing;
    }

    if (await verifyRegisteredWorktree(expected, { requireBase: true })) {
      const recovered = { ...expected, createdAt: new Date().toISOString(), recoveredAfterInterruption: true };
      await writeJsonAtomic(manifestPath, recovered);
      return recovered;
    }

    const branchRef = await git(
      ["show-ref", "--verify", "--quiet", `refs/heads/${expected.branch}`],
      info.repositoryRoot,
      { allowFailure: true },
    );
    if (branchRef.ok) throw new Error(`Expected worktree branch already exists without a matching worktree: ${expected.branch}`);

    await mkdir(path.dirname(expected.worktreeRoot), { recursive: true });
    await git(
      ["worktree", "add", "-b", expected.branch, expected.worktreeRoot, expected.baseCommit],
      info.repositoryRoot,
    );
    if (afterAdd) await afterAdd(expected);
    const binding = { ...expected, createdAt: new Date().toISOString(), recoveredAfterInterruption: false };
    await writeJsonAtomic(manifestPath, binding);
    return binding;
  }, { timeoutMs: lockTimeoutMs });
}
