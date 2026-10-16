import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { collectSetupManifests, generateSetupProposal } from "../src/ai-config.ts";
import { setupMessage, setupModel, setupStream } from "./ai-fixtures.ts";
import { tempDir } from "./helpers.ts";

const cleanup: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture() {
  const root = await tempDir();
  cleanup.push(root);
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "safe-manifest", token: "github_pat_abcdefghijklmnopqrstuvwxyz123456" }));
  await writeFile(join(root, ".env"), "PRIVATE_ENV_DO_NOT_SEND");
  const streamSimple = vi.fn<ExtensionContext["modelRegistry"]["streamSimple"]>(() => setupStream());
  const getBranch = vi.fn(() => { throw new Error("PARENT_TRANSCRIPT_DO_NOT_SEND"); });
  const getSystemPrompt = vi.fn(() => "PARENT_SYSTEM_DO_NOT_SEND");
  const executeTool = vi.fn();
  const ctx = {
    model: { ...setupModel, headers: { "X-Custom-Header": "registered-header" } },
    thinkingLevel: "high", modelRegistry: { streamSimple },
    sessionManager: { getBranch }, getSystemPrompt,
    tools: [{ name: "parent-tool" }], executeTool,
  } as unknown as ExtensionContext;
  return { root, ctx, streamSimple, getBranch, getSystemPrompt, executeTool };
}

describe("AI setup manifest allowlist", () => {
  it("redacts known credentials, caps files, and refuses allowlisted symlinks", async () => {
    const root = await tempDir();
    cleanup.push(root);
    await mkdir(join(root, "project"));
    const project = join(root, "project");
    const secret = join(root, "secret.txt");
    await writeFile(secret, "DO_NOT_READ");
    await symlink(secret, join(project, "README.md"));
    await writeFile(
      join(project, "package.json"),
      JSON.stringify({ token: "github_pat_abcdefghijklmnopqrstuvwxyz123456", padding: "x".repeat(30_000) }),
    );

    const manifests = await collectSetupManifests(project);
    expect(manifests).toContain("package.json");
    expect(manifests).toContain("REDACTED");
    expect(manifests).toContain("file truncated");
    expect(manifests).not.toContain("github_pat_");
    expect(manifests).not.toContain("DO_NOT_READ");
  });
});

describe("AI setup host requests", () => {
  it("passes the exact selected model and a fresh tool-free context, never parent history or credentials", async () => {
    const f = await fixture();
    await expect(generateSetupProposal(f.ctx, f.root)).resolves.toEqual({ reason: "No setup needed", steps: [] });
    await generateSetupProposal(f.ctx, f.root);

    const [model, context, options] = f.streamSimple.mock.calls[0];
    expect(model).toBe(f.ctx.model);
    expect(f.streamSimple.mock.contexts[0]).toBe(f.ctx.modelRegistry);
    expect(Object.keys(context)).toEqual(["messages"]);
    expect(context.messages).toEqual([{ role: "user", content: expect.any(String), timestamp: expect.any(Number) }]);
    expect(context.messages[0].content).toContain("Design a conservative post-create setup hook");
    expect(context.messages[0].content).toContain("safe-manifest");
    expect(context.messages[0].content).toContain("REDACTED");
    expect(JSON.stringify(context)).not.toMatch(/PARENT_|PRIVATE_ENV|github_pat_|parent-tool|registered-header/);
    expect(options).toEqual({ reasoning: "high", maxTokens: 16_384, signal: expect.any(AbortSignal) });
    expect(f.streamSimple.mock.calls[1][1]).not.toBe(context);
    expect(f.streamSimple.mock.calls[1][1].messages).not.toBe(context.messages);
    expect(f.getBranch).not.toHaveBeenCalled();
    expect(f.getSystemPrompt).not.toHaveBeenCalled();
    expect(f.executeTool).not.toHaveBeenCalled();
  });

  it.each(["off", "low", "high", undefined] as const)("forwards selected reasoning %s", async (level) => {
    const f = await fixture();
    f.ctx.thinkingLevel = level;
    await generateSetupProposal(f.ctx, f.root);
    expect(f.streamSimple.mock.calls[0][2]?.reasoning).toBe(level === "off" ? undefined : level);
  });

  it.each([[1024, 1024], [32_768, 16_384], [0, 16_384]])("bounds maxTokens for model limit %s", async (limit, expected) => {
    const f = await fixture();
    f.ctx.model!.maxTokens = limit;
    await generateSetupProposal(f.ctx, f.root);
    expect(f.streamSimple.mock.calls[0][2]?.maxTokens).toBe(expected);
  });

  it("fails explicitly without a selected model or the required host API", async () => {
    const f = await fixture();
    f.ctx.model = undefined;
    await expect(generateSetupProposal(f.ctx, f.root)).rejects.toThrow("requires a selected model");
    expect(f.streamSimple).not.toHaveBeenCalled();
    f.ctx.model = setupModel;
    f.ctx.modelRegistry = {} as ExtensionContext["modelRegistry"];
    await expect(generateSetupProposal(f.ctx, f.root)).rejects.toThrow("update Pi to 1.3.0 or newer");
  });

  it("does not dispatch with no safe manifests", async () => {
    const f = await fixture();
    await rm(join(f.root, "package.json"));
    await expect(generateSetupProposal(f.ctx, f.root)).rejects.toThrow("No safe setup manifests");
    expect(f.streamSimple).not.toHaveBeenCalled();
  });

  it.each([false, true])("does not dispatch when cancelled before manifest collection finishes (pre-aborted: %s)", async (preAborted) => {
    const f = await fixture();
    const controller = new AbortController();
    if (preAborted) controller.abort("SECRET_ABORT_REASON");
    const request = generateSetupProposal(f.ctx, f.root, controller.signal);
    controller.abort("SECRET_ABORT_REASON");
    await expect(request).rejects.toThrow(/^AI setup request cancelled$/);
    expect(f.streamSimple).not.toHaveBeenCalled();
  });

  it.each(["cancel", "timeout"])("enforces %s even when the provider ignores its signal", async (action) => {
    const f = await fixture();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const controller = new AbortController();
    const removeListener = vi.spyOn(controller.signal, "removeEventListener");
    let started!: (signal: AbortSignal) => void;
    const entered = new Promise<AbortSignal>((resolve) => { started = resolve; });
    const stream = createAssistantMessageEventStream(); // Intentionally never emits or closes.
    const end = vi.spyOn(stream, "end");
    f.streamSimple.mockImplementation((_model, _context, options) => {
      started(options!.signal!);
      return stream;
    });
    const request = generateSetupProposal(f.ctx, f.root, controller.signal);
    const rejected = expect(request).rejects.toThrow(action === "cancel" ? /^AI setup request cancelled$/ : /^AI setup request timed out$/);
    const providerSignal = await entered;
    if (action === "cancel") controller.abort("SECRET_ABORT_REASON");
    else {
      await vi.advanceTimersByTimeAsync(5 * 60_000 - 1);
      expect(providerSignal.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
    }
    await rejected;
    expect(providerSignal.aborted).toBe(true);
    expect(end).toHaveBeenCalled();
    expect(removeListener).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cleans up the deadline and cancellation listener on success", async () => {
    const f = await fixture();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const controller = new AbortController();
    const removeListener = vi.spyOn(controller.signal, "removeEventListener");
    await generateSetupProposal(f.ctx, f.root, controller.signal);
    expect(vi.getTimerCount()).toBe(0);
    expect(removeListener).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  it.each(["throw", "iterator"])("does not expose raw provider/auth errors (%s)", async (source) => {
    const f = await fixture();
    const fail = () => { throw new Error("arbitrary-unrecognized-secret https://user:password@provider.invalid"); };
    if (source === "throw") f.streamSimple.mockImplementation(fail);
    else {
      const stream = createAssistantMessageEventStream();
      vi.spyOn(stream, Symbol.asyncIterator).mockImplementation(fail);
      f.streamSimple.mockReturnValue(stream);
    }
    await expect(generateSetupProposal(f.ctx, f.root)).rejects.toThrow(/^AI setup request failed$/);
  });

  it.each(["length", "error", "aborted", "toolUse", "pending", "deferred"] as const)("rejects stopReason %s even with valid proposal JSON", async (stopReason) => {
    const f = await fixture();
    f.streamSimple.mockReturnValue(setupStream(setupMessage({ stopReason, errorMessage: "SECRET_PROVIDER_ERROR" })));
    await expect(generateSetupProposal(f.ctx, f.root)).rejects.toThrow(
      stopReason === "length" ? /^AI setup response was truncated$/ : /^AI setup request did not complete successfully$/,
    );
  });

  it("rejects tool calls even when a provider incorrectly reports stop", async () => {
    const f = await fixture();
    f.streamSimple.mockReturnValue(setupStream(setupMessage({ content: [
      ...setupMessage().content, { type: "toolCall", id: "call", name: "parent-tool", arguments: {} },
    ] })));
    await expect(generateSetupProposal(f.ctx, f.root)).rejects.toThrow("unexpectedly requested a tool");
    expect(f.executeTool).not.toHaveBeenCalled();
    expect(f.streamSimple).toHaveBeenCalledTimes(1);
  });

  it.each(["text", "thinking", "signature"])("rejects oversized %s in UTF-8 bytes before completion and aborts the provider", async (kind) => {
    const f = await fixture();
    const huge = "界".repeat(700_000); // Under 2 Mi characters, but over 2 MiB.
    const content: AssistantMessage["content"] = kind === "text"
      ? [{ type: "text", text: huge }]
      : [{ type: "thinking", thinking: kind === "thinking" ? huge : "", thinkingSignature: kind === "signature" ? huge : undefined }];
    const stream = createAssistantMessageEventStream();
    stream.push({ type: "start", partial: setupMessage({ content, stopReason: "pending" }) });
    f.streamSimple.mockReturnValue(stream);
    await expect(generateSetupProposal(f.ctx, f.root)).rejects.toThrow(/^AI setup request returned oversized output$/);
    expect(f.streamSimple.mock.calls[0][2]?.signal?.aborted).toBe(true);
  });

  it("checks the final response size even without partial events", async () => {
    const f = await fixture();
    const stream = createAssistantMessageEventStream();
    stream.push({ type: "done", reason: "stop", message: setupMessage({ content: [{ type: "text", text: "x".repeat(2 * 1024 * 1024) }] }) });
    stream.end();
    f.streamSimple.mockReturnValue(stream);
    await expect(generateSetupProposal(f.ctx, f.root)).rejects.toThrow("oversized output");
  });

  it("rejects a stream ending without a terminal event rather than accepting a partial proposal", async () => {
    const f = await fixture();
    const stream = createAssistantMessageEventStream();
    stream.push({ type: "start", partial: setupMessage() });
    stream.end();
    f.streamSimple.mockReturnValue(stream);
    await expect(generateSetupProposal(f.ctx, f.root)).rejects.toThrow("ended without a complete response");
  });

  it("still parses fenced JSON, ignores reasoning, and validates proposals", async () => {
    const f = await fixture();
    f.streamSimple.mockReturnValueOnce(setupStream(setupMessage({ content: [
      { type: "thinking", thinking: "not proposal JSON" },
      { type: "text", text: '```json\n{"reason":"Install dependencies","steps":[{"command":"npm","args":["ci"]}]}\n```' },
    ] })));
    await expect(generateSetupProposal(f.ctx, f.root)).resolves.toEqual({
      reason: "Install dependencies", steps: [{ command: "npm", args: ["ci"] }],
    });
    f.streamSimple.mockReturnValueOnce(setupStream(setupMessage({ content: [{ type: "text", text: "not JSON" }] })));
    await expect(generateSetupProposal(f.ctx, f.root)).rejects.toThrow("did not contain valid JSON");
    f.streamSimple.mockReturnValueOnce(setupStream(setupMessage({ content: [{ type: "text", text: '{"reason":"bad","steps":[{"command":"npm","shell":true}]}' }] })));
    await expect(generateSetupProposal(f.ctx, f.root)).rejects.toThrow("cannot request shell mode");
    f.streamSimple.mockReturnValueOnce(setupStream(setupMessage({ content: [] })));
    await expect(generateSetupProposal(f.ctx, f.root)).rejects.toThrow("returned no assistant JSON");
  });
});
