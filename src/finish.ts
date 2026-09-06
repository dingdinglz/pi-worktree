import { join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  deinitSubmodules,
  ensureSubmodulesClean,
  initializedSubmodules,
  scheduleCleanup,
  validateCleanupRequest,
} from "./cleanup.ts";
import { loadEffectiveConfig } from "./config.ts";
import {
  aheadBehind,
  branchExists,
  commitSummary,
  currentHead,
  discoverRepo,
  fastForwardCheckout,
  getUpstream,
  gitOk,
  gitOperationInProgress,
  isAncestor,
  isClean,
  remoteBranchSha,
  statusEntries,
} from "./git.ts";
import {
  createPrPlan,
  findPullRequests,
  prCommands,
  validatePrPlanRemotes,
  verifyPublishedPr,
  writeApprovedPrBody,
} from "./github.ts";
import { assertHookCommandsAvailable, describeHookStep, runHookSteps } from "./hooks.ts";
import { resolveLocale } from "./i18n.ts";
import type { Registry } from "./registry.ts";
import type {
  FinishMode,
  Locale,
  ManagedWorktree,
  PrPlan,
  WorktreeHistoryEntry,
} from "./types.ts";
import { assertSupportedPlatform, canonicalPath, newId, nowIso, pathExists, readTextFileSafe, redactSecrets, truncateText, withFileLock, withFileLocks } from "./util.ts";

export interface PrepareInput {
  transactionId: string;
  title?: string;
  body?: string;
  draft?: boolean;
}

export interface FinalizeInput {
  transactionId: string;
  prUrl?: string;
}

interface ToolActivation {
  activate(): void;
  deactivate(): void;
}

async function strictSource(pi: ExtensionAPI, record: ManagedWorktree): Promise<{ head: string }> {
  if (!(await pathExists(record.sourcePath))) throw new Error(`Recorded source checkout no longer exists: ${record.sourcePath}`);
  const source = await discoverRepo(pi, record.sourcePath);
  if (source.root !== record.sourcePath) throw new Error("Recorded source checkout path was moved or replaced");
  if (source.commonDir !== record.repoCommonDir) throw new Error("Recorded source path now belongs to a different Git repository");
  if (source.branch !== record.sourceBranch) {
    throw new Error(`Recorded source checkout must remain on ${record.sourceBranch}; it is currently on ${source.branch || "detached HEAD"}`);
  }
  const operation = await gitOperationInProgress(pi, record.sourcePath);
  if (operation) throw new Error(`Source checkout has a Git operation in progress: ${operation}`);
  if (!(await isClean(pi, record.sourcePath))) throw new Error("Recorded source checkout has uncommitted or untracked changes");
  return { head: source.head };
}

async function strictTarget(
  pi: ExtensionAPI,
  record: ManagedWorktree,
  allowRebaseInProgress = false,
  allowMissingRecordedBranch = false,
): Promise<string> {
  const target = await discoverRepo(pi, record.path);
  if (target.root !== record.path) throw new Error("Managed worktree path was moved or replaced");
  if (target.commonDir !== record.repoCommonDir) throw new Error("Managed worktree now belongs to a different Git repository");
  const operation = await gitOperationInProgress(pi, record.path);
  const resumingRebase = allowRebaseInProgress && (operation === "rebase-merge" || operation === "rebase-apply") &&
    (await readTextFileSafe(join(target.gitDir, operation, "head-name")))?.trim() === `refs/heads/${record.branch}`;
  if (target.branch !== record.branch) {
    const mayRecreate = allowMissingRecordedBranch && !operation && !target.branch && !(await branchExists(pi, record.path, record.branch));
    if (!mayRecreate && !(resumingRebase && !target.branch)) {
      throw new Error(`Managed worktree must be on ${record.branch}; it is currently on ${target.branch || "detached HEAD"}`);
    }
  }
  if (operation && !resumingRebase) {
    throw new Error(`Worktree has an unfinished Git operation: ${operation}`);
  }
  return target.head;
}

async function refreshSource(
  pi: ExtensionAPI,
  record: ManagedWorktree,
  allowFastForward: boolean,
  ctx?: ExtensionContext,
  locale: Locale = "auto",
): Promise<string> {
  const before = await strictSource(pi, record);
  const upstream = await getUpstream(pi, record.sourcePath, record.sourceBranch);
  if (!upstream) return before.head;
  await gitOk(pi, record.sourcePath, ["fetch", "--", upstream.remote], `Unable to fetch ${upstream.remote}`, { timeout: 120_000 });
  const upstreamHead = await gitOk(pi, record.sourcePath, ["rev-parse", "--verify", `refs/remotes/${upstream.remote}/${upstream.branch}^{commit}`]);
  const relation = await aheadBehind(pi, record.sourcePath, before.head, upstreamHead);
  if (!relation) throw new Error(`Unable to compare source branch with ${upstream.short}`);
  if (relation.ahead > 0 && relation.behind > 0) {
    throw new Error(`Source branch diverged from ${upstream.short}; reconcile it manually`);
  }
  if (relation.behind > 0) {
    const zh = resolveLocale(locale) === "zh-CN";
    if (!allowFastForward || !ctx) {
      throw new Error(`Source branch is behind ${upstream.short}; resume /wt finish to approve a fast-forward`);
    }
    const approved = await ctx.ui.confirm(
      zh ? "快进记录的来源分支？" : "Fast-forward recorded source branch?",
      zh
        ? `${record.sourcePath}\n${record.sourceBranch} 落后于 ${upstream.short} ${relation.behind} 个提交。`
        : `${record.sourcePath}\n${record.sourceBranch} is behind ${upstream.short} by ${relation.behind} commit(s).`,
    );
    if (!approved) throw new Error("Source fast-forward was not approved");
    await fastForwardCheckout(pi, {
      root: record.sourcePath,
      commonDir: record.repoCommonDir,
      branch: record.sourceBranch,
      head: before.head,
    }, upstreamHead);
  }
  return (await strictSource(pi, record)).head;
}

function finishPrompt(record: ManagedWorktree, mode: FinishMode, sourceHead: string, transactionId: string): string {
  const common = [
    `Finish transaction: ${transactionId}`,
    `Mode: ${mode}`,
    `Managed worktree: ${record.path}`,
    `Work branch: ${record.branch}`,
    `Recorded source branch: ${record.sourceBranch}`,
    `Required source SHA: ${sourceHead}`,
    "",
    "If a rebase is in progress, resolve its conflicts and finish it with git rebase --continue before starting another rebase. Do not recreate or switch branches during an active rebase.",
    `Only if no rebase is in progress and ${record.branch} was manually removed, recreate the missing branch at the current HEAD before committing.`,
    "Review the diff and Git status. Stage only intended files and create one or more meaningful commits.",
    `Rebase ${record.branch} onto the exact source SHA ${sourceHead}; resolve conflicts without modifying the source checkout.`,
    "Do not bypass Git hooks or signing. The worktree must be clean when ready.",
  ];
  if (mode === "pr") {
    common.push(
      "Do not push yet.",
      "Prepare a PR title and body (respect the repository PR template), then call worktree_prepare with transactionId, title, body, and draft.",
      "Only after worktree_prepare returns approved exact commands may you push/create or reopen the PR. Then call worktree_finalize with the PR URL.",
    );
  } else {
    common.push(
      "Do not push and do not modify the source checkout.",
      "Call worktree_prepare with transactionId after committing and rebasing. The extension will perform the final fast-forward in the recorded source checkout.",
    );
  }
  return common.join("\n");
}

export class FinishCoordinator {
  constructor(
    private readonly pi: ExtensionAPI,
    private readonly registry: Registry,
    private readonly tools: ToolActivation,
  ) {}

  private async recordForContext(ctx: ExtensionContext): Promise<ManagedWorktree> {
    const repo = await discoverRepo(this.pi, ctx.cwd);
    const record = await this.registry.findByPath(repo.root);
    if (!record) throw new Error("This is not a managed worktree. Run /wt adopt first.");
    return record;
  }

  private async setNeedsPrepare(record: ManagedWorktree, sourceHead: string): Promise<void> {
    const transactionId = record.transaction?.id;
    const transactionSessionId = record.transaction?.sessionId;
    if (!transactionId) throw new Error("Finish transaction changed before prepare reset");
    if (record.transaction?.pr?.bodyFile) await this.registry.removePrBody(record.transaction.pr.bodyFile);
    await this.registry.update(record.id, (item) => {
      if (item.transaction?.id !== transactionId || item.transaction.sessionId !== transactionSessionId ||
          ["awaiting_cleanup", "cleanup_scheduled"].includes(item.transaction.phase)) {
        throw new Error("Finish transaction changed before prepare reset");
      }
      item.state = "finish_active";
      item.transaction.phase = "agent_prepare";
      item.transaction.sourceHead = sourceHead;
      item.transaction.workHead = undefined;
      if (item.transaction.pr) {
        item.transaction.pr.bodyFile = undefined;
        item.transaction.pr.forceLeaseSha = undefined;
        item.transaction.pr.expectedRemoteSha = undefined;
      }
      item.transaction.updatedAt = nowIso();
    });
  }

  private async cleanup(
    ctx: ExtensionContext,
    record: ManagedWorktree,
    result: WorktreeHistoryEntry["result"],
    finalHead: string,
    prUrl?: string,
  ): Promise<{ scheduled: boolean; cleaned: boolean }> {
    this.tools.deactivate();
    if (record.transaction) {
      const transactionId = record.transaction.id;
      record = await this.registry.update(record.id, (item) => {
        if (item.transaction?.id !== transactionId ||
            (item.transaction.cleanupResult !== undefined && item.transaction.cleanupResult !== result)) {
          throw new Error("Cleanup transaction changed before confirmation");
        }
        item.transaction.cleanupResult = result;
      });
    }
    let locale: "auto" | "en" | "zh-CN" = "auto";
    try {
      locale = (await loadEffectiveConfig({
        repoKey: record.repoKey,
        projectRoot: record.path,
        projectTrusted: ctx.isProjectTrusted(),
        agentDir: this.registry.agentDir,
      })).locale;
    } catch {
      // Cleanup recovery must remain available even if configuration became invalid.
    }
    const zh = resolveLocale(locale) === "zh-CN";
    await strictSource(this.pi, record);
    const cleanupHead = await strictTarget(this.pi, record);
    if (!record.transaction?.workHead || cleanupHead !== record.transaction.workHead) {
      throw new Error("Managed worktree HEAD changed after finish authorization");
    }
    const entries = await statusEntries(this.pi, record.path);
    if (entries.length > 0) {
      throw new Error(
        `Cleanup blocked by ${entries.length} tracked or untracked Git status entries:\n${truncateText(redactSecrets(entries.join("\n")))}`,
      );
    }
    const modules = await initializedSubmodules(this.pi, record.path);
    if (modules.length > 0) {
      await ensureSubmodulesClean(this.pi, record.path, modules);
      const approved = await ctx.ui.confirm(
        zh ? "清理已初始化的 submodule？" : "Clean initialized submodules?",
        `${modules.join("\n")}\n\n${zh ? "删除 worktree 前必须先 deinit 这些干净的 submodule。" : "These clean submodules must be deinitialized before removing the worktree."}`,
      );
      if (!approved) {
        await this.markCleanupPending(record, result);
        return { scheduled: false, cleaned: false };
      }
      await deinitSubmodules(this.pi, record.path, modules);
    }
    const expectedWorkHead = record.transaction?.workHead;
    if (!expectedWorkHead) throw new Error("Cleanup transaction is missing its authorized worktree HEAD; inspect and restart finish");
    const request = {
      record: (await this.registry.findById(record.id)) ?? record,
      result,
      finalHead,
      prUrl,
      deleteBranch: result === "merged",
      expectedWorkHead,
    };
    await validateCleanupRequest(this.pi, this.registry, request);
    const approved = await ctx.ui.confirm(
      zh ? "删除受管理的 worktree？" : "Delete managed worktree?",
      `${record.path}\n\n${zh ? "分支" : "Branch"}: ${record.branch}\n${zh ? "结果" : "Result"}: ${result}\n${zh ? "不会使用 --force。" : "This does not use --force."}`,
    );
    if (!approved) {
      await this.markCleanupPending(record, result);
      return { scheduled: false, cleaned: false };
    }

    const currentRoot = (await discoverRepo(this.pi, ctx.cwd)).root;
    if ((await canonicalPath(currentRoot)) !== (await canonicalPath(record.path))) {
      throw new Error("Cleanup must be scheduled from inside the managed worktree");
    }
    await scheduleCleanup(this.registry, request);
    this.tools.deactivate();
    ctx.ui.notify(zh ? "已安排清理；pi 退出后将删除 worktree。" : "Cleanup is scheduled. Pi will exit before the worktree is removed.", "info");
    ctx.shutdown();
    return { scheduled: true, cleaned: false };
  }

  private async markCleanupPending(record: ManagedWorktree, result: WorktreeHistoryEntry["result"]): Promise<void> {
    await this.registry.update(record.id, (item) => {
      item.state = result === "merged" ? "merged_cleanup_pending" : "cleanup_pending";
      if (item.transaction) {
        item.transaction.phase = "awaiting_cleanup";
        item.transaction.cleanupAttemptId = undefined;
        item.transaction.updatedAt = nowIso();
      }
    });
    this.tools.deactivate();
  }

  async cancel(ctx: ExtensionCommandContext): Promise<void> {
    if (ctx.mode !== "tui") throw new Error("Cancelling a finish transaction requires interactive TUI mode");
    await ctx.waitForIdle();
    const record = await this.recordForContext(ctx);
    if (!record.transaction) throw new Error("No active transaction to cancel");
    const zh = resolveLocale("auto") === "zh-CN";
    const approved = await ctx.ui.confirm(
      zh ? "取消 finish transaction？" : "Cancel finish transaction?",
      `${record.transaction.id}\n\n${zh ? "不会回滚提交、rebase 或远端操作；只会释放编排状态。" : "Commits, rebases, and remote actions will not be reverted. Only orchestration state will be released."}`,
    );
    if (!approved) return;
    await withFileLock(this.registry.sourceLockPath(record.repoCommonDir, record.sourceBranch), async () => {
      const fresh = await this.registry.findById(record.id);
      if (!fresh?.transaction || fresh.transaction.id !== record.transaction?.id) {
        throw new Error("Finish transaction changed before cancellation");
      }
      if (fresh.transaction.pr?.bodyFile) await this.registry.removePrBody(fresh.transaction.pr.bodyFile);
      await this.registry.update(record.id, (item) => {
        if (item.transaction?.id !== fresh.transaction?.id) throw new Error("Finish transaction changed before cancellation");
        item.transaction = undefined;
        item.state = item.initError ? "init_failed" : "active";
      });
    });
    this.tools.deactivate();
    ctx.ui.notify("Finish transaction cancelled. Git commits and remote state were left untouched.", "info");
  }

  async start(ctx: ExtensionCommandContext, requestedMode?: FinishMode, resume = false): Promise<void> {
    if (ctx.mode !== "tui") throw new Error("This operation is available only in interactive TUI mode");
    assertSupportedPlatform();
    await ctx.waitForIdle();
    let record = await this.recordForContext(ctx);
    if (record.state === "creating") throw new Error("Worktree creation/adoption is incomplete; recover it with /wt prune and /wt reopen before finishing");
    const existing = record.transaction;
    let mode = requestedMode ?? existing?.mode;
    if (!mode) {
      const zh = resolveLocale("auto") === "zh-CN";
      const choices = zh ? ["创建 Pull Request", "本地合并", "取消"] : ["Create a pull request", "Merge locally", "Cancel"];
      const selected = await ctx.ui.select(zh ? "选择 finish 模式" : "Choose finish mode", choices);
      if (!selected || selected === choices[2]) return;
      mode = selected === choices[0] ? "pr" : "merge";
    }

    if (existing && !resume && record.state !== "cleanup_pending" && record.state !== "merged_cleanup_pending") {
      throw new Error(`A ${existing.mode} transaction is already ${record.state}. Use /wt finish ${existing.mode} --resume or --cancel.`);
    }
    if (resume && !existing) throw new Error("There is no paused transaction to resume");
    if (existing && existing.mode !== mode) throw new Error(`The existing transaction mode is ${existing.mode}, not ${mode}`);
    const currentSessionId = ctx.sessionManager.getSessionId();
    if (existing && existing.sessionId !== currentSessionId &&
        ["agent_prepare", "publish_authorized"].includes(existing.phase)) {
      if (!resume) throw new Error("The finish transaction is owned by another pi session; use --resume to review a takeover");
      if (existing.sessionId) {
        const takeover = await ctx.ui.confirm(
          "Take over finish transaction?",
          `Transaction ${existing.id} belongs to session ${existing.sessionId}. Takeover prevents that session from using the managed finish tools, but does not stop its external Git commands.`,
        );
        if (!takeover) return;
      }
      // Claim legacy transactions here too, before any recovery path can activate tools and return early.
      record = await this.registry.update(record.id, (item) => {
        if (item.transaction?.id !== existing.id || item.transaction.sessionId !== existing.sessionId ||
            item.transaction.phase !== existing.phase || item.transaction.mode !== existing.mode) {
          throw new Error("Finish transaction changed before session ownership could be acquired");
        }
        item.transaction.sessionId = currentSessionId;
        item.transaction.updatedAt = nowIso();
        item.state = "finish_paused";
      });
      existing.sessionId = currentSessionId;
    }

    if (record.state === "cleanup_scheduled") {
      const takeover = await ctx.ui.confirm(
        "Retry scheduled cleanup?",
        "This marks any previous cleanup helper stale and starts a newly confirmed cleanup attempt.",
      );
      if (!takeover) return;
      record = await withFileLock(
        this.registry.sourceLockPath(record.repoCommonDir, record.sourceBranch),
        async () => {
          const fresh = await this.registry.findById(record.id);
          if (!fresh?.transaction || fresh.transaction.id !== existing?.id || fresh.state !== "cleanup_scheduled") {
            throw new Error("Scheduled cleanup changed before takeover; run /wt status again");
          }
          return this.registry.update(record.id, (item) => {
            item.state = item.transaction?.cleanupResult === "merged" ? "merged_cleanup_pending" : "cleanup_pending";
            if (item.transaction) {
              item.transaction.phase = "awaiting_cleanup";
              item.transaction.cleanupAttemptId = undefined;
              item.transaction.updatedAt = nowIso();
            }
          });
        },
      );
    }

    if (record.state === "cleanup_pending" || record.state === "merged_cleanup_pending") {
      const result: WorktreeHistoryEntry["result"] = record.transaction?.cleanupResult ?? (
        record.state === "merged_cleanup_pending" ? "merged" : record.prUrl ? "pr" : "already_integrated"
      );
      const finalHead = record.transaction?.mergedHead ?? record.transaction?.workHead ?? (await currentHead(this.pi, record.path));
      await this.cleanup(ctx, record, result, finalHead, record.prUrl);
      return;
    }

    const config = await loadEffectiveConfig({
      repoKey: record.repoKey,
      projectRoot: record.path,
      projectTrusted: ctx.isProjectTrusted(),
      agentDir: this.registry.agentDir,
    });
    const zh = resolveLocale(config.locale) === "zh-CN";

    const recoveringRebase = resume && existing && ["rebase-merge", "rebase-apply"].includes(
      (await gitOperationInProgress(this.pi, record.path)) ?? "",
    );
    if (resume && !recoveringRebase && existing?.phase === "publish_authorized" && existing.pr && existing.workHead) {
      const targetHead = await strictTarget(this.pi, record);
      const sourceHead = await withFileLock(
        this.registry.sourceLockPath(record.repoCommonDir, record.sourceBranch),
        () => refreshSource(this.pi, record, true, ctx, config.locale),
      );
      if (targetHead !== existing.workHead || sourceHead !== existing.sourceHead || !(await isClean(this.pi, record.path))) {
        await this.setNeedsPrepare(record, sourceHead);
        this.tools.activate();
        this.pi.sendUserMessage(finishPrompt(record, mode, sourceHead, existing.id));
        return;
      }
      let approvedPr = existing.pr;
      const currentRemoteSha = await remoteBranchSha(this.pi, record.path, approvedPr.pushRemote, approvedPr.headBranch);
      if (currentRemoteSha !== existing.workHead && currentRemoteSha !== approvedPr.expectedRemoteSha) {
        await this.setNeedsPrepare(record, sourceHead);
        this.tools.activate();
        this.pi.sendUserMessage(finishPrompt(record, mode, sourceHead, existing.id));
        ctx.ui.notify(
          zh ? "远端工作分支在批准后发生变化；必须重新运行质量门禁并授权。" : "The remote work branch changed after approval; quality gates and authorization must run again.",
          "warning",
        );
        return;
      }
      if (!approvedPr.title || approvedPr.body === undefined) throw new Error("Approved PR transaction is missing title or body metadata");
      if (!approvedPr.bodyFile || !(await this.registry.validatePrBodyFile(approvedPr.bodyFile, approvedPr.body))) {
        if (approvedPr.bodyFile) await this.registry.removePrBody(approvedPr.bodyFile);
        const bodyFile = await writeApprovedPrBody(this.registry, existing.id, approvedPr.body);
        approvedPr = { ...approvedPr, bodyFile };
        await this.registry.update(record.id, (item) => {
          if (item.transaction?.id === existing.id) item.transaction.pr = approvedPr;
        });
      }
      await validatePrPlanRemotes(this.pi, record.path, record.sourcePath, approvedPr);
      const recoveredPrs = await findPullRequests(this.pi, record.path, approvedPr);
      const recoveredOpen = recoveredPrs.find((item) => item.state === "OPEN");
      const recoveredMerged = recoveredPrs.find((item) => item.state === "MERGED" && item.headRefOid === targetHead);
      const recoveredClosed = recoveredPrs.find((item) => item.state === "CLOSED");
      if (recoveredMerged && !recoveredOpen) {
        if (recoveredMerged.headRefOid !== targetHead || !(await isClean(this.pi, record.path))) {
          throw new Error(`Recovered merged PR ${recoveredMerged.url}, but local HEAD does not match its verified head SHA`);
        }
        const clean = await ctx.ui.confirm(
          zh ? "恢复到已合并的 PR" : "Recovered a merged PR",
          `${recoveredMerged.url}\n\n${zh ? "清理此 worktree？" : "Clean up this worktree?"}`,
        );
        if (!clean) return;
        await this.registry.update(record.id, (item) => {
          item.prUrl = recoveredMerged.url;
          item.state = "cleanup_pending";
          if (item.transaction) {
            item.transaction.phase = "awaiting_cleanup";
            item.transaction.cleanupAttemptId = undefined;
            item.transaction.cleanupResult = "already_integrated";
            item.transaction.updatedAt = nowIso();
          }
        });
        record = (await this.registry.findById(record.id))!;
        await this.cleanup(ctx, record, "already_integrated", targetHead, recoveredMerged.url);
        return;
      }
      if (recoveredOpen) {
        approvedPr = { ...approvedPr, existingUrl: recoveredOpen.url, existingIsDraft: recoveredOpen.isDraft, needsReopen: false };
      } else if (recoveredClosed) {
        const choices = zh ? ["重新打开", "创建新的 PR", "取消"] : ["Reopen", "Create a new PR", "Cancel"];
        const action = await ctx.ui.select(
          zh ? `恢复时发现已关闭的 PR：${recoveredClosed.url}` : `Recovered a closed PR: ${recoveredClosed.url}`,
          choices,
        );
        if (!action || action === choices[2]) return;
        if (action === choices[0]) {
          approvedPr = { ...approvedPr, existingUrl: recoveredClosed.url, existingIsDraft: recoveredClosed.isDraft, needsReopen: true };
        } else {
          approvedPr = { ...approvedPr, existingUrl: undefined, existingIsDraft: undefined, needsReopen: false };
        }
      }
      await this.registry.update(record.id, (item) => {
        if (item.transaction?.id === existing.id) item.transaction.pr = approvedPr;
      });
      const commands = prCommands(approvedPr, existing.workHead);
      this.tools.activate();
      this.pi.sendUserMessage([
        `Resume approved PR transaction ${existing.id}.`,
        "Execute only these applicable commands, then call worktree_finalize with the PR URL:",
        commands.push,
        commands.reopen,
        commands.edit,
        commands.draftStatus,
        commands.create,
      ].filter(Boolean).join("\n\n"));
      return;
    }

    const targetHead = await strictTarget(this.pi, record, resume && Boolean(existing), true);
    const sourceHead = await withFileLock(
      this.registry.sourceLockPath(record.repoCommonDir, record.sourceBranch),
      () => refreshSource(this.pi, record, true, ctx, config.locale),
    );
    if (recoveringRebase && existing) {
      await this.setNeedsPrepare(record, sourceHead);
      this.tools.activate();
      this.pi.sendUserMessage(finishPrompt(record, mode, sourceHead, existing.id));
      return;
    }

    if ((await isClean(this.pi, record.path)) && (targetHead === sourceHead || (await isAncestor(this.pi, record.path, targetHead, sourceHead)))) {
      const approved = await ctx.ui.confirm(
        zh ? "工作内容已集成" : "Work is already integrated",
        zh
          ? `工作分支已包含在 ${record.sourceBranch} 中。不再 merge 或创建 PR，直接清理 worktree？`
          : `The work branch is already contained in ${record.sourceBranch}. Clean up the worktree without another merge or PR?`,
      );
      if (!approved) return;
      const timestamp = nowIso();
      await this.registry.update(record.id, (item) => {
        item.state = "cleanup_pending";
        // This result is verified by local ancestry, not by a historical PR.
        item.prUrl = undefined;
        item.transaction = {
          id: newId(),
          mode,
          phase: "awaiting_cleanup",
          sourceHead,
          workHead: targetHead,
          mergedHead: sourceHead,
          cleanupResult: "already_integrated",
          startedAt: timestamp,
          updatedAt: timestamp,
        };
      });
      record = (await this.registry.findById(record.id))!;
      await this.cleanup(ctx, record, "already_integrated", sourceHead);
      return;
    }

    let pr: PrPlan | undefined;
    if (mode === "pr") {
      pr = await createPrPlan({
        pi: this.pi,
        registry: this.registry,
        record,
        config,
        sourceHead,
        select: (title, options) => {
          const localized = zh
            ? title
                .replace("Source branch has no upstream; select the PR base repository", "来源分支没有 upstream；请选择 PR base 仓库")
                .replace("Select the remote PR base branch", "选择远端 PR base 分支")
                .replace("Select the remote that will receive the work branch", "选择接收工作分支的 remote")
            : title;
          return ctx.ui.select(localized, options);
        },
      });
      const pullRequests = await findPullRequests(this.pi, record.path, pr);
      const open = pullRequests.find((item) => item.state === "OPEN");
      const merged = pullRequests.find((item) => item.state === "MERGED" && item.headRefOid === targetHead);
      const closed = pullRequests.find((item) => item.state === "CLOSED");
      if (open) {
        pr.existingUrl = open.url;
        pr.existingIsDraft = open.isDraft;
      }
      else if (merged) {
        const clean = await isClean(this.pi, record.path);
        if (!clean) throw new Error(`PR ${merged.url} is merged, but the worktree contains additional uncommitted work`);
        if (!merged.headRefOid || targetHead !== merged.headRefOid) {
          throw new Error(`PR ${merged.url} is merged, but local HEAD does not match its verified head SHA; inspect before cleanup`);
        }
        const approved = await ctx.ui.confirm(
          zh ? "Pull Request 已合并" : "Pull request is already merged",
          `${merged.url}\n\n${zh ? "清理此 worktree？" : "Clean up this worktree?"}`,
        );
        if (!approved) return;
        const timestamp = nowIso();
        await this.registry.update(record.id, (item) => {
          item.prUrl = merged.url;
          item.state = "cleanup_pending";
          item.transaction = {
            id: newId(),
            mode: "pr",
            phase: "awaiting_cleanup",
            sourceHead,
            workHead: targetHead,
            cleanupResult: "already_integrated",
            startedAt: timestamp,
            updatedAt: timestamp,
          };
        });
        record = (await this.registry.findById(record.id))!;
        await this.cleanup(ctx, record, "already_integrated", targetHead, merged.url);
        return;
      } else if (closed) {
        const closedChoices = zh ? ["重新打开", "创建新的 PR", "取消"] : ["Reopen", "Create a new PR", "Cancel"];
        const action = await ctx.ui.select(
          zh ? `已有 PR 已关闭：${closed.url}` : `Existing PR is closed: ${closed.url}`,
          closedChoices,
        );
        if (!action || action === closedChoices[2]) return;
        if (action === closedChoices[0]) {
          pr.existingUrl = closed.url;
          pr.existingIsDraft = closed.isDraft;
          pr.needsReopen = true;
        }
      }
      const draftChoices = [
        {
          label: config.defaults.draftPr
            ? (zh ? "草稿（默认）" : "Draft (default)")
            : (zh ? "可供审阅（默认）" : "Ready for review (default)"),
          value: config.defaults.draftPr,
        },
        {
          label: config.defaults.draftPr ? (zh ? "可供审阅" : "Ready for review") : (zh ? "草稿" : "Draft"),
          value: !config.defaults.draftPr,
        },
      ];
      const draft = await ctx.ui.select(zh ? "Pull Request 类型" : "Pull request type", draftChoices.map((item) => item.label));
      if (!draft) return;
      pr.draft = draftChoices.find((item) => item.label === draft)?.value ?? config.defaults.draftPr;
    }

    const transactionId = existing?.id ?? newId();
    const summary = [
      `${zh ? "模式" : "Mode"}: ${mode}`,
      `Worktree: ${record.path}`,
      `${zh ? "工作分支" : "Work branch"}: ${record.branch} @ ${targetHead.slice(0, 12)}`,
      `${zh ? "来源" : "Source"}: ${record.sourcePath}`,
      `${zh ? "来源分支" : "Source branch"}: ${record.sourceBranch} @ ${sourceHead.slice(0, 12)}`,
      pr
        ? `PR: ${pr.pushRepo ?? pr.pushRemote}:${pr.headBranch} -> ${pr.baseRepo}:${pr.baseBranch}`
        : (zh ? "不会执行远端 push。" : "No remote push will be performed."),
      `${zh ? "质量门禁" : "Quality gates"}: ${[...config.hooks.preFinish, ...(mode === "pr" ? config.hooks.prePr : config.hooks.preMerge)]
        .map((step) => describeHookStep(step))
        .join("\n") || (zh ? "（无）" : "(none)")}`,
    ].join("\n\n");
    if (!(await ctx.ui.confirm(zh ? "开始 finish transaction？" : "Start finish transaction?", summary))) return;

    const timestamp = nowIso();
    await withFileLocks([
      this.registry.sourceLockPath(record.repoCommonDir, record.sourceBranch),
      this.registry.sourceLockPath(record.repoCommonDir, record.branch),
    ], async () => {
      const [latestSource, latestTarget] = await Promise.all([
        strictSource(this.pi, record),
        strictTarget(this.pi, record, resume && Boolean(existing), true),
      ]);
      if (latestSource.head !== sourceHead || latestTarget !== targetHead) {
        throw new Error("Source or worktree HEAD changed after finish confirmation; review the plan again");
      }
      await this.registry.beginFinishTransaction(record.id, {
        id: transactionId,
        mode,
        phase: "agent_prepare",
        sourceHead,
        sessionId: ctx.sessionManager.getSessionId(),
        startedAt: existing?.startedAt ?? timestamp,
        updatedAt: timestamp,
        pr,
      });
    });
    this.tools.activate();
    this.pi.sendUserMessage(finishPrompt(record, mode, sourceHead, transactionId));
  }

  async prepare(input: PrepareInput, signal: AbortSignal | undefined, ctx: ExtensionContext): Promise<string> {
    if (ctx.mode !== "tui") throw new Error("Finish preparation requires interactive TUI mode");
    assertSupportedPlatform();
    signal?.throwIfAborted();
    let record = await this.recordForContext(ctx);
    const transaction = record.transaction;
    if (!transaction || transaction.id !== input.transactionId || transaction.phase !== "agent_prepare" ||
        (transaction.sessionId && transaction.sessionId !== ctx.sessionManager.getSessionId())) {
      throw new Error("No matching agent_prepare transaction exists for this worktree and pi session");
    }
    const workHead = await strictTarget(this.pi, record);
    if (!(await isClean(this.pi, record.path))) {
      throw new Error("Worktree is not clean. Commit or remove all tracked and untracked status entries before prepare.");
    }
    const latestSource = await refreshSource(this.pi, record, false);
    if (latestSource !== transaction.sourceHead) {
      await this.setNeedsPrepare(record, latestSource);
      throw new Error(`Source changed from ${transaction.sourceHead} to ${latestSource}. Rebase onto ${latestSource} and call prepare again.`);
    }
    if (workHead === latestSource) throw new Error("Work branch has no commits ahead of the source branch");
    if (!(await isAncestor(this.pi, record.path, latestSource, workHead))) {
      throw new Error(`Work branch is not rebased onto required source SHA ${latestSource}`);
    }

    await strictSource(this.pi, record);
    const config = await loadEffectiveConfig({
      repoKey: record.repoKey,
      projectRoot: record.path,
      projectTrusted: ctx.isProjectTrusted(),
      agentDir: this.registry.agentDir,
    });
    const zh = resolveLocale(config.locale) === "zh-CN";
    const hooks = [
      ...config.hooks.preFinish,
      ...(transaction.mode === "pr" ? config.hooks.prePr : config.hooks.preMerge),
    ];
    await assertHookCommandsAvailable(hooks, record.path);
    const headBeforeHooks = workHead;
    const hookResult = await runHookSteps({
      registry: this.registry,
      name: transaction.mode === "pr" ? "preFinish+prePr" : "preFinish+preMerge",
      steps: hooks,
      context: { record, mode: transaction.mode, transactionId: transaction.id },
      signal,
    });
    signal?.throwIfAborted();
    if (!hookResult.ok) {
      throw new Error(`${hookResult.error}${hookResult.stderr ? `\n${hookResult.stderr}` : ""}${hookResult.logPath ? `\nFull local log: ${hookResult.logPath}` : ""}`);
    }
    if (!(await isClean(this.pi, record.path)) || (await currentHead(this.pi, record.path)) !== headBeforeHooks) {
      throw new Error("A pre-finish hook changed Git status or HEAD. Review, commit or revert those changes, then prepare again.");
    }

    const summary = await commitSummary(this.pi, record.path, latestSource);
    if (!(await ctx.ui.confirm(zh ? "批准提交和质量门禁？" : "Approve commits and quality gates?", summary, { signal }))) {
      throw new Error("User declined the commit set; revise it before preparing again");
    }

    signal?.throwIfAborted();
    if (transaction.mode === "merge") {
      const approved = await ctx.ui.confirm(
        zh ? "快进记录的来源 checkout？" : "Fast-forward recorded source checkout?",
        `${summary}\n\n${record.sourcePath}\n${record.sourceBranch}: ${latestSource.slice(0, 12)} -> ${workHead.slice(0, 12)}\n\n${zh ? "不会执行远端 push。" : "No remote push will occur."}`,
        { signal },
      );
      if (!approved) throw new Error("User declined the source branch update");
      const mergedHead = await withFileLock(
        this.registry.sourceLockPath(record.repoCommonDir, record.sourceBranch),
        async () => {
          const fresh = await this.registry.findById(record.id);
          const freshTransaction = fresh?.transaction;
          if (!freshTransaction || freshTransaction.id !== transaction.id || freshTransaction.phase !== "agent_prepare" ||
              freshTransaction.sessionId !== transaction.sessionId) {
            throw new Error("Finish transaction changed before local merge");
          }
          const finalSourceHead = await refreshSource(this.pi, record, false);
          if (finalSourceHead !== latestSource) {
            await this.setNeedsPrepare(record, finalSourceHead);
            throw new Error(`Source changed to ${finalSourceHead}; rebase and prepare again`);
          }
          const targetNow = await strictTarget(this.pi, record);
          if (targetNow !== workHead || !(await isClean(this.pi, record.path))) {
            throw new Error("Worktree changed after approval; prepare again");
          }
          signal?.throwIfAborted();
          await fastForwardCheckout(this.pi, {
            root: record.sourcePath, commonDir: record.repoCommonDir, branch: record.sourceBranch, head: latestSource,
          }, workHead, signal);
          const completedSource = await discoverRepo(this.pi, record.sourcePath);
          const completedHead = completedSource.head;
          if (completedSource.root !== record.sourcePath || completedSource.commonDir !== record.repoCommonDir ||
              completedSource.branch !== record.sourceBranch || completedHead !== workHead || !(await isClean(this.pi, record.sourcePath))) {
            throw new Error("Source checkout changed unexpectedly during its merge hooks; inspect it before resuming");
          }
          await this.registry.update(record.id, (item) => {
            if (item.transaction?.id !== transaction.id || item.transaction.phase !== "agent_prepare" ||
                item.transaction.sessionId !== transaction.sessionId) {
              throw new Error("Finish transaction changed during local merge");
            }
            item.state = "merged_cleanup_pending";
            item.prUrl = undefined;
            item.transaction.phase = "awaiting_cleanup";
            item.transaction.cleanupAttemptId = undefined;
            item.transaction.workHead = workHead;
            item.transaction.mergedHead = completedHead;
            item.transaction.cleanupResult = "merged";
            item.transaction.updatedAt = nowIso();
          });
          return completedHead;
        },
      );
      record = (await this.registry.findById(record.id))!;
      ctx.ui.notify("The work branch was fast-forwarded into its recorded source checkout.", "info");
      signal?.throwIfAborted();
      await this.cleanup(ctx, record, "merged", mergedHead);
      return `Merged ${record.branch} into ${record.sourcePath}:${record.sourceBranch} at ${mergedHead}.`;
    }

    const plan = transaction.pr;
    if (!plan) throw new Error("PR transaction is missing its remote plan");
    await validatePrPlanRemotes(this.pi, record.path, record.sourcePath, plan);
    let title = input.title?.trim();
    let body = input.body?.trim();
    if (!title || !body) throw new Error("PR prepare requires a non-empty title and body");
    if (title.length > 256 || Buffer.byteLength(body, "utf8") > 65_536 ||
        /[\u0000-\u001f\u007f-\u009f]/.test(title) || /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(body)) {
      throw new Error("PR title or body exceeds the safe review limit or contains unsafe control characters");
    }
    title = (await ctx.ui.editor(zh ? "Pull Request 标题" : "Pull request title", title))?.trim();
    if (!title) throw new Error("PR title approval was cancelled");
    if (/[\u0000-\u001f\u007f-\u009f]/.test(title)) throw new Error("PR title must be a control-free single line");
    if (title.length > 256) throw new Error("PR title must not exceed 256 characters");
    body = (await ctx.ui.editor(zh ? "Pull Request 正文" : "Pull request body", body))?.trim();
    if (!body) throw new Error("PR body approval was cancelled");
    if (/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(body)) throw new Error("PR body must not contain unsafe control characters");
    if (Buffer.byteLength(body, "utf8") > 65_536) throw new Error("PR body must not exceed 65536 bytes");
    const draft = input.draft ?? plan.draft ?? config.defaults.draftPr;

    const remoteSha = await remoteBranchSha(this.pi, record.path, plan.pushRemote, plan.headBranch);
    if (remoteSha) {
      await gitOk(
        this.pi,
        record.path,
        ["fetch", "--no-tags", "--", plan.pushRemote, `refs/heads/${plan.headBranch}`],
        `Unable to fetch ${plan.pushRemote}/${plan.headBranch} for lease verification`,
        { timeout: 120_000 },
      );
    }
    let forceLeaseSha: string | undefined;
    if (remoteSha && remoteSha !== workHead && !(await isAncestor(this.pi, record.path, remoteSha, workHead))) {
      const approved = await ctx.ui.confirm(
        zh ? "远端工作分支需要改写历史" : "Remote work branch requires history rewrite",
        `${plan.pushRemote}/${plan.headBranch}\nRemote: ${remoteSha}\nLocal:  ${workHead}\n\nAllow an exact --force-with-lease update?`,
        { signal },
      );
      if (!approved) throw new Error("Remote branch update was not approved");
      forceLeaseSha = remoteSha;
    }
    const bodyFile = await writeApprovedPrBody(this.registry, transaction.id, body);
    const approvedPlan: PrPlan = { ...plan, title, body, bodyFile, draft, forceLeaseSha, expectedRemoteSha: remoteSha };
    const command = prCommands(approvedPlan, workHead);
    const preview = [
      summary,
      "",
      `Repository: ${approvedPlan.baseRepo}`,
      `Base: ${approvedPlan.baseBranch}`,
      `Head: ${approvedPlan.headOwner ? `${approvedPlan.headOwner}:` : ""}${approvedPlan.headBranch}`,
      `Draft: ${draft ? "yes" : "no"}`,
      `Title: ${title}`,
      "",
      body,
      "",
      `Push command:\n${command.push}`,
      command.reopen ? `Reopen command:\n${command.reopen}` : "",
      command.edit ? `Edit command:\n${command.edit}` : "",
      command.draftStatus ? `Draft-status command:\n${command.draftStatus}` : "",
      command.create ? `Create command:\n${command.create}` : `Existing PR: ${approvedPlan.existingUrl}`,
    ].filter(Boolean).join("\n");
    if (!(await ctx.ui.confirm(zh ? "批准远端发布？" : "Approve remote publication?", preview, { signal }))) {
      await this.registry.removePrBody(bodyFile);
      throw new Error("User declined PR publication");
    }
    try {
      await withFileLocks([
        this.registry.sourceLockPath(record.repoCommonDir, record.sourceBranch),
        this.registry.sourceLockPath(record.repoCommonDir, record.branch),
      ], async () => {
        signal?.throwIfAborted();
        await validatePrPlanRemotes(this.pi, record.path, record.sourcePath, approvedPlan);
        const finalSourceHead = await refreshSource(this.pi, record, false);
        const finalWorkHead = await strictTarget(this.pi, record);
        if (finalSourceHead !== latestSource || finalWorkHead !== workHead || !(await isClean(this.pi, record.path))) {
          await this.setNeedsPrepare(record, finalSourceHead);
          throw new Error("Source or worktree changed during publication approval; rebase and prepare again");
        }
        const finalRemoteSha = await remoteBranchSha(this.pi, record.path, plan.pushRemote, plan.headBranch);
        if (finalRemoteSha !== remoteSha) {
          throw new Error("Remote work branch changed during publication approval; prepare again");
        }
        if (!(await this.registry.validatePrBodyFile(bodyFile, body))) {
          throw new Error("Approved PR body file changed before publication authorization; prepare again");
        }
        signal?.throwIfAborted();
        await this.registry.update(record.id, (item) => {
          signal?.throwIfAborted();
          if (item.transaction?.id !== transaction.id || item.transaction.phase !== "agent_prepare" ||
              item.transaction.sessionId !== transaction.sessionId) {
            throw new Error("Finish transaction changed before publication authorization");
          }
          item.state = "publish_authorized";
          item.transaction.phase = "publish_authorized";
          item.transaction.workHead = workHead;
          item.transaction.pr = approvedPlan;
          item.transaction.updatedAt = nowIso();
        });
      });
    } catch (error) {
      await this.registry.removePrBody(bodyFile);
      throw error;
    }
    return [
      "Quality gates and publication plan approved.",
      "Execute only these applicable commands:",
      command.push,
      command.reopen,
      command.edit,
      command.draftStatus,
      command.create,
      `Then call worktree_finalize with transactionId ${transaction.id} and the PR URL.`,
    ].filter(Boolean).join("\n\n");
  }

  async finalize(input: FinalizeInput, ctx: ExtensionContext): Promise<string> {
    if (ctx.mode !== "tui") throw new Error("PR finalization requires interactive TUI mode");
    assertSupportedPlatform();
    let record = await this.recordForContext(ctx);
    const transaction = record.transaction;
    if (!transaction || transaction.id !== input.transactionId || transaction.phase !== "publish_authorized" || transaction.mode !== "pr" ||
        (transaction.sessionId && transaction.sessionId !== ctx.sessionManager.getSessionId())) {
      throw new Error("No matching publish_authorized PR transaction exists for this worktree and pi session");
    }
    const plan = transaction.pr;
    if (!plan || !transaction.workHead || !plan.bodyFile) throw new Error("PR transaction is incomplete");
    this.registry.assertPrBodyPath(plan.bodyFile);
    const workHead = await strictTarget(this.pi, record);
    if (workHead !== transaction.workHead || !(await isClean(this.pi, record.path))) {
      await this.setNeedsPrepare(record, transaction.sourceHead);
      throw new Error("Worktree changed after prepare; run quality gates again");
    }
    const latestSource = await refreshSource(this.pi, record, false);
    if (latestSource !== transaction.sourceHead) {
      await this.setNeedsPrepare(record, latestSource);
      throw new Error(`Source changed to ${latestSource}. Rebase, prepare, and update the PR again.`);
    }
    await validatePrPlanRemotes(this.pi, record.path, record.sourcePath, plan);
    const info = await verifyPublishedPr(this.pi, record.path, plan, workHead, input.prUrl);
    if (plan.title !== undefined && plan.title !== info.title) throw new Error("Published PR title differs from the approved title");
    if (plan.body !== undefined && plan.body.trim() !== (info.body ?? "").trim()) {
      throw new Error("Published PR body differs from the approved body");
    }
    if (plan.draft !== undefined && plan.draft !== info.isDraft) {
      throw new Error("Published PR draft state differs from the approved state");
    }
    if (plan.bodyFile) await this.registry.removePrBody(plan.bodyFile);
    await this.registry.update(record.id, (item) => {
      if (item.transaction?.id !== transaction.id || item.transaction.phase !== "publish_authorized" ||
          item.transaction.sessionId !== transaction.sessionId) {
        throw new Error("Finish transaction changed during PR verification");
      }
      item.prUrl = info.url;
      item.state = "cleanup_pending";
      item.transaction.phase = "awaiting_cleanup";
      item.transaction.cleanupAttemptId = undefined;
      item.transaction.cleanupResult = "pr";
      item.transaction.updatedAt = nowIso();
    });
    record = (await this.registry.findById(record.id))!;
    ctx.ui.notify(`Pull request verified: ${info.url}`, "info");
    await this.cleanup(ctx, record, "pr", workHead, info.url);
    return `Pull request verified: ${info.url}`;
  }

  async pauseCurrent(cwd: string, sessionId?: string): Promise<void> {
    let record: ManagedWorktree | undefined;
    try {
      const root = (await discoverRepo(this.pi, cwd)).root;
      record = await this.registry.findByPath(root);
    } catch {
      return;
    }
    if (!record?.transaction || (record.transaction.sessionId && record.transaction.sessionId !== sessionId) ||
        record.state === "cleanup_scheduled" || record.state === "cleanup_pending" || record.state === "merged_cleanup_pending") return;
    const transactionId = record.transaction.id;
    await this.registry.update(record.id, (item) => {
      if (item.transaction?.id !== transactionId || (item.transaction.sessionId && item.transaction.sessionId !== sessionId)) return;
      item.state = "finish_paused";
      item.transaction.updatedAt = nowIso();
    });
    this.tools.deactivate();
  }
}
