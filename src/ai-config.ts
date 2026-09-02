import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { validateConfig } from "./config.ts";
import { getPiInvocation } from "./launcher.ts";
import type { HookStep, WorktreeConfig } from "./types.ts";
import { redactSecrets } from "./util.ts";

const ALLOWED_FILES = [
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  "pyproject.toml",
  "poetry.lock",
  "uv.lock",
  "requirements.txt",
  "Pipfile",
  "Gemfile",
  "Gemfile.lock",
  "go.mod",
  "go.sum",
  "Cargo.toml",
  "Cargo.lock",
  "composer.json",
  "Makefile",
  "mise.toml",
  ".tool-versions",
  ".node-version",
  ".python-version",
  "README.md",
  "README.rst",
  "README.txt",
];
const MAX_FILE_BYTES = 24 * 1024;
const MAX_TOTAL_BYTES = 120 * 1024;

export interface SetupProposal {
  reason: string;
  steps: HookStep[];
}

export async function collectSetupManifests(root: string): Promise<string> {
  const canonicalRoot = await realpath(root);
  const sections: string[] = [];
  let total = 0;
  for (const name of ALLOWED_FILES) {
    const path = join(canonicalRoot, name);
    try {
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink()) continue;
      const canonical = await realpath(path);
      const rel = relative(canonicalRoot, canonical);
      if (rel.startsWith(`..${sep}`) || rel === "..") continue;
      const handle = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      let value: string;
      try {
        if (!(await handle.stat()).isFile()) continue;
        const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        value = redactSecrets(buffer.subarray(0, Math.min(bytesRead, MAX_FILE_BYTES)).toString("utf8"));
        if (bytesRead > MAX_FILE_BYTES) value = `${value}\n[file truncated]`;
      } finally {
        await handle.close();
      }
      const section = `--- ${name} ---\n${value}`;
      if (total + Buffer.byteLength(section, "utf8") > MAX_TOTAL_BYTES) break;
      sections.push(section);
      total += Buffer.byteLength(section, "utf8");
    } catch {
      // Missing, binary, or inaccessible allowlisted file.
    }
  }
  return sections.join("\n\n");
}

function assistantTextFromJsonEvents(output: string): string {
  if (Buffer.byteLength(output, "utf8") > 2 * 1024 * 1024) throw new Error("AI setup process returned oversized output");
  let final = "";
  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as {
        type?: string;
        message?: { role?: string; content?: Array<{ type?: string; text?: string }> };
      };
      if (event.type !== "message_end" || event.message?.role !== "assistant") continue;
      const text = event.message.content
        ?.filter((part) => part.type === "text" && typeof part.text === "string")
        .map((part) => part.text)
        .join("\n");
      if (text) final = text;
    } catch {
      // Ignore non-event output; stderr is reported separately.
    }
  }
  return final;
}

function parseProposal(text: string): SetupProposal {
  const unfenced = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  let parsed: unknown;
  try {
    parsed = JSON.parse(unfenced) as unknown;
  } catch {
    throw new Error("AI proposal did not contain valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("AI proposal is not an object");
  const record = parsed as Record<string, unknown>;
  if (typeof record.reason !== "string" || !Array.isArray(record.steps)) {
    throw new Error("AI proposal must contain reason and steps");
  }
  if (record.reason.length > 2_000 || /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(record.reason) || record.steps.length > 20) {
    throw new Error("AI proposal exceeds safe review limits or contains unsafe control characters");
  }
  const candidate: WorktreeConfig = { version: 1, hooks: { postCreate: record.steps as HookStep[] } };
  validateConfig(candidate, "<AI proposal>", "repo");
  for (const step of record.steps as HookStep[]) {
    if (step.command.length > 2_000 || (step.args ?? []).some((arg) => arg.length > 8_000)) {
      throw new Error("AI proposal contains an oversized command or argument");
    }
    if (step.shell) throw new Error("AI proposals cannot request shell mode");
    if (step.env && Object.keys(step.env).some((key) => /token|secret|password|key/i.test(key))) {
      throw new Error("AI proposal attempted to define a potentially sensitive environment variable");
    }
  }
  return { reason: redactSecrets(record.reason), steps: record.steps as HookStep[] };
}

export async function generateSetupProposal(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  root: string,
  signal?: AbortSignal,
): Promise<SetupProposal> {
  const manifests = await collectSetupManifests(root);
  if (!manifests) throw new Error("No safe setup manifests were found for AI inspection");
  const prompt = [
    "Design a conservative post-create setup hook for a Git worktree.",
    "You have only the allowlisted project manifests below. Do not assume access to .env, credentials, or other files.",
    "Return exactly one JSON object, with no Markdown:",
    '{"reason":"short explanation","steps":[{"command":"executable","args":["arg"],"timeoutMs":900000}]}',
    "Use argv steps only. Never set shell=true. Never copy secrets. Prefer the package manager proven by the lockfile.",
    "Use an empty steps array when no setup command is needed.",
    "",
    manifests,
  ].join("\n");
  const args = [
    "--mode",
    "json",
    "-p",
    "--no-session",
    "--no-tools",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-context-files",
  ];
  if (ctx.model) args.push("--model", `${ctx.model.provider}/${ctx.model.id}`);
  if (ctx.thinkingLevel) args.push("--thinking", ctx.thinkingLevel);
  args.push("--", prompt);
  const invocation = getPiInvocation(args);
  const result = await pi.exec(invocation.command, invocation.args, { cwd: resolve(root), timeout: 5 * 60_000, signal });
  if (result.code !== 0) {
    const stderr = result.stderr.slice(-64 * 1024);
    throw new Error(redactSecrets(stderr.trim()) || `AI setup process exited with ${result.code}`);
  }
  const text = assistantTextFromJsonEvents(result.stdout);
  if (!text) throw new Error("AI setup process returned no assistant JSON");
  return parseProposal(text);
}
