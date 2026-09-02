import { mkdir, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  assertSafeProjectConfigPath,
  configForDisplay,
  getConfigPaths,
  loadEffectiveConfig,
  saveConfig,
  validateConfig,
} from "./config.ts";
import {
  branchExists,
  discoverRepo,
  git,
  gitOk,
  gitOperationInProgress,
  isClean,
  listWorktrees,
  remoteIdentity,
  remoteNames,
  repositoryNamespace,
  sparsePatterns,
  statusEntries,
  validBranchName,
} from "./git.ts";
import { checkGh } from "./github.ts";
import { assertHookCommandsAvailable, describeHookStep, runHookSteps } from "./hooks.ts";
import { resolveLocale } from "./i18n.ts";
import { buildLaunchPlan, executeLaunchPlan, manualLaunchCommand } from "./launcher.ts";
import type { Registry } from "./registry.ts";
import { withCancellableLoader } from "./ui.ts";
import type {
  EffectiveConfig,
  HookRunResult,
  ManagedWorktree,
  WorktreeConfig,
  WorktreeHistoryEntry,
} from "./types.ts";
import {
  assertSupportedPlatform,
  canonicalPath,
  isDirectoryEmpty,
  isPathInside,
  newId,
  nowIso,
  pathExists,
  redactSecrets,
  readTextFileSafe,
  sanitizeForDisplay,
  slugifyTask,
  truncateText,
  withFileLock,
} from "./util.ts";

function formatHooks(steps: EffectiveConfig["hooks"]["postCreate"]): string {
  return steps.length === 0
    ? "(none)"
    : steps.map((step, index) => `${index + 1}. ${describeHookStep(step)}`).join("\n");
}

async function showText(ctx: ExtensionContext, title: string, text: string): Promise<void> {
  const safeTitle = sanitizeForDisplay(title);
  const safeText = sanitizeForDisplay(text);
  if (ctx.mode === "tui") await ctx.ui.editor(safeTitle, safeText);
  else ctx.ui.notify(safeText, "info");
}

async function loadCurrent(
  pi: ExtensionAPI,
  registry: Registry,
  ctx: ExtensionContext,
): Promise<{ repo: Awaited<ReturnType<typeof discoverRepo>>; config: EffectiveConfig }> {
  const repo = await discoverRepo(pi, ctx.cwd);
  const config = await loadEffectiveConfig({
    repoKey: repo.repoKey,
    projectRoot: repo.root,
    projectTrusted: ctx.isProjectTrusted(),
    agentDir: registry.agentDir,
  });
  return { repo, config };
}

async function launchRecord(
  ctx: ExtensionContext,
  record: ManagedWorktree,
  config: EffectiveConfig,
): Promise<void> {
  let cwd = record.path;
  if (record.relativeCwd) {
    const candidate = join(record.path, record.relativeCwd);
    try {
      const canonicalCandidate = await canonicalPath(candidate);
      if (isPathInside(canonicalCandidate, record.path) && (await stat(canonicalCandidate)).isDirectory()) cwd = canonicalCandidate;
    } catch {
      // Use root.
    }
  }
  const launcherContext = {
    record,
    config,
    cwd,
    model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
    thinking: ctx.thinkingLevel,
  };
  const manual = manualLaunchCommand(launcherContext);
  let plan;
  try {
    plan = buildLaunchPlan(launcherContext);
  } catch (error) {
    ctx.ui.notify(redactSecrets(`Launcher configuration failed: ${error instanceof Error ? error.message : error}\n${manual}`), "warning");
    return;
  }
  if (!plan) {
    ctx.ui.notify(manual, "info");
    return;
  }
  try {
    await executeLaunchPlan(plan);
    ctx.ui.notify(`Opened ${record.path} in ${plan.description}`, "info");
  } catch (error) {
    ctx.ui.notify(redactSecrets(`Launcher failed: ${error instanceof Error ? error.message : error}\n${manual}`), "warning");
  }
}

export async function adoptWorktree(
  pi: ExtensionAPI,
  registry: Registry,
  ctx: ExtensionCommandContext,
): Promise<ManagedWorktree | undefined> {
  if (ctx.mode !== "tui") throw new Error("Adopt is available only in interactive TUI mode");
  assertSupportedPlatform();
  await ctx.waitForIdle();
  const zh = resolveLocale("auto") === "zh-CN";
  let target = await discoverRepo(pi, ctx.cwd);
  if (!target.head) throw new Error("Cannot adopt a worktree without a commit");
  if (target.gitDir === target.commonDir) throw new Error("The repository's primary checkout cannot be adopted as a removable worktree");
  const targetOperation = await gitOperationInProgress(pi, target.root);
  if (targetOperation) throw new Error(`Target worktree has a Git operation in progress: ${targetOperation}`);
  if (await registry.findByPath(target.root)) throw new Error("This worktree is already managed");
  const entries = await listWorktrees(pi, target.root);
  const candidates = entries.filter((entry) => entry.path !== target.root && entry.branch && !entry.prunable);
  if (candidates.length === 0) throw new Error("No other branch checkout is available as the recorded source");
  const selected = await ctx.ui.select(
    zh ? "选择准确的来源 checkout" : "Select the exact source checkout",
    candidates.map((entry) => `${entry.path} — ${entry.branch}`),
  );
  if (!selected) return undefined;
  const sourcePath = selected.slice(0, selected.lastIndexOf(" — "));
  const source = await discoverRepo(pi, sourcePath);
  if (source.root !== sourcePath || source.commonDir !== target.commonDir) {
    throw new Error("Selected source checkout was moved, replaced, or belongs to another repository");
  }
  if (!source.branch) throw new Error("Selected source checkout is detached");
  if (isPathInside(target.root, source.root) || isPathInside(source.root, target.root)) {
    throw new Error("Source and target worktrees must not contain one another");
  }
  if (!(await isClean(pi, source.root))) throw new Error("Selected source checkout is not clean");
  const operation = await gitOperationInProgress(pi, source.root);
  if (operation) throw new Error(`Selected source checkout has a Git operation in progress: ${operation}`);

  let branch = target.branch;
  const detachedHead = target.head;
  const task = (await ctx.ui.input(zh ? "任务描述" : "Task description", branch || "adopted worktree"))?.trim();
  if (!task) return undefined;
  if (task.length > 500 || /[\u0000-\u001f\u007f-\u009f]/.test(task)) throw new Error("Task description must be a control-free single line of at most 500 characters");
  if (!branch) {
    const proposed = `wt/${slugifyTask(task)}`;
    branch = (await ctx.ui.input(zh ? "为 detached worktree 创建的分支" : "Branch to create for the detached worktree", proposed))?.trim() ?? "";
    if (!branch || !(await validBranchName(pi, target.root, branch))) throw new Error(`Invalid branch: ${branch}`);
    if (await branchExists(pi, target.root, branch)) throw new Error(`Branch already exists: ${branch}`);
  }
  const approved = await ctx.ui.confirm(
    zh ? "接管此 worktree？" : "Adopt this worktree?",
    `Target: ${target.root}\nWork branch: ${branch}${target.branch ? "" : " (will be created at current HEAD)"}\nSource: ${source.root}\nSource branch: ${source.branch} @ ${source.head.slice(0, 12)}`,
  );
  if (!approved) return undefined;
  const timestamp = nowIso();
  const canonicalCwd = await canonicalPath(ctx.cwd);
  const relativeCwd = isPathInside(canonicalCwd, target.root) ? relative(target.root, canonicalCwd) : "";
  const record: ManagedWorktree = {
    id: newId(),
    repoId: target.repoId,
    repoKey: target.repoKey,
    repoCommonDir: target.commonDir,
    repoIdentity: target.identity,
    path: target.root,
    branch,
    sourcePath: source.root,
    sourceBranch: source.branch,
    sourceHead: source.head,
    relativeCwd,
    task,
    slug: slugifyTask(task),
    state: "creating",
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  await registry.add(record);
  let createdBranch = false;
  try {
    await withFileLock(registry.sourceLockPath(source.commonDir, source.branch), async () => {
      const managedRecords = await registry.records();
      const currentSource = managedRecords.find((item) => item.id !== record.id && item.path === source.root);
      const conflict = managedRecords.find((item) => item.id !== record.id && item.repoCommonDir === source.commonDir &&
        (item.sourceBranch === source.branch || item.branch === source.branch) && item.transaction &&
        ["agent_prepare", "publish_authorized"].includes(item.transaction.phase));
      if (currentSource?.transaction || conflict) {
        throw new Error("Selected source branch has an active finish transaction; resume or cancel it first");
      }
      const latestSource = await discoverRepo(pi, source.root);
      const latestTarget = await discoverRepo(pi, target.root);
      if (latestSource.root !== source.root || latestSource.commonDir !== source.commonDir ||
          latestSource.branch !== source.branch || latestSource.head !== source.head ||
          (await gitOperationInProgress(pi, source.root)) || !(await isClean(pi, source.root))) {
        throw new Error("Selected source checkout changed after confirmation");
      }
      if (latestTarget.root !== target.root || latestTarget.commonDir !== target.commonDir ||
          latestTarget.head !== detachedHead || latestTarget.branch !== target.branch ||
          (await gitOperationInProgress(pi, target.root))) {
        throw new Error("Target branch or HEAD changed after confirmation");
      }
      if (!target.branch) {
        await gitOk(pi, target.root, ["switch", "-c", branch], "Unable to create branch while adopting worktree");
        createdBranch = true;
      }
      const finalTarget = await discoverRepo(pi, target.root);
      if (finalTarget.root !== target.root || finalTarget.commonDir !== target.commonDir ||
          finalTarget.branch !== branch || finalTarget.head !== detachedHead) {
        throw new Error("Target worktree changed before it could be registered");
      }
      target = finalTarget;
      await registry.update(record.id, (item) => {
        if (item.state !== "creating") throw new Error("Adoption reservation changed before activation");
        item.state = "active";
      });
    });
  } catch (error) {
    let safelyReverted = !createdBranch;
    if (createdBranch) {
      try {
        await withFileLock(registry.sourceLockPath(source.commonDir, source.branch), async () => {
          const latestTarget = await discoverRepo(pi, target.root);
          if (latestTarget.root !== target.root || latestTarget.commonDir !== target.commonDir ||
              latestTarget.branch !== branch || latestTarget.head !== detachedHead ||
              (await gitOperationInProgress(pi, target.root))) return;
          await gitOk(pi, target.root, ["switch", "--detach", detachedHead], "Unable to restore detached checkout after adoption failure");
          const deletion = await git(pi, target.root, ["branch", "-d", "--", branch]);
          safelyReverted = true;
          if (deletion.code !== 0) {
            await registry.writeLog(record.id, `Adoption rollback retained branch ${branch}:\n${deletion.stderr || deletion.stdout}`);
          }
        });
      } catch {
        safelyReverted = false;
      }
    }
    if (safelyReverted) {
      await registry.removeRecord(record.id);
    } else {
      await registry.update(record.id, (item) => {
        item.state = "init_failed";
        item.initError = `Adoption failed after creating the work branch: ${redactSecrets(error instanceof Error ? error.message : String(error))}`;
      });
    }
    throw error;
  }
  try {
    await registry.writeMarker(record, target.gitDir);
  } catch (error) {
    ctx.ui.notify(redactSecrets(`Adopted successfully, but marker metadata could not be written: ${error instanceof Error ? error.message : error}`), "warning");
  }
  const active = (await registry.findById(record.id)) ?? { ...record, state: "active" as const };
  ctx.ui.notify(`${zh ? "已接管" : "Adopted"} ${active.path}: ${active.branch} ← ${active.sourceBranch}`, "info");
  return active;
}

async function restoreBranchFromPr(
  pi: ExtensionAPI,
  registry: Registry,
  ctx: ExtensionCommandContext,
  history: WorktreeHistoryEntry,
): Promise<void> {
  const zh = resolveLocale("auto") === "zh-CN";
  if (!history.prUrl) throw new Error(`Local branch no longer exists: ${history.branch}`);
  const result = await pi.exec(
    "gh",
    ["pr", "view", history.prUrl, "--json", "headRefName,headRefOid,headRepository"],
    { cwd: history.sourcePath, timeout: 30_000 },
  );
  if (result.code !== 0) throw new Error(redactSecrets(result.stderr.trim()) || "Unable to inspect historical PR");
  let info: {
    headRefName: string;
    headRefOid: string;
    headRepository: { nameWithOwner: string };
  };
  try {
    const parsed = JSON.parse(result.stdout) as Partial<typeof info>;
    if (typeof parsed.headRefName !== "string" || typeof parsed.headRefOid !== "string" ||
        !/^[0-9a-f]{40,64}$/i.test(parsed.headRefOid) ||
        typeof parsed.headRepository?.nameWithOwner !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(parsed.headRepository.nameWithOwner)) {
      throw new Error("incomplete");
    }
    info = parsed as typeof info;
  } catch {
    throw new Error("GitHub CLI returned invalid historical PR JSON");
  }
  if (info.headRefName !== history.branch) throw new Error("Historical PR head branch no longer matches the recorded branch");
  const names = await remoteNames(pi, history.sourcePath);
  const matches: string[] = [];
  for (const name of names) {
    const identity = await remoteIdentity(pi, history.sourcePath, name);
    if (!identity || !info.headRepository?.nameWithOwner) continue;
    if (`${identity.owner}/${identity.repo}`.toLowerCase() === info.headRepository.nameWithOwner.toLowerCase()) matches.push(name);
  }
  if (matches.length === 0) throw new Error("No configured remote matches the historical PR head repository");
  const remote = matches.length === 1 ? matches[0] : await ctx.ui.select(zh ? "选择 PR head remote" : "Select PR head remote", matches);
  if (!remote) throw new Error("Branch restore cancelled");
  const approved = await ctx.ui.confirm(
    zh ? "恢复本地 PR 分支？" : "Restore local PR branch?",
    `${remote}/${info.headRefName} @ ${info.headRefOid}\nLocal branch: ${history.branch}`,
  );
  if (!approved) throw new Error("Branch restore cancelled");
  await withFileLock(registry.sourceLockPath(history.repoCommonDir, history.sourceBranch), async () => {
    const source = await discoverRepo(pi, history.sourcePath);
    if (source.root !== history.sourcePath || source.commonDir !== history.repoCommonDir ||
        source.branch !== history.sourceBranch || (await gitOperationInProgress(pi, source.root))) {
      throw new Error("Recorded source checkout changed or has a Git operation in progress");
    }
    if (await branchExists(pi, history.sourcePath, history.branch)) {
      const existing = await gitOk(pi, history.sourcePath, ["rev-parse", `refs/heads/${history.branch}`]);
      if (existing !== info.headRefOid) throw new Error("The historical branch appeared at a different SHA during restore");
      return;
    }
    await gitOk(
      pi,
      history.sourcePath,
      ["fetch", "--no-tags", "--", remote, `refs/heads/${info.headRefName}`],
      "Unable to fetch the historical PR branch",
      { timeout: 120_000 },
    );
    const fetched = await gitOk(pi, history.sourcePath, ["rev-parse", "--verify", "FETCH_HEAD"]);
    if (fetched !== info.headRefOid) throw new Error("Fetched PR branch SHA does not match the approved historical PR head");
    await gitOk(pi, history.sourcePath, ["branch", "--", history.branch, info.headRefOid], "Unable to restore local branch");
  });
  const restored = await git(pi, history.sourcePath, ["rev-parse", `refs/heads/${history.branch}`]);
  if (restored.code !== 0 || restored.stdout.trim() !== info.headRefOid) throw new Error("Restored branch SHA does not match historical PR");
}

async function retryInitialization(
  pi: ExtensionAPI,
  registry: Registry,
  ctx: ExtensionCommandContext,
  record: ManagedWorktree,
): Promise<ManagedWorktree> {
  let target = await discoverRepo(pi, record.path);
  if (target.root !== record.path || target.commonDir !== record.repoCommonDir) {
    throw new Error("Managed worktree identity changed; initialization retry is blocked");
  }
  const recreateMissingBranch = target.branch !== record.branch;
  if (recreateMissingBranch && (target.branch || (await branchExists(pi, target.root, record.branch)))) {
    throw new Error("Managed worktree branch changed; initialization retry is blocked");
  }
  const operation = await gitOperationInProgress(pi, record.path);
  if (operation) throw new Error(`Worktree has a Git operation in progress: ${operation}`);
  const config = await loadEffectiveConfig({
    repoKey: record.repoKey,
    projectRoot: record.path,
    projectTrusted: ctx.isProjectTrusted(),
    agentDir: registry.agentDir,
  });
  const zh = resolveLocale(config.locale) === "zh-CN";
  await assertHookCommandsAvailable(config.hooks.postCreate, record.path);
  const entries = await statusEntries(pi, record.path);
  const approved = await ctx.ui.confirm(
    zh ? "重试 worktree 初始化？" : "Retry worktree initialization?",
    `${record.path}\n${recreateMissingBranch ? `${zh ? "将重新创建分支" : "Will recreate branch"}: ${record.branch} @ ${target.head}\n` : ""}\nPost-create hooks:\n${formatHooks(config.hooks.postCreate)}\n\nGit status entries (${entries.length}):\n${truncateText(redactSecrets(entries.join("\n"))) || "(none)"}`,
  );
  if (!approved) return record;
  if (recreateMissingBranch) {
    const approvedHead = target.head;
    await withFileLock(registry.sourceLockPath(record.repoCommonDir, record.sourceBranch), async () => {
      const [source, latestTarget] = await Promise.all([
        discoverRepo(pi, record.sourcePath),
        discoverRepo(pi, record.path),
      ]);
      if (source.root !== record.sourcePath || source.commonDir !== record.repoCommonDir ||
          source.branch !== record.sourceBranch || (await gitOperationInProgress(pi, source.root)) || !(await isClean(pi, source.root)) ||
          latestTarget.root !== record.path || latestTarget.commonDir !== record.repoCommonDir || latestTarget.branch ||
          latestTarget.head !== approvedHead || (await branchExists(pi, latestTarget.root, record.branch)) ||
          (await gitOperationInProgress(pi, latestTarget.root))) {
        throw new Error("Source, target, or missing branch changed before initialization recovery");
      }
      await gitOk(pi, latestTarget.root, ["switch", "-c", record.branch], "Unable to recreate the managed work branch");
    });
    target = await discoverRepo(pi, record.path);
    if (target.branch !== record.branch || target.head !== approvedHead) {
      throw new Error("Recreated work branch does not match the approved recovery HEAD");
    }
  }
  await registry.writeMarker(record, target.gitDir);
  const loaded: { value?: HookRunResult; error?: Error } = config.hooks.postCreate.length === 0
    ? { value: { ok: true, aborted: false, stdout: "", stderr: "" } }
    : await withCancellableLoader(
        ctx,
        zh ? "正在运行 postCreate hooks…（Esc 取消）" : "Running postCreate hooks… (Esc to cancel)",
        (signal) => runHookSteps({
          registry,
          name: "postCreate-retry",
          steps: config.hooks.postCreate,
          context: { record, mode: "create" },
          signal,
        }),
      );
  const result: HookRunResult = loaded.error
    ? { ok: false, aborted: false, stdout: "", stderr: "", error: loaded.error.message }
    : loaded.value ?? { ok: false, aborted: true, stdout: "", stderr: "", error: "Hook aborted" };
  const updated = await registry.update(record.id, (item) => {
    item.state = result.ok ? "active" : "init_failed";
    item.initError = result.ok ? undefined : `${result.error}${result.logPath ? `; log: ${result.logPath}` : ""}`;
  });
  if (result.ok) await launchRecord(ctx, updated, config);
  else ctx.ui.notify(`${zh ? "初始化仍然失败" : "Initialization still failed"}: ${result.error}`, "warning");
  return updated;
}

export async function reopenWorktree(
  pi: ExtensionAPI,
  registry: Registry,
  ctx: ExtensionCommandContext,
  requestedId?: string,
): Promise<ManagedWorktree | undefined> {
  if (ctx.mode !== "tui") throw new Error("Reopen is available only in interactive TUI mode");
  assertSupportedPlatform();
  await ctx.waitForIdle();
  let zh = resolveLocale("auto") === "zh-CN";
  const current = await loadCurrent(pi, registry, ctx);
  const currentRecord = await registry.findByPath(current.repo.root);
  if (!requestedId && currentRecord?.state === "init_failed") {
    return retryInitialization(pi, registry, ctx, currentRecord);
  }
  const historyEntries = (await registry.history()).filter(
    (item) => item.repoCommonDir === current.repo.commonDir && item.result === "pr" && item.prUrl,
  );
  let history: WorktreeHistoryEntry | undefined;
  if (requestedId) {
    history = historyEntries.find((item) => item.id === requestedId);
    if (!history) {
      const matches = historyEntries.filter((item) => item.id.startsWith(requestedId));
      if (matches.length > 1) throw new Error(`Ambiguous history id prefix: ${requestedId}`);
      history = matches[0];
    }
  }
  if (requestedId && !history) throw new Error(`Historical PR worktree not found: ${requestedId}`);
  if (!history && historyEntries.length === 0) throw new Error("No completed PR worktree is available to reopen");
  if (!history) {
    const options = historyEntries.map((item) => `${item.id} — ${item.branch} — ${item.prUrl}`);
    const selected = await ctx.ui.select(
      zh ? "重新打开 PR worktree" : "Reopen a PR worktree",
      options,
    );
    if (!selected) return undefined;
    history = historyEntries[options.indexOf(selected)];
  }
  if (!history) throw new Error("Historical PR worktree not found");
  const reopenConfig = await loadEffectiveConfig({
    repoKey: history.repoKey,
    projectRoot: history.sourcePath,
    projectTrusted: ctx.isProjectTrusted(),
    agentDir: registry.agentDir,
  });
  zh = resolveLocale(reopenConfig.locale) === "zh-CN";
  const source = await discoverRepo(pi, history.sourcePath);
  if (source.root !== history.sourcePath || source.commonDir !== history.repoCommonDir) {
    throw new Error("Recorded source checkout was moved, replaced, or now belongs to another repository");
  }
  if (source.branch !== history.sourceBranch) throw new Error(`Recorded source checkout is not on ${history.sourceBranch}`);
  if ((await gitOperationInProgress(pi, source.root)) || !(await isClean(pi, source.root))) {
    throw new Error("Recorded source checkout must be clean and have no Git operation in progress before reopening");
  }
  if (await registry.records().then((items) => items.some((item) => item.repoCommonDir === history!.repoCommonDir && item.branch === history!.branch))) {
    throw new Error(`Branch already has a managed worktree: ${history.branch}`);
  }
  if (!(await validBranchName(pi, history.sourcePath, history.branch))) throw new Error(`Historical branch name is invalid: ${history.branch}`);
  if (!(await branchExists(pi, history.sourcePath, history.branch))) await restoreBranchFromPr(pi, registry, ctx, history);
  const reopenHead = await gitOk(pi, history.sourcePath, ["rev-parse", `refs/heads/${history.branch}`], "Unable to inspect reopen branch");
  const existingCheckout = (await listWorktrees(pi, history.sourcePath)).find((item) => item.branch === history!.branch && !item.prunable);
  if (existingCheckout) {
    throw new Error(`Branch ${history.branch} is already checked out at ${existingCheckout.path}; run /wt adopt there instead`);
  }
  const namespace = repositoryNamespace(reopenConfig.worktreeRoot, {
    ...current.repo,
    repoId: history.repoId,
    identity: history.repoIdentity ?? current.repo.identity,
  });
  let path = await canonicalPath(join(namespace, history.slug), true);
  if (await pathExists(path) && !(await isDirectoryEmpty(path))) {
    const pathChoices = zh
      ? ["使用带序号的路径", "选择其他绝对路径", "取消"]
      : ["Use a numbered path", "Choose another absolute path", "Cancel"];
    const action = await ctx.ui.select(
      zh ? `首选恢复路径已占用：${path}` : `Preferred reopen path is occupied: ${path}`,
      pathChoices,
    );
    if (!action || action === pathChoices[2]) return undefined;
    if (action === pathChoices[0]) {
      let sequence = 2;
      do {
        path = await canonicalPath(join(namespace, `${history.slug}-${sequence++}`), true);
      } while (await pathExists(path));
    } else {
      const entered = (await ctx.ui.input(zh ? "绝对恢复路径" : "Absolute reopen path"))?.trim();
      if (!entered) return undefined;
      if (!isAbsolute(entered)) throw new Error("Reopen path must be absolute");
      path = await canonicalPath(entered, true);
      if ((await pathExists(path)) && !(await isDirectoryEmpty(path))) throw new Error(`Reopen path is not empty: ${path}`);
    }
  }
  if (isPathInside(path, current.repo.root) || isPathInside(path, history.sourcePath) ||
      isPathInside(current.repo.root, path) || isPathInside(history.sourcePath, path) || isPathInside(path, current.repo.commonDir)) {
    throw new Error("Reopen path cannot contain or be inside a repository checkout or Git admin directory");
  }
  const registeredAtPath = await registry.findByPath(path);
  if (registeredAtPath) throw new Error(`Reopen path is already managed by ${registeredAtPath.id}`);
  if ((await listWorktrees(pi, history.sourcePath)).some((item) => item.path === path)) {
    throw new Error(`Reopen path is already registered as a Git worktree: ${path}`);
  }
  if (!(await isClean(pi, history.sourcePath))) throw new Error("Recorded source checkout must be clean before reopening");
  const timestamp = nowIso();
  const record: ManagedWorktree = {
    id: newId(),
    repoId: history.repoId,
    repoKey: history.repoKey,
    repoCommonDir: history.repoCommonDir,
    repoIdentity: history.repoIdentity,
    path,
    branch: history.branch,
    sourcePath: history.sourcePath,
    sourceBranch: history.sourceBranch,
    sourceHead: source.head,
    relativeCwd: "",
    task: history.task,
    slug: history.slug,
    state: "creating",
    createdAt: timestamp,
    updatedAt: timestamp,
    prUrl: history.prUrl,
  };
  await assertHookCommandsAvailable(reopenConfig.hooks.postCreate, history.sourcePath);
  if (!(await ctx.ui.confirm(
    zh ? "重新打开 worktree？" : "Reopen worktree?",
    `${history.branch} @ ${reopenHead.slice(0, 12)}\n${path}\nPR: ${history.prUrl}\n\nPost-create hooks:\n${formatHooks(reopenConfig.hooks.postCreate)}`,
  ))) return undefined;
  await mkdir(dirname(path), { recursive: true });
  await registry.add(record);
  let created = false;
  let actualCreatedPath = path;
  let target: Awaited<ReturnType<typeof discoverRepo>>;
  try {
    await withFileLock(registry.sourceLockPath(source.commonDir, source.branch), async () => {
      const managedRecords = await registry.records();
      const currentSource = managedRecords.find((item) => item.id !== record.id && item.path === source.root);
      const conflict = managedRecords.find((item) => item.id !== record.id && item.repoCommonDir === source.commonDir &&
        (item.sourceBranch === source.branch || item.branch === source.branch) && item.transaction &&
        ["agent_prepare", "publish_authorized"].includes(item.transaction.phase));
      if (currentSource?.transaction || conflict) {
        throw new Error("Recorded source branch has an active finish transaction; resume or cancel it first");
      }
      const latest = await discoverRepo(pi, history.sourcePath);
      if (latest.root !== source.root || latest.commonDir !== source.commonDir ||
          latest.branch !== source.branch || latest.head !== source.head || (await gitOperationInProgress(pi, latest.root)) ||
          !(await isClean(pi, latest.root))) {
        throw new Error("Recorded source checkout changed after confirmation");
      }
      const latestBranchHead = await gitOk(pi, history.sourcePath, ["rev-parse", `refs/heads/${history.branch}`]);
      if (latestBranchHead !== reopenHead) throw new Error("Reopen branch changed after confirmation");
      if ((await canonicalPath(path, true)) !== path || ((await pathExists(path)) && !(await isDirectoryEmpty(path)))) {
        throw new Error("Reopen path changed or is no longer empty after confirmation");
      }
      if ((await listWorktrees(pi, history.sourcePath)).some((item) => item.path === path)) {
        throw new Error("Reopen path became registered as another Git worktree");
      }
      await gitOk(pi, history.sourcePath, ["worktree", "add", "--", path, history.branch], "Unable to reopen worktree");
      created = true;
    });
    target = await discoverRepo(pi, path);
    actualCreatedPath = target.root;
    if ((await canonicalPath(target.root)) !== path || target.commonDir !== history.repoCommonDir ||
        target.branch !== history.branch || target.head !== reopenHead) {
      throw new Error("Reopened worktree resolved to different path, repository, branch, or HEAD metadata");
    }
  } catch (error) {
    const partiallyAdded = (await listWorktrees(pi, history.sourcePath)).find(
      (item) => item.path === path && item.branch === history.branch,
    );
    if (created || partiallyAdded) {
      const rollback = await git(pi, history.sourcePath, ["worktree", "remove", created ? actualCreatedPath : path]);
      if (rollback.code !== 0) {
        await registry.update(record.id, (item) => {
          item.state = "init_failed";
          item.initError = `Reopen validation failed and safe rollback failed: ${redactSecrets(rollback.stderr || rollback.stdout)}`;
        });
        throw new Error("Reopened worktree could not be validated or safely rolled back; it was preserved for inspection");
      }
    }
    await registry.removeRecord(record.id);
    throw error;
  }
  try {
    await registry.writeMarker(record, target.gitDir);
  } catch (error) {
    await registry.update(record.id, (item) => {
      item.state = "init_failed";
      item.initError = `Unable to write management marker: ${error instanceof Error ? error.message : String(error)}`;
    });
    throw new Error("Reopened worktree was preserved because its management marker could not be written");
  }
  const [sourceSparse, targetSparse] = await Promise.all([
    sparsePatterns(pi, history.sourcePath),
    sparsePatterns(pi, path),
  ]);
  if (JSON.stringify(sourceSparse) !== JSON.stringify(targetSparse)) {
    await registry.update(record.id, (item) => {
      item.state = "init_failed";
      item.initError = "Sparse-checkout patterns do not match the source checkout";
    });
    throw new Error("Sparse-checkout patterns do not match; reopened worktree was preserved");
  }
  const loadedHook: { value?: HookRunResult; error?: Error } = reopenConfig.hooks.postCreate.length === 0
    ? { value: { ok: true, aborted: false, stdout: "", stderr: "" } }
    : await withCancellableLoader(ctx, zh ? "正在运行 postCreate hooks…（Esc 取消）" : "Running postCreate hooks… (Esc to cancel)", (signal) =>
        runHookSteps({
          registry,
          name: "postCreate",
          steps: reopenConfig.hooks.postCreate,
          context: { record, mode: "create" },
          signal,
        }),
      );
  const hookResult = ("error" in loadedHook && loadedHook.error)
    ? { ok: false, aborted: false, stdout: "", stderr: "", error: loadedHook.error.message }
    : loadedHook.value ?? {
    ok: false,
    aborted: true,
    stdout: "",
    stderr: "",
        error: "Hook aborted",
      };
  if (!hookResult.ok) {
    const failed = await registry.update(record.id, (item) => {
      item.state = "init_failed";
      item.initError = `${hookResult.error}; ${hookResult.logPath ?? "no log"}`;
    });
    ctx.ui.notify(`Reopened, but postCreate failed: ${hookResult.error}`, "warning");
    return failed;
  }
  const active = await registry.update(record.id, (item) => {
    item.state = "active";
    item.initError = undefined;
  });
  await launchRecord(ctx, active, reopenConfig);
  return active;
}

export async function showStatus(
  pi: ExtensionAPI,
  registry: Registry,
  ctx: ExtensionContext,
): Promise<void> {
  const repo = await discoverRepo(pi, ctx.cwd);
  const record = await registry.findByPath(repo.root);
  let config: EffectiveConfig | undefined;
  try {
    config = await loadEffectiveConfig({
      repoKey: record?.repoKey ?? repo.repoKey,
      projectRoot: repo.root,
      projectTrusted: ctx.isProjectTrusted(),
      agentDir: registry.agentDir,
    });
  } catch (error) {
    ctx.ui.notify(redactSecrets(`Configuration is invalid: ${error instanceof Error ? error.message : error}`), "warning");
  }
  const zh = resolveLocale(config?.locale ?? "auto") === "zh-CN";
  let sourceHealth = "";
  let targetHealth = "";
  if (record) {
    const targetEntries = await statusEntries(pi, record.path);
    const targetExact = repo.root === record.path && repo.commonDir === record.repoCommonDir && repo.branch === record.branch;
    const targetOperation = await gitOperationInProgress(pi, record.path);
    targetHealth = `${repo.head.slice(0, 12)}; ${targetEntries.length === 0 ? (zh ? "干净" : "clean") : `${targetEntries.length} status entries`}; ${targetExact ? (zh ? "身份匹配" : "identity matches") : (zh ? "身份不匹配" : "IDENTITY MISMATCH")}${targetOperation ? `; operation=${targetOperation}` : ""}`;
    try {
      const source = await discoverRepo(pi, record.sourcePath);
      const sourceEntries = await statusEntries(pi, source.root);
      const exact = source.root === record.sourcePath && source.commonDir === record.repoCommonDir && source.branch === record.sourceBranch;
      const sourceOperation = await gitOperationInProgress(pi, source.root);
      sourceHealth = `${source.head.slice(0, 12)}; ${sourceEntries.length === 0 ? (zh ? "干净" : "clean") : `${sourceEntries.length} status entries`}; ${exact ? (zh ? "身份匹配" : "identity matches") : (zh ? "身份不匹配" : "IDENTITY MISMATCH")}${sourceOperation ? `; operation=${sourceOperation}` : ""}`;
    } catch (error) {
      sourceHealth = `${zh ? "不可用" : "unavailable"}: ${error instanceof Error ? error.message : error}`;
    }
  }
  const output = record
    ? [
        `${zh ? "状态" : "State"}: ${record.state}`,
        `${zh ? "路径" : "Path"}: ${record.path}`,
        `${zh ? "工作分支" : "Work branch"}: ${record.branch}`,
        `${zh ? "工作树健康状态" : "Worktree health"}: ${targetHealth}`,
        `${zh ? "来源" : "Source"}: ${record.sourcePath}`,
        `${zh ? "来源分支" : "Source branch"}: ${record.sourceBranch}`,
        `${zh ? "来源健康状态" : "Source health"}: ${sourceHealth}`,
        `${zh ? "创建时间" : "Created"}: ${record.createdAt}`,
        record.prUrl ? `PR: ${record.prUrl}` : "",
        record.initError ? `${zh ? "最近错误" : "Last error"}: ${record.initError}` : "",
        record.transaction ? `Transaction: ${record.transaction.id} (${record.transaction.mode}/${record.transaction.phase})` : "",
      ].filter(Boolean).join("\n")
    : zh
      ? `当前 checkout 未受管理。\n仓库：${repo.repoId}\n分支：${repo.branch || "detached"}\n默认根目录：${config?.worktreeRoot ?? "（配置无效）"}`
      : `Current checkout is not managed.\nRepository: ${repo.repoId}\nBranch: ${repo.branch || "detached"}\nDefault root: ${config?.worktreeRoot ?? "(configuration invalid)"}`;
  await showText(ctx, zh ? "受管理 worktree 状态" : "Managed worktree status", output);
}

export async function listManaged(
  pi: ExtensionAPI,
  registry: Registry,
  ctx: ExtensionContext,
  all: boolean,
): Promise<void> {
  const zh = resolveLocale("auto") === "zh-CN";
  let commonDir: string | undefined;
  if (!all) commonDir = (await discoverRepo(pi, ctx.cwd)).commonDir;
  const [allRecords, allHistory] = await Promise.all([registry.records(), registry.history()]);
  const records = allRecords.filter((item) => !commonDir || item.repoCommonDir === commonDir);
  const history = allHistory.filter((item) => !commonDir || item.repoCommonDir === commonDir);
  const items = [
    ...records.map((item) => `ACTIVE ${item.id} ${item.state} ${item.branch} — ${item.path}`),
    ...history.map((item) => `DONE   ${item.id} ${item.result} ${item.branch} — ${item.prUrl ?? item.finalHead.slice(0, 12)}`),
  ].map(sanitizeForDisplay);
  if (items.length === 0) {
    ctx.ui.notify(zh ? "没有找到受管理的 worktree。" : "No managed worktrees found.", "info");
    return;
  }
  if (ctx.mode !== "tui") {
    ctx.ui.notify(items.join("\n"), "info");
    return;
  }
  const selected = await ctx.ui.select(zh ? "受管理的 worktree" : "Managed worktrees", items);
  if (!selected) return;
  const id = selected.split(/\s+/)[1];
  const record = records.find((item) => item.id === id);
  const old = history.find((item) => item.id === id);
  await showText(ctx, zh ? "Worktree 详情" : "Worktree details", JSON.stringify(record ?? old, null, 2));
}

function editableConfigTemplate(current?: WorktreeConfig): string {
  return `${JSON.stringify(current ?? { version: 1 }, null, 2)}\n`;
}

export async function manageConfig(
  pi: ExtensionAPI,
  registry: Registry,
  ctx: ExtensionCommandContext,
  action: "show" | "edit" | "export" | "reset",
): Promise<void> {
  const repo = await discoverRepo(pi, ctx.cwd);
  const managed = await registry.findByPath(repo.root);
  const repoKey = managed?.repoKey ?? repo.repoKey;
  const paths = getConfigPaths(repoKey, repo.root, registry.agentDir);
  let config: EffectiveConfig | undefined;
  try {
    config = await loadEffectiveConfig({
      repoKey,
      projectRoot: repo.root,
      projectTrusted: ctx.isProjectTrusted(),
      agentDir: registry.agentDir,
    });
  } catch (error) {
    if (action === "show" || action === "export") throw error;
    ctx.ui.notify(`Configuration is invalid; ${action} remains available for recovery.`, "warning");
  }
  const zh = resolveLocale(config?.locale ?? "auto") === "zh-CN";
  if (action === "show") {
    await showText(ctx, zh ? "pi-worktree 生效配置" : "Effective pi-worktree configuration", JSON.stringify(configForDisplay(config!), null, 2));
    return;
  }
  if (ctx.mode !== "tui") throw new Error("Configuration changes require interactive TUI mode");
  await ctx.waitForIdle();
  if (action === "edit") {
    const options = ["global", "per-repo", ...(ctx.isProjectTrusted() ? ["project"] : [])];
    const selected = await ctx.ui.select(zh ? "配置作用域" : "Configuration scope", options);
    if (!selected) return;
    const scope = selected === "per-repo" ? "repo" : selected as "global" | "project";
    const path = scope === "global" ? paths.global : scope === "repo" ? paths.repo : paths.project;
    let initial = editableConfigTemplate();
    try {
      if (scope === "project") await assertSafeProjectConfigPath(path);
      initial = (await readTextFileSafe(path)) ?? initial;
    } catch {
      if (scope === "project") {
        throw new Error("The project .pi directory is unsafe or symlink-diverted; repair it manually before editing project configuration");
      }
      ctx.ui.notify(`The existing ${scope} config is unsafe or unreadable; saving will replace its path without following it.`, "warning");
    }
    const edited = await ctx.ui.editor(sanitizeForDisplay(`Edit ${scope} config: ${path}`), sanitizeForDisplay(initial));
    if (edited === undefined) return;
    if (Buffer.byteLength(edited, "utf8") > 2 * 1024 * 1024) throw new Error("Configuration exceeds the 2 MiB safety limit");
    let rawConfig: unknown;
    try {
      rawConfig = JSON.parse(edited) as unknown;
    } catch {
      throw new Error(`${path}: invalid JSON`);
    }
    const parsed = validateConfig(rawConfig, path, scope);
    await saveConfig(path, parsed, scope);
    ctx.ui.notify(`Saved ${path}`, "info");
    return;
  }
  if (action === "export") {
    if (!config) throw new Error("Effective configuration is unavailable");
    if (!ctx.isProjectTrusted()) throw new Error("Project must be trusted before exporting project configuration");
    const exported: WorktreeConfig = {
      version: 1,
      $schema: "https://raw.githubusercontent.com/dingdinglz/pi-worktree/main/schema/worktree.schema.json",
      locale: config.locale,
      worktreeRoot: config.worktreeRoot,
      branchPrefix: config.branchPrefix,
      defaults: config.defaults,
      pr: config.pr,
      hooks: config.hooks,
    };
    if (!(await ctx.ui.confirm(
      zh ? "导出项目配置？" : "Export project configuration?",
      `${paths.project}\n\n${zh ? "这可能使来源 checkout 变为 dirty。" : "This may make the source checkout dirty."}`,
    ))) return;
    await saveConfig(paths.project, exported, "project");
    ctx.ui.notify(`Exported ${paths.project}. Review and commit it explicitly.`, "warning");
    return;
  }

  const active = (await registry.records()).filter((item) => item.transaction);
  if (active.length > 0) throw new Error("Cannot reset state/config while any repository has active finish transactions");
  const resetChoices = zh
    ? ["已完成历史", "日志", "全局和 per-repo 配置", "取消"]
    : ["completed history", "logs", "global and per-repo config", "cancel"];
  const selected = await ctx.ui.select(zh ? "重置用户数据" : "Reset user data", resetChoices);
  if (!selected || selected === resetChoices[3]) return;
  if (!(await ctx.ui.confirm(
    zh ? "确认重置" : "Confirm reset",
    `${selected}\n\n${zh ? "不会删除 Git worktree 或分支。" : "Git worktrees and branches will not be deleted."}`,
  ))) return;
  const selectedIndex = resetChoices.indexOf(selected);
  if (selectedIndex === 0) await registry.reset("history");
  else if (selectedIndex === 1) await registry.reset("logs");
  else await registry.reset("config", [paths.global, paths.repo]);
  ctx.ui.notify(`Reset ${selected}`, "info");
}

export async function doctor(
  pi: ExtensionAPI,
  registry: Registry,
  ctx: ExtensionCommandContext,
  fix: boolean,
): Promise<void> {
  const zh = resolveLocale("auto") === "zh-CN";
  const lines: string[] = [];
  const [nodeMajor, nodeMinor] = process.versions.node.split(".").map(Number);
  const nodeSupported = nodeMajor > 22 || (nodeMajor === 22 && nodeMinor >= 19);
  lines.push(`${nodeSupported ? "✓" : "✗"} Node ${process.versions.node} (requires >=22.19.0)`);
  lines.push(process.platform === "win32" ? "✗ native Windows mutations are unsupported (use WSL)" : `✓ platform ${process.platform}`);
  const gitVersion = await pi.exec("git", ["--version"], { timeout: 10_000 });
  lines.push(`${gitVersion.code === 0 ? "✓" : "✗"} ${gitVersion.stdout.trim() || gitVersion.stderr.trim()}`);
  const worktreeCapability = await pi.exec("git", ["worktree", "list", "--porcelain", "-z"], { cwd: ctx.cwd, timeout: 10_000 });
  lines.push(`${worktreeCapability.code === 0 ? "✓" : "✗"} git worktree porcelain -z`);
  try {
    const stateInfo = await stat(registry.baseDir);
    const stateMode = stateInfo.mode & 0o777;
    lines.push(`${stateInfo.isDirectory() && (stateMode & 0o077) === 0 ? "✓" : "✗"} state directory ${registry.baseDir} (mode ${stateMode.toString(8)})`);
  } catch {
    lines.push(`- state directory does not exist yet: ${registry.baseDir}`);
  }
  try {
    const { repo, config } = await loadCurrent(pi, registry, ctx);
    lines.push(`✓ repository ${repo.repoId}`);
    lines.push(`✓ config (${config.layers.map((layer) => layer.scope).join(" → ")})`);
    lines.push(`✓ worktree root ${config.worktreeRoot}`);
    try {
      await assertHookCommandsAvailable(Object.values(config.hooks).flat(), repo.root);
      lines.push("✓ configured hook executables are available");
    } catch (error) {
      lines.push(`✗ ${error instanceof Error ? error.message : error}`);
    }
    if (repo.identity) {
      try {
        await checkGh(pi, repo.root, repo.identity.host);
        lines.push(`✓ gh authenticated for ${repo.identity.host}`);
      } catch (error) {
        lines.push(`✗ ${error instanceof Error ? error.message : error}`);
      }
    } else {
      lines.push("- no GitHub-compatible remote; PR workflow unavailable");
    }
    const record = await registry.findByPath(repo.root);
    {
      const probeRecord: ManagedWorktree = record ?? {
        id: "doctor",
        repoId: repo.repoId,
        repoKey: repo.repoKey,
        repoCommonDir: repo.commonDir,
        path: repo.root,
        branch: repo.branch || "detached",
        sourcePath: repo.root,
        sourceBranch: repo.branch || "detached",
        sourceHead: repo.head,
        relativeCwd: "",
        task: "doctor",
        slug: "doctor",
        state: "active",
        createdAt: nowIso(),
        updatedAt: nowIso(),
      };
      try {
        const launchPlan = buildLaunchPlan({
          record: probeRecord,
          config: { ...config, defaults: { ...config.defaults, launch: true } },
          cwd: repo.root,
        });
        lines.push(config.launcher.mode === "none"
          ? "- automatic launcher is disabled"
          : launchPlan
            ? `✓ launcher available (${launchPlan.description})`
            : "✓ manual launcher fallback is available");
      } catch (error) {
        lines.push(`✗ ${error instanceof Error ? error.message : error}`);
      }
    }
    lines.push(record ? `✓ managed record ${record.id} (${record.state})` : "- current checkout is not managed");
  } catch (error) {
    lines.push(`✗ ${error instanceof Error ? error.message : error}`);
  }
  if (fix) {
    if (ctx.mode !== "tui") throw new Error("--fix requires TUI mode");
    await ctx.waitForIdle();
    if (await ctx.ui.confirm(
      zh ? "应用安全的诊断修复？" : "Apply safe doctor fixes?",
      zh ? "只创建缺失的用户状态目录，不会删除 worktree 或分支。" : "Create missing user state directories only. No worktrees or branches will be deleted.",
    )) {
      await registry.ensure();
      lines.push("✓ ensured user state directories");
    }
  }
  await showText(ctx, zh ? "pi-worktree 诊断" : "pi-worktree doctor", lines.join("\n"));
}

export async function pruneManaged(
  pi: ExtensionAPI,
  registry: Registry,
  ctx: ExtensionCommandContext,
): Promise<void> {
  if (ctx.mode !== "tui") throw new Error("Prune requires interactive TUI mode");
  assertSupportedPlatform();
  await ctx.waitForIdle();
  const repo = await discoverRepo(pi, ctx.cwd);
  const managed = await registry.findByPath(repo.root);
  let historyRetentionDays = 30;
  let logRetentionDays = 7;
  let locale: "auto" | "en" | "zh-CN" = "auto";
  try {
    const config = await loadEffectiveConfig({
      repoKey: managed?.repoKey ?? repo.repoKey,
      projectRoot: repo.root,
      projectTrusted: ctx.isProjectTrusted(),
      agentDir: registry.agentDir,
    });
    historyRetentionDays = config.defaults.historyRetentionDays;
    logRetentionDays = config.defaults.logRetentionDays;
    locale = config.locale;
  } catch {
    ctx.ui.notify("Configuration is invalid; prune will use default retention periods for recovery.", "warning");
  }
  const zh = resolveLocale(locale) === "zh-CN";
  const dry = await git(pi, repo.root, ["worktree", "prune", "--dry-run", "--verbose"]);
  const records = (await registry.records()).filter((item) => item.repoCommonDir === repo.commonDir);
  const stale: ManagedWorktree[] = [];
  const orphanedCleanup: ManagedWorktree[] = [];
  const strandedTransactions: ManagedWorktree[] = [];
  const abandonedTransactions: ManagedWorktree[] = [];
  const interrupted: ManagedWorktree[] = [];
  const interruptedCutoff = Date.now() - 24 * 60 * 60_000;
  const abandonedCutoff = Date.now() - 7 * 24 * 60 * 60_000;
  for (const record of records) {
    const oldEnoughToRecoverCreation = Date.parse(record.updatedAt) < interruptedCutoff;
    if (!(await pathExists(record.path))) {
      if (record.state === "creating" && !oldEnoughToRecoverCreation) continue;
      if (record.transaction && ["cleanup_pending", "cleanup_scheduled", "merged_cleanup_pending"].includes(record.state)) {
        orphanedCleanup.push(record);
      } else if (record.transaction) {
        strandedTransactions.push(record);
      } else stale.push(record);
    } else if (record.state === "creating" && oldEnoughToRecoverCreation) interrupted.push(record);
    else if (record.state === "finish_paused" && record.transaction && Date.parse(record.transaction.updatedAt) < abandonedCutoff) {
      abandonedTransactions.push(record);
    }
  }
  const plan = [
    dry.stdout.trim() || "No stale Git worktree admin entries.",
    stale.length ? `Stale registry records:\n${stale.map((item) => `${item.id} ${item.path}`).join("\n")}` : "No stale registry records.",
    orphanedCleanup.length
      ? `Cleanup records whose worktree is already absent will be finalized:\n${orphanedCleanup.map((item) => `${item.id} ${item.path}`).join("\n")}`
      : "No orphaned cleanup records.",
    strandedTransactions.length
      ? `Missing worktrees with unfinished transactions will release orchestration metadata only (Git/remote state is untouched):\n${strandedTransactions.map((item) => `${item.id} ${item.transaction?.mode}/${item.transaction?.phase} ${item.path}`).join("\n")}`
      : "No stranded finish transactions.",
    abandonedTransactions.length
      ? `Paused finish transactions older than 7 days will release orchestration metadata only:\n${abandonedTransactions.map((item) => `${item.id} ${item.transaction?.mode}/${item.transaction?.phase} ${item.path}`).join("\n")}`
      : "No old paused finish transactions.",
    interrupted.length
      ? `Interrupted creations will be reconciled without deleting paths:\n${interrupted.map((item) => `${item.id} ${item.path}`).join("\n")}`
      : "No interrupted creations.",
    `History older than ${historyRetentionDays} days and logs older than ${logRetentionDays} days will be removed.`,
  ].join("\n\n");
  if (!(await ctx.ui.confirm(zh ? "执行安全清理？" : "Run safe prune?", plan))) return;
  await gitOk(pi, repo.root, ["worktree", "prune", "--verbose"], "git worktree prune failed");
  for (const record of stale) {
    const fresh = await registry.findById(record.id);
    if (!fresh || fresh.updatedAt !== record.updatedAt || (await pathExists(fresh.path))) continue;
    await registry.removeRecord(record.id);
  }
  for (const record of strandedTransactions) {
    const fresh = await registry.findById(record.id);
    if (!fresh || fresh.updatedAt !== record.updatedAt || (await pathExists(fresh.path))) continue;
    if (fresh.transaction?.pr?.bodyFile) await registry.removePrBody(fresh.transaction.pr.bodyFile);
    await registry.removeRecord(fresh.id);
  }
  for (const record of abandonedTransactions) {
    let released = false;
    try {
      await registry.update(record.id, (item) => {
        const transaction = item.transaction;
        if (!transaction || transaction.id !== record.transaction?.id || transaction.updatedAt !== record.transaction?.updatedAt || item.state !== "finish_paused") {
          throw new Error("Paused transaction changed during prune");
        }
        item.transaction = undefined;
        item.state = item.initError ? "init_failed" : "active";
        released = true;
      });
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "Paused transaction changed during prune") throw error;
    }
    if (released && record.transaction?.pr?.bodyFile) await registry.removePrBody(record.transaction.pr.bodyFile);
  }
  for (const record of orphanedCleanup) {
    await withFileLock(registry.sourceLockPath(record.repoCommonDir, record.sourceBranch), async () => {
      const fresh = await registry.findById(record.id);
      const transaction = fresh?.transaction;
      if (!fresh || !transaction || transaction.id !== record.transaction?.id || (await pathExists(fresh.path))) return;
      const source = await discoverRepo(pi, fresh.sourcePath);
      if (source.root !== fresh.sourcePath || source.commonDir !== fresh.repoCommonDir || source.branch !== fresh.sourceBranch ||
          (await gitOperationInProgress(pi, source.root)) || !(await isClean(pi, source.root))) {
        throw new Error(`Cannot finalize orphaned cleanup ${fresh.id}: recorded source checkout is not exact, clean, and idle`);
      }
      const result: WorktreeHistoryEntry["result"] = transaction.cleanupResult ?? (
        fresh.state === "merged_cleanup_pending" || transaction.mode === "merge"
          ? "merged"
          : fresh.prUrl
            ? "pr"
            : "already_integrated"
      );
      if (result === "merged" && (await branchExists(pi, source.root, fresh.branch))) {
        const deletion = await git(pi, source.root, ["branch", "-d", "--", fresh.branch]);
        if (deletion.code !== 0) {
          await registry.writeLog(fresh.id, `Orphaned cleanup retained branch ${fresh.branch}:\n${deletion.stderr || deletion.stdout}`);
        }
      }
      await registry.complete(
        fresh.id,
        result,
        transaction.mergedHead ?? transaction.workHead ?? source.head,
        fresh.prUrl,
      );
    });
  }
  for (const record of interrupted) {
    try {
      const target = await discoverRepo(pi, record.path);
      if (target.root !== record.path || target.commonDir !== record.repoCommonDir || target.branch !== record.branch) {
        throw new Error("metadata mismatch");
      }
      await registry.update(record.id, (item) => {
        if (item.state !== "creating" || item.updatedAt !== record.updatedAt) {
          throw new Error("Creation record changed during prune");
        }
        item.state = "init_failed";
        item.initError = "Creation was interrupted; inspect the worktree and rerun project initialization before finishing";
      });
    } catch (error) {
      if (error instanceof Error && error.message === "Creation record changed during prune") continue;
      try {
        await registry.update(record.id, (item) => {
          if (item.state !== "creating" || item.updatedAt !== record.updatedAt) throw new Error("Creation record changed during prune");
          item.state = "init_failed";
          item.initError = `Interrupted creation could not be validated: ${error instanceof Error ? error.message : String(error)}`;
        });
      } catch (updateError) {
        if (!(updateError instanceof Error) || updateError.message !== "Creation record changed during prune") throw updateError;
      }
    }
  }
  const result = await registry.prune({
    historyRetentionDays,
    logRetentionDays,
  });

  const branchCandidates: WorktreeHistoryEntry[] = [];
  for (const item of (await registry.history()).filter((entry) => entry.repoCommonDir === repo.commonDir)) {
    if (!item.prUrl || !(await branchExists(pi, repo.root, item.branch))) continue;
    const view = await pi.exec("gh", ["pr", "view", item.prUrl, "--json", "state"], { cwd: repo.root, timeout: 20_000 });
    if (view.code === 0) {
      try {
        if ((JSON.parse(view.stdout) as { state?: string }).state === "MERGED") branchCandidates.push(item);
      } catch {
        // Ignore malformed gh output; never delete a branch without a verified merged state.
      }
    }
  }
  if (branchCandidates.length > 0) {
    const approved = await ctx.ui.confirm(
      zh ? "删除已安全合并的本地 PR 分支？" : "Delete safely merged local PR branches?",
      `${branchCandidates.map((item) => item.branch).join("\n")}\n\nOnly git branch -d will be used.`,
    );
    if (approved) {
      for (const item of branchCandidates) {
        const deletion = await git(pi, repo.root, ["branch", "-d", "--", item.branch]);
        if (deletion.code !== 0) {
          await registry.writeLog(item.id, `Prune retained branch ${item.branch}:\n${deletion.stderr || deletion.stdout}`);
        }
      }
    }
  }
  ctx.ui.notify(
    `Prune complete: ${stale.length} stale records, ${strandedTransactions.length} stranded and ${abandonedTransactions.length} old paused transactions released, ${orphanedCleanup.length} cleanup records finalized, ${result.historyRemoved} history entries, ${result.logsRemoved} logs removed.`,
    "info",
  );
}
