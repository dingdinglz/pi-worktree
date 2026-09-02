import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalPath, parseCommandLine, redactSecrets, safeRepoSegment, shellQuote, slugifyTask, withFileLock } from "../src/util.ts";
import { parseArgs } from "../src/cli.ts";

describe("utility helpers", () => {
  it("slugifies ASCII and safely falls back for non-ASCII tasks", () => {
    expect(slugifyTask("Implement Token Refresh!")).toBe("implement-token-refresh");
    expect(slugifyTask("实现登录", new Date(2026, 8, 2, 7, 8, 9))).toBe("20260902-070809");
    expect(safeRepoSegment("..")).toBe("repo");
  });

  it("parses quoted command arguments", () => {
    expect(parseCommandLine(`new "task with spaces" --branch 'wt/task'`)).toEqual([
      "new",
      "task with spaces",
      "--branch",
      "wt/task",
    ]);
    const parsed = parseArgs(`task --branch "wt/a b" --no-launch`, new Set(["branch"]));
    expect(parsed.positional).toEqual(["task"]);
    expect(parsed.flags.get("branch")).toBe("wt/a b");
    expect(parsed.flags.get("no-launch")).toBe(true);
  });

  it("canonicalizes the deepest existing ancestor before appending missing segments", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-wt-util-"));
    try {
      const real = join(root, "real");
      await mkdir(real);
      await symlink(real, join(root, "link"));
      expect(await canonicalPath(join(root, "link", "missing", "child"), true)).toBe(join(await realpath(real), "missing", "child"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reclaims a lock owned by a dead process", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-wt-lock-"));
    try {
      const path = join(root, "state.lock");
      await writeFile(path, JSON.stringify({ pid: 2_147_483_647 }));
      let entered = false;
      await withFileLock(path, async () => {
        entered = true;
      });
      expect(entered).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("quotes shell values and redacts common credentials", () => {
    expect(shellQuote("a'b")).toBe("'a'\\''b'");
    expect(redactSecrets("Authorization: Bearer abc123 token=hello")).toBe(
      "Authorization: Bearer [REDACTED] token=[REDACTED]",
    );
    expect(redactSecrets("ghp_abcdefghijklmnopqrstuvwxyz123456")).toContain("REDACTED_GITHUB_TOKEN");
    expect(redactSecrets("https://user:password@example.com/repo?access_token=secret")).toBe(
      "https://[REDACTED]@example.com/repo?access_token=[REDACTED]",
    );
    expect(redactSecrets("safe\u001b[31m\rtext\nnext")).toBe("safe�[31m�text\nnext");
  });
});
