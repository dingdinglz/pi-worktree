import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { getConfigPaths, saveConfig } from "../src/config.ts";
import { discoverRepo, gitOk } from "../src/git.ts";
import { reopenWorktree } from "../src/management.ts";
import { Registry } from "../src/registry.ts";
import type { ManagedWorktree } from "../src/types.ts";
import { newId, nowIso } from "../src/util.ts";
import { executor, initRepo, run, tempDir } from "./helpers.ts";

const cleanup: string[] = [];
afterEach(async () => Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

describe("PR worktree reopening", () => {
  it("checks out the retained local branch and creates a new managed record", async () => {
    const root = await tempDir();
    cleanup.push(root);
    const source = join(root, "source");
    const oldTarget = join(root, "old-target");
    await initRepo(source);
    await writeFile(join(source, "base"), "base\n");
    await run("git", ["add", "."], source);
    await run("git", ["commit", "-qm", "base"], source);
    await gitOk(executor, source, ["worktree", "add", "-b", "wt/review", oldTarget, "main"]);
    await writeFile(join(oldTarget, "feature"), "feature\n");
    await run("git", ["add", "."], oldTarget);
    await run("git", ["commit", "-qm", "feature"], oldTarget);
    const sourceRepo = await discoverRepo(executor, source);
    const oldRepo = await discoverRepo(executor, oldTarget);
    const timestamp = nowIso();
    const historicalRecord: ManagedWorktree = {
      id: newId(),
      repoId: sourceRepo.repoId,
      repoKey: sourceRepo.repoKey,
      repoCommonDir: sourceRepo.commonDir,
      path: oldRepo.root,
      branch: "wt/review",
      sourcePath: sourceRepo.root,
      sourceBranch: "main",
      sourceHead: sourceRepo.head,
      relativeCwd: "",
      task: "review",
      slug: "review",
      state: "active",
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const registry = new Registry(join(root, "agent"));
    await registry.add(historicalRecord);
    await gitOk(executor, source, ["worktree", "remove", oldTarget]);
    await registry.complete(historicalRecord.id, "pr", oldRepo.head, "https://github.com/owner/repo/pull/1");
    await saveConfig(
      getConfigPaths(sourceRepo.repoKey, sourceRepo.root, registry.agentDir).repo,
      { version: 1, worktreeRoot: join(root, "reopened"), defaults: { launch: false, missingPostCreate: "skip" } },
      "repo",
    );
    const ctx = {
      cwd: source,
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
    const pi = { exec: executor.exec.bind(executor) } as unknown as ExtensionAPI;

    const reopened = await reopenWorktree(pi, registry, ctx, historicalRecord.id);
    expect(reopened?.branch).toBe("wt/review");
    expect((await discoverRepo(executor, reopened!.path)).branch).toBe("wt/review");
    expect((await registry.findById(reopened!.id))?.state).toBe("active");
  });
});
