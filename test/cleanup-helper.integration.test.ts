import { execFile, spawn } from "node:child_process";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { branchExists, discoverRepo, gitOk } from "../src/git.ts";
import { Registry } from "../src/registry.ts";
import type { ManagedWorktree } from "../src/types.ts";
import { newId, nowIso, pathExists } from "../src/util.ts";
import { executor, initRepo, run, tempDir } from "./helpers.ts";

const execFileAsync = promisify(execFile);
const cleanup: string[] = [];
afterEach(async () => Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

describe("detached cleanup helper", () => {
  it("removes a clean worktree, safely deletes an integrated branch, and records history", async () => {
    const root = await tempDir();
    cleanup.push(root);
    const source = join(root, "source");
    const target = join(root, "target");
    await initRepo(source);
    await writeFile(join(source, "base"), "base\n");
    await run("git", ["add", "."], source);
    await run("git", ["commit", "-qm", "base"], source);
    await gitOk(executor, source, ["worktree", "add", "-b", "wt/topic", target, "main"]);
    await writeFile(join(target, "feature"), "feature\n");
    await run("git", ["add", "."], target);
    await run("git", ["commit", "-qm", "feature"], target);
    await gitOk(executor, source, ["merge", "--ff-only", "wt/topic"]);

    const sourceRepo = await discoverRepo(executor, source);
    const finalHead = sourceRepo.head;
    const timestamp = nowIso();
    const transactionId = newId();
    const cleanupAttemptId = newId();
    const record: ManagedWorktree = {
      id: newId(),
      repoId: sourceRepo.repoId,
      repoKey: sourceRepo.repoKey,
      repoCommonDir: sourceRepo.commonDir,
      path: (await discoverRepo(executor, target)).root,
      branch: "wt/topic",
      sourcePath: sourceRepo.root,
      sourceBranch: "main",
      sourceHead: finalHead,
      relativeCwd: "",
      task: "topic",
      slug: "topic",
      state: "cleanup_scheduled",
      createdAt: timestamp,
      updatedAt: timestamp,
      transaction: {
        id: transactionId,
        mode: "merge",
        phase: "cleanup_scheduled",
        sourceHead: finalHead,
        workHead: finalHead,
        mergedHead: finalHead,
        cleanupResult: "merged",
        cleanupAttemptId,
        startedAt: timestamp,
        updatedAt: timestamp,
      },
    };
    const registry = new Registry(join(root, "agent"));
    await registry.add(record);
    const payload = {
      parentPid: 99999999,
      sourcePath: record.sourcePath,
      targetPath: record.path,
      branch: record.branch,
      deleteBranch: true,
      registryPath: registry.path,
      registryLock: registry.lockPath,
      sourceLock: registry.sourceLockPath(record.repoCommonDir, record.sourceBranch),
      cleanupAttemptId,
      fallbackMarker: join(registry.markersDir, `${record.id}.json`),
      recordId: record.id,
      result: "merged",
      finalHead,
      expectedWorkHead: finalHead,
      transactionId,
      repoCommonDir: record.repoCommonDir,
      sourceBranch: record.sourceBranch,
      logPath: join(registry.logsDir, `cleanup-${record.id}-123-${cleanupAttemptId}.log`),
    };
    const helper = fileURLToPath(new URL("../src/cleanup-helper.mjs", import.meta.url));
    const blocker = join(target, "untracked-blocker");
    await writeFile(blocker, "keep me\n");
    let helperError: unknown;
    try {
      await execFileAsync(process.execPath, [helper, Buffer.from(JSON.stringify(payload)).toString("base64url")], {
        timeout: 30_000,
      });
    } catch (error) {
      helperError = error;
    }
    expect((helperError as { stderr?: string })?.stderr).toContain("Target checkout is no longer clean");
    expect(await pathExists(target)).toBe(true);
    expect((await registry.findById(record.id))?.state).toBe("merged_cleanup_pending");
    await rm(blocker);
    const replacementAttemptId = newId();
    await registry.update(record.id, (item) => {
      item.state = "cleanup_scheduled";
      if (item.transaction) {
        item.transaction.phase = "cleanup_scheduled";
        item.transaction.cleanupAttemptId = replacementAttemptId;
      }
    });

    let staleError: unknown;
    try {
      await execFileAsync(process.execPath, [helper, Buffer.from(JSON.stringify(payload)).toString("base64url")], {
        timeout: 30_000,
      });
    } catch (error) {
      staleError = error;
    }
    expect((staleError as { stderr?: string })?.stderr).toContain("transaction no longer matches");
    expect(await pathExists(target)).toBe(true);
    const replacementPayload = {
      ...payload,
      cleanupAttemptId: replacementAttemptId,
      logPath: join(registry.logsDir, `cleanup-${record.id}-124-${replacementAttemptId}.log`),
    };
    const temporaryParent = spawn(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], { stdio: "ignore" });
    if (!temporaryParent.pid) throw new Error("Unable to start temporary parent process");
    const waitingPayload = { ...replacementPayload, parentPid: temporaryParent.pid };
    const waitingHelper = spawn(
      process.execPath,
      [helper, Buffer.from(JSON.stringify(waitingPayload)).toString("base64url")],
      { stdio: ["ignore", "ignore", "pipe", "ipc"] },
    );
    let waitingStderr = "";
    waitingHelper.stderr?.on("data", (chunk) => { waitingStderr += chunk.toString(); });
    await new Promise<void>((resolveReady, rejectReady) => {
      const timer = setTimeout(() => rejectReady(new Error("Cleanup helper did not announce readiness")), 5_000);
      waitingHelper.on("message", (message) => {
        if (!(message as { ready?: boolean })?.ready) return;
        clearTimeout(timer);
        resolveReady();
      });
      waitingHelper.once("exit", (code) => {
        clearTimeout(timer);
        rejectReady(new Error(`Cleanup helper exited before cancellation test (${code ?? "unknown"})`));
      });
    });
    const cancelledCompletion = new Promise<number | null>((resolveExit) => waitingHelper.once("exit", resolveExit));
    await registry.update(record.id, (item) => {
      item.state = "active";
      item.transaction = undefined;
    });
    temporaryParent.kill("SIGTERM");
    const cancelledExit = await cancelledCompletion;
    expect(cancelledExit).not.toBe(0);
    expect(waitingStderr).toContain("unexpected state active");
    expect(await pathExists(target)).toBe(true);

    const finalAttemptId = newId();
    await registry.update(record.id, (item) => {
      item.state = "cleanup_scheduled";
      item.transaction = {
        ...record.transaction!,
        phase: "cleanup_scheduled",
        cleanupAttemptId: finalAttemptId,
        updatedAt: nowIso(),
      };
    });
    const finalPayload = {
      ...payload,
      cleanupAttemptId: finalAttemptId,
      logPath: join(registry.logsDir, `cleanup-${record.id}-125-${finalAttemptId}.log`),
    };
    await execFileAsync(process.execPath, [helper, Buffer.from(JSON.stringify(finalPayload)).toString("base64url")], {
      timeout: 30_000,
    });

    expect(await pathExists(target)).toBe(false);
    expect(await branchExists(executor, source, "wt/topic")).toBe(false);
    expect(await registry.findById(record.id)).toBeUndefined();
    expect((await registry.history())[0].result).toBe("merged");
  });
});
