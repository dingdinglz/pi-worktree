import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { findPullRequests, prCommands, validatePrPlanRemotes } from "../src/github.ts";
import type { PrPlan } from "../src/types.ts";

describe("GitHub command plans", () => {
  it.each([
    "https://github.com/unapproved/repo.git\n",
    "https://github.com/owner/repo.git\nhttps://github.com/unapproved/repo.git\n",
  ])("refuses a push URL that can publish to an unapproved repository", async (pushUrls) => {
    const pi = {
      async exec(_command: string, args: string[]) {
        return {
          stdout: args.includes("--push") ? pushUrls : "https://github.com/owner/repo.git\n",
          stderr: "", code: 0, killed: false,
        };
      },
    } as unknown as ExtensionAPI;
    const plan: PrPlan = {
      host: "github.com", baseRepo: "github.com/owner/repo", baseRemote: "origin",
      baseBranch: "main", pushRemote: "origin", pushRepo: "github.com/owner/repo",
      headBranch: "wt/topic", headOwner: "owner",
    };
    await expect(validatePrPlanRemotes(pi, "/work", "/source", plan)).rejects.toThrow(/push/i);
  });

  it("ignores PRs whose head repository was deleted instead of crashing", async () => {
    const pi = {
      async exec() {
        return {
          stdout: JSON.stringify([{
            url: "https://github.com/owner/repo/pull/1", state: "MERGED", title: "Topic", body: "Body", isDraft: false,
            headRefName: "wt/topic", baseRefName: "main", headRefOid: "a".repeat(40), headRepository: null,
          }]),
          stderr: "", code: 0, killed: false,
        };
      },
    } as unknown as ExtensionAPI;
    await expect(findPullRequests(pi, "/work", {
      host: "github.com", baseRepo: "github.com/owner/repo", baseRemote: "origin",
      baseBranch: "main", pushRemote: "origin", pushRepo: "github.com/owner/repo",
      headBranch: "wt/topic", headOwner: "owner",
    })).resolves.toEqual([]);
  });

  it("uses explicit refs and exact force-with-lease", () => {
    const commands = prCommands({
      host: "github.com",
      baseRepo: "github.com/base/repo",
      baseRemote: "upstream",
      baseBranch: "develop",
      pushRemote: "origin",
      pushRepo: "github.com/fork/repo",
      headOwner: "fork",
      headBranch: "wt/topic",
      forceLeaseSha: "abc123",
      title: "A safe title",
      bodyFile: "/tmp/body file.md",
      draft: true,
    }, "a".repeat(40));
    expect(commands.push).toContain("GIT_TERMINAL_PROMPT=0");
    expect(commands.push).toContain("--force-with-lease=refs/heads/wt/topic:abc123");
    expect(commands.push).toContain(`${"a".repeat(40)}^{commit}:refs/heads/wt/topic`);
    expect(commands.push).not.toContain("HEAD:");
    expect(commands.create).toContain("'fork:wt/topic'");
    expect(commands.create).toContain("GH_PROMPT_DISABLED=1");
    expect(commands.create).toContain("--body-file");
    expect(commands.create).toContain("--draft");
  });

  it("edits an existing PR and changes draft status only when needed", () => {
    const commands = prCommands({
      host: "github.com",
      baseRepo: "github.com/base/repo",
      baseRemote: "upstream",
      baseBranch: "develop",
      pushRemote: "origin",
      pushRepo: "github.com/fork/repo",
      headOwner: "fork",
      headBranch: "wt/topic",
      existingUrl: "https://github.com/base/repo/pull/1",
      existingIsDraft: true,
      title: "Updated",
      bodyFile: "/tmp/body.md",
      draft: false,
    }, "a".repeat(40));
    expect(commands.create).toBeUndefined();
    expect(commands.edit).toContain("'pr' 'edit'");
    expect(commands.draftStatus).toContain("'pr' 'ready'");
    expect(commands.draftStatus).not.toContain("--undo");
  });
});
