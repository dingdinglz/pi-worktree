import { describe, expect, it } from "vitest";
import { parseRemoteUrl, parseWorktreePorcelain } from "../src/git.ts";

describe("Git parsing", () => {
  it.each([
    ["git@github.com:owner/repo.git", "github.com/owner/repo"],
    ["https://github.com/owner/repo.git", "github.com/owner/repo"],
    ["ssh://git@git.example.com/team/repo.git", "git.example.com/team/repo"],
  ])("parses remote %s", (url, expected) => {
    expect(parseRemoteUrl("origin", url)?.repoSpec).toBe(expected);
  });

  it("does not retain HTTP credentials from remote URLs", () => {
    const identity = parseRemoteUrl("origin", "https://user:github_pat_abcdefghijklmnopqrstuvwxyz@github.com/owner/repo.git");
    expect(identity?.repoSpec).toBe("github.com/owner/repo");
    expect(identity?.url).not.toContain("github_pat_");
  });

  it("parses NUL-delimited worktree porcelain", () => {
    const output = [
      "worktree /repo",
      "HEAD aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "branch refs/heads/main",
      "",
      "worktree /repo-wt",
      "HEAD bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "detached",
      "",
    ].join("\0");
    expect(parseWorktreePorcelain(output)).toEqual([
      {
        path: "/repo",
        head: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        branch: "main",
        detached: false,
        bare: false,
      },
      {
        path: "/repo-wt",
        head: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        detached: true,
        bare: false,
      },
    ]);
  });
});
