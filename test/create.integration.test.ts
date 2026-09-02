import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { getConfigPaths, saveConfig } from "../src/config.ts";
import { createWorktree } from "../src/create.ts";
import { discoverRepo, listWorktrees } from "../src/git.ts";
import { Registry } from "../src/registry.ts";
import { pathExists } from "../src/util.ts";
import { executor, initRepo, run, tempDir } from "./helpers.ts";

const cleanup: string[] = [];
afterEach(async () => Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

function context(cwd: string): ExtensionCommandContext {
  return {
    cwd,
    mode: "tui",
    hasUI: true,
    model: undefined,
    thinkingLevel: "off",
    ui: {
      confirm: async () => true,
      select: async () => undefined,
      input: async () => undefined,
      editor: async () => undefined,
      notify: () => {},
    },
    isProjectTrusted: () => false,
    waitForIdle: async () => {},
  } as unknown as ExtensionCommandContext;
}

describe("managed worktree creation", () => {
  it("records the exact source path, branch and SHA", async () => {
    const root = await tempDir();
    cleanup.push(root);
    const source = join(root, "a");
    const target = join(root, "worktrees", "topic");
    await initRepo(source, "develop");
    await writeFile(join(source, "base"), "base\n");
    await run("git", ["add", "."], source);
    await run("git", ["commit", "-qm", "base"], source);
    const sourceRepo = await discoverRepo(executor, source);
    const registry = new Registry(join(root, "agent"));
    const paths = getConfigPaths(sourceRepo.repoKey, sourceRepo.root, registry.agentDir);
    await saveConfig(paths.repo, { version: 1, defaults: { missingPostCreate: "skip", launch: false } }, "repo");

    const record = await createWorktree(
      { exec: executor.exec.bind(executor) } as unknown as ExtensionAPI,
      registry,
      context(source),
      { task: "topic", path: target, noLaunch: true },
    );

    expect(record?.state).toBe("active");
    expect(record?.sourcePath).toBe(sourceRepo.root);
    expect(record?.sourceBranch).toBe("develop");
    expect(record?.sourceHead).toBe(sourceRepo.head);
    expect((await registry.findByPath(target))?.branch).toBe("wt/topic");
    expect(await pathExists(join((await discoverRepo(executor, target)).gitDir, "pi-worktree.json"))).toBe(true);
    expect((await listWorktrees(executor, source)).some((item) => item.branch === "wt/topic")).toBe(true);
  });
});
