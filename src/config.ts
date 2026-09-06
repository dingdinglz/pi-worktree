import { chmod, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import type {
  ConfigLayer,
  EffectiveConfig,
  HookName,
  HookSequence,
  HookStep,
  WorktreeConfig,
} from "./types.ts";
import { canonicalPath, readJsonFile, resolveConfiguredPath, writeJsonAtomic } from "./util.ts";

const HOOK_NAMES: HookName[] = ["postCreate", "preFinish", "prePr", "preMerge"];
const CONFIG_KEYS = new Set([
  "version",
  "$schema",
  "locale",
  "worktreeRoot",
  "branchPrefix",
  "launcher",
  "defaults",
  "pr",
  "hooks",
]);

export const DEFAULT_CONFIG: WorktreeConfig = {
  version: 1,
  locale: "auto",
  worktreeRoot: join(homedir(), ".pi", "worktrees"),
  branchPrefix: "wt/",
  launcher: { mode: "auto" },
  defaults: {
    draftPr: false,
    launch: true,
    missingPostCreate: "ask",
    historyRetentionDays: 30,
    logRetentionDays: 7,
  },
  pr: {},
  hooks: {},
};

export interface ConfigPaths {
  global: string;
  repo: string;
  project: string;
}

export class ConfigValidationError extends Error {
  constructor(
    message: string,
    public readonly configPath?: string,
    public readonly jsonPath = "/",
  ) {
    super(`${configPath ? `${configPath}: ` : ""}${jsonPath}: ${message}`);
    this.name = "ConfigValidationError";
  }
}

function assertObject(value: unknown, path: string, file?: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ConfigValidationError("expected an object", file, path);
  }
}

function assertKnownKeys(value: Record<string, unknown>, allowed: Set<string>, path: string, file?: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new ConfigValidationError(`unknown property ${JSON.stringify(key)}`, file, `${path}/${key}`);
  }
}

function assertOptionalString(value: unknown, path: string, file?: string): void {
  if (value !== undefined && typeof value !== "string") throw new ConfigValidationError("expected a string", file, path);
}

function validateHookStep(value: unknown, path: string, file?: string): asserts value is HookStep {
  assertObject(value, path, file);
  assertKnownKeys(value, new Set(["command", "args", "timeoutMs", "env", "shell"]), path, file);
  if (typeof value.command !== "string" || value.command.trim().length === 0 || value.command.includes("\0") || value.command.length > 8_192) {
    throw new ConfigValidationError("command must be a non-empty NUL-free string of at most 8192 characters", file, `${path}/command`);
  }
  if (value.args !== undefined && (!Array.isArray(value.args) || value.args.length > 256 ||
      value.args.some((item) => typeof item !== "string" || item.includes("\0") || item.length > 32_768))) {
    throw new ConfigValidationError("args must contain at most 256 NUL-free strings of at most 32768 characters", file, `${path}/args`);
  }
  if (
    value.timeoutMs !== undefined &&
    (typeof value.timeoutMs !== "number" || !Number.isFinite(value.timeoutMs) || !Number.isInteger(value.timeoutMs) || value.timeoutMs <= 0 || value.timeoutMs > 86_400_000)
  ) {
    throw new ConfigValidationError("timeoutMs must be between 1 and 86400000", file, `${path}/timeoutMs`);
  }
  if (value.shell !== undefined && typeof value.shell !== "boolean") {
    throw new ConfigValidationError("shell must be a boolean", file, `${path}/shell`);
  }
  if (value.shell === true && Array.isArray(value.args) && value.args.length > 0) {
    throw new ConfigValidationError("shell steps must include arguments in command, not args", file, `${path}/args`);
  }
  if (value.env !== undefined) {
    assertObject(value.env, `${path}/env`, file);
    if (Object.keys(value.env).length > 256) {
      throw new ConfigValidationError("env must contain at most 256 variables", file, `${path}/env`);
    }
    for (const [key, envValue] of Object.entries(value.env)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
        throw new ConfigValidationError("invalid environment variable name", file, `${path}/env/${key}`);
      }
      if (key.startsWith("PI_WT_")) {
        throw new ConfigValidationError("PI_WT_* variables are reserved by pi-worktree", file, `${path}/env/${key}`);
      }
      if (typeof envValue !== "string" || envValue.includes("\0") || envValue.length > 32_768) {
        throw new ConfigValidationError("environment values must be NUL-free strings of at most 32768 characters", file, `${path}/env/${key}`);
      }
    }
  }
}

function validateHookSequence(value: unknown, path: string, file?: string): asserts value is HookSequence {
  let steps: unknown;
  if (Array.isArray(value)) {
    steps = value;
  } else {
    assertObject(value, path, file);
    assertKnownKeys(value, new Set(["merge", "steps"]), path, file);
    if (value.merge !== undefined && (typeof value.merge !== "string" || !["replace", "append", "prepend"].includes(value.merge))) {
      throw new ConfigValidationError("merge must be replace, append, or prepend", file, `${path}/merge`);
    }
    steps = value.steps;
  }
  if (!Array.isArray(steps) || steps.length > 1_024) {
    throw new ConfigValidationError("steps must be an array of at most 1024 entries", file, `${path}/steps`);
  }
  steps.forEach((step, index) => validateHookStep(step, `${path}/steps/${index}`, file));
}

export function validateConfig(value: unknown, file?: string, scope?: ConfigLayer["scope"]): WorktreeConfig {
  assertObject(value, "/", file);
  assertKnownKeys(value, CONFIG_KEYS, "", file);
  if (value.version !== 1) throw new ConfigValidationError("version must be 1", file, "/version");
  assertOptionalString(value.$schema, "/$schema", file);
  if (typeof value.$schema === "string" && (value.$schema.length === 0 || value.$schema.length > 4_096 || value.$schema.includes("\0"))) {
    throw new ConfigValidationError("$schema must be a non-empty NUL-free string of at most 4096 characters", file, "/$schema");
  }
  if (value.locale !== undefined && (typeof value.locale !== "string" || !["auto", "en", "zh-CN"].includes(value.locale))) {
    throw new ConfigValidationError("locale must be auto, en, or zh-CN", file, "/locale");
  }
  assertOptionalString(value.worktreeRoot, "/worktreeRoot", file);
  if (typeof value.worktreeRoot === "string") {
    if (value.worktreeRoot.includes("\0") || value.worktreeRoot.length > 4_096) {
      throw new ConfigValidationError("worktreeRoot must be NUL-free and at most 4096 characters", file, "/worktreeRoot");
    }
    resolveConfiguredPath(value.worktreeRoot);
  }
  assertOptionalString(value.branchPrefix, "/branchPrefix", file);
  if (typeof value.branchPrefix === "string" && (value.branchPrefix.includes("..") || value.branchPrefix.includes("\0") || value.branchPrefix.length > 512)) {
    throw new ConfigValidationError("branchPrefix cannot contain '..' or NUL and must be at most 512 characters", file, "/branchPrefix");
  }

  if (value.launcher !== undefined) {
    if (scope === "project") {
      throw new ConfigValidationError("project configuration cannot define launcher", file, "/launcher");
    }
    assertObject(value.launcher, "/launcher", file);
    assertKnownKeys(value.launcher, new Set(["mode", "shell", "command"]), "/launcher", file);
    if (value.launcher.mode !== undefined && (typeof value.launcher.mode !== "string" || !["auto", "none", "custom"].includes(value.launcher.mode))) {
      throw new ConfigValidationError("mode must be auto, none, or custom", file, "/launcher/mode");
    }
    assertOptionalString(value.launcher.shell, "/launcher/shell", file);
    if (typeof value.launcher.shell === "string" && (value.launcher.shell.length === 0 || value.launcher.shell.includes("\0") || value.launcher.shell.length > 4_096)) {
      throw new ConfigValidationError("shell must be NUL-free and between 1 and 4096 characters", file, "/launcher/shell");
    }
    if (
      value.launcher.command !== undefined &&
      (!Array.isArray(value.launcher.command) || value.launcher.command.length > 256 ||
        value.launcher.command.some((item) => typeof item !== "string" || item.includes("\0") || item.length > 32_768) ||
        (value.launcher.command.length > 0 && (typeof value.launcher.command[0] !== "string" || value.launcher.command[0].trim().length === 0)))
    ) {
      throw new ConfigValidationError("command must be an argv array of at most 256 NUL-free strings with a non-empty executable", file, "/launcher/command");
    }
    if (value.launcher.mode === "custom") {
      if (!Array.isArray(value.launcher.command) || value.launcher.command.length === 0) {
        throw new ConfigValidationError("custom launcher mode requires a non-empty command argv array", file, "/launcher/command");
      }
      if (!value.launcher.command.some((item) => item.includes("{pi}")) || !value.launcher.command.includes("{piArgs}")) {
        throw new ConfigValidationError(
          "custom launcher command must include {pi} and a standalone {piArgs} token",
          file,
          "/launcher/command",
        );
      }
      const known = new Set(["path", "root", "branch", "sourcePath", "sourceBranch", "task", "pi", "piArgs"]);
      for (const item of value.launcher.command) {
        for (const match of item.matchAll(/\{([^{}]+)\}/g)) {
          if (!known.has(match[1])) throw new ConfigValidationError(`unknown launcher placeholder {${match[1]}}`, file, "/launcher/command");
          if (match[1] === "piArgs" && item !== "{piArgs}") {
            throw new ConfigValidationError("{piArgs} must be a standalone argv item", file, "/launcher/command");
          }
        }
      }
    }
  }

  if (value.defaults !== undefined) {
    assertObject(value.defaults, "/defaults", file);
    assertKnownKeys(
      value.defaults,
      new Set(["draftPr", "launch", "missingPostCreate", "historyRetentionDays", "logRetentionDays"]),
      "/defaults",
      file,
    );
    for (const key of ["draftPr", "launch"] as const) {
      if (value.defaults[key] !== undefined && typeof value.defaults[key] !== "boolean") {
        throw new ConfigValidationError("expected a boolean", file, `/defaults/${key}`);
      }
    }
    if (
      value.defaults.missingPostCreate !== undefined &&
      (typeof value.defaults.missingPostCreate !== "string" || !["ask", "skip"].includes(value.defaults.missingPostCreate))
    ) {
      throw new ConfigValidationError("must be ask or skip", file, "/defaults/missingPostCreate");
    }
    for (const key of ["historyRetentionDays", "logRetentionDays"] as const) {
      const item = value.defaults[key];
      if (item !== undefined && (typeof item !== "number" || !Number.isInteger(item) || item < 0 || item > 365_000)) {
        throw new ConfigValidationError("expected an integer between 0 and 365000", file, `/defaults/${key}`);
      }
    }
  }

  if (value.pr !== undefined) {
    assertObject(value.pr, "/pr", file);
    assertKnownKeys(value.pr, new Set(["pushRemote", "baseRepo"]), "/pr", file);
    assertOptionalString(value.pr.pushRemote, "/pr/pushRemote", file);
    assertOptionalString(value.pr.baseRepo, "/pr/baseRepo", file);
    if (typeof value.pr.pushRemote === "string" && (value.pr.pushRemote.length === 0 || value.pr.pushRemote.includes("\0") || value.pr.pushRemote.length > 1_024)) {
      throw new ConfigValidationError("pushRemote must be NUL-free and between 1 and 1024 characters", file, "/pr/pushRemote");
    }
    if (typeof value.pr.baseRepo === "string" && (value.pr.baseRepo.length === 0 || value.pr.baseRepo.includes("\0") || value.pr.baseRepo.length > 2_048)) {
      throw new ConfigValidationError("baseRepo must be NUL-free and between 1 and 2048 characters", file, "/pr/baseRepo");
    }
  }

  if (value.hooks !== undefined) {
    assertObject(value.hooks, "/hooks", file);
    assertKnownKeys(value.hooks, new Set(HOOK_NAMES), "/hooks", file);
    for (const name of HOOK_NAMES) {
      if (value.hooks[name] !== undefined) validateHookSequence(value.hooks[name], `/hooks/${name}`, file);
    }
  }

  return value as unknown as WorktreeConfig;
}

function normalizeSequence(sequence: HookSequence): { merge: "replace" | "append" | "prepend"; steps: HookStep[] } {
  if (Array.isArray(sequence)) return { merge: "replace", steps: sequence };
  return { merge: sequence.merge ?? "replace", steps: sequence.steps };
}

export function getConfigPaths(repoKey: string, projectRoot: string, agentDir = getAgentDir()): ConfigPaths {
  return {
    global: join(agentDir, "worktree.json"),
    repo: join(agentDir, "worktree", "repos", `${repoKey}.json`),
    project: join(projectRoot, CONFIG_DIR_NAME, "worktree.json"),
  };
}

export async function assertSafeProjectConfigPath(path: string): Promise<void> {
  if (basename(path) !== "worktree.json" || basename(dirname(path)) !== CONFIG_DIR_NAME) {
    throw new ConfigValidationError("unexpected project configuration path", path);
  }
  const projectRoot = await canonicalPath(dirname(dirname(path)), true);
  const expectedParent = join(projectRoot, CONFIG_DIR_NAME);
  if ((await canonicalPath(dirname(path), true)) !== expectedParent) {
    throw new ConfigValidationError("project configuration directory must not be symlink-diverted", path);
  }
}

async function loadLayer(
  scope: ConfigLayer["scope"],
  path: string,
): Promise<ConfigLayer | undefined> {
  if (scope === "project") await assertSafeProjectConfigPath(path);
  let value: unknown;
  try {
    value = await readJsonFile<unknown>(path);
  } catch (error) {
    if (error instanceof SyntaxError) throw new ConfigValidationError("invalid JSON", path);
    throw error;
  }
  if (value === undefined) return undefined;
  return { scope, path, config: validateConfig(value, path, scope) };
}

export async function loadEffectiveConfig(options: {
  repoKey: string;
  projectRoot: string;
  projectTrusted: boolean;
  agentDir?: string;
}): Promise<EffectiveConfig> {
  const paths = getConfigPaths(options.repoKey, options.projectRoot, options.agentDir);
  const layers: ConfigLayer[] = [{ scope: "defaults", config: DEFAULT_CONFIG }];
  const global = await loadLayer("global", paths.global);
  if (global) layers.push(global);
  const repo = await loadLayer("repo", paths.repo);
  if (repo) layers.push(repo);
  if (options.projectTrusted) {
    const project = await loadLayer("project", paths.project);
    if (project) layers.push(project);
  }

  const effective: EffectiveConfig = {
    version: 1,
    locale: "auto",
    worktreeRoot: join(homedir(), ".pi", "worktrees"),
    branchPrefix: "wt/",
    launcher: { mode: "auto" },
    defaults: {
      draftPr: false,
      launch: true,
      missingPostCreate: "ask",
      historyRetentionDays: 30,
      logRetentionDays: 7,
    },
    pr: {},
    hooks: { postCreate: [], preFinish: [], prePr: [], preMerge: [] },
    layers,
    provenance: Object.fromEntries(HOOK_NAMES.map((name) => [`hooks.${name}`, "built-in defaults"])),
  };

  for (const layer of layers) {
    const source = layer.path ?? "built-in defaults";
    const config = layer.config;
    if (config.locale !== undefined) {
      effective.locale = config.locale;
      effective.provenance.locale = source;
    }
    if (config.worktreeRoot !== undefined) {
      effective.worktreeRoot = resolveConfiguredPath(config.worktreeRoot);
      effective.provenance.worktreeRoot = source;
    }
    if (config.branchPrefix !== undefined) {
      effective.branchPrefix = config.branchPrefix;
      effective.provenance.branchPrefix = source;
    }
    if (config.launcher) {
      effective.launcher = { ...effective.launcher, ...config.launcher } as EffectiveConfig["launcher"];
      for (const key of Object.keys(config.launcher)) effective.provenance[`launcher.${key}`] = source;
    }
    if (config.defaults) {
      effective.defaults = { ...effective.defaults, ...config.defaults };
      for (const key of Object.keys(config.defaults)) effective.provenance[`defaults.${key}`] = source;
    }
    if (config.pr) {
      effective.pr = { ...effective.pr, ...config.pr };
      for (const key of Object.keys(config.pr)) effective.provenance[`pr.${key}`] = source;
    }
    for (const name of HOOK_NAMES) {
      const sequence = config.hooks?.[name];
      if (!sequence) continue;
      const normalized = normalizeSequence(sequence);
      const previousSource = effective.provenance[`hooks.${name}`];
      if (normalized.merge === "append") {
        effective.hooks[name] = [...effective.hooks[name], ...normalized.steps];
        effective.provenance[`hooks.${name}`] = `${previousSource} → ${source}`;
      } else if (normalized.merge === "prepend") {
        effective.hooks[name] = [...normalized.steps, ...effective.hooks[name]];
        effective.provenance[`hooks.${name}`] = `${source} → ${previousSource}`;
      } else {
        effective.hooks[name] = [...normalized.steps];
        effective.provenance[`hooks.${name}`] = source;
      }
    }
  }

  validateConfig({ version: 1, launcher: effective.launcher }, "<effective configuration>", "repo");
  return effective;
}

export async function readConfig(path: string, scope: ConfigLayer["scope"]): Promise<WorktreeConfig | undefined> {
  try {
    const value = await readJsonFile<unknown>(path);
    return value === undefined ? undefined : validateConfig(value, path, scope);
  } catch (error) {
    if (error instanceof SyntaxError) throw new ConfigValidationError("invalid JSON", path);
    throw error;
  }
}

export async function saveConfig(path: string, value: WorktreeConfig, scope: ConfigLayer["scope"]): Promise<void> {
  validateConfig(value, path, scope);
  if (scope === "project") await assertSafeProjectConfigPath(path);
  if (scope !== "project") {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await chmod(dirname(path), 0o700).catch(() => undefined);
  }
  await writeJsonAtomic(path, value, scope === "project" ? 0o644 : 0o600);
}


export function configForDisplay(config: EffectiveConfig): Record<string, unknown> {
  return {
    version: config.version,
    locale: config.locale,
    worktreeRoot: config.worktreeRoot,
    branchPrefix: config.branchPrefix,
    launcher: config.launcher,
    defaults: config.defaults,
    pr: config.pr,
    hooks: config.hooks,
    provenance: config.provenance,
  };
}
