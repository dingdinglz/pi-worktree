import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getConfigPaths, saveConfig } from "../src/config.ts";
import { createWorktree } from "../src/create.ts";
import { currentHead, discoverRepo, listWorktrees, statusEntries } from "../src/git.ts";
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
  it.each([
    { timing: "before creation", allowDirty: undefined },
    { timing: "before creation", allowDirty: false },
    { timing: "before creation", allowDirty: true },
    { timing: "during confirmation", allowDirty: undefined },
  ])("leaves source changes untouched and creates a clean worktree ($timing; allowDirty: $allowDirty)", async ({ timing, allowDirty }) => {
    const root = await tempDir();
    cleanup.push(root);
    const source = join(root, "source");
    const target = join(root, "target");
    await initRepo(source, "develop");
    const committedFiles = { tracked: "base\n", deleted: "keep me\n", renamed: "rename me\n", ".gitignore": "ignored\n" };
    for (const [name, content] of Object.entries(committedFiles)) await writeFile(join(source, name), content);
    await run("git", ["add", "."], source);
    await run("git", ["commit", "-qm", "base"], source);
    const original = await discoverRepo(executor, source);
    const registry = new Registry(join(root, "agent"));
    await saveConfig(getConfigPaths(original.repoKey, original.root, registry.agentDir).repo, {
      version: 1, locale: "en", defaults: { missingPostCreate: "skip", launch: false },
    }, "repo");
    const changedFiles = {
      tracked: "unstaged\n", "staged-new": "staged addition\n", "renamed-new": "rename me\n",
      untracked: "untracked content\n", ignored: "ignored content\n",
    };
    const snapshot = async () => ({
      status: await statusEntries(executor, source),
      index: await run("git", ["ls-files", "--stage", "-z"], source),
      staged: await run("git", ["diff", "--cached", "--binary"], source),
      unstaged: await run("git", ["diff", "--binary"], source),
      stash: await run("git", ["stash", "list"], source),
    });
    const changeSource = async () => {
      await writeFile(join(source, "tracked"), "staged\n");
      await writeFile(join(source, "staged-new"), changedFiles["staged-new"]);
      await run("git", ["add", "tracked", "staged-new"], source);
      await run("git", ["mv", "renamed", "renamed-new"], source);
      await rm(join(source, "deleted"));
      for (const [name, content] of Object.entries(changedFiles)) await writeFile(join(source, name), content);
      return snapshot();
    };
    let before: Awaited<ReturnType<typeof snapshot>> | undefined;
    if (timing === "before creation") before = await changeSource();
    const ctx = context(source);
    ctx.ui.confirm = vi.fn(async () => {
      if (timing === "during confirmation") before = await changeSource();
      return true;
    });

    const created = await createWorktree(
      { exec: executor.exec.bind(executor) } as unknown as ExtensionAPI, registry, ctx,
      { task: "topic", path: target, noLaunch: true, allowDirty },
    );

    expect(created?.state).toBe("active");
    expect(created?.sourceHead).toBe(original.head);
    expect(await currentHead(executor, target)).toBe(original.head);
    expect(await statusEntries(executor, target)).toEqual([]);
    for (const [name, content] of Object.entries(committedFiles)) {
      expect(await readFile(join(target, name), "utf8")).toBe(content);
    }
    for (const name of ["staged-new", "renamed-new", "untracked", "ignored"]) {
      expect(await pathExists(join(target, name))).toBe(false);
    }
    expect(await snapshot()).toEqual(before);
    expect((await discoverRepo(executor, source)).branch).toBe(original.branch);
    expect(await currentHead(executor, source)).toBe(original.head);
    for (const [name, content] of Object.entries(changedFiles)) {
      expect(await readFile(join(source, name), "utf8")).toBe(content);
    }
    expect(await pathExists(join(source, "deleted"))).toBe(false);
    expect(await pathExists(join(source, "renamed"))).toBe(false);
    expect(ctx.ui.confirm).toHaveBeenCalledTimes(1);
    expect(ctx.ui.confirm).toHaveBeenCalledWith("Create this worktree?", expect.stringContaining("committed HEAD"));
  });

  it("uses committed local HEAD without fast-forwarding a dirty source behind upstream", async () => {
    const root = await tempDir();
    cleanup.push(root);
    const source = join(root, "source");
    const target = join(root, "target");
    const remote = join(root, "remote.git");
    await initRepo(source, "develop");
    await writeFile(join(source, "tracked"), "base\n");
    await run("git", ["add", "."], source);
    await run("git", ["commit", "-qm", "base"], source);
    await run("git", ["init", "-q", "--bare", remote]);
    await run("git", ["remote", "add", "origin", remote], source);
    await run("git", ["push", "-u", "origin", "develop"], source);
    const original = await discoverRepo(executor, source);
    await run("git", ["switch", "-c", "remote-update"], source);
    await writeFile(join(source, "tracked"), "remote update\n");
    await run("git", ["commit", "-am", "remote update"], source);
    await run("git", ["push", "origin", "HEAD:develop"], source);
    await run("git", ["switch", "develop"], source);
    await writeFile(join(source, "tracked"), "local staged\n");
    await run("git", ["add", "tracked"], source);
    await writeFile(join(source, "tracked"), "local unstaged\n");
    await writeFile(join(source, "untracked"), "keep me\n");
    const originalStatus = await statusEntries(executor, source);
    const originalIndex = await run("git", ["ls-files", "--stage"], source);
    const registry = new Registry(join(root, "agent"));
    await saveConfig(getConfigPaths(original.repoKey, original.root, registry.agentDir).repo, {
      version: 1, locale: "en", defaults: { missingPostCreate: "skip", launch: false },
    }, "repo");
    const ctx = context(source);
    ctx.ui.select = vi.fn(async (_title, choices) => choices[0]);

    const created = await createWorktree(
      { exec: executor.exec.bind(executor) } as unknown as ExtensionAPI, registry, ctx,
      { task: "topic", path: target, noLaunch: true },
    );

    expect(created?.state).toBe("active");
    expect(created?.sourceHead).toBe(original.head);
    expect(await currentHead(executor, target)).toBe(original.head);
    expect(await statusEntries(executor, target)).toEqual([]);
    expect(await readFile(join(target, "tracked"), "utf8")).toBe("base\n");
    expect(await pathExists(join(target, "untracked"))).toBe(false);
    expect(await currentHead(executor, source)).toBe(original.head);
    expect(await statusEntries(executor, source)).toEqual(originalStatus);
    expect(await run("git", ["ls-files", "--stage"], source)).toBe(originalIndex);
    expect(await readFile(join(source, "tracked"), "utf8")).toBe("local unstaged\n");
    expect(await readFile(join(source, "untracked"), "utf8")).toBe("keep me\n");
    expect(ctx.ui.select).not.toHaveBeenCalled();
  });

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
