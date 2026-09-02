import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, closeSync, constants, fstatSync, mkdirSync, openSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";

let cleanupWasAnnounced = false;

function readJsonPrivate(path, maxBytes = 2 * 1024 * 1024) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > maxBytes) throw new Error(`Unsafe or oversized JSON file: ${path}`);
    try {
      return JSON.parse(readFileSync(fd, "utf8"));
    } catch {
      throw new Error(`Invalid JSON file: ${path}`);
    }
  } finally {
    closeSync(fd);
  }
}

function writePrivate(path, content) {
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_NONBLOCK;
  const fd = openSync(path, flags, 0o600);
  let createdFile;
  try {
    const info = fstatSync(fd);
    if (!info.isFile()) throw new Error(`Unsafe output file: ${path}`);
    createdFile = { dev: info.dev, ino: info.ino };
    writeFileSync(fd, content);
  } catch (error) {
    try {
      const current = statSync(path);
      if (createdFile && current.dev === createdFile.dev && current.ino === createdFile.ino) rmSync(path, { force: true });
    } catch {}
    throw error;
  } finally {
    closeSync(fd);
  }
}

function redact(value) {
  return String(value)
    .replace(/-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\r\n]*PRIVATE KEY-----/g, "[REDACTED_PRIVATE_KEY]")
    .replace(/\b(gh[opsu]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, "[REDACTED_GITHUB_TOKEN]")
    .replace(/\b(AKIA[0-9A-Z]{16})\b/g, "[REDACTED_AWS_ACCESS_KEY]")
    .replace(/\b(sk-[A-Za-z0-9_-]{20,})\b/g, "[REDACTED_API_KEY]")
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi, "$1[REDACTED]@")
    .replace(/([?&](?:access_token|token|api_key|key)=)[^&#\s]+/gi, "$1[REDACTED]")
    .replace(/([\"']?(?:token|password|passwd|secret|api[_-]?key|access[_-]?key|credential)[\"']?\s*:\s*[\"'])[^\"']+([\"'])/gi, "$1[REDACTED]$2")
    .replace(/((?:token|password|passwd|secret|api[_-]?key|access[_-]?key|credential)\s*[=:]\s*)[^\s\"']+/gi, "$1[REDACTED]")
    .replace(/(Authorization:\s*(?:Bearer|token)\s+)[^\s]+/gi, "$1[REDACTED]")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "�");
}

function truncate(value, maxBytes = 2 * 1024 * 1024) {
  const encoded = Buffer.from(String(value), "utf8");
  if (encoded.length <= maxBytes) return String(value);
  let start = encoded.length - maxBytes;
  while (start < encoded.length && (encoded[start] & 0xc0) === 0x80) start++;
  return `[earlier output truncated]\n${encoded.subarray(start).toString("utf8")}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function lock(path, fn) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const start = Date.now();
  let ownedLock;
  while (true) {
    try {
      const fd = openSync(path, "wx", 0o600);
      let createdLock;
      try {
        const info = fstatSync(fd);
        createdLock = { dev: info.dev, ino: info.ino };
        writeFileSync(fd, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
      } catch (error) {
        try {
          const current = statSync(path);
          if (createdLock && current.dev === createdLock.dev && current.ino === createdLock.ino) rmSync(path, { force: true });
        } catch {}
        throw error;
      } finally {
        closeSync(fd);
      }
      ownedLock = createdLock;
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      try {
        const observed = statSync(path);
        let stale = false;
        try {
          const owner = readJsonPrivate(path, 4_096);
          stale = !alive(owner.pid);
        } catch {
          stale = Date.now() - observed.mtimeMs > 60_000;
        }
        if (stale) {
          const current = statSync(path);
          if (current.dev === observed.dev && current.ino === observed.ino && current.mtimeMs === observed.mtimeMs) {
            rmSync(path, { force: true });
          }
          continue;
        }
      } catch {
        if (Date.now() - start > 30_000) throw new Error(`Timed out waiting for registry lock: ${path}`);
        await sleep(100);
        continue;
      }
      if (Date.now() - start > 30_000) throw new Error(`Timed out waiting for registry lock: ${path}`);
      await sleep(100);
    }
  }
  try {
    return await fn();
  } finally {
    try {
      const current = statSync(path);
      if (ownedLock && current.dev === ownedLock.dev && current.ino === ownedLock.ino) rmSync(path, { force: true });
    } catch {}
  }
}

function git(cwd, args, logs) {
  try {
    const stdout = execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    logs.push(`$ git ${args.join(" ")}\n${stdout}`);
    return { ok: true, output: stdout };
  } catch (error) {
    const output = `${error?.stdout ?? ""}${error?.stderr ?? ""}`;
    logs.push(`$ git ${args.join(" ")}\n${output}`);
    return { ok: false, output };
  }
}

function mustGit(cwd, args, logs, message) {
  const result = git(cwd, args, logs);
  if (!result.ok) throw new Error(`${message}: ${result.output.trim()}`);
  return result.output.trim();
}

function commonDir(cwd, logs) {
  const absolute = git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"], logs);
  let value = absolute.ok
    ? absolute.output.trim()
    : mustGit(cwd, ["rev-parse", "--git-common-dir"], logs, "Unable to inspect Git common directory");
  if (!isAbsolute(value)) value = resolve(cwd, value);
  return realpathSync(value);
}

function validatePayloadShape(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Invalid cleanup payload");
  const requiredStrings = [
    "sourcePath", "targetPath", "branch", "registryPath", "registryLock", "sourceLock", "cleanupAttemptId",
    "fallbackMarker", "recordId", "result", "finalHead", "expectedWorkHead", "transactionId", "repoCommonDir",
    "sourceBranch", "logPath",
  ];
  for (const key of requiredStrings) {
    if (typeof payload[key] !== "string" || payload[key].length === 0 || payload[key].includes("\0")) {
      throw new Error(`Invalid cleanup payload field ${key}`);
    }
  }
  if (!Number.isSafeInteger(payload.parentPid) || payload.parentPid <= 0 || typeof payload.deleteBranch !== "boolean") {
    throw new Error("Invalid cleanup process metadata");
  }
  if (![payload.recordId, payload.cleanupAttemptId, payload.transactionId].every((value) => /^[A-Za-z0-9_-]{1,256}$/.test(value))) {
    throw new Error("Invalid cleanup identifier");
  }
  if (payload.branch.length > 1_024 || payload.sourceBranch.length > 1_024 ||
      /[\u0000-\u0020\u007f-\u009f]/.test(payload.branch) || /[\u0000-\u0020\u007f-\u009f]/.test(payload.sourceBranch)) {
    throw new Error("Invalid cleanup branch");
  }
  if (!/^[0-9a-f]{40,64}$/i.test(payload.finalHead) || !/^[0-9a-f]{40,64}$/i.test(payload.expectedWorkHead)) {
    throw new Error("Invalid cleanup commit ID");
  }
  if (!["pr", "merged", "already_integrated"].includes(payload.result)) throw new Error("Invalid cleanup result");
  if (payload.prUrl !== undefined) {
    if (typeof payload.prUrl !== "string" || payload.prUrl.length === 0 || payload.prUrl.length > 4_096 ||
        /[\u0000-\u0020\u007f-\u009f]/.test(payload.prUrl)) {
      throw new Error("Invalid cleanup PR URL");
    }
    const prUrl = new URL(payload.prUrl);
    if (prUrl.protocol !== "https:" || prUrl.username || prUrl.password || !prUrl.hostname) {
      throw new Error("Invalid cleanup PR URL");
    }
  }
  if ((payload.result === "pr" && !payload.prUrl) || (payload.result === "merged" && payload.prUrl)) {
    throw new Error("Cleanup result and PR URL are inconsistent");
  }
  for (const key of ["sourcePath", "targetPath", "registryPath", "registryLock", "sourceLock", "fallbackMarker", "repoCommonDir", "logPath"]) {
    if (payload[key].length > 4_096 || !isAbsolute(payload[key]) || resolve(payload[key]) !== payload[key]) {
      throw new Error(`Cleanup path ${key} is not canonical`);
    }
  }
  if (payload.sourcePath === payload.targetPath || payload.targetPath.startsWith(`${payload.sourcePath}${sep}`) ||
      payload.sourcePath.startsWith(`${payload.targetPath}${sep}`)) {
    throw new Error("Cleanup source and target paths must be distinct and non-nested");
  }
  const stateRoot = dirname(payload.registryPath);
  if (payload.registryPath !== join(stateRoot, "registry.json")) throw new Error("Unexpected cleanup registry path");
  if (payload.registryLock !== join(stateRoot, "registry.lock")) throw new Error("Unexpected cleanup registry lock");
  const sourceHash = createHash("sha256").update(`${payload.repoCommonDir}\0${payload.sourceBranch}`).digest("hex").slice(0, 20);
  if (payload.sourceLock !== join(stateRoot, "locks", `${sourceHash}.lock`)) throw new Error("Unexpected cleanup source lock");
  if (payload.fallbackMarker !== join(stateRoot, "markers", `${payload.recordId}.json`)) throw new Error("Unexpected cleanup marker path");
  const logPrefix = `cleanup-${payload.recordId}-`;
  const logSuffix = basename(payload.logPath).slice(logPrefix.length);
  if (dirname(payload.logPath) !== join(stateRoot, "logs") || !basename(payload.logPath).startsWith(logPrefix) ||
      !new RegExp(`^\\d+-${payload.cleanupAttemptId}\\.log$`).test(logSuffix)) {
    throw new Error("Unexpected cleanup log path");
  }
}

function registryRecord(payload) {
  const data = readJsonPrivate(payload.registryPath);
  const record = data.worktrees?.find((item) => item.id === payload.recordId);
  if (!record) throw new Error("Scheduled cleanup record no longer exists");
  const dependent = data.worktrees?.find((item) => item.id !== record.id && item.sourcePath === record.path);
  if (dependent) throw new Error(`Cleanup blocked: worktree ${dependent.id} records this checkout as its source`);
  if (record.state !== "cleanup_scheduled") throw new Error(`Cleanup record is in unexpected state ${record.state}`);
  if (!record.transaction || record.transaction.id !== payload.transactionId || record.transaction.phase !== "cleanup_scheduled" ||
      record.transaction.cleanupAttemptId !== payload.cleanupAttemptId) {
    throw new Error("Scheduled cleanup transaction no longer matches");
  }
  if (!record.transaction.workHead || record.transaction.workHead !== payload.expectedWorkHead) {
    throw new Error("Cleanup HEAD is not the worktree HEAD authorized by the finish transaction");
  }
  if (record.transaction.cleanupResult !== payload.result || payload.deleteBranch !== (payload.result === "merged")) {
    throw new Error("Cleanup result does not match the finish transaction");
  }
  const authorizedFinalHead = record.transaction.mergedHead ?? record.transaction.workHead;
  if (payload.finalHead !== authorizedFinalHead || (record.prUrl ?? undefined) !== (payload.prUrl ?? undefined)) {
    throw new Error("Cleanup completion metadata does not match the finish transaction");
  }
  if (record.path !== payload.targetPath || record.sourcePath !== payload.sourcePath || record.branch !== payload.branch ||
      record.sourceBranch !== payload.sourceBranch || record.repoCommonDir !== payload.repoCommonDir) {
    throw new Error("Scheduled cleanup metadata no longer matches the registry");
  }
  return record;
}

function operationInProgress(cwd, logs) {
  for (const name of ["rebase-merge", "rebase-apply", "MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "REBASE_HEAD", "BISECT_START", "sequencer"]) {
    const result = git(cwd, ["rev-parse", "--git-path", name], logs);
    if (!result.ok) continue;
    try {
      accessSync(isAbsolute(result.output.trim()) ? result.output.trim() : resolve(cwd, result.output.trim()));
      return name;
    } catch {}
  }
  return undefined;
}

function validateCleanup(payload, logs) {
  registryRecord(payload);
  if (realpathSync(payload.sourcePath) !== payload.sourcePath || realpathSync(payload.targetPath) !== payload.targetPath) {
    throw new Error("A scheduled checkout path was moved or replaced");
  }
  const sourceRoot = realpathSync(mustGit(payload.sourcePath, ["rev-parse", "--show-toplevel"], logs, "Unable to inspect source checkout"));
  const targetRoot = realpathSync(mustGit(payload.targetPath, ["rev-parse", "--show-toplevel"], logs, "Unable to inspect target checkout"));
  if (sourceRoot !== payload.sourcePath || targetRoot !== payload.targetPath) throw new Error("A scheduled checkout root changed");
  if (commonDir(payload.sourcePath, logs) !== payload.repoCommonDir || commonDir(payload.targetPath, logs) !== payload.repoCommonDir) {
    throw new Error("A scheduled checkout now belongs to another repository");
  }
  const sourceBranch = mustGit(payload.sourcePath, ["symbolic-ref", "--quiet", "--short", "HEAD"], logs, "Source checkout is detached");
  const targetBranch = mustGit(payload.targetPath, ["symbolic-ref", "--quiet", "--short", "HEAD"], logs, "Target checkout is detached");
  if (sourceBranch !== payload.sourceBranch || targetBranch !== payload.branch) throw new Error("A scheduled checkout changed branches");
  const sourceOperation = operationInProgress(payload.sourcePath, logs);
  const targetOperation = operationInProgress(payload.targetPath, logs);
  if (sourceOperation || targetOperation) throw new Error(`Cleanup blocked by Git operation in progress: ${sourceOperation ?? targetOperation}`);
  const targetHead = mustGit(payload.targetPath, ["rev-parse", "--verify", "HEAD"], logs, "Unable to inspect target HEAD");
  if (payload.expectedWorkHead && targetHead !== payload.expectedWorkHead) throw new Error("Target HEAD changed after cleanup approval");
  if (mustGit(payload.sourcePath, ["status", "--porcelain=v1", "--untracked-files=all"], logs, "Unable to inspect source status")) {
    throw new Error("Source checkout is no longer clean");
  }
  if (mustGit(payload.targetPath, ["status", "--porcelain=v1", "--untracked-files=all"], logs, "Unable to inspect target status")) {
    throw new Error("Target checkout is no longer clean");
  }
  const requiresIntegration = payload.deleteBranch || (payload.result === "already_integrated" && !payload.prUrl);
  if (requiresIntegration) {
    mustGit(payload.sourcePath, ["merge-base", "--is-ancestor", `refs/heads/${payload.branch}`, `refs/heads/${payload.sourceBranch}`], logs, "Work branch is no longer integrated");
  }
}

function historyFrom(record, payload) {
  return {
    id: record.id,
    repoId: record.repoId,
    repoKey: record.repoKey,
    repoCommonDir: record.repoCommonDir,
    repoIdentity: record.repoIdentity,
    path: record.path,
    branch: record.branch,
    sourcePath: record.sourcePath,
    sourceBranch: record.sourceBranch,
    sourceHead: record.sourceHead,
    finalHead: payload.finalHead,
    task: record.task,
    slug: record.slug,
    result: payload.result,
    prUrl: payload.prUrl,
    completedAt: new Date().toISOString(),
  };
}

async function updateRegistryUnlocked(payload, success, error) {
  let data;
  try {
    data = readJsonPrivate(payload.registryPath);
  } catch {
    return false;
  }
  const index = data.worktrees?.findIndex((item) => item.id === payload.recordId) ?? -1;
  if (index < 0) return false;
  const record = data.worktrees[index];
  if (record.transaction?.id !== payload.transactionId || record.transaction.cleanupAttemptId !== payload.cleanupAttemptId) {
    return false;
  }
  if (success) {
    data.worktrees.splice(index, 1);
    if (!Array.isArray(data.history)) data.history = [];
    data.history.unshift(historyFrom(record, payload));
  } else {
    record.state = payload.result === "merged" ? "merged_cleanup_pending" : "cleanup_pending";
    record.initError = redact(error);
    record.updatedAt = new Date().toISOString();
    record.transaction.phase = "awaiting_cleanup";
    record.transaction.cleanupAttemptId = undefined;
    record.transaction.updatedAt = record.updatedAt;
  }
  const temp = `${payload.registryPath}.${process.pid}.tmp`;
  const serialized = `${JSON.stringify(data, null, 2)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > 2 * 1024 * 1024) throw new Error("Updated registry exceeds the 2 MiB safety limit");
  writePrivate(temp, serialized);
  const { renameSync, chmodSync } = await import("node:fs");
  renameSync(temp, payload.registryPath);
  try { chmodSync(payload.registryPath, 0o600); } catch {}
  return true;
}

async function updateRegistry(payload, success, error) {
  let updated = false;
  await lock(payload.sourceLock, async () => {
    await lock(payload.registryLock, async () => {
      updated = await updateRegistryUnlocked(payload, success, error);
    });
  });
  if (updated && success) rmSync(payload.fallbackMarker, { force: true });
  return updated;
}

async function performCleanup(payload, logs) {
  let success = false;
  let failure;
  await lock(payload.sourceLock, async () => {
    await lock(payload.registryLock, async () => {
      validateCleanup(payload, logs);
      let removed = git(payload.sourcePath, ["worktree", "remove", payload.targetPath], logs);
      if (!removed.ok) {
        try {
          accessSync(payload.targetPath);
        } catch (error) {
          if (error?.code !== "ENOENT") throw error;
          git(payload.sourcePath, ["worktree", "prune"], logs);
          removed = { ok: true, output: "target already absent" };
        }
      }

      if (removed.ok && payload.deleteBranch) {
        const deletion = git(payload.sourcePath, ["branch", "-d", "--", payload.branch], logs);
        if (!deletion.ok) logs.push("Safe branch deletion failed; the integrated branch was retained.");
      }
      success = removed.ok;
      failure = success ? undefined : logs.at(-1) || "cleanup failed";
      mkdirSync(dirname(payload.logPath), { recursive: true, mode: 0o700 });
      writePrivate(payload.logPath, `${truncate(redact(logs.join("\n\n")))}\n`);
      if (!(await updateRegistryUnlocked(payload, success, failure))) {
        throw new Error("Cleanup registry transaction changed while locks were held");
      }
    });
  });
  if (success) rmSync(payload.fallbackMarker, { force: true });
  return { success, failure };
}

async function main() {
  const encoded = process.argv[2];
  if (!encoded) throw new Error("Missing cleanup payload");
  const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  validatePayloadShape(payload);
  registryRecord(payload);
  if (process.send) process.send({ ready: true });
  if (process.disconnect) process.disconnect();
  cleanupWasAnnounced = true;

  while (alive(payload.parentPid)) await sleep(150);

  const logs = [`Cleanup started ${new Date().toISOString()}`, `Target: ${payload.targetPath}`];
  const { success } = await performCleanup(payload, logs);
  process.exitCode = success ? 0 : 1;
}

main().catch(async (error) => {
  try {
    const encoded = process.argv[2];
    if (encoded && cleanupWasAnnounced) {
      const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
      validatePayloadShape(payload);
      await updateRegistry(payload, false, redact(error instanceof Error ? error.message : String(error)));
      mkdirSync(dirname(payload.logPath), { recursive: true, mode: 0o700 });
      writePrivate(payload.logPath, `${truncate(redact(error?.stack ?? error))}\n`);
    }
  } catch {}
  process.stderr.write(`${truncate(redact(error?.stack ?? error), 64 * 1024)}\n`);
  process.exitCode = 1;
});
