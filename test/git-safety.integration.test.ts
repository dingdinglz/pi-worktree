import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { gitOperationInProgress, remoteBranchSha } from "../src/git.ts";
import { executor, initRepo, tempDir } from "./helpers.ts";

const cleanup: string[] = [];
afterEach(async () => Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

describe("Git safety checks", () => {
  it.each(["MERGE_HEAD", "BISECT_START", "rebase-merge"])("detects %s in a checkout other than the process cwd", async (operation) => {
    const root = await tempDir();
    cleanup.push(root);
    await initRepo(root);
    const marker = join(root, ".git", operation);
    if (operation === "rebase-merge") await mkdir(marker);
    else await writeFile(marker, "a".repeat(40));
    expect(await gitOperationInProgress(executor, root)).toBe(operation);
  });

  it("does not treat a failed remote query as a missing branch", async () => {
    const root = await tempDir();
    cleanup.push(root);
    await initRepo(root);
    await expect(remoteBranchSha(executor, root, join(root, "missing.git"), "topic"))
      .rejects.toThrow(/remote/i);
  });
});
