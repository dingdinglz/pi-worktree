import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { assertAllowedFlags, flagBoolean, flagString, parseArgs } from "./cli.ts";
import { createWorktree } from "./create.ts";
import { FinishCoordinator } from "./finish.ts";
import { discoverRepo } from "./git.ts";
import { resolveLocale } from "./i18n.ts";
import {
  adoptWorktree,
  doctor,
  listManaged,
  manageConfig,
  pruneManaged,
  reopenWorktree,
  showStatus,
} from "./management.ts";
import { Registry } from "./registry.ts";
import { loadEffectiveConfig } from "./config.ts";
import type { FinishMode } from "./types.ts";
import { redactSecrets, truncateText } from "./util.ts";

const PREPARE_TOOL = "worktree_prepare";
const FINALIZE_TOOL = "worktree_finalize";
const TOOL_NAMES = new Set([PREPARE_TOOL, FINALIZE_TOOL]);

function requireNoPositionals(positionals: string[], usage: string): void {
  if (positionals.length > 0) throw new Error(`Usage: ${usage}`);
}

export default function piWorktreeExtension(pi: ExtensionAPI) {
  const registry = new Registry();
  const tools = {
    activate() {
      pi.setActiveTools([...new Set([...pi.getActiveTools(), PREPARE_TOOL, FINALIZE_TOOL])]);
    },
    deactivate() {
      pi.setActiveTools(pi.getActiveTools().filter((name) => !TOOL_NAMES.has(name)));
    },
  };
  const finish = new FinishCoordinator(pi, registry, tools);

  pi.registerTool({
    name: PREPARE_TOOL,
    label: "Prepare Worktree Finish",
    description:
      "Continue an explicitly user-started pi-worktree finish transaction after commits and rebase are complete. It is locked unless /wt finish has created a transaction.",
    parameters: Type.Object({
      transactionId: Type.String({ description: "Exact transaction id from the /wt finish prompt" }),
      title: Type.Optional(Type.String({ description: "Proposed PR title (PR mode only)" })),
      body: Type.Optional(Type.String({ description: "Proposed PR body (PR mode only)" })),
      draft: Type.Optional(Type.Boolean({ description: "Whether the proposed PR is a draft" })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const text = await finish.prepare(params, signal, ctx);
      let terminate = false;
      try {
        const repo = await discoverRepo(pi, ctx.cwd);
        const record = await registry.findByPath(repo.root);
        terminate = record?.state === "cleanup_scheduled" || record?.state === "merged_cleanup_pending";
      } catch {
        // Use normal agent continuation when state cannot be inspected.
      }
      return { content: [{ type: "text", text }], details: { transactionId: params.transactionId }, terminate };
    },
  });

  pi.registerTool({
    name: FINALIZE_TOOL,
    label: "Finalize Worktree PR",
    description:
      "Verify the pushed branch and PR for an explicitly approved pi-worktree transaction, then offer safe cleanup. It is locked unless worktree_prepare authorized publication.",
    parameters: Type.Object({
      transactionId: Type.String({ description: "Exact transaction id returned by worktree_prepare" }),
      prUrl: Type.Optional(Type.String({ description: "Created or reopened pull request URL" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const text = await finish.finalize(params, ctx);
      return { content: [{ type: "text", text }], details: { transactionId: params.transactionId }, terminate: true };
    },
  });

  async function menu(ctx: ExtensionCommandContext): Promise<string | undefined> {
    const zh = resolveLocale("auto") === "zh-CN";
    const items = [
      ["new", "create a managed worktree", "创建受管理的 worktree"],
      ["finish", "PR or merge the current worktree", "创建 PR 或合并当前 worktree"],
      ["adopt", "attach metadata to the current worktree", "接管当前 worktree"],
      ["reopen", "restore a PR worktree", "恢复 PR worktree"],
      ["list", "list managed worktrees", "列出受管理的 worktree"],
      ["status", "show current status", "显示当前状态"],
      ["config", "inspect or edit configuration", "查看或编辑配置"],
      ["doctor", "diagnose prerequisites", "诊断运行条件"],
      ["prune", "safely prune stale state", "安全清理过期状态"],
    ] as const;
    const options = items.map(([key, en, cn]) => `${key} — ${zh ? cn : en}`);
    const selected = await ctx.ui.select("pi-worktree", options);
    return selected?.split(" — ")[0];
  }

  async function commandHandler(rawArgs: string, ctx: ExtensionCommandContext): Promise<void> {
    try {
      const first = parseArgs(rawArgs);
      let subcommand: string | undefined = first.positional[0];
      if (!subcommand) subcommand = await menu(ctx);
      if (!subcommand) return;
      const rest = rawArgs.trim().replace(/^\S+\s*/, subcommand === first.positional[0] ? "" : rawArgs.trim());

      if (subcommand === "new") {
        const parsed = parseArgs(rest, new Set(["branch", "path"]));
        assertAllowedFlags(parsed, new Set(["branch", "path", "no-launch", "allow-dirty"]));
        await createWorktree(pi, registry, ctx, {
          task: parsed.positional.join(" ") || undefined,
          branch: flagString(parsed, "branch"),
          path: flagString(parsed, "path"),
          noLaunch: flagBoolean(parsed, "no-launch"),
          allowDirty: flagBoolean(parsed, "allow-dirty"),
        });
        return;
      }

      if (subcommand === "finish") {
        const parsed = parseArgs(rest);
        assertAllowedFlags(parsed, new Set(["resume", "cancel"]));
        const mode = parsed.positional[0] as FinishMode | undefined;
        if (mode && mode !== "pr" && mode !== "merge") throw new Error("Finish mode must be pr or merge");
        if (parsed.positional.length > 1 || (flagBoolean(parsed, "resume") && flagBoolean(parsed, "cancel"))) {
          throw new Error("Usage: /wt finish <pr|merge> [--resume|--cancel]");
        }
        if (flagBoolean(parsed, "cancel")) {
          await finish.cancel(ctx);
          return;
        }
        await finish.start(ctx, mode, flagBoolean(parsed, "resume"));
        return;
      }

      if (subcommand === "adopt") {
        const parsed = parseArgs(rest);
        assertAllowedFlags(parsed, new Set());
        requireNoPositionals(parsed.positional, "/wt adopt");
        await adoptWorktree(pi, registry, ctx);
        return;
      }
      if (subcommand === "reopen") {
        const parsed = parseArgs(rest);
        assertAllowedFlags(parsed, new Set());
        if (parsed.positional.length > 1) throw new Error("Usage: /wt reopen [id]");
        await reopenWorktree(pi, registry, ctx, parsed.positional[0]);
        return;
      }
      if (subcommand === "list") {
        const parsed = parseArgs(rest);
        assertAllowedFlags(parsed, new Set(["all"]));
        requireNoPositionals(parsed.positional, "/wt list [--all]");
        await listManaged(pi, registry, ctx, flagBoolean(parsed, "all"));
        return;
      }
      if (subcommand === "status") {
        const parsed = parseArgs(rest);
        assertAllowedFlags(parsed, new Set());
        requireNoPositionals(parsed.positional, "/wt status");
        await showStatus(pi, registry, ctx);
        return;
      }
      if (subcommand === "config") {
        const parsed = parseArgs(rest);
        assertAllowedFlags(parsed, new Set());
        const action = (parsed.positional[0] ?? "show") as "show" | "edit" | "export" | "reset";
        if (!["show", "edit", "export", "reset"].includes(action) || parsed.positional.length > 1) {
          throw new Error("Usage: /wt config [show|edit|export|reset]");
        }
        await manageConfig(pi, registry, ctx, action);
        return;
      }
      if (subcommand === "doctor") {
        const parsed = parseArgs(rest);
        assertAllowedFlags(parsed, new Set(["fix"]));
        requireNoPositionals(parsed.positional, "/wt doctor [--fix]");
        await doctor(pi, registry, ctx, flagBoolean(parsed, "fix"));
        return;
      }
      if (subcommand === "prune") {
        const parsed = parseArgs(rest);
        assertAllowedFlags(parsed, new Set());
        requireNoPositionals(parsed.positional, "/wt prune");
        await pruneManaged(pi, registry, ctx);
        return;
      }
      throw new Error(`Unknown /wt subcommand: ${subcommand}`);
    } catch (error) {
      ctx.ui.notify(truncateText(redactSecrets(error instanceof Error ? error.message : String(error)), 8_192), "error");
    }
  }

  const completions = (prefix: string) => {
    const commands = ["new", "finish pr", "finish merge", "adopt", "reopen", "list", "status", "config", "doctor", "prune"];
    const matching = commands.filter((command) => command.startsWith(prefix));
    return matching.length ? matching.map((value) => ({ value, label: value })) : null;
  };
  pi.registerCommand("wt", {
    description: "Create, finish, inspect, or recover managed Git worktrees",
    getArgumentCompletions: completions,
    handler: commandHandler,
  });
  pi.registerCommand("worktree", {
    description: "Alias for /wt",
    getArgumentCompletions: completions,
    handler: commandHandler,
  });

  pi.on("session_start", async (_event, ctx) => {
    tools.deactivate();
    try {
      await registry.ensure();
      const repo = await discoverRepo(pi, ctx.cwd);
      const record = await registry.findByPath(repo.root);
      if (!record) {
        ctx.ui.setStatus("pi-worktree", undefined);
        return;
      }
      const currentSessionId = ctx.sessionManager.getSessionId();
      const transactionOwnedByThisSession = !record.transaction?.sessionId || record.transaction.sessionId === currentSessionId;
      if ((record.state === "finish_active" || record.state === "publish_authorized") && transactionOwnedByThisSession) {
        const updated = await registry.update(record.id, (item) => {
          const transaction = item.transaction;
          if (transaction && transaction.id === record.transaction?.id) {
            item.state = "finish_paused";
            transaction.updatedAt = new Date().toISOString();
          }
        });
        record.state = updated.state;
      }
      const config = await loadEffectiveConfig({
        repoKey: record.repoKey,
        projectRoot: repo.root,
        projectTrusted: ctx.isProjectTrusted(),
        agentDir: registry.agentDir,
      });
      const zh = resolveLocale(config.locale) === "zh-CN";
      const warning = Boolean(record.transaction) || ["creating", "init_failed", "finish_paused", "cleanup_pending", "cleanup_scheduled", "merged_cleanup_pending"].includes(record.state);
      const status = `wt: ${record.branch} ← ${record.sourceBranch}${warning ? ` [${record.state}]` : ""}`;
      ctx.ui.setStatus("pi-worktree", warning ? ctx.ui.theme.fg("warning", status) : ctx.ui.theme.fg("accent", status));
      if (warning) {
        const recovery = record.transaction
          ? `/wt finish ${record.transaction.mode} --resume`
          : record.state === "init_failed"
            ? "/wt reopen"
            : "/wt prune";
        ctx.ui.notify(`${status}\n${zh ? "请使用" : "Use"} ${recovery}.`, "warning");
      }
    } catch {
      ctx.ui.setStatus("pi-worktree", undefined);
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    try {
      await finish.pauseCurrent(ctx.cwd, ctx.sessionManager.getSessionId());
    } catch {
      // Never prevent pi shutdown because local recovery state could not be updated.
    }
    ctx.ui.setStatus("pi-worktree", undefined);
  });
}
