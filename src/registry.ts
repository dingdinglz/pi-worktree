import { constants } from "node:fs";
import { chmod, mkdir, open, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type {
  FinishTransaction,
  ManagedWorktree,
  RegistryData,
  WorktreeHistoryEntry,
} from "./types.ts";
import { canonicalPath, newId, nowIso, pathExists, redactSecrets, shortHash, truncateText, withFileLock, writeJsonAtomic } from "./util.ts";

const EMPTY_REGISTRY: RegistryData = { version: 1, worktrees: [], history: [] };
const WORKTREE_STATES = new Set([
  "creating",
  "active",
  "init_failed",
  "finish_active",
  "finish_paused",
  "publish_authorized",
  "cleanup_pending",
  "cleanup_scheduled",
  "merged_cleanup_pending",
]);

function validRequiredString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !value.includes("\0");
}

function validIdentifier(value: unknown): value is string {
  return validRequiredString(value) && value.length <= 256 && /^[A-Za-z0-9_-]+$/.test(value);
}

function validIsoDate(value: unknown): value is string {
  if (!validRequiredString(value)) return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString() === value;
}

function validGitOid(value: unknown): value is string {
  return validRequiredString(value) && /^[0-9a-f]{40,64}$/i.test(value);
}

function validHttpUrl(value: unknown): value is string {
  if (!validRequiredString(value) || value.length > 4_096 || /[\u0000-\u0020\u007f-\u009f]/.test(value)) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && !parsed.username && !parsed.password && Boolean(parsed.hostname);
  } catch {
    return false;
  }
}

function validBranch(value: unknown): value is string {
  return validRequiredString(value) && value !== "@" && value.length <= 1_024 && !value.startsWith("-") &&
    !/[\x00-\x20~^:?*\\[]/.test(value) && !value.includes("..") && !value.includes("@{") &&
    !value.includes("//") && !value.endsWith("/") && !value.endsWith(".") && !value.endsWith(".lock");
}

function validRepoSpec(value: unknown): value is string {
  if (!validRequiredString(value)) return false;
  const parts = value.split("/");
  return parts.length === 3 && parts.every((part) => /^[A-Za-z0-9._-]+$/.test(part) && part !== "." && part !== "..");
}

function validRemoteIdentity(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const identity = value as Record<string, unknown>;
  for (const key of ["remote", "url", "host", "owner", "repo", "repoSpec"]) {
    if (!validRequiredString(identity[key]) || String(identity[key]).length > 4_096 || /[\u0000-\u001f\u007f-\u009f]/.test(String(identity[key]))) return false;
  }
  return !String(identity.host).includes("/") && !String(identity.repo).includes("/") &&
    identity.repoSpec === `${identity.host}/${identity.owner}/${identity.repo}`;
}

function validatePrPlan(value: unknown, registryPath: string): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid PR transaction in ${registryPath}`);
  const plan = value as Record<string, unknown>;
  for (const key of ["host", "baseRepo", "baseRemote", "baseBranch", "pushRemote", "pushRepo", "headBranch", "headOwner"]) {
    if (!validRequiredString(plan[key])) throw new Error(`Invalid PR transaction field ${key} in ${registryPath}`);
  }
  if (!validRepoSpec(plan.baseRepo) || !validRepoSpec(plan.pushRepo) || !/^[A-Za-z0-9_.-]+$/.test(String(plan.headOwner)) ||
      String(plan.baseRepo).split("/")[0] !== plan.host || String(plan.pushRepo).split("/")[0] !== plan.host ||
      String(plan.pushRepo).split("/")[1].toLowerCase() !== String(plan.headOwner).toLowerCase() ||
      !validBranch(plan.baseBranch) || !validBranch(plan.headBranch) ||
      !validBranch(`remote/${String(plan.baseRemote)}`) || !validBranch(`remote/${String(plan.pushRemote)}`)) {
    throw new Error(`Invalid PR repository, remote, or branch in ${registryPath}`);
  }
  for (const key of ["expectedRemoteSha", "forceLeaseSha"]) {
    if (plan[key] !== undefined && !validGitOid(plan[key])) throw new Error(`Invalid PR commit field ${key} in ${registryPath}`);
  }
  for (const key of ["existingUrl"]) {
    if (plan[key] !== undefined && !validHttpUrl(plan[key])) throw new Error(`Invalid PR URL in ${registryPath}`);
  }
  for (const key of ["existingIsDraft", "needsReopen", "draft"]) {
    if (plan[key] !== undefined && typeof plan[key] !== "boolean") throw new Error(`Invalid PR boolean field ${key} in ${registryPath}`);
  }
  if (plan.title !== undefined && (typeof plan.title !== "string" || plan.title.length > 256 || /[\u0000-\u001f\u007f-\u009f]/.test(plan.title))) {
    throw new Error(`Invalid PR title in ${registryPath}`);
  }
  if (plan.body !== undefined && (typeof plan.body !== "string" || /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(plan.body) || Buffer.byteLength(plan.body, "utf8") > 65_536)) {
    throw new Error(`Invalid PR body in ${registryPath}`);
  }
  if (plan.bodyFile !== undefined) {
    const bodyFile = String(plan.bodyFile);
    if (!isAbsolute(bodyFile) || dirname(resolve(bodyFile)) !== dirname(resolve(registryPath)) || !/^pr-body-[A-Za-z0-9_-]+-[A-Za-z0-9_-]+\.md$/.test(basename(bodyFile))) {
      throw new Error(`Invalid PR body file in ${registryPath}`);
    }
  }
}

function validateRegistryData(value: unknown, path: string): asserts value is RegistryData {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid registry object in ${path}`);
  const data = value as Record<string, unknown>;
  if (data.version !== 1 || !Array.isArray(data.worktrees) || !Array.isArray(data.history)) {
    throw new Error(`Unsupported registry format in ${path}`);
  }
  const activeIds = new Set<string>();
  const activePaths = new Set<string>();
  const activeBranches = new Set<string>();
  for (const item of data.worktrees) {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`Invalid worktree record in ${path}`);
    const record = item as Record<string, unknown>;
    for (const key of ["id", "repoId", "repoKey", "repoCommonDir", "path", "branch", "sourcePath", "sourceBranch", "sourceHead", "task", "slug", "createdAt", "updatedAt"]) {
      if (!validRequiredString(record[key])) throw new Error(`Invalid worktree record field ${key} in ${path}`);
    }
    if (!validIdentifier(record.id) || !validIdentifier(record.repoKey) || !validIdentifier(record.slug) ||
        activeIds.has(String(record.id)) || activePaths.has(String(record.path)) ||
        activeBranches.has(`${record.repoCommonDir}\0${record.branch}`) ||
        String(record.task).length > 500 || /[\u0000-\u001f\u007f-\u009f]/.test(String(record.task)) ||
        !validIsoDate(record.createdAt) || !validIsoDate(record.updatedAt) ||
        !validBranch(record.branch) || !validBranch(record.sourceBranch) || !validGitOid(record.sourceHead)) {
      throw new Error(`Invalid or duplicate worktree identifier, path, branch, or commit in ${path}`);
    }
    activeIds.add(String(record.id));
    activePaths.add(String(record.path));
    activeBranches.add(`${record.repoCommonDir}\0${record.branch}`);
    if (record.path === record.sourcePath || String(record.path).startsWith(`${record.sourcePath}${sep}`) ||
        String(record.sourcePath).startsWith(`${record.path}${sep}`) || !isAbsolute(String(record.repoCommonDir)) ||
        !isAbsolute(String(record.path)) || !isAbsolute(String(record.sourcePath)) ||
        resolve(String(record.repoCommonDir)) !== record.repoCommonDir || resolve(String(record.path)) !== record.path ||
        resolve(String(record.sourcePath)) !== record.sourcePath) {
      throw new Error(`Registry checkout paths must be distinct, non-nested normalized absolute paths in ${path}`);
    }
    if (typeof record.relativeCwd !== "string" || record.relativeCwd.length > 4_096 || record.relativeCwd.includes("\0") || isAbsolute(record.relativeCwd) ||
        (resolve(String(record.path), record.relativeCwd) !== resolve(String(record.path)) &&
          !resolve(String(record.path), record.relativeCwd).startsWith(`${resolve(String(record.path))}${sep}`))) {
      throw new Error(`Invalid relativeCwd in ${path}`);
    }
    if (!WORKTREE_STATES.has(String(record.state))) throw new Error(`Invalid worktree state in ${path}`);
    if (record.repoIdentity !== undefined && (!validRemoteIdentity(record.repoIdentity) ||
        record.repoId !== (record.repoIdentity as Record<string, unknown>).repoSpec)) {
      throw new Error(`Invalid worktree repository identity in ${path}`);
    }
    if (record.initError !== undefined && (typeof record.initError !== "string" || Buffer.byteLength(record.initError, "utf8") > 1_048_576 || record.initError.includes("\0"))) {
      throw new Error(`Invalid worktree recovery error in ${path}`);
    }
    if (record.prUrl !== undefined && !validHttpUrl(record.prUrl)) throw new Error(`Invalid worktree PR URL in ${path}`);
    if (record.transaction !== undefined) {
      if (!record.transaction || typeof record.transaction !== "object" || Array.isArray(record.transaction)) {
        throw new Error(`Invalid finish transaction in ${path}`);
      }
      const transaction = record.transaction as Record<string, unknown>;
      if (transaction.cleanupResult !== undefined && !["pr", "merged", "already_integrated"].includes(String(transaction.cleanupResult))) {
        throw new Error(`Invalid cleanup transaction result in ${path}`);
      }
      if (transaction.cleanupAttemptId !== undefined && !validIdentifier(transaction.cleanupAttemptId)) {
        throw new Error(`Invalid cleanup attempt ID in ${path}`);
      }
      if (transaction.pr !== undefined) validatePrPlan(transaction.pr, path);
      if ((transaction.mode === "merge" && transaction.pr !== undefined) ||
          (transaction.sessionId !== undefined && (!validRequiredString(transaction.sessionId) || String(transaction.sessionId).length > 4_096))) {
        throw new Error(`Invalid finish transaction metadata in ${path}`);
      }
      if (!validIdentifier(transaction.id) || !validGitOid(transaction.sourceHead) ||
          (transaction.workHead !== undefined && !validGitOid(transaction.workHead)) ||
          (transaction.mergedHead !== undefined && !validGitOid(transaction.mergedHead)) ||
          !validIsoDate(transaction.startedAt) || !validIsoDate(transaction.updatedAt) ||
          !["pr", "merge"].includes(String(transaction.mode)) ||
          !["agent_prepare", "publish_authorized", "awaiting_cleanup", "cleanup_scheduled"].includes(String(transaction.phase))) {
        throw new Error(`Invalid finish transaction in ${path}`);
      }
      const bodyFile = (transaction.pr as Record<string, unknown> | undefined)?.bodyFile;
      if (bodyFile !== undefined) {
        const bodyName = basename(String(bodyFile));
        const prefix = `pr-body-${transaction.id}-`;
        if (!bodyName.startsWith(prefix) || !/^[A-Za-z0-9_-]+\.md$/.test(bodyName.slice(prefix.length))) {
          throw new Error(`PR body file does not belong to its finish transaction in ${path}`);
        }
      }
      const phase = String(transaction.phase);
      const state = String(record.state);
      const phaseStateValid =
        (phase === "agent_prepare" && ["finish_active", "finish_paused"].includes(state)) ||
        (phase === "publish_authorized" && ["publish_authorized", "finish_paused"].includes(state)) ||
        (phase === "awaiting_cleanup" && ["cleanup_pending", "merged_cleanup_pending"].includes(state)) ||
        (phase === "cleanup_scheduled" && state === "cleanup_scheduled");
      const cleanupPhase = ["awaiting_cleanup", "cleanup_scheduled"].includes(phase);
      const cleanupResult = transaction.cleanupResult;
      if (!phaseStateValid ||
          (phase === "cleanup_scheduled") !== (transaction.cleanupAttemptId !== undefined) ||
          (["publish_authorized", "awaiting_cleanup", "cleanup_scheduled"].includes(phase) && transaction.workHead === undefined) ||
          (cleanupPhase && cleanupResult === undefined) ||
          (phase === "awaiting_cleanup" && (state === "merged_cleanup_pending") !== (cleanupResult === "merged")) ||
          (cleanupPhase && cleanupResult === "pr" && record.prUrl === undefined) ||
          (cleanupPhase && cleanupResult === "merged" && record.prUrl !== undefined)) {
        throw new Error(`Finish transaction phase and worktree state are inconsistent in ${path}`);
      }
    } else if (["finish_active", "finish_paused", "publish_authorized", "cleanup_pending", "cleanup_scheduled", "merged_cleanup_pending"].includes(String(record.state))) {
      throw new Error(`Worktree state requires a finish transaction in ${path}`);
    }
  }
  const recordsByPath = new Map((data.worktrees as ManagedWorktree[]).map((record) => [record.path, record]));
  for (const record of data.worktrees as ManagedWorktree[]) {
    const visited = new Set([record.path]);
    let sourcePath = record.sourcePath;
    while (recordsByPath.has(sourcePath)) {
      if (visited.has(sourcePath)) throw new Error(`Managed worktree source dependency cycle detected in ${path}`);
      visited.add(sourcePath);
      sourcePath = recordsByPath.get(sourcePath)!.sourcePath;
    }
  }
  const historyIds = new Set<string>();
  for (const item of data.history) {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`Invalid history record in ${path}`);
    const record = item as Record<string, unknown>;
    for (const key of ["id", "repoId", "repoKey", "repoCommonDir", "path", "branch", "sourcePath", "sourceBranch", "sourceHead", "finalHead", "task", "slug", "completedAt"]) {
      if (!validRequiredString(record[key])) throw new Error(`Invalid history field ${key} in ${path}`);
    }
    if (!validIdentifier(record.id) || historyIds.has(String(record.id)) || !validIdentifier(record.repoKey) || !validIdentifier(record.slug) ||
        String(record.task).length > 500 || /[\u0000-\u001f\u007f-\u009f]/.test(String(record.task)) || !validIsoDate(record.completedAt) ||
        !validBranch(record.branch) || !validBranch(record.sourceBranch) ||
        !validGitOid(record.sourceHead) || !validGitOid(record.finalHead)) {
      throw new Error(`Invalid or duplicate history identifier, branch, or commit in ${path}`);
    }
    historyIds.add(String(record.id));
    if (record.repoIdentity !== undefined && (!validRemoteIdentity(record.repoIdentity) ||
        record.repoId !== (record.repoIdentity as Record<string, unknown>).repoSpec)) {
      throw new Error(`Invalid history repository identity in ${path}`);
    }
    if (record.path === record.sourcePath || String(record.path).startsWith(`${record.sourcePath}${sep}`) ||
        String(record.sourcePath).startsWith(`${record.path}${sep}`) || !isAbsolute(String(record.repoCommonDir)) ||
        !isAbsolute(String(record.path)) || !isAbsolute(String(record.sourcePath)) ||
        resolve(String(record.repoCommonDir)) !== record.repoCommonDir || resolve(String(record.path)) !== record.path ||
        resolve(String(record.sourcePath)) !== record.sourcePath) {
      throw new Error(`Registry history paths must be distinct, non-nested normalized absolute paths in ${path}`);
    }
    if (!["pr", "merged", "already_integrated"].includes(String(record.result)) ||
        (record.result === "pr" && record.prUrl === undefined) || (record.result === "merged" && record.prUrl !== undefined)) {
      throw new Error(`Invalid or inconsistent history result in ${path}`);
    }
    if (record.prUrl !== undefined && !validHttpUrl(record.prUrl)) throw new Error(`Invalid history PR URL in ${path}`);
  }
}

export class Registry {
  readonly agentDir: string;
  readonly baseDir: string;
  readonly path: string;
  readonly lockPath: string;
  readonly logsDir: string;
  readonly markersDir: string;
  readonly locksDir: string;

  constructor(agentDir = getAgentDir()) {
    this.agentDir = resolve(agentDir);
    this.baseDir = join(this.agentDir, "worktree");
    this.path = join(this.baseDir, "registry.json");
    this.lockPath = join(this.baseDir, "registry.lock");
    this.logsDir = join(this.baseDir, "logs");
    this.markersDir = join(this.baseDir, "markers");
    this.locksDir = join(this.baseDir, "locks");
  }

  async ensure(): Promise<void> {
    const canonicalAgentDir = await canonicalPath(this.agentDir, true);
    const expectedBaseDir = join(canonicalAgentDir, "worktree");
    if ((await canonicalPath(this.baseDir, true)) !== expectedBaseDir) {
      throw new Error(`Worktree state directory is symlink-diverted: ${this.baseDir}`);
    }
    await mkdir(this.baseDir, { recursive: true, mode: 0o700 });
    const canonicalBaseDir = await canonicalPath(this.baseDir);
    const directories = [this.logsDir, this.markersDir, this.locksDir];
    for (const path of directories) {
      if ((await canonicalPath(path, true)) !== join(canonicalBaseDir, basename(path))) {
        throw new Error(`Worktree state subdirectory is symlink-diverted: ${path}`);
      }
      await mkdir(path, { recursive: true, mode: 0o700 });
    }
    await Promise.all([this.baseDir, ...directories].map((path) => chmod(path, 0o700).catch(() => undefined)));
  }

  private async loadUnlocked(): Promise<RegistryData> {
    try {
      const handle = await open(this.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      let text: string;
      try {
        const info = await handle.stat();
        if (!info.isFile()) throw new Error(`Registry path is not a regular file: ${this.path}`);
        if (info.size > 2 * 1024 * 1024) throw new Error(`Registry exceeds the 2 MiB safety limit: ${this.path}`);
        text = await handle.readFile("utf8");
      } finally {
        await handle.close();
      }
      let raw: unknown;
      try {
        raw = JSON.parse(text) as unknown;
      } catch {
        throw new Error(`Registry contains invalid JSON: ${this.path}`);
      }
      validateRegistryData(raw, this.path);
      return raw;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return structuredClone(EMPTY_REGISTRY);
      throw error;
    }
  }

  async load(): Promise<RegistryData> {
    await this.ensure();
    return this.loadUnlocked();
  }

  async mutate<T>(mutator: (data: RegistryData) => T | Promise<T>): Promise<T> {
    await this.ensure();
    return withFileLock(this.lockPath, async () => {
      const data = await this.loadUnlocked();
      const result = await mutator(data);
      validateRegistryData(data, this.path);
      await writeJsonAtomic(this.path, data, 0o600);
      return result;
    });
  }

  async add(record: ManagedWorktree): Promise<void> {
    await this.mutate((data) => {
      const duplicate = data.worktrees.find(
        (item) => item.id === record.id || item.path === record.path ||
          (item.repoCommonDir === record.repoCommonDir && item.branch === record.branch),
      );
      if (duplicate) throw new Error(`A managed worktree already exists for ${duplicate.path} (${duplicate.branch})`);
      data.worktrees.push(record);
    });
  }

  async update(id: string, updater: (record: ManagedWorktree) => void): Promise<ManagedWorktree> {
    return this.mutate((data) => {
      const record = data.worktrees.find((item) => item.id === id);
      if (!record) throw new Error(`Managed worktree not found: ${id}`);
      updater(record);
      record.updatedAt = nowIso();
      return structuredClone(record);
    });
  }

  async beginFinishTransaction(id: string, transaction: FinishTransaction): Promise<ManagedWorktree> {
    return this.mutate((data) => {
      const record = data.worktrees.find((item) => item.id === id);
      if (!record) throw new Error(`Managed worktree not found: ${id}`);
      const protectedBranches = new Set([record.sourceBranch, record.branch]);
      const conflict = data.worktrees.find(
        (item) => item.id !== id && item.repoCommonDir === record.repoCommonDir && item.transaction &&
          ["agent_prepare", "publish_authorized"].includes(item.transaction.phase) &&
          (protectedBranches.has(item.sourceBranch) || protectedBranches.has(item.branch)),
      );
      if (conflict) {
        throw new Error(
          `Source branch ${record.sourceBranch} is locked by worktree ${conflict.id} (${conflict.path}); resume or cancel it first`,
        );
      }
      record.state = "finish_active";
      record.transaction = transaction;
      record.updatedAt = nowIso();
      return structuredClone(record);
    });
  }

  async findById(id: string): Promise<ManagedWorktree | undefined> {
    const data = await this.load();
    const exact = data.worktrees.find((item) => item.id === id);
    if (exact) return exact;
    const matches = data.worktrees.filter((item) => item.id.startsWith(id));
    if (matches.length > 1) throw new Error(`Ambiguous managed worktree id prefix: ${id}`);
    return matches[0];
  }

  async findByPath(path: string): Promise<ManagedWorktree | undefined> {
    const canonical = await canonicalPath(path, true);
    const data = await this.load();
    for (const item of data.worktrees) {
      if ((await canonicalPath(item.path, true)) === canonical) return item;
    }
    return undefined;
  }

  async records(repoKey?: string): Promise<ManagedWorktree[]> {
    const data = await this.load();
    return data.worktrees.filter((item) => !repoKey || item.repoKey === repoKey);
  }

  async history(repoKey?: string): Promise<WorktreeHistoryEntry[]> {
    const data = await this.load();
    return data.history.filter((item) => !repoKey || item.repoKey === repoKey);
  }

  async complete(
    id: string,
    result: WorktreeHistoryEntry["result"],
    finalHead: string,
    prUrl?: string,
  ): Promise<WorktreeHistoryEntry> {
    const completed = await this.mutate((data) => {
      const index = data.worktrees.findIndex((item) => item.id === id);
      if (index < 0) throw new Error(`Managed worktree not found: ${id}`);
      const record = data.worktrees[index];
      const history: WorktreeHistoryEntry = {
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
        finalHead,
        task: record.task,
        slug: record.slug,
        result,
        prUrl,
        completedAt: nowIso(),
      };
      data.worktrees.splice(index, 1);
      data.history.unshift(history);
      return history;
    });
    await this.removeMarker(id);
    return completed;
  }

  async removeRecord(id: string): Promise<void> {
    await this.mutate((data) => {
      data.worktrees = data.worktrees.filter((item) => item.id !== id);
    });
    await this.removeMarker(id);
  }

  async prune(options: { historyRetentionDays: number; logRetentionDays: number }): Promise<{
    historyRemoved: number;
    staleRecords: ManagedWorktree[];
    logsRemoved: number;
  }> {
    const historyCutoff = Date.now() - options.historyRetentionDays * 86_400_000;
    let historyRemoved = 0;
    const staleRecords: ManagedWorktree[] = [];
    const activePrBodies = new Set<string>();
    await this.mutate(async (data) => {
      for (const record of data.worktrees) {
        if (record.transaction?.pr?.bodyFile) activePrBodies.add(resolve(record.transaction.pr.bodyFile));
      }
      const before = data.history.length;
      data.history = options.historyRetentionDays === 0
        ? []
        : data.history.filter((item) => Date.parse(item.completedAt) >= historyCutoff);
      historyRemoved = before - data.history.length;
      for (const record of data.worktrees) {
        if (!(await pathExists(record.path))) staleRecords.push(structuredClone(record));
      }
    });

    let logsRemoved = 0;
    try {
      const { readdir, stat } = await import("node:fs/promises");
      const cutoff = Date.now() - options.logRetentionDays * 86_400_000;
      for (const directory of [this.logsDir, this.baseDir]) {
        for (const file of await readdir(directory)) {
          if (directory === this.baseDir && !/^pr-body-[A-Za-z0-9_-]+-[A-Za-z0-9_-]+\.md$/.test(file)) continue;
          const path = join(directory, file);
          if (activePrBodies.has(resolve(path))) continue;
          const info = await stat(path);
          if (!info.isFile()) continue;
          if (options.logRetentionDays === 0 || info.mtimeMs < cutoff) {
            await rm(path, { force: true });
            logsRemoved++;
          }
        }
      }
    } catch {
      // Missing or inaccessible log directory is reported by doctor, not prune.
    }
    return { historyRemoved, staleRecords, logsRemoved };
  }

  sourceLockPath(commonDir: string, branch: string): string {
    return join(this.locksDir, `${shortHash(`${commonDir}\0${branch}`, 20)}.lock`);
  }

  async writeMarker(record: ManagedWorktree, gitDir: string): Promise<void> {
    const marker = {
      version: 1,
      id: record.id,
      repoKey: record.repoKey,
      sourcePath: record.sourcePath,
      sourceBranch: record.sourceBranch,
    };
    try {
      await writeJsonAtomic(join(gitDir, "pi-worktree.json"), marker, 0o600);
    } catch {
      await writeJsonAtomic(join(this.markersDir, `${record.id}.json`), marker, 0o600);
    }
  }

  async removeMarker(id: string): Promise<void> {
    if (!validIdentifier(id)) throw new Error(`Invalid marker identifier: ${id}`);
    await rm(join(this.markersDir, `${id}.json`), { force: true });
  }

  assertPrBodyPath(path: string): void {
    const resolved = resolve(path);
    if (dirname(resolved) !== resolve(this.baseDir) || !/^pr-body-[A-Za-z0-9_-]+-[A-Za-z0-9_-]+\.md$/.test(basename(resolved))) {
      throw new Error(`Unrecognized PR body path: ${path}`);
    }
  }

  async validatePrBodyFile(path: string, expectedBody: string): Promise<boolean> {
    try {
      this.assertPrBodyPath(path);
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const info = await handle.stat();
        if (!info.isFile() || info.size > 65_536) return false;
        return (await handle.readFile("utf8")) === expectedBody;
      } finally {
        await handle.close();
      }
    } catch {
      return false;
    }
  }

  async removePrBody(path: string): Promise<void> {
    try {
      this.assertPrBodyPath(path);
    } catch {
      return;
    }
    await rm(resolve(path), { force: true });
  }

  async writeLog(name: string, content: string): Promise<string> {
    await this.ensure();
    const path = join(this.logsDir, `${name.replace(/[^A-Za-z0-9._-]+/g, "-")}-${Date.now()}-${newId()}.log`);
    const handle = await open(path, "wx", 0o600);
    try {
      try {
        await handle.writeFile(truncateText(redactSecrets(content), 2 * 1024 * 1024), "utf8");
      } finally {
        await handle.close();
      }
    } catch (error) {
      await rm(path, { force: true });
      throw error;
    }
    return path;
  }

  async reset(kind: "history" | "logs" | "config", configPaths: string[] = []): Promise<void> {
    if (kind === "history") {
      await this.mutate((data) => {
        data.history = [];
      });
      return;
    }
    if (kind === "logs") {
      await withFileLock(this.lockPath, async () => {
        await rm(this.logsDir, { recursive: true, force: true });
        await mkdir(this.logsDir, { recursive: true, mode: 0o700 });
        await chmod(this.logsDir, 0o700).catch(() => undefined);
      });
      return;
    }
    for (const path of configPaths) await rm(path, { force: true });
  }
}
