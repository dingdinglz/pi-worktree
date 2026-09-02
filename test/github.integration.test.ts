import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { createPrPlan, verifyPublishedPr } from "../src/github.ts";
import { currentHead, discoverRepo, gitOk } from "../src/git.ts";
import { Registry } from "../src/registry.ts";
import type { EffectiveConfig, ManagedWorktree } from "../src/types.ts";
import { newId, nowIso } from "../src/util.ts";
import { executor, initRepo, run, tempDir } from "./helpers.ts";

const cleanup: string[] = [];
afterEach(async () => Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

describe("GitHub adapter verification", () => {
  it("uses a fake gh adapter and verifies the pushed SHA and PR refs", async () => {
    const root = await tempDir();
    cleanup.push(root);
    const remote = join(root, "remote.git");
    const source = join(root, "source");
    const target = join(root, "target");
    await run("git", ["init", "-q", "--bare", remote]);
    await initRepo(source, "develop");
    await writeFile(join(source, "base"), "base\n");
    await run("git", ["add", "."], source);
    await run("git", ["commit", "-qm", "base"], source);
    await run("git", ["remote", "add", "origin", remote], source);
    await run("git", ["push", "-u", "origin", "develop"], source);
    await gitOk(executor, source, ["worktree", "add", "-b", "wt/topic", target, "develop"]);
    await writeFile(join(target, "feature"), "feature\n");
    await run("git", ["add", "."], target);
    await run("git", ["commit", "-qm", "feature"], target);

    const sourceRepo = await discoverRepo(executor, source);
    const targetRepo = await discoverRepo(executor, target);
    const timestamp = nowIso();
    const record: ManagedWorktree = {
      id: newId(),
      repoId: "github.com/owner/repo",
      repoKey: "repo",
      repoCommonDir: sourceRepo.commonDir,
      path: targetRepo.root,
      branch: "wt/topic",
      sourcePath: sourceRepo.root,
      sourceBranch: "develop",
      sourceHead: sourceRepo.head,
      relativeCwd: "",
      task: "topic",
      slug: "topic",
      state: "active",
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    let publishedHead = "";
    let returnedPrUrl = "https://github.com/owner/repo/pull/1";
    let returnedHeadRepository = "owner/repo";
    const fakePi = {
      async exec(command: string, args: string[], options?: { cwd?: string; timeout?: number }) {
        if (command === "gh") {
          if (args[0] === "--version" || (args[0] === "auth" && args[1] === "status")) {
            return { stdout: "ok\n", stderr: "", code: 0, killed: false };
          }
          if (args[0] === "pr" && args[1] === "view") {
            return {
              stdout: JSON.stringify({
                url: returnedPrUrl,
                state: "OPEN",
                title: "Topic",
                body: "Body",
                isDraft: false,
                headRefName: "wt/topic",
                baseRefName: "develop",
                headRefOid: publishedHead,
                headRepository: { nameWithOwner: returnedHeadRepository },
              }),
              stderr: "",
              code: 0,
              killed: false,
            };
          }
          return { stdout: "[]", stderr: "", code: 0, killed: false };
        }
        if (command === "git" && args[0] === "remote" && args[1] === "get-url") {
          return { stdout: "https://github.com/owner/repo.git\n", stderr: "", code: 0, killed: false };
        }
        return executor.exec(command, args, options);
      },
    } as unknown as ExtensionAPI;
    const config = {
      version: 1,
      locale: "en",
      worktreeRoot: join(root, "worktrees"),
      branchPrefix: "wt/",
      launcher: { mode: "none" },
      defaults: { draftPr: false, launch: false, missingPostCreate: "skip", historyRetentionDays: 30, logRetentionDays: 7 },
      pr: {},
      hooks: { postCreate: [], preFinish: [], prePr: [], preMerge: [] },
      layers: [],
      provenance: {},
    } satisfies EffectiveConfig;
    const registry = new Registry(join(root, "agent"));
    const plan = await createPrPlan({ pi: fakePi, registry, record, config, sourceHead: sourceRepo.head });
    expect(plan.baseRepo).toBe("github.com/owner/repo");
    expect(plan.pushRemote).toBe("origin");

    await run("git", ["config", "--unset", "branch.develop.remote"], source);
    await run("git", ["config", "--unset", "branch.develop.merge"], source);
    const selections: string[] = [];
    const noUpstreamPlan = await createPrPlan({
      pi: fakePi,
      registry,
      record,
      config,
      sourceHead: sourceRepo.head,
      select: async (title, choices) => {
        selections.push(title);
        return choices[0];
      },
    });
    expect(noUpstreamPlan.baseBranch).toBe("develop");
    expect(selections[0]).toMatch(/no upstream/);

    await run("git", ["push", "--set-upstream", "origin", "HEAD:refs/heads/wt/topic"], target);
    publishedHead = await currentHead(executor, target);
    const info = await verifyPublishedPr(fakePi, target, plan, publishedHead, "https://github.com/owner/repo/pull/1");
    expect(info.url).toContain("/pull/1");

    returnedPrUrl = "http://github.com/owner/repo/pull/1";
    await expect(verifyPublishedPr(fakePi, target, plan, publishedHead, returnedPrUrl)).rejects.toThrow(/approved base repository/);
    returnedPrUrl = "https://github.com/owner/repo/pull/1";
    returnedHeadRepository = "attacker/repo";
    await expect(verifyPublishedPr(fakePi, target, plan, publishedHead, returnedPrUrl)).rejects.toThrow(/approved push repository/);
  });
});
