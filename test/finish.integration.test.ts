import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getConfigPaths, saveConfig } from "../src/config.ts";
import { FinishCoordinator } from "../src/finish.ts";
import { currentHead, discoverRepo, gitOk, isClean, remoteBranchSha } from "../src/git.ts";
import { Registry } from "../src/registry.ts";
import type { ManagedWorktree } from "../src/types.ts";
import { newId, nowIso } from "../src/util.ts";
import { executor, initRepo, run, tempDir } from "./helpers.ts";

const cleanup: string[] = [];
afterEach(async () => Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

function fakePi(): ExtensionAPI {
  return { exec: executor.exec.bind(executor), sendUserMessage: vi.fn() } as unknown as ExtensionAPI;
}

function fakeContext(cwd: string, confirmations: boolean[], sessionId = "test-session"): ExtensionCommandContext {
  return {
    cwd,
    mode: "tui",
    hasUI: true,
    ui: {
      confirm: async () => confirmations.shift() ?? false,
      select: async () => undefined,
      input: async () => undefined,
      editor: async (_title: string, text: string) => text,
      notify: () => {},
    },
    isProjectTrusted: () => false,
    waitForIdle: async () => {},
    sessionManager: { getSessionId: () => sessionId },
    shutdown: () => {},
  } as unknown as ExtensionCommandContext;
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
  await saveConfig(getConfigPaths(record.repoKey, record.path, registry.agentDir).repo, { version: 1, locale: "en" }, "repo");
  return { root, source, target, sourceRepo, record, registry, transactionId };
}

async function conflictedRebaseFixture() {
  const data = await fixture();
  await writeFile(join(data.source, "feature"), "conflicting source change\n");
  await run("git", ["add", "."], data.source);
  await run("git", ["commit", "-qm", "source conflict"], data.source);
  expect((await executor.exec("git", ["rebase", "develop"], { cwd: data.target })).code).not.toBe(0);
  await data.registry.update(data.record.id, (record) => { record.state = "finish_paused"; });
  return data;
}

async function prFixture() {
  const data = await fixture();
  const remote = join(data.root, "remote.git");
  await run("git", ["init", "-q", "--bare", remote]);
  await run("git", ["remote", "add", "origin", remote], data.source);
  await run("git", ["push", "-u", "origin", "develop"], data.source);
  await data.registry.update(data.record.id, (record) => {
    record.transaction!.mode = "pr";
    record.transaction!.pr = {
      host: "github.com", baseRepo: "github.com/owner/repo", baseRemote: "origin",
      baseBranch: "develop", pushRemote: "origin", pushRepo: "github.com/owner/repo",
      headBranch: "wt/topic", headOwner: "owner",
    };
  });
  const pi = {
    async exec(command: string, args: string[], options?: Parameters<ExtensionAPI["exec"]>[2]) {
      if (command === "git" && args[0] === "remote" && args[1] === "get-url") {
        return { stdout: "https://github.com/owner/repo.git\n", stderr: "", code: 0, killed: false };
      }
      if (command === "gh") {
        if (args[0] !== "pr" || args[1] !== "view") throw new Error(`Unexpected gh command: ${args.join(" ")}`);
        return {
          stdout: JSON.stringify({
            url: "https://github.com/owner/repo/pull/1", state: "OPEN", title: "Topic", body: "Body", isDraft: false,
            headRefName: "wt/topic", baseRefName: "develop", headRefOid: await currentHead(executor, data.target),
            headRepository: { nameWithOwner: "owner/repo" },
          }),
          stderr: "", code: 0, killed: false,
        };
      }
      return executor.exec(command, args, options);
    },
  } as ExtensionAPI;
  return { ...data, pi };
}

describe("PR publication authorization", () => {
  it("prepares, pushes and verifies a PR using only local Git and fake gh", async () => {
    const data = await prFixture();
    const ctx = fakeContext(data.target, [true, true, false]);
    const coordinator = new FinishCoordinator(data.pi, data.registry, { activate() {}, deactivate() {} });
    const prepared = await coordinator.prepare(
      { transactionId: data.transactionId, title: "Topic", body: "Body", draft: false }, undefined, ctx,
    );
    const push = prepared.split("\n\n").find((part) => part.startsWith("GIT_TERMINAL_PROMPT=0"));
    expect(push).toBeDefined();
    await run("/bin/sh", ["-c", push!], data.target);
    await expect(coordinator.finalize(
      { transactionId: data.transactionId, prUrl: "https://github.com/owner/repo/pull/1" }, ctx,
    )).resolves.toContain("Pull request verified");
    expect((await data.registry.findById(data.record.id))?.state).toBe("cleanup_pending");
  });

  it("pins the approved push SHA even when HEAD moves before the command executes", async () => {
    const data = await prFixture();
    const coordinator = new FinishCoordinator(data.pi, data.registry, { activate() {}, deactivate() {} });
    const approvedHead = await currentHead(executor, data.target);
    const prepared = await coordinator.prepare(
      { transactionId: data.transactionId, title: "Topic", body: "Body" }, undefined, fakeContext(data.target, [true, true]),
    );
    const push = prepared.split("\n\n").find((part) => part.startsWith("GIT_TERMINAL_PROMPT=0"));
    expect(push).toBeDefined();
    await run("git", ["commit", "--allow-empty", "-qm", "not reviewed"], data.target);
    expect(await currentHead(executor, data.target)).not.toBe(approvedHead);
    await run("/bin/sh", ["-c", push!], data.target);
    expect(await remoteBranchSha(executor, data.target, "origin", "wt/topic")).toBe(approvedHead);
  });

  it.each(["heads", "tags"])("does not resolve the approved SHA to a colliding refs/%s ref", async (namespace) => {
    const data = await prFixture();
    const coordinator = new FinishCoordinator(data.pi, data.registry, { activate() {}, deactivate() {} });
    const approvedHead = await currentHead(executor, data.target);
    const prepared = await coordinator.prepare(
      { transactionId: data.transactionId, title: "Topic", body: "Body" }, undefined, fakeContext(data.target, [true, true]),
    );
    const push = prepared.split("\n\n").find((part) => part.startsWith("GIT_TERMINAL_PROMPT=0"));
    expect(push).toBeDefined();
    const collidingRef = `refs/${namespace}/${approvedHead}`;
    await run("git", ["update-ref", collidingRef, data.sourceRepo.head], data.target);
    expect(await run("git", ["rev-parse", "--verify", collidingRef], data.target)).toBe(data.sourceRepo.head);
    expect(await currentHead(executor, data.target)).toBe(approvedHead);
    await run("/bin/sh", ["-c", push!], data.target);
    expect(await remoteBranchSha(executor, data.target, "origin", "wt/topic")).toBe(approvedHead);
  });

  it.each(["source", "target"] as const)("rejects changes to %s HEAD made during the approval dialog", async (checkout) => {
    const data = await prFixture();
    const ctx = fakeContext(data.target, []);
    ctx.ui.confirm = async (title) => {
      if (title === "Approve remote publication?") {
        await writeFile(join(data[checkout], "late-change"), "not reviewed\n");
        await run("git", ["add", "."], data[checkout]);
        await run("git", ["commit", "-qm", "unreviewed"], data[checkout]);
      }
      return true;
    };
    const coordinator = new FinishCoordinator(data.pi, data.registry, { activate() {}, deactivate() {} });
    await expect(coordinator.prepare(
      { transactionId: data.transactionId, title: "Topic", body: "Body" }, undefined, ctx,
    )).rejects.toThrow(/changed/i);
    expect((await data.registry.findById(data.record.id))?.transaction?.phase).toBe("agent_prepare");
  });

  it("does not authorize publication after cancellation", async () => {
    const data = await prFixture();
    const controller = new AbortController();
    const ctx = fakeContext(data.target, []);
    ctx.ui.confirm = async (title) => {
      if (title === "Approve remote publication?") controller.abort();
      return true;
    };
    const coordinator = new FinishCoordinator(data.pi, data.registry, { activate() {}, deactivate() {} });
    await expect(coordinator.prepare(
      { transactionId: data.transactionId, title: "Topic", body: "Body" }, controller.signal, ctx,
    )).rejects.toThrow(/abort/i);
    expect((await data.registry.findById(data.record.id))?.transaction?.phase).toBe("agent_prepare");
  });
});

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

  it("can finish a reopened PR worktree with a local merge", async () => {
    const data = await fixture();
    await data.registry.update(data.record.id, (record) => {
      record.prUrl = "https://github.com/owner/repo/pull/1";
    });
    const coordinator = new FinishCoordinator(fakePi(), data.registry, { activate() {}, deactivate() {} });
    await expect(coordinator.prepare(
      { transactionId: data.transactionId }, undefined, fakeContext(data.target, [true, true, false]),
    )).resolves.toContain("Merged wt/topic");
    const record = await data.registry.findById(data.record.id);
    expect(record?.state).toBe("merged_cleanup_pending");
    expect(record?.prUrl).toBeUndefined();
  });

  it("can clean up an already-integrated worktree with an old PR URL", async () => {
    const data = await fixture();
    await run("git", ["merge", "--ff-only", "wt/topic"], data.source);
    await data.registry.update(data.record.id, (record) => {
      record.transaction = undefined;
      record.state = "active";
      record.prUrl = "https://github.com/owner/repo/pull/1";
    });
    const coordinator = new FinishCoordinator(fakePi(), data.registry, { activate() {}, deactivate() {} });
    await expect(coordinator.start(fakeContext(data.target, [true, false]), "merge")).resolves.toBeUndefined();
    const record = await data.registry.findById(data.record.id);
    expect(record?.transaction?.cleanupResult).toBe("already_integrated");
    expect(record?.prUrl).toBeUndefined();
  });

  it.each([false, true])("resumes a rebase even at a temporarily clean detached HEAD (conflict resolved: %s)", async (resolved) => {
    const data = await fixture();
    await writeFile(join(data.source, "feature"), "conflicting source change\n");
    await run("git", ["add", "."], data.source);
    await run("git", ["commit", "-qm", "source conflict"], data.source);
    const latest = await currentHead(executor, data.source);
    const rebase = await executor.exec("git", ["rebase", latest], { cwd: data.target });
    expect(rebase.code).not.toBe(0);
    if (resolved) {
      await run("git", ["checkout", "--ours", "feature"], data.target);
      await run("git", ["add", "feature"], data.target);
      expect(await isClean(executor, data.target)).toBe(true);
    }
    await data.registry.update(data.record.id, (record) => { record.state = "finish_paused"; });
    const pi = fakePi();
    const coordinator = new FinishCoordinator(pi, data.registry, { activate() {}, deactivate() {} });
    await expect(coordinator.start(fakeContext(data.target, [true]), "merge", true)).resolves.toBeUndefined();
    expect(pi.sendUserMessage).toHaveBeenCalledWith(expect.stringContaining("rebase --continue"));
    const record = await data.registry.findById(data.record.id);
    expect(record?.transaction?.sourceHead).toBe(latest);
    expect(record?.state).toBe("finish_active");
  });

  it("binds legacy rebase recovery to one session and requires approval for a takeover", async () => {
    const data = await conflictedRebaseFixture();
    const firstContext = fakeContext(data.target, [], "first-session");
    const first = new FinishCoordinator(fakePi(), data.registry, { activate() {}, deactivate() {} });
    await first.start(firstContext, "merge", true);

    const secondContext = fakeContext(data.target, [], "second-session");
    const confirm = vi.fn(async () => false);
    secondContext.ui.confirm = confirm;
    const activate = vi.fn();
    const second = new FinishCoordinator(fakePi(), data.registry, { activate, deactivate() {} });
    await second.start(secondContext, "merge", true);
    expect(confirm).toHaveBeenCalledWith("Take over finish transaction?", expect.stringContaining("first-session"));
    expect(activate).not.toHaveBeenCalled();
    expect((await data.registry.findById(data.record.id))?.transaction?.sessionId).toBe("first-session");

    confirm.mockResolvedValue(true);
    await second.start(secondContext, "merge", true);
    expect(activate).toHaveBeenCalledOnce();
    expect((await data.registry.findById(data.record.id))?.transaction?.sessionId).toBe("second-session");
    await expect(first.prepare({ transactionId: data.transactionId }, undefined, firstContext))
      .rejects.toThrow(/No matching agent_prepare transaction.*session/);
  });

  it("atomically claims an unowned rebase transaction when two sessions resume concurrently", async () => {
    const data = await conflictedRebaseFixture();
    const update = data.registry.update.bind(data.registry);
    let arrivals = 0;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const updateSpy = vi.spyOn(data.registry, "update").mockImplementation(async (id, updater) => {
      if (++arrivals <= 2) {
        if (arrivals === 2) release();
        await barrier;
      }
      return update(id, updater);
    });
    const activate = vi.fn();
    try {
      const outcomes = await Promise.allSettled(["first-session", "second-session"].map((sessionId) => {
        const coordinator = new FinishCoordinator(fakePi(), data.registry, { activate, deactivate() {} });
        return coordinator.start(fakeContext(data.target, [], sessionId), "merge", true);
      }));
      expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
      expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
      expect(activate).toHaveBeenCalledOnce();
      expect(["first-session", "second-session"]).toContain((await data.registry.findById(data.record.id))?.transaction?.sessionId);
    } finally {
      updateSpy.mockRestore();
    }
  });

  it("does not allow a different branch's in-progress rebase to be resumed", async () => {
    const data = await fixture();
    await writeFile(join(data.source, "feature"), "conflicting source change\n");
    await run("git", ["add", "."], data.source);
    await run("git", ["commit", "-qm", "source conflict"], data.source);
    await run("git", ["switch", "-c", "unrelated"], data.target);
    expect((await executor.exec("git", ["rebase", "develop"], { cwd: data.target })).code).not.toBe(0);
    const coordinator = new FinishCoordinator(fakePi(), data.registry, { activate() {}, deactivate() {} });
    await expect(coordinator.start(fakeContext(data.target, [true]), "merge", true)).rejects.toThrow(/must be on wt\/topic/);
  });

  it("can bind a legacy transaction without a session ID when resuming", async () => {
    const data = await fixture();
    const pi = fakePi();
    const coordinator = new FinishCoordinator(pi, data.registry, { activate() {}, deactivate() {} });
    await coordinator.start(fakeContext(data.target, [true]), "merge", true);
    expect((await data.registry.findById(data.record.id))?.transaction?.sessionId).toBe("test-session");
    expect(pi.sendUserMessage).toHaveBeenCalledOnce();
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

    // The user can change branches in another terminal while the confirmation is open.
    await data.registry.update(data.record.id, (record) => { record.state = "finish_paused"; });
    const ctx = fakeContext(data.target, []);
    ctx.ui.confirm = async () => {
      await run("git", ["switch", "-c", "unrelated"], data.source);
      return true;
    };
    await expect(coordinator.start(ctx, "merge", true)).rejects.toThrow(/changed|remain on/i);
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
