import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { validateConfig } from "./config.ts";
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
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_OUTPUT_TOKENS = 16 * 1024;
const REQUEST_TIMEOUT_MS = 5 * 60_000;

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

// Only these locally generated errors may cross the provider boundary verbatim.
class SetupResponseError extends Error {}

type SetupStream = ReturnType<ExtensionContext["modelRegistry"]["streamSimple"]>;

async function assistantTextFromStream(stream: SetupStream): Promise<string> {
  for await (const event of stream) {
    const message = event.type === "done" ? event.message : event.type === "error" ? event.error : event.partial;
    // Bound the whole response, including reasoning, signatures, and unexpected tool arguments,
    // while streaming as well as at completion. Never accept just a truncated JSON prefix.
    if (Buffer.byteLength(JSON.stringify(message), "utf8") > MAX_OUTPUT_BYTES) {
      throw new SetupResponseError("AI setup request returned oversized output");
    }
    if (event.type !== "done" && event.type !== "error") continue;
    if (message.stopReason === "length") throw new SetupResponseError("AI setup response was truncated");
    if (event.type !== "done" || event.reason !== "stop" || message.stopReason !== "stop") {
      throw new SetupResponseError("AI setup request did not complete successfully");
    }
    if (message.content.some((part) => part.type === "toolCall")) {
      throw new SetupResponseError("AI setup response unexpectedly requested a tool");
    }
    const text = message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
    if (!text) throw new SetupResponseError("AI setup request returned no assistant JSON");
    return text;
  }
  throw new SetupResponseError("AI setup request ended without a complete response");
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
  ctx: ExtensionContext,
  root: string,
  signal?: AbortSignal,
): Promise<SetupProposal> {
  const model = ctx.model;
  if (!model) throw new Error("AI setup requires a selected model");
  if (typeof ctx.modelRegistry.streamSimple !== "function") {
    throw new Error("AI setup requires modelRegistry.streamSimple; update Pi to 1.3.0 or newer");
  }
  if (signal?.aborted) throw new Error("AI setup request cancelled");
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
  const controller = new AbortController();
  const cancel = () => controller.abort();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, REQUEST_TIMEOUT_MS);
  signal?.addEventListener("abort", cancel, { once: true });
  let onAbort!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new Error("AI setup request aborted"));
    controller.signal.addEventListener("abort", onAbort, { once: true });
  });
  let stream: SetupStream | undefined;
  let text: string;
  try {
    // Also enforce a deadline when a provider fails to finish or ignores cancellation.
    text = await Promise.race([(async () => {
      // Cancellation may have arrived while reading manifests. Do not dispatch in that case.
      if (signal?.aborted) cancel();
      controller.signal.throwIfAborted();
      // Use the selected object and host facade, not a provider/id reconstruction or standalone
      // pi-ai client: the runtime owns extension providers, authentication, endpoints, and routing.
      stream = ctx.modelRegistry.streamSimple(model, {
        messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
      }, {
        reasoning: ctx.thinkingLevel === "off" ? undefined : ctx.thinkingLevel,
        maxTokens: model.maxTokens > 0 ? Math.min(model.maxTokens, MAX_OUTPUT_TOKENS) : MAX_OUTPUT_TOKENS,
        signal: controller.signal,
      });
      return assistantTextFromStream(stream);
    })(), aborted]);
    controller.signal.throwIfAborted();
  } catch (error) {
    if (controller.signal.aborted) throw new Error(timedOut ? "AI setup request timed out" : "AI setup request cancelled");
    if (error instanceof SetupResponseError) throw error;
    // Provider/auth errors can contain arbitrary credentials or request payloads.
    throw new Error("AI setup request failed");
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", cancel);
    controller.signal.removeEventListener("abort", onAbort);
    controller.abort();
    stream?.end();
  }
  return parseProposal(text);
}
