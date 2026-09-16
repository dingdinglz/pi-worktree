import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { writeApprovedPrBody } from "../src/github.ts";
import { Registry } from "../src/registry.ts";
import type { ManagedWorktree } from "../src/types.ts";
import { tempDir } from "./helpers.ts";

const cleanup: string[] = [];
afterEach(async () => Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

function record(path: string): ManagedWorktree {
  return {
    id: "id-1",
    repoId: "local/repo",
    repoKey: "repo",
    repoCommonDir: `${path}/.git`,
    path,
    branch: "wt/task",
    sourcePath: `${path}-source`,
    sourceBranch: "main",
    sourceHead: "a".repeat(40),
    relativeCwd: "",
    task: "task",
    slug: "task",
    state: "active",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

describe("registry", () => {
  it("persists records and creates minimal completion history", async () => {
    const root = await tempDir();
    cleanup.push(root);
    const registry = new Registry(root);
    const item = record(`${root}/worktree`);
    item.repoId = "github.com/owner/repo";
    item.repoIdentity = {
      remote: "origin",
      url: "https://github.com/owner/repo.git",
      host: "github.com",
      owner: "owner",
      repo: "repo",
      repoSpec: "github.com/owner/repo",
    };
    await registry.add(item);
    expect((await registry.findById("id-1"))?.repoIdentity?.repoSpec).toBe("github.com/owner/repo");
    const finalHead = "b".repeat(40);
    const history = await registry.complete(item.id, "pr", finalHead, "https://github.com/o/r/pull/1");
    expect(history.finalHead).toBe(finalHead);
    expect((await registry.records()).length).toBe(0);
    expect((await registry.history())[0].prUrl).toContain("/pull/1");
  });

  it.each([
    "github.com--owner--repo-12345678",
    "git.example.com--some.owner--my.repo-12345678",
    "local--my.repo-12345678-abcdef12",
  ])("round-trips dotted repository keys through active records and history (%s)", async (repoKey) => {
    const root = await tempDir();
    cleanup.push(root);
    const registry = new Registry(root);
    const item = { ...record(`${root}/worktree`), repoKey };
    await registry.add(item);
    const reloaded = new Registry(root);
    expect(await reloaded.records(repoKey)).toEqual([item]);
    const history = await reloaded.complete(item.id, "merged", "b".repeat(40));
    expect(history.repoKey).toBe(repoKey);
    expect(await new Registry(root).history(repoKey)).toEqual([history]);
    expect(await reloaded.records()).toEqual([]);
  });

  it.each([
    "", ".", "..", "../escape", "repo/child", "repo\\child", "/absolute",
    "repo\u0000key", "repo\nkey", "repo key", "a".repeat(257),
  ])("rejects unsafe repository keys in active records and stored history (%j)", async (repoKey) => {
    const root = await tempDir();
    cleanup.push(root);
    const registry = new Registry(root);
    const item = record(`${root}/worktree`);
    await expect(registry.add({ ...item, repoKey })).rejects.toThrow(/Invalid/);
    expect(await registry.records()).toEqual([]);

    await registry.add(item);
    const history = await registry.complete(item.id, "merged", "b".repeat(40));
    await writeFile(registry.path, JSON.stringify({
      version: 1, worktrees: [], history: [{ ...history, repoKey }],
    }));
    await expect(registry.load()).rejects.toThrow(/Invalid/);
  });

  it.each(["id", "slug"] as const)("still rejects dots in %s", async (field) => {
    const root = await tempDir();
    cleanup.push(root);
    const registry = new Registry(root);
    await expect(registry.add({ ...record(`${root}/worktree`), [field]: "with.dot" })).rejects.toThrow(/identifier/);
    expect(await registry.records()).toEqual([]);
  });

  it("rejects a symlink-diverted state directory", async () => {
    const root = await tempDir();
    cleanup.push(root);
    const agent = `${root}/agent`;
    const external = `${root}/external`;
    await mkdir(agent, { recursive: true });
    await mkdir(external, { recursive: true });
    await symlink(external, `${agent}/worktree`);
    await expect(new Registry(agent).load()).rejects.toThrow(/symlink-diverted/);
  });

  it("rejects path-traversing identifiers and relative working directories", async () => {
    const root = await tempDir();
    cleanup.push(root);
    const registry = new Registry(root);
    await expect(registry.add({ ...record(`${root}/bad-id`), id: "../escape" })).rejects.toThrow(/identifier/);
    await expect(registry.add({ ...record(`${root}/bad-cwd`), relativeCwd: "../../escape" })).rejects.toThrow(/relativeCwd/);
    expect(await registry.records()).toEqual([]);
  });

  it("binds recoverable PR body files to their exact finish transaction", async () => {
    const root = await tempDir();
    cleanup.push(root);
    const registry = new Registry(root);
    const item = record(`${root}/pr-body`);
    await registry.add(item);
    const timestamp = new Date().toISOString();
    await registry.beginFinishTransaction(item.id, {
      id: "tx-body",
      mode: "pr",
      phase: "agent_prepare",
      sourceHead: item.sourceHead,
      startedAt: timestamp,
      updatedAt: timestamp,
      pr: {
        host: "github.com",
        baseRepo: "github.com/owner/repo",
        baseRemote: "origin",
        baseBranch: "main",
        pushRemote: "origin",
        pushRepo: "github.com/owner/repo",
        headBranch: item.branch,
        headOwner: "owner",
      },
    });
    const bodyFile = await writeApprovedPrBody(registry, "tx-body", "body");
    await registry.update(item.id, (current) => {
      if (current.transaction?.pr) current.transaction.pr.bodyFile = bodyFile;
    });
    expect((await registry.findById(item.id))?.transaction?.pr?.bodyFile).toBe(bodyFile);
  });

  it("rejects managed source dependency cycles", async () => {
    const root = await tempDir();
    cleanup.push(root);
    const registry = new Registry(root);
    const first = { ...record(`${root}/one`), sourcePath: `${root}/two` };
    const second = {
      ...record(`${root}/two`),
      id: "id-2",
      branch: "wt/two",
      sourcePath: `${root}/one`,
    };
    await registry.add(first);
    await expect(registry.add(second)).rejects.toThrow(/dependency cycle/);
    expect((await registry.records()).map((item) => item.id)).toEqual([first.id]);
  });

  it("does not overwrite a transaction started by another session in the same worktree", async () => {
    const root = await tempDir();
    cleanup.push(root);
    const registry = new Registry(root);
    const item = record(`${root}/same-worktree`);
    await registry.add(item);
    const transaction = {
      id: "tx-1", sessionId: "session-1", mode: "merge" as const, phase: "agent_prepare" as const,
      sourceHead: item.sourceHead, startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    await registry.beginFinishTransaction(item.id, transaction);
    await expect(registry.beginFinishTransaction(item.id, {
      ...transaction, id: "tx-2", sessionId: "session-2",
    })).rejects.toThrow(/transaction/i);
    await expect(registry.beginFinishTransaction(item.id, {
      ...transaction, sessionId: "session-2",
    })).rejects.toThrow(/transaction/i);
    expect((await registry.findById(item.id))?.transaction).toEqual(transaction);
    await expect(registry.beginFinishTransaction(item.id, transaction)).resolves.toMatchObject({ state: "finish_active" });
  });

  it("atomically rejects two active finish transactions for the same source branch", async () => {
    const root = await tempDir();
    cleanup.push(root);
    const registry = new Registry(root);
    const first = record(`${root}/one`);
    const second = {
      ...record(`${root}/two`),
      id: "id-2",
      branch: "wt/two",
      repoCommonDir: first.repoCommonDir,
      sourcePath: first.sourcePath,
      sourceBranch: first.sourceBranch,
    };
    await registry.add(first);
    await registry.add(second);
    const transaction = {
      id: "tx-1",
      mode: "merge" as const,
      phase: "agent_prepare" as const,
      sourceHead: "a".repeat(40),
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await registry.beginFinishTransaction(first.id, transaction);
    await expect(registry.beginFinishTransaction(second.id, { ...transaction, id: "tx-2" })).rejects.toThrow(/locked/);

    const child = {
      ...record(`${root}/child`),
      id: "id-3",
      branch: "wt/child",
      repoCommonDir: first.repoCommonDir,
      sourcePath: first.path,
      sourceBranch: first.branch,
    };
    await registry.add(child);
    await expect(registry.beginFinishTransaction(child.id, { ...transaction, id: "tx-3" })).rejects.toThrow(/locked/);
  });
});
