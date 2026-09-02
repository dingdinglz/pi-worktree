export type Locale = "auto" | "en" | "zh-CN";
export type FinishMode = "pr" | "merge";
export type HookName = "postCreate" | "preFinish" | "prePr" | "preMerge";
export type HookMergeMode = "replace" | "append" | "prepend";

export interface HookStep {
  command: string;
  args?: string[];
  timeoutMs?: number;
  env?: Record<string, string>;
  shell?: boolean;
}

export interface HookSequenceObject {
  merge?: HookMergeMode;
  steps: HookStep[];
}

export type HookSequence = HookStep[] | HookSequenceObject;

export interface LauncherConfig {
  mode?: "auto" | "none" | "custom";
  shell?: string;
  command?: string[];
}

export interface DefaultsConfig {
  draftPr?: boolean;
  launch?: boolean;
  missingPostCreate?: "ask" | "skip";
  historyRetentionDays?: number;
  logRetentionDays?: number;
}

export interface PrConfig {
  pushRemote?: string;
  baseRepo?: string;
}

export interface WorktreeConfig {
  version: 1;
  $schema?: string;
  locale?: Locale;
  worktreeRoot?: string;
  branchPrefix?: string;
  launcher?: LauncherConfig;
  defaults?: DefaultsConfig;
  pr?: PrConfig;
  hooks?: Partial<Record<HookName, HookSequence>>;
}

export interface ConfigLayer {
  scope: "defaults" | "global" | "repo" | "project";
  path?: string;
  config: WorktreeConfig;
}

export interface EffectiveConfig {
  version: 1;
  locale: Locale;
  worktreeRoot: string;
  branchPrefix: string;
  launcher: Required<Pick<LauncherConfig, "mode">> & Omit<LauncherConfig, "mode">;
  defaults: Required<DefaultsConfig>;
  pr: PrConfig;
  hooks: Record<HookName, HookStep[]>;
  layers: ConfigLayer[];
  provenance: Record<string, string>;
}

export interface RemoteIdentity {
  remote: string;
  url: string;
  host: string;
  owner: string;
  repo: string;
  repoSpec: string;
}

export interface UpstreamInfo {
  remote: string;
  mergeRef: string;
  branch: string;
  short: string;
  remoteUrl?: string;
  identity?: RemoteIdentity;
}

export interface RepoInfo {
  root: string;
  gitDir: string;
  commonDir: string;
  branch: string;
  head: string;
  repoId: string;
  repoKey: string;
  identity?: RemoteIdentity;
  upstream?: UpstreamInfo;
}

export type WorktreeState =
  | "creating"
  | "active"
  | "init_failed"
  | "finish_active"
  | "finish_paused"
  | "publish_authorized"
  | "cleanup_pending"
  | "cleanup_scheduled"
  | "merged_cleanup_pending";

export type TransactionPhase =
  | "agent_prepare"
  | "publish_authorized"
  | "awaiting_cleanup"
  | "cleanup_scheduled";

export interface PrPlan {
  host: string;
  baseRepo: string;
  baseRemote: string;
  baseBranch: string;
  pushRemote: string;
  pushRepo?: string;
  headBranch: string;
  headOwner?: string;
  existingUrl?: string;
  existingIsDraft?: boolean;
  needsReopen?: boolean;
  expectedRemoteSha?: string;
  forceLeaseSha?: string;
  title?: string;
  body?: string;
  bodyFile?: string;
  draft?: boolean;
}

export interface FinishTransaction {
  id: string;
  mode: FinishMode;
  phase: TransactionPhase;
  sourceHead: string;
  workHead?: string;
  sessionId?: string;
  startedAt: string;
  updatedAt: string;
  pr?: PrPlan;
  mergedHead?: string;
  cleanupResult?: WorktreeHistoryEntry["result"];
  cleanupAttemptId?: string;
}

export interface ManagedWorktree {
  id: string;
  repoId: string;
  repoKey: string;
  repoCommonDir: string;
  repoIdentity?: RemoteIdentity;
  path: string;
  branch: string;
  sourcePath: string;
  sourceBranch: string;
  sourceHead: string;
  relativeCwd: string;
  task: string;
  slug: string;
  state: WorktreeState;
  createdAt: string;
  updatedAt: string;
  initError?: string;
  transaction?: FinishTransaction;
  prUrl?: string;
}

export interface WorktreeHistoryEntry {
  id: string;
  repoId: string;
  repoKey: string;
  repoCommonDir: string;
  repoIdentity?: RemoteIdentity;
  path: string;
  branch: string;
  sourcePath: string;
  sourceBranch: string;
  sourceHead: string;
  finalHead: string;
  task: string;
  slug: string;
  result: "pr" | "merged" | "already_integrated";
  prUrl?: string;
  completedAt: string;
}

export interface RegistryData {
  version: 1;
  worktrees: ManagedWorktree[];
  history: WorktreeHistoryEntry[];
}

export interface GitWorktreeEntry {
  path: string;
  head: string;
  branch?: string;
  detached: boolean;
  bare: boolean;
  prunable?: string;
  locked?: string;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
  code: number;
  killed?: boolean;
}

export interface HookRunResult {
  ok: boolean;
  aborted: boolean;
  step?: HookStep;
  stepIndex?: number;
  stdout: string;
  stderr: string;
  logPath?: string;
  error?: string;
}

export interface LaunchPlan {
  command: string;
  args: string[];
  cwd: string;
  description: string;
  manualCommand: string;
}
