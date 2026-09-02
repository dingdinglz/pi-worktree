import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectSetupManifests } from "../src/ai-config.ts";
import { tempDir } from "./helpers.ts";

const cleanup: string[] = [];
afterEach(async () => Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

describe("AI setup manifest allowlist", () => {
  it("redacts known credentials, caps files, and refuses allowlisted symlinks", async () => {
    const root = await tempDir();
    cleanup.push(root);
    await mkdir(join(root, "project"));
    const project = join(root, "project");
    const secret = join(root, "secret.txt");
    await writeFile(secret, "DO_NOT_READ");
    await symlink(secret, join(project, "README.md"));
    await writeFile(
      join(project, "package.json"),
      JSON.stringify({ token: "github_pat_abcdefghijklmnopqrstuvwxyz123456", padding: "x".repeat(30_000) }),
    );

    const manifests = await collectSetupManifests(project);
    expect(manifests).toContain("package.json");
    expect(manifests).toContain("REDACTED");
    expect(manifests).toContain("file truncated");
    expect(manifests).not.toContain("github_pat_");
    expect(manifests).not.toContain("DO_NOT_READ");
  });
});
