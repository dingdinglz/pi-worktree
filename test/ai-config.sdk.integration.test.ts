import { rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingHttpHeaders } from "node:http";
import { join } from "node:path";
import { InMemoryCredentialStore, InMemoryModelsStore, type Model, type SimpleStreamOptions, type TranscriptContext } from "@earendil-works/pi-ai";
import { streamSimple as streamOpenAI } from "@earendil-works/pi-ai/api/openai-completions";
import {
  createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
  type ModelRouteRequest,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { generateSetupProposal } from "../src/ai-config.ts";
import { setupModel } from "./ai-fixtures.ts";
import { tempDir } from "./helpers.ts";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const clean of cleanup.splice(0).reverse()) await clean();
  vi.unstubAllEnvs();
});

describe("AI setup through the real Pi SDK runtime", () => {
  it.each([false, true])("retains extension provider, auth and HTTP endpoint (virtual selection: %s)", async (virtual) => {
    // No real credentials, external network, user extensions, or persistent sessions.
    vi.stubEnv("PI_OFFLINE", "1");
    const root = await tempDir();
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "sdk-manifest", token: "github_pat_abcdefghijklmnopqrstuvwxyz123456" }));
    await writeFile(join(root, ".env"), "PRIVATE_ENV_DO_NOT_SEND");
    const requests: Array<{ url: string | undefined; headers: IncomingHttpHeaders; body: Record<string, unknown> }> = [];
    const proposal = { reason: "SDK fixture proposal", steps: [{ command: "npm", args: ["ci"] }] };
    const server = createServer(async (request, response) => {
      let text = "";
      for await (const chunk of request) text += chunk.toString();
      requests.push({ url: request.url, headers: request.headers, body: JSON.parse(text) });
      response.writeHead(200, { "content-type": "text/event-stream" });
      const chunk = (delta: object, finishReason: string | null) => ({
        id: "setup-response", object: "chat.completion.chunk", created: 1, model: setupModel.id,
        choices: [{ index: 0, delta, finish_reason: finishReason }],
      });
      response.write(`data: ${JSON.stringify(chunk({ role: "assistant", content: JSON.stringify(proposal) }, null))}\n\n`);
      response.write(`data: ${JSON.stringify(chunk({}, "stop"))}\n\n`);
      response.end("data: [DONE]\n\n");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanup.push(() => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeAllConnections();
    }));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing test endpoint");
    const endpoint = `http://127.0.0.1:${address.port}/extension-endpoint/v1`;
    const physical: Model<"openai-completions"> = {
      ...setupModel, api: "openai-completions", baseUrl: endpoint, maxTokens: 2048,
      compat: { supportsReasoningEffort: true, maxTokensField: "max_tokens" },
    };
    const providerCalls: Array<{ model: Model<"openai-completions">; context: TranscriptContext; options?: SimpleStreamOptions }> = [];
    const routes: ModelRouteRequest[] = [];
    const agentDir = join(root, "agent");
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
    const modelRuntime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(), modelsPath: null, modelsStore: new InMemoryModelsStore(),
      refreshOnCreate: false, allowModelNetwork: false,
    });
    const resourceLoader = new DefaultResourceLoader({
      cwd: root, agentDir, settingsManager,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      systemPrompt: "PARENT_SYSTEM_DO_NOT_SEND",
      extensionFactories: [(pi) => {
        pi.registerProvider(physical.provider, {
          api: physical.api, baseUrl: endpoint, apiKey: "test-only-provider-key",
          headers: { "X-Setup-Extension": "registered" }, models: [physical],
          streamSimple(model, context, options) {
            // This is a real extension provider handler, reached via ModelRegistry -> ModelRuntime.
            // Delegate to the actual wire adapter so the server verifies endpoint/auth/payload too.
            const target = model as Model<"openai-completions">;
            providerCalls.push({ model: target, context, options });
            return streamOpenAI(target, context, options);
          },
        });
        pi.registerVirtualModel({
          provider: "setup-router", id: "auto", name: "Setup router", thinkingLevels: ["off", "high"],
          route(request, ctx) {
            routes.push(request);
            return { model: ctx.modelRegistry.find(physical.provider, physical.id)!, thinkingLevel: "low" };
          },
        });
      }],
    });
    await resourceLoader.reload();
    const sessionManager = SessionManager.inMemory(root);
    sessionManager.appendMessage({ role: "user", content: "PARENT_TRANSCRIPT_DO_NOT_SEND", timestamp: Date.now() });
    const { session, extensionsResult } = await createAgentSession({
      cwd: root, agentDir, modelRuntime, resourceLoader, sessionManager, settingsManager,
      model: physical, thinkingLevel: "high", tools: ["read"],
    });
    cleanup.push(() => session.dispose());
    expect(extensionsResult.errors).toEqual([]);
    await session.bindExtensions({ mode: "json" });
    await modelRuntime.refresh({ allowNetwork: false });
    const selected = modelRuntime.getModel(virtual ? "setup-router" : physical.provider, virtual ? "auto" : physical.id)!;
    expect(selected).toBeDefined();
    await session.setModel(selected);
    session.setThinkingLevel("high");
    const ctx = session.extensionRunner.createContext();
    expect(ctx.model).toBe(session.model);
    expect(session.getActiveToolNames()).toContain("read");
    expect(JSON.stringify(session.messages)).toContain("PARENT_TRANSCRIPT_DO_NOT_SEND");
    const before = JSON.stringify({ messages: session.messages, entries: sessionManager.getBranch() });
    const events: string[] = [];
    session.subscribe((event) => events.push(event.type));

    await expect(generateSetupProposal(ctx, root)).resolves.toEqual(proposal);

    expect(providerCalls).toHaveLength(1);
    expect(providerCalls[0].model).toMatchObject({ provider: physical.provider, id: physical.id, baseUrl: endpoint });
    expect(providerCalls[0].options).toMatchObject({ apiKey: "test-only-provider-key", reasoning: virtual ? "low" : "high", maxTokens: 2048 });
    expect(providerCalls[0].context.messages).toEqual([{ role: "user", content: expect.any(String), timestamp: expect.any(Number) }]);
    expect(routes).toHaveLength(virtual ? 1 : 0);
    if (virtual) {
      expect(routes[0]).toMatchObject({ reason: "direct", model: selected, thinkingLevel: "high" });
      expect(routes[0].previous).toBeUndefined();
      expect(routes[0].state).toBeUndefined();
      expect(routes[0].messages).toEqual(providerCalls[0].context.messages);
    }
    expect(requests).toHaveLength(1);
    const request = requests[0];
    expect(request.url).toBe("/extension-endpoint/v1/chat/completions");
    expect(request.headers.authorization).toBe("Bearer test-only-provider-key");
    expect(request.headers["x-setup-extension"]).toBe("registered");
    expect(request.body).toMatchObject({ model: physical.id, max_tokens: 2048, reasoning_effort: virtual ? "low" : "high" });
    expect(request.body.tools).toBeUndefined();
    expect(request.body.messages).toEqual([{ role: "user", content: expect.any(String) }]);
    expect(JSON.stringify(request.body)).toContain("sdk-manifest");
    expect(JSON.stringify(request.body)).toContain("REDACTED");
    expect(JSON.stringify(request.body)).not.toMatch(/PARENT_|PRIVATE_ENV|github_pat_|test-only-provider-key/);
    expect(JSON.stringify({ messages: session.messages, entries: sessionManager.getBranch() })).toBe(before);
    expect(session.model).toBe(selected);
    expect(events).toEqual([]); // No agent loop, tool execution, or appended messages.
  });
});
