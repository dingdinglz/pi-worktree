import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getConfigPaths, readConfig, saveConfig } from "../src/config.ts";
import { createWorktree } from "../src/create.ts";
import { discoverRepo, listWorktrees } from "../src/git.ts";
import piWorktreeExtension from "../src/index.ts";
import { Registry } from "../src/registry.ts";
import type { HookStep } from "../src/types.ts";
import * as ui from "../src/ui.ts";
import { pathExists } from "../src/util.ts";
import { executor, initRepo, run, tempDir } from "./helpers.ts";

const cleanup: string[] = [];
beforeEach(() => {
  // Run the real AI parsing and hook execution without rendering a terminal loader.
  vi.spyOn(ui, "withCancellableLoader").mockImplementation(async (_ctx, _message, task) => ({
    value: await task(new AbortController().signal), aborted: false,
  }));
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function markerStep(name: string): HookStep {
  return {
    command: process.execPath,
    args: ["-e", `require('node:fs').writeFileSync('${name}.txt', '${name}')`],
    timeoutMs: 10_000,
  };
}
const generatedSteps = [markerStep("generated")];
const editedSteps = [markerStep("edited")];

async function fixture(locale: "en" | "zh-CN" = "en", proposalSteps = generatedSteps) {
  const root = await tempDir();
  cleanup.push(root);
  const source = join(root, "source");
  const target = join(root, "target");
  await initRepo(source);
  await writeFile(join(source, "README.md"), "# Setup fixture\n");
  await run("git", ["add", "."], source);
  await run("git", ["commit", "-qm", "base"], source);
  vi.stubEnv("PI_CODING_AGENT_DIR", join(root, "agent"));
  const registry = new Registry();
  const repo = await discoverRepo(executor, source);
  const configPath = getConfigPaths(repo.repoKey, repo.root, registry.agentDir).repo;
  const initialConfig = {
    version: 1 as const, locale, worktreeRoot: join(root, "worktrees"),
    defaults: { launch: false }, hooks: { preFinish: [{ command: "git", args: ["status", "--short"] }] },
  };
  await saveConfig(configPath, initialConfig, "repo");
  const initialText = await readFile(configPath, "utf8");
  const select = vi.fn<ExtensionCommandContext["ui"]["select"]>();
  const editor = vi.fn<ExtensionCommandContext["ui"]["editor"]>();
  const confirm = vi.fn<ExtensionCommandContext["ui"]["confirm"]>().mockResolvedValue(true);
  const ctx = {
    cwd: source, mode: "tui", hasUI: true, thinkingLevel: "off",
    ui: { select, editor, confirm, custom: vi.fn().mockResolvedValue("topic"), notify: vi.fn() },
    isProjectTrusted: () => false, waitForIdle: async () => {},
  } as unknown as ExtensionCommandContext;
  const commands = new Map<string, Parameters<ExtensionAPI["registerCommand"]>[1]>();
  const exec = vi.fn<ExtensionAPI["exec"]>(async (command, args, options) => {
    if (args.includes("--no-tools")) {
      return {
        code: 0, stderr: "", killed: false,
        stdout: JSON.stringify({
          type: "message_end",
          message: { role: "assistant", content: [{ type: "text", text: JSON.stringify({
            reason: "Set up the fixture", steps: proposalSteps,
          }) }] },
        }),
      };
    }
    return executor.exec(command, args, options);
  });
  const pi = {
    exec,
    registerCommand: (name: string, command: Parameters<ExtensionAPI["registerCommand"]>[1]) => commands.set(name, command),
    registerTool: () => {}, on: () => {},
  } as unknown as ExtensionAPI;
  return {
    source, target, registry, configPath, initialConfig, initialText, ctx, pi, exec, select, editor, confirm, commands,
    create: () => createWorktree(pi, registry, ctx, { task: "topic", path: target, noLaunch: true }),
  };
}

describe("reviewing AI postCreate proposals", () => {
  it.each(["en", "zh-CN"] as const)("allows manual editing through /wt → new (%s)", async (locale) => {
    const f = await fixture(locale);
    const zh = locale === "zh-CN";
    f.select
      .mockImplementationOnce(async (_title, options) => options[0])
      .mockResolvedValueOnce(zh ? "让 AI 生成建议" : "Ask AI for a proposal")
      .mockResolvedValueOnce(zh ? "手动修改" : "Edit manually")
      .mockResolvedValueOnce(zh ? "保存并执行" : "Save and run");
    f.editor.mockImplementationOnce(async () => {
      expect(await readFile(f.configPath, "utf8")).toBe(f.initialText);
      expect(await f.registry.records()).toEqual([]);
      return JSON.stringify(editedSteps);
    });
    piWorktreeExtension(f.pi);

    await f.commands.get("wt")!.handler("", f.ctx);

    const records = await f.registry.records();
    expect(records).toHaveLength(1);
    expect(records[0].state).toBe("active");
    expect(f.editor).toHaveBeenCalledWith(expect.stringContaining("postCreate"), JSON.stringify(generatedSteps, null, 2));
    expect(f.select.mock.calls[2][0]).toContain("generated.txt");
    expect(f.select.mock.calls[3][0]).toContain("edited.txt");
    expect(f.select.mock.calls[3][0]).not.toContain("generated.txt");
    expect(f.confirm.mock.calls.at(-1)?.[1]).toContain("edited.txt");
    expect(await readConfig(f.configPath, "repo")).toEqual({
      ...f.initialConfig, hooks: { ...f.initialConfig.hooks, postCreate: { merge: "replace", steps: editedSteps } },
    });
    expect(await readFile(join(records[0].path, "edited.txt"), "utf8")).toBe("edited");
    expect(await pathExists(join(records[0].path, "generated.txt"))).toBe(false);
    expect(await pathExists(join(f.source, "edited.txt"))).toBe(false);
    expect(await pathExists(join(f.source, "generated.txt"))).toBe(false);
    expect(f.exec.mock.calls.filter(([, args]) => args.includes("--no-tools"))).toHaveLength(1);
    expect(f.ctx.ui.notify).not.toHaveBeenCalledWith(expect.anything(), "error");
  });

  it("still accepts the generated steps without editing", async () => {
    const f = await fixture();
    f.select.mockResolvedValueOnce("Ask AI for a proposal").mockResolvedValueOnce("Save and run");

    expect((await f.create())?.state).toBe("active");

    expect(f.editor).not.toHaveBeenCalled();
    expect(await readFile(join(f.target, "generated.txt"), "utf8")).toBe("generated");
    expect((await readConfig(f.configPath, "repo"))?.hooks?.postCreate).toEqual({ merge: "replace", steps: generatedSteps });
  });

  it.each([
    ["invalid JSON", "[{"],
    ["empty input", ""],
    ["a hook sequence object", '{"steps":[]}'],
    ["null", "null"],
    ["an empty command", '[{"command":""}]'],
    ["non-string arguments", '[{"command":"node","args":[1]}]'],
    ["an invalid timeout", '[{"command":"node","timeoutMs":-1}]'],
    ["reserved environment variables", '[{"command":"node","env":{"PI_WT_PATH":"spoofed"}}]'],
    ["shell mode with argv", '[{"command":"echo","shell":true,"args":["hello"]}]'],
    ["oversized input", " ".repeat(2 * 1024 * 1024 + 1)],
  ])("retains %s for correction without saving or running it", async (_description, invalid) => {
    const f = await fixture();
    f.select.mockResolvedValueOnce("Ask AI for a proposal").mockResolvedValueOnce("Edit manually").mockResolvedValueOnce("Save and run");
    f.editor.mockResolvedValueOnce(invalid).mockImplementationOnce(async () => {
      expect(await readFile(f.configPath, "utf8")).toBe(f.initialText);
      expect(await pathExists(f.target)).toBe(false);
      return JSON.stringify(editedSteps);
    });

    expect((await f.create())?.state).toBe("active");

    expect(f.editor).toHaveBeenNthCalledWith(2, expect.any(String), invalid);
    expect(f.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Invalid postCreate"), "error");
    expect(f.select.mock.calls.at(-1)?.[0]).toContain("edited.txt");
    expect(await readFile(join(f.target, "edited.txt"), "utf8")).toBe("edited");
    expect(await pathExists(join(f.target, "generated.txt"))).toBe(false);
  });

  it.each(["Skip once", "Cancel", undefined])("does not save or run edited steps when review ends with %s", async (action) => {
    const f = await fixture();
    f.select.mockResolvedValueOnce("Ask AI for a proposal").mockResolvedValueOnce("Edit manually").mockResolvedValueOnce(action);
    f.editor.mockResolvedValueOnce(JSON.stringify(editedSteps));

    const created = await f.create();

    if (action === "Skip once") expect(created?.state).toBe("active");
    else expect(created).toBeUndefined();
    expect(await readFile(f.configPath, "utf8")).toBe(f.initialText);
    expect(await listWorktrees(executor, f.source)).toHaveLength(action === "Skip once" ? 2 : 1);
    expect(await pathExists(join(f.target, "generated.txt"))).toBe(false);
    expect(await pathExists(join(f.target, "edited.txt"))).toBe(false);
    expect(f.confirm).toHaveBeenCalledTimes(action === "Skip once" ? 2 : 1);
  });

  it("returns to review with the last valid steps when editing is cancelled", async () => {
    const f = await fixture();
    f.select
      .mockResolvedValueOnce("Ask AI for a proposal")
      .mockResolvedValueOnce("Edit manually")
      .mockResolvedValueOnce("Edit manually")
      .mockResolvedValueOnce("Edit manually")
      .mockResolvedValueOnce("Save and run");
    f.editor
      .mockResolvedValueOnce(JSON.stringify(editedSteps))
      .mockResolvedValueOnce("invalid")
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined);

    expect((await f.create())?.state).toBe("active");

    expect(f.editor.mock.calls.map(([, draft]) => draft)).toEqual([
      JSON.stringify(generatedSteps, null, 2), JSON.stringify(editedSteps, null, 2),
      "invalid", JSON.stringify(editedSteps, null, 2),
    ]);
    expect(await readFile(join(f.target, "edited.txt"), "utf8")).toBe("edited");
    expect(await pathExists(join(f.target, "generated.txt"))).toBe(false);
  });

  it("allows cancelling the editor and then the entire creation", async () => {
    const f = await fixture();
    f.select.mockResolvedValueOnce("Ask AI for a proposal").mockResolvedValueOnce("Edit manually").mockResolvedValueOnce("Cancel");
    f.editor.mockResolvedValueOnce(undefined);

    expect(await f.create()).toBeUndefined();

    expect(f.select.mock.calls.at(-1)?.[0]).toContain("generated.txt");
    expect(await readFile(f.configPath, "utf8")).toBe(f.initialText);
    expect(await f.registry.records()).toEqual([]);
    expect(await pathExists(f.target)).toBe(false);
  });

  it.each([false, true])("allows editing to or from an empty step array (initially empty: %s)", async (initiallyEmpty) => {
    const steps = initiallyEmpty ? editedSteps : [];
    const f = await fixture("en", initiallyEmpty ? [] : generatedSteps);
    f.select.mockResolvedValueOnce("Ask AI for a proposal").mockResolvedValueOnce("Edit manually").mockResolvedValueOnce("Save and run");
    f.editor.mockResolvedValueOnce(JSON.stringify(steps));

    expect((await f.create())?.state).toBe("active");

    expect((await readConfig(f.configPath, "repo"))?.hooks?.postCreate).toEqual({ merge: "replace", steps });
    expect(await pathExists(join(f.target, "edited.txt"))).toBe(initiallyEmpty);
    expect(await pathExists(join(f.target, "generated.txt"))).toBe(false);
    expect(f.confirm.mock.calls.at(-1)?.[1]).toContain(initiallyEmpty ? "edited.txt" : "(none)");
  });

  it("does not execute approved edits before final worktree confirmation", async () => {
    const f = await fixture();
    f.select.mockResolvedValueOnce("Ask AI for a proposal").mockResolvedValueOnce("Edit manually").mockResolvedValueOnce("Save and run");
    f.editor.mockResolvedValueOnce(JSON.stringify(editedSteps));
    f.confirm.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    expect(await f.create()).toBeUndefined();

    expect((await readConfig(f.configPath, "repo"))?.hooks?.postCreate).toEqual({ merge: "replace", steps: editedSteps });
    expect(await f.registry.records()).toEqual([]);
    expect(await pathExists(f.target)).toBe(false);
    expect(await pathExists(join(f.source, "edited.txt"))).toBe(false);
    expect(ui.withCancellableLoader).toHaveBeenCalledTimes(1);
  });
});
