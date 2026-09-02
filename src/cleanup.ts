import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { currentHead, discoverRepo, git, gitOk, gitOperationInProgress, isAncestor, isClean, statusEntries } from "./git.ts";
import type { ManagedWorktree, WorktreeHistoryEntry } from "./types.ts";
import type { Registry } from "./registry.ts";
import { canonicalPath, isPathInside, newId, nowIso, withFileLock } from "./util.ts";

async function safeSubmoduleRoot(worktreePath: string, modulePath: string): Promise<string> {
  const worktreeRoot = await canonicalPath(worktreePath);
  const lexical = resolve(worktreeRoot, modulePath);
  if (lexical === worktreeRoot || !isPathInside(lexical, worktreeRoot)) {
    throw new Error(`Unsafe submodule path outside the managed worktree: ${modulePath}`);
  }
  const canonical = await canonicalPath(lexical);
  if (!isPathInside(canonical, worktreeRoot)) {
    throw new Error(`Submodule path resolves outside the managed worktree: ${modulePath}`);
  }
  return canonical;
}

export async function initializedSubmodules(pi: ExtensionAPI, path: string): Promise<string[]> {
  const modules = await git(pi, path, ["config", "-f", ".gitmodules", "--get-regexp", "^submodule\\..*\\.path$"]);
  if (modules.code === 1) return [];
  if (modules.code !== 0) throw new Error("Unable to parse .gitmodules safely before cleanup");
  const result: string[] = [];
  for (const line of modules.stdout.split("\n").filter(Boolean)) {
    const modulePath = line.trim().split(/\s+/).slice(1).join(" ");
    if (!modulePath) continue;
    try {
      await access(join(path, modulePath));
    } catch {
      continue;
    }
    const moduleRoot = await safeSubmoduleRoot(path, modulePath);
    const inside = await git(pi, moduleRoot, ["rev-parse", "--is-inside-work-tree"]);
    if (inside.code === 0 && inside.stdout.trim() === "true") result.push(modulePath);
  }
  return result;
}

export async function ensureSubmodulesClean(pi: ExtensionAPI, path: string, modules: string[]): Promise<void> {
  for (const modulePath of modules) {
    const moduleRoot = await safeSubmoduleRoot(path, modulePath);
    const entries = await statusEntries(pi, moduleRoot);
    if (entries.length > 0) throw new Error(`Submodule has uncommitted or untracked content: ${modulePath}`);
  }
}

export async function deinitSubmodules(pi: ExtensionAPI, path: string, modules: string[]): Promise<void> {
  if (modules.length === 0) return;
  await gitOk(pi, path, ["submodule", "deinit", "--all"], "Unable to deinitialize clean submodules");
}

export interface CleanupRequest {
  record: ManagedWorktree;
  result: WorktreeHistoryEntry["result"];
  finalHead: string;
  prUrl?: string;
  deleteBranch: boolean;
  expectedWorkHead: string;
}

export async function validateCleanupRequest(pi: ExtensionAPI, registry: Registry, request: CleanupRequest): Promise<void> {
  const { record } = request;
  const dependent = (await registry.records()).find((item) => item.id !== record.id && item.sourcePath === record.path);
  if (dependent) {
    throw new Error(`Cleanup blocked: worktree ${dependent.id} records this checkout as its source`);
  }
  const transaction = record.transaction;
  if (!transaction?.workHead || transaction.workHead !== request.expectedWorkHead) {
    throw new Error("Cleanup HEAD is not the worktree HEAD authorized by the finish transaction");
  }
  if (transaction.cleanupResult !== request.result || request.deleteBranch !== (request.result === "merged") ||
      (request.result === "pr" && !request.prUrl) || (request.result === "merged" && request.prUrl !== undefined)) {
    throw new Error("Cleanup result does not match the finish transaction");
  }
  if (request.finalHead !== (transaction.mergedHead ?? transaction.workHead) || (record.prUrl ?? undefined) !== (request.prUrl ?? undefined)) {
    throw new Error("Cleanup completion metadata does not match the finish transaction");
  }
  const [source, target] = await Promise.all([
    discoverRepo(pi, record.sourcePath),
    discoverRepo(pi, record.path),
  ]);
  if (source.root !== record.sourcePath || target.root !== record.path) throw new Error("A recorded checkout path was moved or replaced");
  if (source.commonDir !== record.repoCommonDir || target.commonDir !== record.repoCommonDir) {
    throw new Error("A recorded checkout now belongs to a different repository");
  }
  if (source.branch !== record.sourceBranch) throw new Error(`Recorded source checkout is not on ${record.sourceBranch}`);
  if (target.branch !== record.branch) throw new Error(`Managed worktree is not on ${record.branch}`);
  const [sourceOperation, targetOperation] = await Promise.all([
    gitOperationInProgress(pi, record.sourcePath),
    gitOperationInProgress(pi, record.path),
  ]);
  if (sourceOperation || targetOperation) {
    throw new Error(`Cleanup blocked by Git operation in progress: ${sourceOperation ?? targetOperation}`);
  }
  if (!(await isClean(pi, record.sourcePath))) throw new Error("Recorded source checkout is not clean");
  if (!(await isClean(pi, record.path))) throw new Error("Managed worktree is not clean");
  const workHead = await currentHead(pi, record.path);
  if (workHead !== request.expectedWorkHead) throw new Error("Managed worktree HEAD changed before cleanup");
  const requiresIntegration = request.deleteBranch || (request.result === "already_integrated" && !request.prUrl);
  if (requiresIntegration && !(await isAncestor(pi, record.sourcePath, `refs/heads/${record.branch}`, `refs/heads/${record.sourceBranch}`))) {
    throw new Error(`Work branch ${record.branch} is not integrated into ${record.sourceBranch}`);
  }
}

export async function scheduleCleanup(
  registry: Registry,
  request: CleanupRequest,
): Promise<void> {
  if (!request.record.transaction?.id) throw new Error("Cleanup cannot be scheduled without an active transaction");
  if (request.record.transaction.workHead !== request.expectedWorkHead ||
      request.record.transaction.cleanupResult !== request.result ||
      request.finalHead !== (request.record.transaction.mergedHead ?? request.record.transaction.workHead)) {
    throw new Error("Cleanup cannot be scheduled with unauthorized completion metadata");
  }
  const helper = fileURLToPath(new URL("./cleanup-helper.mjs", import.meta.url));
  const cleanupAttemptId = newId();
  const logPath = `${registry.logsDir}/cleanup-${request.record.id}-${Date.now()}-${cleanupAttemptId}.log`;
  const sourceLock = registry.sourceLockPath(request.record.repoCommonDir, request.record.sourceBranch);
  const payload = {
    parentPid: process.pid,
    sourcePath: request.record.sourcePath,
    targetPath: request.record.path,
    branch: request.record.branch,
    deleteBranch: request.deleteBranch,
    registryPath: registry.path,
    registryLock: registry.lockPath,
    sourceLock,
    cleanupAttemptId,
    fallbackMarker: join(registry.markersDir, `${request.record.id}.json`),
    recordId: request.record.id,
    result: request.result,
    finalHead: request.finalHead,
    expectedWorkHead: request.expectedWorkHead,
    transactionId: request.record.transaction?.id,
    repoCommonDir: request.record.repoCommonDir,
    sourceBranch: request.record.sourceBranch,
    prUrl: request.prUrl,
    logPath,
  };
  await withFileLock(sourceLock, async () => {
    await registry.update(request.record.id, (record) => {
      const transaction = record.transaction;
      if (!transaction || transaction.id !== request.record.transaction?.id || transaction.workHead !== request.expectedWorkHead ||
          transaction.cleanupResult !== request.result || request.finalHead !== (transaction.mergedHead ?? transaction.workHead) ||
          (record.prUrl ?? undefined) !== (request.prUrl ?? undefined)) {
        throw new Error("Cleanup transaction changed before scheduling");
      }
      record.state = "cleanup_scheduled";
      transaction.phase = "cleanup_scheduled";
      transaction.cleanupResult = request.result;
      transaction.cleanupAttemptId = cleanupAttemptId;
      transaction.updatedAt = nowIso();
    });

    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, [helper, Buffer.from(JSON.stringify(payload)).toString("base64url")], {
        detached: true,
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      });
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          child.kill("SIGTERM");
          reject(new Error("Cleanup helper did not become ready"));
        }
      }, 5_000);
      child.once("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      });
      child.on("message", (message) => {
        if (settled || !(message as { ready?: boolean })?.ready) return;
        settled = true;
        clearTimeout(timer);
        child.unref();
        resolve();
      });
      child.once("exit", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error(`Cleanup helper exited before ready (${code ?? "unknown"})`));
      });
    }).catch(async (error) => {
      try {
        await registry.update(request.record.id, (record) => {
          if (record.transaction?.cleanupAttemptId !== cleanupAttemptId) return;
          record.state = request.result === "merged" ? "merged_cleanup_pending" : "cleanup_pending";
          record.initError = error instanceof Error ? error.message : String(error);
          record.transaction.phase = "awaiting_cleanup";
          record.transaction.cleanupAttemptId = undefined;
          record.transaction.updatedAt = nowIso();
        });
      } catch {
        // Preserve the helper startup error if the registry changed concurrently.
      }
      throw error;
    });
  });
}

