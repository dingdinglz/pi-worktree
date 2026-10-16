import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as cleanupModule from "../src/cleanup.ts";
import { getConfigPaths, saveConfig } from "../src/config.ts";
import { FinishCoordinator } from "../src/finish.ts";
import { currentHead, discoverRepo, gitOk, isClean, remoteBranchSha } from "../src/git.ts";
import { Registry } from "../src/registry.ts";
import type { ManagedWorktree } from "../src/types.ts";
import { newId, nowIso } from "../src/util.ts";
import { executor, initRepo, run, tempDir } from "./helpers.ts";

const cleanup: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

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

async function prFixture(prState: "OPEN" | "MERGED" = "OPEN") {
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
    sendUserMessage: vi.fn(),
    async exec(command: string, args: string[], options?: Parameters<ExtensionAPI["exec"]>[2]) {
      if (command === "git" && args[0] === "remote" && args[1] === "get-url") {
        return { stdout: "https://github.com/owner/repo.git\n", stderr: "", code: 0, killed: false };
      }
      if (command === "gh") {
        if (args[0] === "--version" || args[0] === "auth") return { stdout: "", stderr: "", code: 0, killed: false };
        if (args[0] !== "pr" || !["view", "list"].includes(args[1])) throw new Error(`Unexpected gh command: ${args.join(" ")}`);
        const info = {
          url: "https://github.com/owner/repo/pull/1", state: prState, title: "Topic", body: "Body", isDraft: false,
          headRefName: "wt/topic", baseRefName: "develop", headRefOid: await remoteBranchSha(executor, data.target, "origin", "wt/topic"),
          headRepository: { nameWithOwner: "owner/repo" },
        };
        return {
          stdout: JSON.stringify(args[1] === "list" ? [info] : info),
          stderr: "", code: 0, killed: false,
        };
      }
      return executor.exec(command, args, options);
    },
  } as unknown as ExtensionAPI;
  return { ...data, pi };
}

describe("PR publication authorization", () => {
  it("prepares, pushes and verifies a PR using only local Git and fake gh", async () => {
    const data = await prFixture();
    const ctx = fakeContext(data.target, [true, true]);
    ctx.ui.confirm = vi.fn(ctx.ui.confirm);
    ctx.shutdown = vi.fn();
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
    expect(ctx.ui.confirm).toHaveBeenCalledTimes(2);
    expect(ctx.shutdown).not.toHaveBeenCalled();
    const schedule = vi.spyOn(cleanupModule, "scheduleCleanup").mockResolvedValue(undefined);
    await coordinator.cleanupCurrent(fakeContext(data.target, [true]));
    expect(schedule).toHaveBeenCalledWith(data.registry, expect.objectContaining({
      result: "pr", deleteBranch: false, prUrl: "https://github.com/owner/repo/pull/1",
    }));
  });

  it.each([false, true])("retains an already-merged PR without scheduling cleanup (resume: %s)", async (resume) => {
    const data = await prFixture("MERGED");
    const coordinator = new FinishCoordinator(data.pi, data.registry, { activate() {}, deactivate() {} });
    const prepared = await coordinator.prepare(
      { transactionId: data.transactionId, title: "Topic", body: "Body" }, undefined, fakeContext(data.target, [true, true]),
    );
    await run("/bin/sh", ["-c", prepared.split("\n\n").find((part) => part.startsWith("GIT_TERMINAL_PROMPT=0"))!], data.target);
    if (!resume) await data.registry.update(data.record.id, (record) => {
      record.state = "active";
      record.transaction = undefined;
    });
    const ctx = fakeContext(data.target, [true]);
    ctx.ui.confirm = vi.fn(ctx.ui.confirm);
    ctx.shutdown = vi.fn();
    await coordinator.start(ctx, "pr", resume);
    expect(ctx.ui.confirm).toHaveBeenCalledTimes(1);
    expect(ctx.shutdown).not.toHaveBeenCalled();
    expect((await data.registry.findById(data.record.id))?.transaction?.cleanupResult).toBe("already_integrated");
  });

  it.each(["committed", "uncommitted"])("starts another PR round after %s review changes and reuses the open PR", async (changes) => {
    const data = await prFixture();
    const coordinator = new FinishCoordinator(data.pi, data.registry, { activate() {}, deactivate() {} });
    const ctx = fakeContext(data.target, [true, true]);
    const prepared = await coordinator.prepare(
      { transactionId: data.transactionId, title: "Topic", body: "Body" }, undefined, ctx,
    );
    await run("/bin/sh", ["-c", prepared.split("\n\n").find((part) => part.startsWith("GIT_TERMINAL_PROMPT=0"))!], data.target);
    await coordinator.finalize({ transactionId: data.transactionId }, ctx);
    const previousHead = await currentHead(executor, data.target);
    await writeFile(join(data.target, "review"), "review fix\n");
    if (changes === "committed") {
      await run("git", ["add", "review"], data.target);
      await run("git", ["commit", "-qm", "review fix"], data.target);
    }
    const nextCtx = fakeContext(data.target, [true], "review-session");
    nextCtx.ui.select = async (_title, choices) => choices[0];
    await coordinator.start(nextCtx, "pr");
    const next = (await data.registry.findById(data.record.id))!.transaction!;
    expect(next.id).not.toBe(data.transactionId);
    expect(next.sessionId).toBe("review-session");
    expect(next.phase).toBe("agent_prepare");
    expect(next.workHead).toBeUndefined();
    expect(next.pr?.existingUrl).toBe("https://github.com/owner/repo/pull/1");
    expect(data.pi.sendUserMessage).toHaveBeenCalledWith(expect.stringContaining("Do not push yet"));
    // Starting the next round must not publish new work using the old authorization.
    expect(await remoteBranchSha(executor, data.target, "origin", "wt/topic")).toBe(previousHead);
    if (changes === "uncommitted") {
      await run("git", ["add", "review"], data.target);
      await run("git", ["commit", "-qm", "review fix"], data.target);
    }
    const nextPrepared = await coordinator.prepare(
      { transactionId: next.id, title: "Topic", body: "Body" }, undefined, fakeContext(data.target, [true, true], "review-session"),
    );
    expect(nextPrepared).not.toContain("'gh' 'pr' 'create'");
    expect(nextPrepared).toContain("'gh' 'pr' 'edit'");
    await run("/bin/sh", ["-c", nextPrepared.split("\n\n").find((part) => part.startsWith("GIT_TERMINAL_PROMPT=0"))!], data.target);
    await coordinator.finalize({ transactionId: next.id }, nextCtx);
    expect((await data.registry.findById(data.record.id))?.transaction?.workHead).toBe(await currentHead(executor, data.target));
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

describe("Explicit cleanup and repeated finish", () => {
  async function finishedMerge() {
    const data = await fixture();
    const pi = fakePi();
    const coordinator = new FinishCoordinator(pi, data.registry, { activate() {}, deactivate() {} });
    await coordinator.prepare({ transactionId: data.transactionId }, undefined, fakeContext(data.target, [true, true]));
    return { ...data, pi, coordinator };
  }

  it("only schedules deletion via explicit cleanup and confirmation", async () => {
    const data = await finishedMerge();
    const schedule = vi.spyOn(cleanupModule, "scheduleCleanup").mockResolvedValue(undefined);
    const ctx = fakeContext(data.target, [false, true]);
    ctx.shutdown = vi.fn();
    await data.coordinator.cleanupCurrent(ctx);
    expect(schedule).not.toHaveBeenCalled();
    expect(ctx.shutdown).not.toHaveBeenCalled();
    await data.coordinator.cleanupCurrent(ctx);
    expect(schedule).toHaveBeenCalledWith(data.registry, expect.objectContaining({
      expectedWorkHead: await currentHead(executor, data.target), result: "merged", deleteBranch: true,
    }));
    expect(ctx.shutdown).toHaveBeenCalledOnce();
  });

  it.each(["committed", "untracked", "tracked"])("blocks cleanup with %s review changes", async (changes) => {
    const data = await finishedMerge();
    const schedule = vi.spyOn(cleanupModule, "scheduleCleanup").mockResolvedValue(undefined);
    if (changes === "committed") await run("git", ["commit", "--allow-empty", "-qm", "new work"], data.target);
    else await writeFile(join(data.target, changes === "tracked" ? "feature" : "new-file"), "unfinished\n");
    const ctx = fakeContext(data.target, [true]);
    ctx.shutdown = vi.fn();
    await expect(data.coordinator.cleanupCurrent(ctx)).rejects.toThrow(changes === "committed" ? /HEAD changed.*\/wt finish/ : /Git status entries/);
    expect(schedule).not.toHaveBeenCalled();
    expect(ctx.shutdown).not.toHaveBeenCalled();
  });

  it("requires a completed finish and interactive mode for cleanup", async () => {
    const data = await fixture();
    const coordinator = new FinishCoordinator(fakePi(), data.registry, { activate() {}, deactivate() {} });
    const ctx = fakeContext(data.target, [true]);
    await expect(coordinator.cleanupCurrent(ctx)).rejects.toThrow(/Run \/wt finish first/);
    await expect(coordinator.cleanupCurrent({ ...ctx, mode: "rpc" })).rejects.toThrow(/interactive TUI/);
  });

  it("starts a fresh merge transaction after more work, but preserves the receipt when cancelled", async () => {
    const data = await finishedMerge();
    const before = (await data.registry.findById(data.record.id))!.transaction!;
    await run("git", ["commit", "--allow-empty", "-qm", "review fix"], data.target);
    await data.coordinator.start(fakeContext(data.target, [false]), "merge");
    expect((await data.registry.findById(data.record.id))?.transaction).toEqual(before);
    await data.coordinator.start(fakeContext(data.target, [true]), "merge");
    const next = (await data.registry.findById(data.record.id))!.transaction!;
    expect(next.id).not.toBe(before.id);
    expect(next.phase).toBe("agent_prepare");
    await expect(data.coordinator.prepare({ transactionId: before.id }, undefined, fakeContext(data.target, [true])))
      .rejects.toThrow(/No matching/);
    await data.coordinator.prepare({ transactionId: next.id }, undefined, fakeContext(data.target, [true, true]));
    expect(await currentHead(executor, data.source)).toBe(await currentHead(executor, data.target));
  });

  it("does not overwrite cleanup scheduled while confirming an already-integrated finish", async () => {
    const data = await finishedMerge();
    const ctx = fakeContext(data.target, []);
    ctx.ui.confirm = async () => {
      await data.registry.update(data.record.id, (record) => {
        record.state = "cleanup_scheduled";
        record.transaction!.phase = "cleanup_scheduled";
        record.transaction!.cleanupAttemptId = "concurrent-cleanup";
      });
      return true;
    };
    await expect(data.coordinator.start(ctx, "merge")).rejects.toThrow(/transaction changed before completion/);
    expect((await data.registry.findById(data.record.id))?.transaction?.cleanupAttemptId).toBe("concurrent-cleanup");
  });

  it("guides completed --resume to a new finish or explicit cleanup", async () => {
    const data = await finishedMerge();
    await expect(data.coordinator.start(fakeContext(data.target, []), "merge", true)).rejects.toThrow(/Finish already completed/);
  });

  it("retries scheduled cleanup through cleanup, never through finish", async () => {
    const data = await finishedMerge();
    await data.registry.update(data.record.id, (record) => {
      record.state = "cleanup_scheduled";
      record.transaction!.phase = "cleanup_scheduled";
      record.transaction!.cleanupAttemptId = "old-attempt";
    });
    await expect(data.coordinator.start(fakeContext(data.target, []), "merge", true)).rejects.toThrow(/Use \/wt cleanup/);
    await data.coordinator.cleanupCurrent(fakeContext(data.target, [true, false]));
    const record = await data.registry.findById(data.record.id);
    expect(record?.state).toBe("merged_cleanup_pending");
    expect(record?.transaction?.cleanupAttemptId).toBeUndefined();
  });
});

describe("FinishCoordinator local merge", () => {
  it("updates the exact source checkout and retains the worktree without asking to delete it", async () => {
    const data = await fixture();
    const pi = fakePi();
    const coordinator = new FinishCoordinator(pi, data.registry, { activate() {}, deactivate() {} });
    const workHead = await currentHead(executor, data.target);
    const ctx = fakeContext(data.target, [true, true]);
    ctx.ui.confirm = vi.fn(ctx.ui.confirm);
    ctx.shutdown = vi.fn();
    const result = await coordinator.prepare({ transactionId: data.transactionId }, undefined, ctx);
    expect(ctx.ui.confirm).toHaveBeenCalledTimes(2);
    expect(ctx.shutdown).not.toHaveBeenCalled();
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

  it("retains an already-integrated worktree and clears its old PR URL", async () => {
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
