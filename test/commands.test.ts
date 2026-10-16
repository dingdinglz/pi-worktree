import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FinishCoordinator } from "../src/finish.ts";
import piWorktreeExtension from "../src/index.ts";

afterEach(() => vi.restoreAllMocks());

function harness() {
  const commands = new Map<string, Parameters<ExtensionAPI["registerCommand"]>[1]>();
  piWorktreeExtension({
    registerCommand: (name: string, command: Parameters<ExtensionAPI["registerCommand"]>[1]) => commands.set(name, command),
    registerTool() {},
    on() {},
  } as unknown as ExtensionAPI);
  const ctx = {
    ui: {
      notify: vi.fn(),
      select: vi.fn(async (_title: string, choices: string[]) => choices.find((choice) => choice.startsWith("cleanup — "))),
    },
  } as unknown as ExtensionCommandContext;
  return { commands, ctx };
}

describe("cleanup command", () => {
  it.each(["wt", "worktree"])("routes /%s cleanup and exposes completion", async (name) => {
    const cleanup = vi.spyOn(FinishCoordinator.prototype, "cleanupCurrent").mockResolvedValue(undefined);
    const { commands, ctx } = harness();
    const command = commands.get(name)!;
    expect(command.getArgumentCompletions!("cle")).toEqual([{ value: "cleanup", label: "cleanup" }]);
    await command.handler("cleanup", ctx);
    expect(cleanup).toHaveBeenCalledWith(ctx);
    expect(ctx.ui.notify).not.toHaveBeenCalled();
  });

  it("offers cleanup in the guided menu", async () => {
    const cleanup = vi.spyOn(FinishCoordinator.prototype, "cleanupCurrent").mockResolvedValue(undefined);
    const { commands, ctx } = harness();
    await commands.get("wt")!.handler("", ctx);
    expect(cleanup).toHaveBeenCalledWith(ctx);
  });

  it.each(["cleanup other-worktree", "cleanup --force", "cleanup --yes"])("rejects unsupported arguments: %s", async (args) => {
    const cleanup = vi.spyOn(FinishCoordinator.prototype, "cleanupCurrent").mockResolvedValue(undefined);
    const { commands, ctx } = harness();
    await commands.get("wt")!.handler(args, ctx);
    expect(cleanup).not.toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.any(String), "error");
  });
});
