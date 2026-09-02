import { spawn } from "node:child_process";
import { accessSync, constants, existsSync, statSync } from "node:fs";
import { basename, delimiter, isAbsolute, join, resolve } from "node:path";
import type { EffectiveConfig, LaunchPlan, ManagedWorktree } from "./types.ts";
import { shellQuote } from "./util.ts";

interface PiInvocation {
  command: string;
  args: string[];
}

export interface LauncherContext {
  record: ManagedWorktree;
  config: EffectiveConfig;
  cwd: string;
  model?: string;
  thinking?: string;
  environment?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}

export function getPiInvocation(args: string[]): PiInvocation {
  const currentScript = process.argv[1];
  const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
  if (currentScript && !isBunVirtualScript && existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }
  const execName = basename(process.execPath).toLowerCase();
  const genericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
  return genericRuntime ? { command: "pi", args } : { command: process.execPath, args };
}

export function buildPiArgs(context: LauncherContext): string[] {
  const metadata = [
    `Task: ${context.record.task}`,
    "",
    "You are working in a managed Git worktree.",
    `Work branch: ${context.record.branch}`,
    `Recorded source branch: ${context.record.sourceBranch}`,
    `Recorded source SHA: ${context.record.sourceHead}`,
    "Do not modify the source checkout directly. When the task is ready, use /wt finish pr or /wt finish merge.",
  ].join("\n");
  const args = ["--name", context.record.task.slice(0, 80)];
  if (context.model) args.push("--model", context.model);
  if (context.thinking) args.push("--thinking", context.thinking);
  args.push(metadata);
  return args;
}

function isExecutable(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function executableOnPath(command: string, environment: NodeJS.ProcessEnv, cwd = process.cwd()): boolean {
  if (command.includes("/") || isAbsolute(command)) return isExecutable(isAbsolute(command) ? command : resolve(cwd, command));
  return (environment.PATH ?? "")
    .split(delimiter)
    .filter(Boolean)
    .some((directory) => isExecutable(join(isAbsolute(directory) ? directory : resolve(cwd, directory), command)));
}

function replacePlaceholders(value: string, context: LauncherContext, invocation: PiInvocation): string {
  const replacements: Record<string, string> = {
    "{path}": context.cwd,
    "{root}": context.record.path,
    "{branch}": context.record.branch,
    "{sourcePath}": context.record.sourcePath,
    "{sourceBranch}": context.record.sourceBranch,
    "{task}": context.record.task,
    "{pi}": invocation.command,
  };
  let result = value;
  for (const [placeholder, replacement] of Object.entries(replacements)) result = result.replaceAll(placeholder, replacement);
  return result;
}

function customPlan(
  context: LauncherContext,
  invocation: PiInvocation,
  manualCommand: string,
  environment: NodeJS.ProcessEnv,
): LaunchPlan | undefined {
  const template = context.config.launcher.command;
  if (!template || template.length === 0) return undefined;
  const expanded: string[] = [];
  for (const item of template) {
    if (item === "{piArgs}") expanded.push(...invocation.args);
    else expanded.push(replacePlaceholders(item, context, invocation));
  }
  const [command, ...args] = expanded;
  if (!command) return undefined;
  if (!executableOnPath(command, environment, context.cwd)) {
    throw new Error(`Configured launcher executable is unavailable: ${command}`);
  }
  return { command, args, cwd: context.cwd, description: "custom launcher", manualCommand };
}

const APPLE_TERMINAL_SCRIPT = `
on run argv
  set launchCommand to item 1 of argv
  tell application "Terminal"
    activate
    if (count of windows) is 0 then
      do script launchCommand
    else
      tell application "System Events" to keystroke "t" using command down
      delay 0.2
      do script launchCommand in selected tab of front window
    end if
  end tell
end run`;

const ITERM_SCRIPT = `
on run argv
  set launchCommand to item 1 of argv
  tell application "iTerm"
    activate
    if (count of windows) is 0 then
      set newWindow to (create window with default profile)
      tell current session of newWindow to write text launchCommand
    else
      tell current window
        set newTab to (create tab with default profile)
        tell current session of newTab to write text launchCommand
      end tell
    end if
  end tell
end run`;

export function buildLaunchPlan(context: LauncherContext): LaunchPlan | undefined {
  const environment = context.environment ?? process.env;
  const platform = context.platform ?? process.platform;
  const piArgs = buildPiArgs(context);
  const invocation = getPiInvocation(piArgs);
  const inner = `cd ${shellQuote(context.cwd)} && exec ${[invocation.command, ...invocation.args].map(shellQuote).join(" ")}`;
  const manualCommand = inner.replace(/^cd /, "cd ");
  if (context.config.launcher.mode === "none" || !context.config.defaults.launch) return undefined;
  if (context.config.launcher.mode === "custom") return customPlan(context, invocation, manualCommand, environment);

  const requestedShell = context.config.launcher.shell || environment.SHELL || "/bin/sh";
  if (context.config.launcher.shell && !executableOnPath(requestedShell, environment, context.cwd)) {
    throw new Error(`Configured launcher shell is unavailable: ${requestedShell}`);
  }
  const shell = executableOnPath(requestedShell, environment, context.cwd) ? requestedShell : "/bin/sh";
  if (environment.SSH_CONNECTION || environment.SSH_TTY || environment.WSL_DISTRO_NAME || environment.WSL_INTEROP) {
    return undefined;
  }
  if (environment.TMUX && executableOnPath("tmux", environment)) {
    return {
      command: "tmux",
      args: ["new-window", "-c", context.cwd, shell, "-lic", inner],
      cwd: context.cwd,
      description: "tmux window",
      manualCommand,
    };
  }

  const term = `${environment.TERM_PROGRAM ?? ""} ${environment.TERMINAL_EMULATOR ?? ""}`.toLowerCase();
  if (term.includes("vscode") || term.includes("cursor")) return undefined;

  if (platform === "darwin") {
    if ((term.includes("iterm") || environment.ITERM_SESSION_ID) && executableOnPath("osascript", environment)) {
      return {
        command: "osascript",
        args: ["-e", ITERM_SCRIPT, inner],
        cwd: context.cwd,
        description: "iTerm2 tab",
        manualCommand,
      };
    }
    if ((term.includes("apple_terminal") || term.includes("apple terminal")) && executableOnPath("osascript", environment)) {
      return {
        command: "osascript",
        args: ["-e", APPLE_TERMINAL_SCRIPT, inner],
        cwd: context.cwd,
        description: "Apple Terminal tab",
        manualCommand,
      };
    }
  }

  if ((term.includes("wezterm") || environment.WEZTERM_PANE) && executableOnPath("wezterm", environment)) {
    return {
      command: "wezterm",
      args: ["cli", "spawn", "--cwd", context.cwd, "--", shell, "-lic", inner],
      cwd: context.cwd,
      description: "WezTerm tab",
      manualCommand,
    };
  }
  if ((term.includes("kitty") || environment.KITTY_WINDOW_ID) && executableOnPath("kitty", environment)) {
    return {
      command: "kitty",
      args: ["@", "launch", "--type=tab", `--cwd=${context.cwd}`, shell, "-lic", inner],
      cwd: context.cwd,
      description: "Kitty tab",
      manualCommand,
    };
  }
  if ((term.includes("ghostty") || environment.GHOSTTY_RESOURCES_DIR) && executableOnPath("ghostty", environment)) {
    return {
      command: "ghostty",
      args: ["+new-window", `--working-directory=${context.cwd}`, "-e", shell, "-lic", inner],
      cwd: context.cwd,
      description: "Ghostty window",
      manualCommand,
    };
  }
  if (platform === "linux" && (term.includes("gnome") || environment.GNOME_TERMINAL_SCREEN) && executableOnPath("gnome-terminal", environment)) {
    return {
      command: "gnome-terminal",
      args: ["--tab", `--working-directory=${context.cwd}`, "--", shell, "-lic", inner],
      cwd: context.cwd,
      description: "GNOME Terminal tab",
      manualCommand,
    };
  }
  if (platform === "linux" && (term.includes("konsole") || environment.KONSOLE_VERSION) && executableOnPath("konsole", environment)) {
    return {
      command: "konsole",
      args: ["--new-tab", "--workdir", context.cwd, "-e", shell, "-lic", inner],
      cwd: context.cwd,
      description: "Konsole tab",
      manualCommand,
    };
  }
  return undefined;
}

export function manualLaunchCommand(context: LauncherContext): string {
  const invocation = getPiInvocation(buildPiArgs(context));
  return `cd ${shellQuote(context.cwd)} && exec ${[invocation.command, ...invocation.args].map(shellQuote).join(" ")}`;
}

export async function executeLaunchPlan(plan: LaunchPlan): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(plan.command, plan.args, {
      cwd: plan.cwd,
      detached: true,
      stdio: "ignore",
      shell: false,
    });
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else {
        child.unref();
        resolve();
      }
    };
    child.once("error", finish);
    child.once("spawn", () => setTimeout(() => finish(), 250));
    child.once("exit", (code) => {
      if (code && code !== 0) finish(new Error(`${plan.description} exited with code ${code}`));
      else finish();
    });
  });
}
