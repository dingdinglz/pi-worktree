import { mkdir, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { generateSetupProposal } from "./ai-config.ts";
import {
  getConfigPaths,
  loadEffectiveConfig,
  readConfig,
  saveConfig,
} from "./config.ts";
import {
  aheadBehind,
  branchExists,
  currentHead,
  discoverRepo,
  git,
  gitOk,
  gitOperationInProgress,
  isAncestor,
  isClean,
  listWorktrees,
  repositoryNamespace,
  sparsePatterns,
  statusEntries,
  validBranchName,
} from "./git.ts";
import { assertHookCommandsAvailable, describeHookStep, runHookSteps } from "./hooks.ts";
import { createTranslator, resolveLocale } from "./i18n.ts";
import { buildLaunchPlan, executeLaunchPlan, manualLaunchCommand } from "./launcher.ts";
import type { EffectiveConfig, HookRunResult, HookStep, ManagedWorktree, WorktreeConfig } from "./types.ts";
import type { Registry } from "./registry.ts";
import { withCancellableLoader } from "./ui.ts";
import {
  assertSupportedPlatform,
  canonicalPath,
  isDirectoryEmpty,
  isPathInside,
  newId,
  nowIso,
  pathExists,
  redactSecrets,
  slugifyTask,
  withFileLock,
} from "./util.ts";

export interface CreateOptions {
  task?: string;
  branch?: string;
  path?: string;
  noLaunch?: boolean;
  allowDirty?: boolean;
}

function hookPlan(steps: HookStep[]): string {
  if (steps.length === 0) return "(none)";
  return steps.map((step, index) => `${index + 1}. ${describeHookStep(step)}`).join("\n");
}

async function saveRepoPostCreate(
  repoKey: string,
  projectRoot: string,
  steps: HookStep[],
  agentDir?: string,
): Promise<void> {
  const paths = getConfigPaths(repoKey, projectRoot, agentDir);
  const current = (await readConfig(paths.repo, "repo")) ?? { version: 1 };
  const next: WorktreeConfig = {
    ...current,
    version: 1,
    hooks: { ...current.hooks, postCreate: { merge: "replace", steps } },
  };
  await saveConfig(paths.repo, next, "repo");
}

async function rememberSkip(repoKey: string, projectRoot: string, agentDir?: string): Promise<void> {
  const paths = getConfigPaths(repoKey, projectRoot, agentDir);
  const current = (await readConfig(paths.repo, "repo")) ?? { version: 1 };
  await saveConfig(
    paths.repo,
    { ...current, version: 1, defaults: { ...current.defaults, missingPostCreate: "skip" } },
    "repo",
  );
}

async function resolveMissingHook(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  repoKey: string,
  projectRoot: string,
  config: EffectiveConfig,
  agentDir?: string,
): Promise<EffectiveConfig | undefined> {
  if (config.hooks.postCreate.length > 0 || config.defaults.missingPostCreate === "skip") return config;
  const locale = resolveLocale(config.locale) === "zh-CN" ? "zh" : "en";
  const choices = locale === "zh"
    ? ["仅本次跳过", "此仓库以后默认跳过", "让 AI 生成建议", "取消"]
    : ["Skip once", "Remember skip for this repository", "Ask AI for a proposal", "Cancel"];
  const selected = await ctx.ui.select(
    locale === "zh" ? "未配置 postCreate hook" : "No postCreate hook configured",
    choices,
  );
  if (!selected || selected === choices[3]) return undefined;
  if (selected === choices[1]) {
    await rememberSkip(repoKey, projectRoot, agentDir);
    const reloaded = await loadEffectiveConfig({ repoKey, projectRoot, projectTrusted: ctx.isProjectTrusted(), agentDir });
    if (reloaded.hooks.postCreate.length === 0 && reloaded.defaults.missingPostCreate !== "skip") {
      throw new Error("A higher-precedence configuration overrides the remembered skip; edit that layer explicitly");
    }
    return reloaded;
  }
  if (selected === choices[2]) {
    const shareApproved = await ctx.ui.confirm(
      locale === "zh" ? "发送白名单 manifest 摘要？" : "Send allowlisted manifest excerpts?",
      locale === "zh"
        ? "将仅把经过大小限制和脱敏的 lockfile、package manifest、README、Makefile 与语言工具配置摘要发送给当前模型提供方。不会读取 .env 或凭据文件。"
        : "Only bounded, redacted excerpts from lockfiles, package manifests, README, Makefile, and language tool files will be sent to the selected model provider. .env and credential files are not read.",
    );
    if (!shareApproved) return config;
    const generated = await withCancellableLoader(
      ctx,
      locale === "zh" ? "AI 正在分析安全清单…（Esc 取消）" : "AI is inspecting safe manifests… (Esc to cancel)",
      (signal) => generateSetupProposal(pi, ctx, projectRoot, signal),
    );
    if (generated.aborted) return undefined;
    if (generated.error) throw generated.error;
    const proposal = generated.value;
    if (!proposal) return undefined;
    const approved = await ctx.ui.confirm(
      locale === "zh" ? "AI 初始化建议" : "AI setup proposal",
      `${proposal.reason}\n\n${hookPlan(proposal.steps)}\n\n${locale === "zh" ? "保存到用户侧 per-repo 配置并执行？" : "Save to user per-repo config and run it?"}`,
    );
    if (!approved) return config;
    await saveRepoPostCreate(repoKey, projectRoot, proposal.steps, agentDir);
    const reloaded = await loadEffectiveConfig({ repoKey, projectRoot, projectTrusted: ctx.isProjectTrusted(), agentDir });
    if (proposal.steps.length > 0 && reloaded.hooks.postCreate.length === 0) {
      throw new Error("A higher-precedence project configuration overrides the saved AI proposal; edit it explicitly");
    }
    return reloaded;
  }
  return config;
}

async function syncSourceForCreate(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  root: string,
  upstream: { remote: string; short: string; branch: string } | undefined,
  zh = false,
): Promise<void> {
  if (!upstream) return;
  const fetch = await git(pi, root, ["fetch", "--", upstream.remote], { timeout: 120_000 });
  if (fetch.code !== 0) {
    ctx.ui.notify(
      `${zh ? "Fetch 失败，将使用当前本地 HEAD" : "Fetch failed; using the current local HEAD"}: ${redactSecrets(fetch.stderr.trim())}`,
      "warning",
    );
    return;
  }
  const relation = await aheadBehind(pi, root, "HEAD", `refs/remotes/${upstream.remote}/${upstream.branch}`);
  if (!relation || relation.behind === 0) return;
  const choices = relation.ahead === 0
    ? (zh ? ["先快进来源分支", "使用当前本地 HEAD", "取消"] : ["Fast-forward source branch first", "Use current local HEAD", "Cancel"])
    : (zh ? ["使用当前已分叉的本地 HEAD", "取消"] : ["Use current divergent local HEAD", "Cancel"]);
  const selected = await ctx.ui.select(
    zh
      ? `来源分支领先 ${relation.ahead} / 落后 ${relation.behind}（相对 ${upstream.short}）`
      : `Source is ${relation.ahead} ahead / ${relation.behind} behind ${upstream.short}`,
    choices,
  );
  if (!selected || selected === choices.at(-1)) throw new Error(zh ? "已取消" : "Cancelled");
  if (selected === choices[0] && relation.ahead === 0) {
    await gitOk(pi, root, ["merge", "--ff-only", `refs/remotes/${upstream.remote}/${upstream.branch}`], "Unable to fast-forward source branch");
  }
}

async function chooseUniqueNames(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  sourceRoot: string,
  config: EffectiveConfig,
  namespace: string,
  initialSlug: string,
  requestedBranch?: string,
  requestedPath?: string,
): Promise<{ slug: string; branch: string; path: string }> {
  let sequence = 1;
  let slug = initialSlug;
  while (true) {
    const generatedBranch = `${config.branchPrefix}${slug}`;
    const branch = requestedBranch ?? generatedBranch;
    if (!(await validBranchName(pi, sourceRoot, branch))) throw new Error(`Invalid Git branch name: ${branch}`);
    let path: string;
    if (requestedPath) {
      if (!isAbsolute(requestedPath) && !requestedPath.startsWith("~/")) {
        throw new Error("--path must be absolute or start with ~/");
      }
      path = await canonicalPath(requestedPath, true);
    } else {
      path = await canonicalPath(join(namespace, slug), true);
    }
    const exists = await pathExists(path);
    const empty = exists ? await isDirectoryEmpty(path) : true;
    const branchTaken = await branchExists(pi, sourceRoot, branch);
    if (!branchTaken && (!exists || empty)) return { slug, branch, path };
    if (requestedBranch || requestedPath) {
      throw new Error(
        `${branchTaken ? `Branch already exists: ${branch}. ` : ""}${exists && !empty ? `Path is not empty: ${path}` : ""}`.trim(),
      );
    }
    sequence++;
    slug = `${initialSlug}-${sequence}`;
    ctx.ui.notify(`Name collision; trying ${config.branchPrefix}${slug}`, "warning");
  }
}

async function assertSafeTarget(pi: ExtensionAPI, sourceRoot: string, target: string): Promise<void> {
  const currentCanonical = await canonicalPath(target, true);
  if (currentCanonical !== target) throw new Error("Target path was symlink-diverted or otherwise changed");
  if ((await pathExists(target)) && !(await isDirectoryEmpty(target))) throw new Error(`Target path is not empty: ${target}`);
  const entries = await listWorktrees(pi, sourceRoot);
  for (const entry of entries) {
    if (isPathInside(target, entry.path)) throw new Error(`Target path is inside an existing worktree: ${entry.path}`);
    if (isPathInside(entry.path, target)) throw new Error(`Target path would contain an existing worktree: ${entry.path}`);
  }
  const repo = await discoverRepo(pi, sourceRoot);
  if (isPathInside(target, repo.commonDir)) throw new Error(`Target path is inside the Git admin directory: ${repo.commonDir}`);
}

async function runPostCreateWithUi(
  registry: Registry,
  ctx: ExtensionCommandContext,
  record: ManagedWorktree,
  steps: HookStep[],
): Promise<HookRunResult> {
  if (steps.length === 0) return { ok: true, aborted: false, stdout: "", stderr: "" };
  const loaded = await withCancellableLoader(
    ctx,
    resolveLocale("auto") === "zh-CN" ? "正在运行 postCreate hooks…（Esc 取消）" : "Running postCreate hooks… (Esc to cancel)",
    (signal) =>
      runHookSteps({
        registry,
        name: "postCreate",
        steps,
        context: { record, mode: "create" },
        signal,
      }),
  );
  if (loaded.error) {
    return { ok: false, aborted: loaded.aborted, stdout: "", stderr: "", error: loaded.error.message };
  }
  return loaded.value ?? { ok: false, aborted: true, stdout: "", stderr: "", error: "Hook aborted" };
}

async function rollbackCreated(pi: ExtensionAPI, registry: Registry, record: ManagedWorktree): Promise<void> {
  await withFileLock(registry.sourceLockPath(record.repoCommonDir, record.sourceBranch), async () => {
    const fresh = await registry.findById(record.id);
    if (!fresh) throw new Error("Cannot roll back: the managed creation record no longer exists");
    const dependent = (await registry.records()).find((item) => item.id !== fresh.id && item.sourcePath === fresh.path);
    if (dependent) throw new Error(`Cannot roll back: worktree ${dependent.id} records this checkout as its source`);
    const [source, target] = await Promise.all([
      discoverRepo(pi, fresh.sourcePath),
      discoverRepo(pi, fresh.path),
    ]);
    if (source.root !== fresh.sourcePath || target.root !== fresh.path ||
        source.commonDir !== fresh.repoCommonDir || target.commonDir !== fresh.repoCommonDir ||
        source.branch !== fresh.sourceBranch || target.branch !== fresh.branch) {
      throw new Error("Cannot roll back: recorded checkout identity changed");
    }
    const [sourceOperation, targetOperation] = await Promise.all([
      gitOperationInProgress(pi, fresh.sourcePath),
      gitOperationInProgress(pi, fresh.path),
    ]);
    if (sourceOperation || targetOperation) {
      throw new Error(`Cannot roll back: Git operation in progress (${sourceOperation ?? targetOperation})`);
    }
    if (!(await isClean(pi, fresh.path))) throw new Error("Cannot roll back: the new worktree contains changes");
    if ((await currentHead(pi, fresh.path)) !== fresh.sourceHead) {
      throw new Error("Cannot roll back: the new work branch contains commits");
    }
    if (!(await isAncestor(pi, fresh.sourcePath, fresh.sourceHead, `refs/heads/${fresh.sourceBranch}`))) {
      throw new Error("Cannot roll back: the recorded source branch no longer contains the creation commit");
    }
    await gitOk(pi, fresh.sourcePath, ["worktree", "remove", fresh.path], "Unable to roll back worktree creation");
    const deletion = await git(pi, fresh.sourcePath, ["branch", "-d", "--", fresh.branch]);
    if (deletion.code !== 0) {
      await registry.update(fresh.id, (item) => {
        item.state = "init_failed";
        item.initError = `Worktree removed, but safe branch rollback failed: ${redactSecrets(deletion.stderr || deletion.stdout)}`;
      });
      throw new Error("Worktree was removed, but Git retained the branch; run /wt prune after inspection");
    }
    await registry.removeRecord(fresh.id);
  });
}

export async function createWorktree(
  pi: ExtensionAPI,
  registry: Registry,
  ctx: ExtensionCommandContext,
  options: CreateOptions,
): Promise<ManagedWorktree | undefined> {
  if (ctx.mode !== "tui") throw new Error("This operation is available only in interactive TUI mode");
  assertSupportedPlatform();
  await ctx.waitForIdle();
  let repo = await discoverRepo(pi, ctx.cwd);
  let config = await loadEffectiveConfig({
    repoKey: repo.repoKey,
    projectRoot: repo.root,
    projectTrusted: ctx.isProjectTrusted(),
    agentDir: registry.agentDir,
  });
  const t = createTranslator(config.locale);
  const initialZh = resolveLocale(config.locale) === "zh-CN";
  if (!repo.head) throw new Error(t("noInitialCommit"));
  if (!repo.branch) throw new Error(t("sourceDetached"));
  const operation = await gitOperationInProgress(pi, repo.root);
  if (operation) throw new Error(`${t("sourceOperation")} (${operation})`);
  const originalSourcePath = repo.root;
  const originalCommonDir = repo.commonDir;
  const originalSourceBranch = repo.branch;
  let dirty = !(await isClean(pi, repo.root));
  let dirtyTransferWarningApproved = false;
  if (dirty && !options.allowDirty) throw new Error(`${t("sourceDirty")} Use --allow-dirty to base the new worktree on committed HEAD.`);
  if (dirty && options.allowDirty) {
    const approved = await ctx.ui.confirm(
      t("sourceDirty"),
      initialZh
        ? "新 worktree 只包含已提交的 HEAD，不会带入来源 checkout 的未提交修改。继续？"
        : "The new worktree will include only committed HEAD, not the source checkout's uncommitted changes. Continue?",
    );
    if (!approved) return undefined;
    dirtyTransferWarningApproved = true;
  }

  await withFileLock(registry.sourceLockPath(repo.commonDir, repo.branch), async () => {
    const managedRecords = await registry.records();
    const currentManaged = managedRecords.find((item) => item.path === repo.root);
    if (currentManaged?.transaction) {
      throw new Error(`Current source worktree has finish transaction ${currentManaged.transaction.id}; complete or cancel it first`);
    }
    const conflict = managedRecords.find(
      (item) => item.repoCommonDir === repo.commonDir &&
        (item.sourceBranch === repo.branch || item.branch === repo.branch) &&
        item.transaction &&
        ["agent_prepare", "publish_authorized"].includes(item.transaction.phase),
    );
    if (conflict) {
      throw new Error(`Source branch ${repo.branch} is locked by finish transaction ${conflict.transaction!.id}`);
    }
    await syncSourceForCreate(pi, ctx, repo.root, repo.upstream, initialZh);
  });
  repo = await discoverRepo(pi, repo.root);
  if (repo.root !== originalSourcePath || repo.commonDir !== originalCommonDir || repo.branch !== originalSourceBranch) {
    throw new Error("Source checkout path, repository, or branch changed while synchronizing it");
  }
  const synchronizedOperation = await gitOperationInProgress(pi, repo.root);
  if (synchronizedOperation) throw new Error(`Source checkout has a Git operation in progress: ${synchronizedOperation}`);
  dirty = !(await isClean(pi, repo.root));
  if (dirty && !options.allowDirty) throw new Error(`${t("sourceDirty")} Use --allow-dirty to continue explicitly.`);
  if (dirty && options.allowDirty && !dirtyTransferWarningApproved) {
    const approved = await ctx.ui.confirm(
      t("sourceDirty"),
      initialZh
        ? "同步 hook 使来源 checkout 变为 dirty；这些修改不会带入新 worktree。继续？"
        : "A synchronization hook made the source checkout dirty. Those changes will not be copied into the new worktree. Continue?",
    );
    if (!approved) return undefined;
    dirtyTransferWarningApproved = true;
  }
  const task = options.task?.trim() || (await ctx.ui.input(t("taskPrompt"), "Describe the task"))?.trim();
  if (!task) return undefined;
  if (task.length > 500 || /[\u0000-\u001f\u007f-\u009f]/.test(task)) throw new Error("Task description must be a control-free single line of at most 500 characters");
  const initialSlug = slugifyTask(task);
  const namespace = repositoryNamespace(config.worktreeRoot, repo);
  const names = await chooseUniqueNames(pi, ctx, repo.root, config, namespace, initialSlug, options.branch, options.path);
  await assertSafeTarget(pi, repo.root, names.path);
  const resolvedConfig = await resolveMissingHook(pi, ctx, repo.repoKey, repo.root, config, registry.agentDir);
  if (!resolvedConfig) return undefined;
  config = resolvedConfig;
  const zh = resolveLocale(config.locale) === "zh-CN";
  await assertHookCommandsAvailable(config.hooks.postCreate, repo.root);

  const launch = !options.noLaunch && config.defaults.launch;
  const summary = [
    `${zh ? "来源" : "Source"}: ${repo.root}`,
    `${zh ? "来源分支" : "Source branch"}: ${repo.branch} @ ${repo.head.slice(0, 12)}`,
    dirty ? (zh ? "警告：来源 checkout 的修改不会复制到新 worktree。" : "WARNING: Source changes are not copied into the new worktree.") : "",
    `${zh ? "工作分支" : "Work branch"}: ${names.branch}`,
    `${zh ? "路径" : "Path"}: ${names.path}`,
    `Post-create hooks:\n${hookPlan(config.hooks.postCreate)}`,
    `${zh ? "启动" : "Launch"}: ${launch ? config.launcher.mode : (zh ? "禁用" : "disabled")}`,
  ].filter(Boolean).join("\n\n");
  if (!(await ctx.ui.confirm(t("confirmCreate"), summary))) return undefined;
  if (dirty) dirtyTransferWarningApproved = true;

  const canonicalCwd = await canonicalPath(ctx.cwd);
  const relativeCwd = isPathInside(canonicalCwd, repo.root) ? relative(repo.root, canonicalCwd) : "";
  const timestamp = nowIso();
  const record: ManagedWorktree = {
    id: newId(),
    repoId: repo.repoId,
    repoKey: repo.repoKey,
    repoCommonDir: repo.commonDir,
    repoIdentity: repo.identity,
    path: names.path,
    branch: names.branch,
    sourcePath: repo.root,
    sourceBranch: repo.branch,
    sourceHead: repo.head,
    relativeCwd,
    task,
    slug: names.slug,
    state: "creating",
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  if (launch) {
    buildLaunchPlan({
      record,
      config,
      cwd: record.path,
      model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
      thinking: ctx.thinkingLevel,
    });
  }
  await mkdir(resolve(names.path, ".."), { recursive: true });
  await registry.add(record);
  let created = false;
  let actualCreatedPath = names.path;
  try {
    await withFileLock(registry.sourceLockPath(repo.commonDir, repo.branch), async () => {
      const managedRecords = await registry.records();
      const sourceRecord = managedRecords.find((item) => item.path === repo.root && item.id !== record.id);
      if (sourceRecord?.transaction) {
        throw new Error(`Current source worktree has finish transaction ${sourceRecord.transaction.id}; complete or cancel it first`);
      }
      const conflict = managedRecords.find((item) => item.id !== record.id && item.repoCommonDir === repo.commonDir &&
        (item.sourceBranch === repo.branch || item.branch === repo.branch) && item.transaction &&
        ["agent_prepare", "publish_authorized"].includes(item.transaction.phase));
      if (conflict) throw new Error(`Source branch ${repo.branch} is locked by finish transaction ${conflict.transaction!.id}`);
      const latest = await discoverRepo(pi, repo.root);
      if (latest.root !== repo.root || latest.commonDir !== repo.commonDir || latest.branch !== repo.branch || latest.head !== repo.head) {
        throw new Error("Source checkout, branch, or HEAD changed after confirmation; run /wt new again to review the new plan");
      }
      const latestOperation = await gitOperationInProgress(pi, repo.root);
      if (latestOperation) throw new Error(`Source checkout has a Git operation in progress: ${latestOperation}`);
      const latestClean = await isClean(pi, repo.root);
      if (!options.allowDirty && !latestClean) {
        throw new Error("Source checkout became dirty after confirmation");
      }
      if (options.allowDirty && !latestClean && !dirtyTransferWarningApproved) {
        const approved = await ctx.ui.confirm(
          t("sourceDirty"),
          initialZh
            ? "来源 checkout 在最终确认后变为 dirty；这些修改不会带入新 worktree。继续？"
            : "The source checkout became dirty after final confirmation. Those changes will not be copied. Continue?",
        );
        if (!approved) throw new Error(initialZh ? "已取消" : "Cancelled");
      }
      await assertSafeTarget(pi, repo.root, names.path);
      await gitOk(pi, repo.root, ["worktree", "add", "-b", names.branch, "--", names.path, `refs/heads/${repo.branch}`], "Unable to create worktree");
      created = true;
    });
    const targetRepo = await discoverRepo(pi, names.path);
    actualCreatedPath = targetRepo.root;
    if ((await canonicalPath(targetRepo.root)) !== names.path) {
      throw new Error("New worktree resolved to a different canonical path than the approved target");
    }
    if (targetRepo.head !== repo.head) throw new Error("New worktree HEAD does not match the approved source SHA");
    await registry.writeMarker(record, targetRepo.gitDir);
  } catch (error) {
    let partiallyAdded = false;
    try {
      partiallyAdded = (await listWorktrees(pi, repo.root)).some(
        (item) => item.path === names.path && item.branch === names.branch,
      );
    } catch {
      // Preserve the creating record if Git administration cannot be inspected.
      await registry.update(record.id, (item) => {
        item.state = "init_failed";
        item.initError = "Creation failed and partial Git worktree state could not be inspected";
      });
      throw error;
    }
    const ownsCreatedBranch = created || partiallyAdded;
    if (ownsCreatedBranch) {
      const removal = await git(pi, repo.root, ["worktree", "remove", created ? actualCreatedPath : names.path]);
      if (removal.code !== 0 && (await pathExists(created ? actualCreatedPath : names.path))) {
        await registry.update(record.id, (item) => {
          item.state = "init_failed";
          item.initError = `Creation failed and safe rollback failed: ${redactSecrets(removal.stderr || removal.stdout)}`;
        });
        throw new Error("Creation failed and the partial worktree could not be safely removed; it was preserved for inspection");
      }
      if (removal.code !== 0) await git(pi, repo.root, ["worktree", "prune"]);
    }
    if (ownsCreatedBranch && (await branchExists(pi, repo.root, names.branch))) {
      const branchHead = await git(pi, repo.root, ["rev-parse", "--verify", `refs/heads/${names.branch}`]);
      if (branchHead.code !== 0 || branchHead.stdout.trim() !== repo.head) {
        await registry.update(record.id, (item) => {
          item.state = "init_failed";
          item.initError = "Creation failed, but the new branch contains unexpected commits and was preserved";
        });
        throw new Error("Creation failed; the new branch contains commits and was preserved for inspection");
      }
      const deletion = await git(pi, repo.root, ["branch", "-d", "--", names.branch]);
      if (deletion.code !== 0) {
        await registry.writeLog(record.id, `Safe rollback retained branch ${names.branch}:\n${deletion.stderr || deletion.stdout}`);
      }
    }
    await registry.removeRecord(record.id);
    throw error;
  }

  const [sourceSparse, targetSparse] = await Promise.all([sparsePatterns(pi, repo.root), sparsePatterns(pi, names.path)]);
  if (JSON.stringify(sourceSparse) !== JSON.stringify(targetSparse)) {
    await registry.update(record.id, (item) => {
      item.state = "init_failed";
      item.initError = "Sparse-checkout patterns do not match the source checkout";
    });
    throw new Error("Sparse-checkout patterns do not match; worktree was preserved and launcher was not started");
  }

  let openedAfterFailure = false;
  let hookResult = await runPostCreateWithUi(registry, ctx, record, config.hooks.postCreate);
  while (!hookResult.ok) {
    await registry.update(record.id, (item) => {
      item.state = "init_failed";
      item.initError = `${hookResult.error}${hookResult.logPath ? `; log: ${hookResult.logPath}` : ""}`;
    });
    const failureChoices = zh ? ["重试", "仍然打开", "确认干净后删除"] : ["Retry", "Open anyway", "Delete if clean"];
    const selected = await ctx.ui.select(t("hookFailed"), failureChoices);
    if (selected === failureChoices[0]) {
      hookResult = await runPostCreateWithUi(registry, ctx, record, config.hooks.postCreate);
      continue;
    }
    if (selected === failureChoices[2]) {
      await rollbackCreated(pi, registry, record);
      return undefined;
    }
    if (selected !== failureChoices[1]) return (await registry.findById(record.id)) ?? record;
    openedAfterFailure = true;
    break;
  }
  if (!openedAfterFailure) {
    await registry.update(record.id, (item) => {
      item.state = "active";
      item.initError = undefined;
    });
  }
  const persisted = await registry.findById(record.id);
  if (persisted) Object.assign(record, persisted);

  const postStatus = await statusEntries(pi, record.path);
  if (postStatus.length > 0) {
    ctx.ui.notify(
      zh
        ? `postCreate 留下了 ${postStatus.length} 个 Git status 项；finish 前请检查。`
        : `postCreate left ${postStatus.length} Git status entr${postStatus.length === 1 ? "y" : "ies"}; review before finishing.`,
      "warning",
    );
  }

  if (launch) {
    let launchCwd = record.path;
    if (record.relativeCwd) {
      const candidate = join(record.path, record.relativeCwd);
      try {
        const canonicalCandidate = await canonicalPath(candidate);
        if (isPathInside(canonicalCandidate, record.path) && (await stat(canonicalCandidate)).isDirectory()) {
          launchCwd = canonicalCandidate;
        }
      } catch {
        // Fall back to root.
      }
    }
    const launcherContext = {
      record,
      config,
      cwd: launchCwd,
      model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
      thinking: ctx.thinkingLevel,
    };
    const manual = manualLaunchCommand(launcherContext);
    try {
      const plan = buildLaunchPlan(launcherContext);
      if (plan) {
        await executeLaunchPlan(plan);
        ctx.ui.notify(`${t("created")}: ${record.path}\nOpened in ${plan.description}.`, "info");
      } else {
        ctx.ui.notify(`${t("created")}: ${record.path}\n${manual}`, "info");
      }
    } catch (error) {
      ctx.ui.notify(redactSecrets(`${t("launchFailed")}\n${error instanceof Error ? error.message : error}\n${manual}`), "warning");
    }
  } else {
    ctx.ui.notify(`${t("created")}: ${record.path}`, "info");
  }
  return record;
}
