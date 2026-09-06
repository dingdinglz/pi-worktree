import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getConfigPaths, saveConfig } from "../src/config.ts";
import { createWorktree } from "../src/create.ts";
import { currentHead, discoverRepo, listWorktrees } from "../src/git.ts";
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
  it.each([false, true])("revalidates the source before a confirmed fast-forward (branch changed: %s)", async (changeBranch) => {
    const root = await tempDir();
    cleanup.push(root);
    const source = join(root, "source");
    const remote = join(root, "remote.git");
    await initRepo(source, "develop");
    await run("git", ["commit", "--allow-empty", "-qm", "base"], source);
    await run("git", ["init", "-q", "--bare", remote]);
    await run("git", ["remote", "add", "origin", remote], source);
    await run("git", ["push", "-u", "origin", "develop"], source);
    const original = await discoverRepo(executor, source);
    await run("git", ["switch", "-c", "remote-update"], source);
    await run("git", ["commit", "--allow-empty", "-qm", "remote update"], source);
    const remoteHead = await currentHead(executor, source);
    await run("git", ["push", "origin", "HEAD:develop"], source);
    await run("git", ["switch", "develop"], source);
    const registry = new Registry(join(root, "agent"));
    await saveConfig(getConfigPaths(original.repoKey, original.root, registry.agentDir).repo, {
      version: 1, defaults: { missingPostCreate: "skip", launch: false },
    }, "repo");
    const ctx = context(source);
    ctx.ui.select = async (_title, choices) => {
      if (changeBranch) await run("git", ["switch", "-c", "unrelated"], source);
      return choices[0];
    };
    const creating = createWorktree(
      { exec: executor.exec.bind(executor) } as unknown as ExtensionAPI, registry, ctx,
      { task: "topic", path: join(root, "target"), noLaunch: true },
    );
    if (changeBranch) {
      await expect(creating).rejects.toThrow(/changed/);
      expect(await currentHead(executor, source)).toBe(original.head);
      expect(await registry.records()).toEqual([]);
    } else {
      expect((await creating)?.sourceHead).toBe(remoteHead);
      expect(await currentHead(executor, source)).toBe(remoteHead);
    }
  });

  it("creates from the clean local HEAD when the upstream branch was deleted and pruned", async () => {
    const root = await tempDir();
    cleanup.push(root);
    const source = join(root, "source");
    const remote = join(root, "remote.git");
    await initRepo(source, "develop");
    await run("git", ["commit", "--allow-empty", "-qm", "base"], source);
    await run("git", ["init", "-q", "--bare", remote]);
    await run("git", ["remote", "add", "origin", remote], source);
    await run("git", ["push", "-u", "origin", "develop"], source);
    await run("git", ["update-ref", "-d", "refs/heads/develop"], remote);
    await run("git", ["fetch", "--prune", "origin"], source);
    expect((await executor.exec("git", ["show-ref", "--verify", "refs/remotes/origin/develop"], { cwd: source })).code).not.toBe(0);
    const original = await discoverRepo(executor, source);
    expect(original.upstream?.branch).toBe("develop");
    const registry = new Registry(join(root, "agent"));
    await saveConfig(getConfigPaths(original.repoKey, original.root, registry.agentDir).repo, {
      version: 1, locale: "en", defaults: { missingPostCreate: "skip", launch: false },
    }, "repo");
    const ctx = context(source);
    ctx.ui.notify = vi.fn();
    const created = await createWorktree(
      { exec: executor.exec.bind(executor) } as unknown as ExtensionAPI, registry, ctx,
      { task: "topic", path: join(root, "target"), noLaunch: true },
    );
    expect(created?.state).toBe("active");
    expect(created?.sourceHead).toBe(original.head);
    expect(await currentHead(executor, created!.path)).toBe(original.head);
    expect(await currentHead(executor, source)).toBe(original.head);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringMatching(/upstream.*local HEAD/i), "warning");
  });

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
