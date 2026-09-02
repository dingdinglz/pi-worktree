import { describe, expect, it } from "vitest";
import { prCommands } from "../src/github.ts";

describe("GitHub command plans", () => {
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
    });
    expect(commands.push).toContain("GIT_TERMINAL_PROMPT=0");
    expect(commands.push).toContain("--force-with-lease=refs/heads/wt/topic:abc123");
    expect(commands.push).toContain("HEAD:refs/heads/wt/topic");
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
    });
    expect(commands.create).toBeUndefined();
    expect(commands.edit).toContain("'pr' 'edit'");
    expect(commands.draftStatus).toContain("'pr' 'ready'");
    expect(commands.draftStatus).not.toContain("--undo");
  });
});
