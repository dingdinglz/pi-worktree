import { mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  currentHead,
  discoverRepo,
  git,
  gitOk,
  isAncestor,
  isClean,
  listWorktrees,
} from "../src/git.ts";
import { executor, initRepo, run, tempDir } from "./helpers.ts";

const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("recorded-source linear integration", () => {
  it("rebases onto a moving source and fast-forwards the exact source checkout", async () => {
    const root = await tempDir();
    cleanup.push(root);
    const source = join(root, "a");
    const target = join(root, "worktrees", "topic");
    await initRepo(source, "develop");
    await writeFile(join(source, "base.txt"), "base\n");
    await run("git", ["add", "."], source);
    await run("git", ["commit", "-qm", "base"], source);
    const initial = await currentHead(executor, source);

    await mkdir(join(root, "worktrees"));
    await gitOk(executor, source, ["worktree", "add", "-b", "wt/topic", target, "develop"]);
    await writeFile(join(target, "feature.txt"), "feature\n");
    await run("git", ["add", "."], target);
    await run("git", ["commit", "-qm", "feature"], target);

    await writeFile(join(source, "source.txt"), "source moved\n");
    await run("git", ["add", "."], source);
    await run("git", ["commit", "-qm", "source moved"], source);
    const latestSource = await currentHead(executor, source);
    expect(latestSource).not.toBe(initial);

    await gitOk(executor, target, ["rebase", latestSource]);
    const workHead = await currentHead(executor, target);
    expect(await isAncestor(executor, target, latestSource, workHead)).toBe(true);
    await gitOk(executor, source, ["merge", "--ff-only", "wt/topic"]);
    expect(await currentHead(executor, source)).toBe(workHead);
    expect((await discoverRepo(executor, source)).branch).toBe("develop");

    await gitOk(executor, source, ["worktree", "remove", target]);
    await gitOk(executor, source, ["branch", "-d", "wt/topic"]);
    expect((await listWorktrees(executor, source)).map((item) => item.path)).toEqual([await realpath(source)]);
  });

  it("lets Git remove ignored setup output but refuses ordinary untracked files", async () => {
    const root = await tempDir();
    cleanup.push(root);
    const source = join(root, "repo");
    const ignoredTarget = join(root, "ignored");
    const dirtyTarget = join(root, "dirty");
    await initRepo(source);
    await writeFile(join(source, ".gitignore"), "node_modules/\n");
    await writeFile(join(source, "tracked"), "x\n");
    await run("git", ["add", "."], source);
    await run("git", ["commit", "-qm", "base"], source);

    await gitOk(executor, source, ["worktree", "add", "-b", "wt/ignored", ignoredTarget, "main"]);
    await mkdir(join(ignoredTarget, "node_modules", "pkg"), { recursive: true });
    await writeFile(join(ignoredTarget, "node_modules", "pkg", "file"), "ignored");
    expect(await isClean(executor, ignoredTarget)).toBe(true);
    expect((await git(executor, source, ["worktree", "remove", ignoredTarget])).code).toBe(0);

    await gitOk(executor, source, ["worktree", "add", "-b", "wt/dirty", dirtyTarget, "main"]);
    await writeFile(join(dirtyTarget, "untracked"), "keep me");
    expect(await isClean(executor, dirtyTarget)).toBe(false);
    expect((await git(executor, source, ["worktree", "remove", dirtyTarget])).code).not.toBe(0);
  });
});
