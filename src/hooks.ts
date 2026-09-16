import { spawn } from "node:child_process";
import { access, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, isAbsolute, resolve } from "node:path";
import type { HookRunResult, HookStep, ManagedWorktree } from "./types.ts";
import type { Registry } from "./registry.ts";
import { formatHookCommand } from "./hook-commands.ts";
import { redactSecrets, truncateText } from "./util.ts";

const MAX_CAPTURE_BYTES = 2 * 1024 * 1024;

async function executableExists(command: string, cwd: string, environment: NodeJS.ProcessEnv): Promise<boolean> {
  const candidates = command.includes("/") || isAbsolute(command)
    ? [resolve(cwd, command)]
    : (environment.PATH ?? "")
        .split(delimiter)
        .filter(Boolean)
        .map((directory) => resolve(isAbsolute(directory) ? directory : resolve(cwd, directory), command));
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      if ((await stat(candidate)).isFile()) return true;
    } catch {
      // Try the next PATH entry.
    }
  }
  return false;
}

export function describeHookStep(step: HookStep): string {
  const command = `${step.shell ? "[shell] " : ""}${formatHookCommand(step)}`;
  const details = [
    step.timeoutMs ? `timeout=${step.timeoutMs}ms` : "timeout=900000ms",
    step.env && Object.keys(step.env).length > 0
      ? `env=${Object.keys(step.env).map((key) => `${key}=[set]`).join(",")}`
      : "",
  ].filter(Boolean).join("; ");
  return redactSecrets(`${command} (${details})`);
}

export async function assertHookCommandsAvailable(steps: HookStep[], cwd: string): Promise<void> {
  for (const [index, step] of steps.entries()) {
    const command = step.shell ? process.env.SHELL || "/bin/sh" : step.command;
    if (!(await executableExists(command, cwd, { ...process.env, ...step.env }))) {
      throw new Error(`Hook step ${index + 1} executable is unavailable: ${redactSecrets(command)}`);
    }
  }
}

interface StepResult {
  code: number;
  stdout: string;
  stderr: string;
  killed: boolean;
  aborted: boolean;
  timedOut: boolean;
}

function appendCapped(current: string, chunk: Buffer | string): string {
  const next = current + chunk.toString();
  const encoded = Buffer.from(next, "utf8");
  if (encoded.length <= MAX_CAPTURE_BYTES) return next;
  let start = encoded.length - MAX_CAPTURE_BYTES;
  while (start < encoded.length && (encoded[start] & 0xc0) === 0x80) start++;
  return `[capture capped at ${MAX_CAPTURE_BYTES} bytes]\n${encoded.subarray(start).toString("utf8")}`;
}

function terminateProcess(child: ReturnType<typeof spawn>): void {
  if (child.exitCode !== null || child.killed) return;
  try {
    if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGTERM");
    else child.kill("SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
  setTimeout(() => {
    if (child.exitCode !== null) return;
    try {
      if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
      else child.kill("SIGKILL");
    } catch {
      // Already exited.
    }
  }, 5_000).unref();
}

async function runStep(
  step: HookStep,
  cwd: string,
  environment: NodeJS.ProcessEnv,
  signal?: AbortSignal,
  onUpdate?: (tail: string) => void,
): Promise<StepResult> {
  const timeoutMs = step.timeoutMs ?? 15 * 60_000;
  let command = step.command;
  let args = step.args ?? [];
  if (step.shell) {
    const shell = process.env.SHELL || "/bin/sh";
    try {
      await access(shell);
    } catch {
      throw new Error(`Configured login shell does not exist: ${shell}`);
    }
    command = shell;
    args = ["-lc", step.command];
  }

  return new Promise<StepResult>((resolve) => {
    const reserved = Object.fromEntries(Object.entries(environment).filter(([key]) => key.startsWith("PI_WT_")));
    const child = spawn(command, args, {
      cwd,
      env: { ...environment, ...step.env, ...reserved },
      shell: false,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let aborted = false;
    let lastUpdate = 0;
    const update = () => {
      if (!onUpdate || Date.now() - lastUpdate < 100) return;
      lastUpdate = Date.now();
      onUpdate(truncateText(redactSecrets(`${stdout.slice(-8_000)}\n${stderr.slice(-8_000)}`), 4_000));
    };
    child.stdout.on("data", (chunk) => {
      stdout = appendCapped(stdout, chunk);
      update();
    });
    child.stderr.on("data", (chunk) => {
      stderr = appendCapped(stderr, chunk);
      update();
    });
    child.on("error", (error) => {
      stderr = appendCapped(stderr, error instanceof Error ? error.message : String(error));
    });
    const timeout = setTimeout(() => {
      timedOut = true;
      terminateProcess(child);
    }, timeoutMs);
    timeout.unref();
    const abort = () => {
      aborted = true;
      terminateProcess(child);
    };
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
    child.on("close", (code) => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      resolve({
        code: code ?? (aborted ? 130 : timedOut ? 124 : 1),
        stdout,
        stderr,
        killed: child.killed,
        aborted,
        timedOut,
      });
    });
  });
}

export interface HookContext {
  record: ManagedWorktree;
  mode: "create" | "pr" | "merge";
  transactionId?: string;
}

export async function runHookSteps(options: {
  registry: Registry;
  name: string;
  steps: HookStep[];
  context: HookContext;
  signal?: AbortSignal;
  onUpdate?: (message: string) => void;
}): Promise<HookRunResult> {
  if (options.steps.length === 0) return { ok: true, aborted: false, stdout: "", stderr: "" };
  let outputs = "";
  let errors = "";
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    PI_WT_PATH: options.context.record.path,
    PI_WT_SOURCE_PATH: options.context.record.sourcePath,
    PI_WT_BRANCH: options.context.record.branch,
    PI_WT_SOURCE_BRANCH: options.context.record.sourceBranch,
    PI_WT_MODE: options.context.mode,
    PI_WT_ID: options.context.record.id,
  };
  if (options.context.transactionId) environment.PI_WT_TRANSACTION_ID = options.context.transactionId;

  for (let index = 0; index < options.steps.length; index++) {
    const step = options.steps[index];
    options.onUpdate?.(`${options.name} ${index + 1}/${options.steps.length}: ${redactSecrets(step.command)}`);
    let result: StepResult;
    try {
      result = await runStep(step, options.context.record.path, environment, options.signal, (tail) => {
        options.onUpdate?.(`${options.name} ${index + 1}/${options.steps.length}\n${tail}`);
      });
    } catch (error) {
      result = {
        code: 1,
        stdout: "",
        stderr: error instanceof Error ? error.message : String(error),
        killed: false,
        aborted: options.signal?.aborted ?? false,
        timedOut: false,
      };
    }
    const header = `$ ${step.shell ? step.command : [step.command, ...(step.args ?? [])].join(" ")}`;
    outputs = appendCapped(outputs, `${header}\n${result.stdout}\n`);
    errors = appendCapped(errors, `${header}\n${result.stderr}\n`);
    const combined = redactSecrets(
      [
        `Hook: ${options.name}`,
        `Step: ${index + 1}/${options.steps.length}`,
        `Exit: ${result.code}`,
        result.timedOut ? "Timed out: yes" : "",
        result.aborted ? "Aborted: yes" : "",
        "",
        header,
        "--- stdout ---",
        result.stdout,
        "--- stderr ---",
        result.stderr,
      ]
        .filter((line) => line !== "")
        .join("\n"),
    );
    const logPath = await options.registry.writeLog(`${options.context.record.id}-${options.name}-${index + 1}`, combined);
    if (result.code !== 0 || result.aborted || result.timedOut) {
      const error = result.aborted
        ? "Hook aborted"
        : result.timedOut
          ? `Hook timed out after ${step.timeoutMs ?? 15 * 60_000}ms`
          : `Hook exited with code ${result.code}`;
      return {
        ok: false,
        aborted: result.aborted,
        step,
        stepIndex: index,
        stdout: truncateText(redactSecrets(result.stdout)),
        stderr: truncateText(redactSecrets(result.stderr)),
        logPath,
        error,
      };
    }
  }

  return {
    ok: true,
    aborted: false,
    stdout: truncateText(redactSecrets(outputs)),
    stderr: truncateText(redactSecrets(errors)),
  };
}
