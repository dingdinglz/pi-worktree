import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { discoverRepo, gitOk } from "../src/git.ts";
import { adoptWorktree } from "../src/management.ts";
import { Registry } from "../src/registry.ts";
import { executor, initRepo, run, tempDir } from "./helpers.ts";

const cleanup: string[] = [];
afterEach(async () => Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

describe("worktree adoption", () => {
  it("atomically gives a detached worktree a branch and activates its managed record", async () => {
    const root = await tempDir();
    cleanup.push(root);
    const source = join(root, "source");
    const target = join(root, "target");
    await initRepo(source);
    await writeFile(join(source, "tracked"), "base\n");
    await run("git", ["add", "."], source);
    await run("git", ["commit", "-qm", "base"], source);
    await gitOk(executor, source, ["worktree", "add", "--detach", target, "main"]);

    const answers = ["adopt detached worktree", "wt/adopted"];
    const ctx = {
      cwd: target,
      mode: "tui",
      hasUI: true,
      ui: {
        select: async (_title: string, choices: string[]) => choices[0],
        input: async () => answers.shift(),
        confirm: async () => true,
        editor: async () => undefined,
        notify: () => {},
      },
      isProjectTrusted: () => false,
      waitForIdle: async () => {},
    } as unknown as ExtensionCommandContext;
    const pi = { exec: executor.exec.bind(executor) } as unknown as ExtensionAPI;
    const registry = new Registry(join(root, "agent"));

    const adopted = await adoptWorktree(pi, registry, ctx);
    expect(adopted?.state).toBe("active");
    expect(adopted?.branch).toBe("wt/adopted");
    expect((await discoverRepo(executor, target)).branch).toBe("wt/adopted");
    expect((await registry.findByPath(target))?.id).toBe(adopted?.id);
  });
});
