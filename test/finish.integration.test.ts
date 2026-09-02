import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { FinishCoordinator } from "../src/finish.ts";
import { currentHead, discoverRepo, gitOk } from "../src/git.ts";
import { Registry } from "../src/registry.ts";
import type { ManagedWorktree } from "../src/types.ts";
import { newId, nowIso } from "../src/util.ts";
import { executor, initRepo, run, tempDir } from "./helpers.ts";

const cleanup: string[] = [];
afterEach(async () => Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

function fakePi(): ExtensionAPI {
  return { exec: executor.exec.bind(executor) } as unknown as ExtensionAPI;
}

function fakeContext(cwd: string, confirmations: boolean[]): ExtensionContext {
  return {
    cwd,
    mode: "tui",
    hasUI: true,
    ui: {
      confirm: async () => confirmations.shift() ?? false,
      select: async () => undefined,
      input: async () => undefined,
      editor: async () => undefined,
      notify: () => {},
    },
    isProjectTrusted: () => false,
    shutdown: () => {},
  } as unknown as ExtensionContext;
}

async function fixture() {
  const root = await tempDir();
  cleanup.push(root);
  const source = join(root, "source");
  const target = join(root, "target");
  await initRepo(source, "develop");
  await writeFile(join(source, "base"), "base\n");
  await run("git", ["add", "."], source);
  await run("git", ["commit", "-qm", "base"], source);
  await gitOk(executor, source, ["worktree", "add", "-b", "wt/topic", target, "develop"]);
  await writeFile(join(target, "feature"), "feature\n");
  await run("git", ["add", "."], target);
  await run("git", ["commit", "-qm", "feature"], target);
  const sourceRepo = await discoverRepo(executor, source);
  const targetRepo = await discoverRepo(executor, target);
  const timestamp = nowIso();
  const transactionId = newId();
  const record: ManagedWorktree = {
    id: newId(),
    repoId: sourceRepo.repoId,
    repoKey: sourceRepo.repoKey,
    repoCommonDir: sourceRepo.commonDir,
    path: targetRepo.root,
    branch: "wt/topic",
    sourcePath: sourceRepo.root,
    sourceBranch: "develop",
    sourceHead: sourceRepo.head,
    relativeCwd: "",
    task: "topic",
    slug: "topic",
    state: "finish_active",
    createdAt: timestamp,
    updatedAt: timestamp,
    transaction: {
      id: transactionId,
      mode: "merge",
      phase: "agent_prepare",
      sourceHead: sourceRepo.head,
      startedAt: timestamp,
      updatedAt: timestamp,
    },
  };
  const registry = new Registry(join(root, "agent"));
  await registry.add(record);
  return { root, source, target, sourceRepo, record, registry, transactionId };
}

describe("FinishCoordinator local merge", () => {
  it("updates the exact source checkout and leaves cleanup pending when deletion is declined", async () => {
    const data = await fixture();
    const pi = fakePi();
    const coordinator = new FinishCoordinator(pi, data.registry, { activate() {}, deactivate() {} });
    const workHead = await currentHead(executor, data.target);
    const result = await coordinator.prepare(
      { transactionId: data.transactionId },
      undefined,
      fakeContext(data.target, [true, true, false]),
    );
    expect(result).toContain("Merged wt/topic");
    expect(await currentHead(executor, data.source)).toBe(workHead);
    expect((await data.registry.findById(data.record.id))?.state).toBe("merged_cleanup_pending");
  });

  it("does not fast-forward a newly-behind source branch from the prepare tool", async () => {
    const data = await fixture();
    const remote = join(data.root, "remote.git");
    const other = join(data.root, "other");
    await run("git", ["init", "-q", "--bare", remote]);
    await run("git", ["remote", "add", "origin", remote], data.source);
    await run("git", ["push", "-u", "origin", "develop"], data.source);
    await run("git", ["clone", "-q", remote, other]);
    await run("git", ["checkout", "-q", "develop"], other);
    await run("git", ["config", "user.email", "test@example.com"], other);
    await run("git", ["config", "user.name", "Test"], other);
    await writeFile(join(other, "remote-change"), "remote\n");
    await run("git", ["add", "."], other);
    await run("git", ["commit", "-qm", "remote advanced"], other);
    await run("git", ["push", "-q", "origin", "develop"], other);
    const original = await currentHead(executor, data.source);
    const coordinator = new FinishCoordinator(fakePi(), data.registry, { activate() {}, deactivate() {} });
    await expect(
      coordinator.prepare({ transactionId: data.transactionId }, undefined, fakeContext(data.target, [])),
    ).rejects.toThrow(/resume \/wt finish to approve/);
    expect(await currentHead(executor, data.source)).toBe(original);
  });

  it("refuses a stale source SHA and updates the transaction for another rebase", async () => {
    const data = await fixture();
    await writeFile(join(data.source, "new-source"), "new\n");
    await run("git", ["add", "."], data.source);
    await run("git", ["commit", "-qm", "source advanced"], data.source);
    const latest = await currentHead(executor, data.source);
    const coordinator = new FinishCoordinator(fakePi(), data.registry, { activate() {}, deactivate() {} });
    await expect(
      coordinator.prepare({ transactionId: data.transactionId }, undefined, fakeContext(data.target, [])),
    ).rejects.toThrow(/Source changed/);
    expect((await data.registry.findById(data.record.id))?.transaction?.sourceHead).toBe(latest);
  });
});
