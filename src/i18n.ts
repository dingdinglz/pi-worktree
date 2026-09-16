import type { Locale } from "./types.ts";

const messages = {
  en: {
    tuiOnly: "This operation is available only in interactive TUI mode.",
    notRepo: "Current directory is not inside a Git worktree.",
    noInitialCommit: "The repository needs an initial commit before a managed worktree can be created.",
    sourceDetached: "The source checkout must be on a local branch (detached HEAD is not supported).",
    sourceOperation: "The source checkout has a Git operation in progress.",
    cancelled: "Cancelled.",
    configInvalid: "Invalid worktree configuration",
    createTitle: "Create managed worktree",
    taskPrompt: "Task description",
    taskCompletionHint: "/ commands • @ files • single line, up to 500 characters",
    taskComplete: "complete",
    taskSubmit: "submit",
    taskCancel: "cancel",
    branchPrompt: "Work branch",
    confirmCreate: "Create this worktree?",
    created: "Worktree created",
    launchFailed: "Worktree was created, but automatic launch failed.",
    noManaged: "This is not a managed worktree. Run /wt adopt first.",
    finishTitle: "Finish managed worktree",
    sourceChanged: "The source branch changed. Rebase onto the new source SHA and prepare again.",
    transactionMissing: "No matching active finish transaction exists for this worktree.",
    cleanupDeclined: "Integration is complete; worktree cleanup is pending.",
    cleanupScheduled: "Cleanup is scheduled. Pi will exit before the worktree is removed.",
    doctorTitle: "pi-worktree doctor",
    configTitle: "Effective pi-worktree configuration",
    statusTitle: "Managed worktree status",
    listTitle: "Managed worktrees",
    noEntries: "No managed worktrees found.",
    hookFailed: "A configured hook failed. The worktree was preserved.",
    prepared: "Quality gates passed. Continue with the approved PR publication plan.",
    merged: "The work branch was fast-forwarded into its recorded source checkout.",
    prVerified: "Pull request verified.",
    unknownCommand: "Unknown /wt subcommand.",
  },
  "zh-CN": {
    tuiOnly: "此操作仅能在交互式 TUI 模式中执行。",
    notRepo: "当前目录不在 Git worktree 中。",
    noInitialCommit: "仓库必须先有首次提交，才能创建受管理的 worktree。",
    sourceDetached: "来源 checkout 必须位于本地分支，不能是 detached HEAD。",
    sourceOperation: "来源 checkout 正在进行其他 Git 操作。",
    cancelled: "已取消。",
    configInvalid: "worktree 配置无效",
    createTitle: "创建受管理的 worktree",
    taskPrompt: "任务描述",
    taskCompletionHint: "/ 命令 • @ 文件 • 单行，最多 500 字符",
    taskComplete: "补全",
    taskSubmit: "提交",
    taskCancel: "取消",
    branchPrompt: "工作分支",
    confirmCreate: "创建此 worktree？",
    created: "worktree 已创建",
    launchFailed: "worktree 已创建，但自动启动失败。",
    noManaged: "当前不是受管理的 worktree，请先运行 /wt adopt。",
    finishTitle: "完成受管理的 worktree",
    sourceChanged: "来源分支发生变化，请 rebase 到新的来源 SHA 后再次 prepare。",
    transactionMissing: "当前 worktree 没有匹配的 active finish transaction。",
    cleanupDeclined: "集成已经完成，worktree 等待后续清理。",
    cleanupScheduled: "已安排清理；pi 退出后将删除 worktree。",
    doctorTitle: "pi-worktree 诊断",
    configTitle: "pi-worktree 生效配置",
    statusTitle: "受管理 worktree 状态",
    listTitle: "受管理的 worktree",
    noEntries: "没有找到受管理的 worktree。",
    hookFailed: "配置的 hook 执行失败，worktree 已保留。",
    prepared: "质量门禁已通过，请继续执行已批准的 PR 发布计划。",
    merged: "工作分支已 fast-forward 合并到记录的来源 checkout。",
    prVerified: "Pull Request 已验证。",
    unknownCommand: "未知的 /wt 子命令。",
  },
} as const;

export type MessageKey = keyof (typeof messages)["en"];

export function resolveLocale(configured: Locale | undefined, environment = process.env): "en" | "zh-CN" {
  if (configured === "en" || configured === "zh-CN") return configured;
  const raw = `${environment.LC_ALL ?? environment.LC_MESSAGES ?? environment.LANG ?? ""}`.toLowerCase();
  return raw.startsWith("zh") || raw.includes("zh_cn") ? "zh-CN" : "en";
}

export function createTranslator(locale: Locale | undefined): (key: MessageKey) => string {
  const resolved = resolveLocale(locale);
  return (key) => messages[resolved][key] ?? messages.en[key];
}
