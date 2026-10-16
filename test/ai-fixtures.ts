import { createAssistantMessageEventStream, type AssistantMessage, type Model } from "@earendil-works/pi-ai";

export const setupModel: Model<"anthropic-messages"> = {
  provider: "setup-custom-provider", id: "setup-model", name: "Setup model",
  api: "anthropic-messages", baseUrl: "https://setup.invalid/custom-endpoint",
  reasoning: true, input: ["text"], contextWindow: 200_000, maxTokens: 32_768,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

export function setupMessage(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: "assistant", api: setupModel.api, provider: setupModel.provider, model: setupModel.id,
    content: [{ type: "text", text: JSON.stringify({ reason: "No setup needed", steps: [] }) }],
    usage: {
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop", timestamp: Date.now(), ...overrides,
  };
}

export function setupStream(message = setupMessage()) {
  const stream = createAssistantMessageEventStream();
  stream.push({ type: "start", partial: message });
  if (message.stopReason === "error" || message.stopReason === "aborted") {
    stream.push({ type: "error", reason: message.stopReason, error: message });
  } else {
    // Permit malformed stop reasons in regression fixtures, too.
    stream.push({ type: "done", reason: "stop", message });
  }
  stream.end();
  return stream;
}
