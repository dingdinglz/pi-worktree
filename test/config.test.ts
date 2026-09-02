import { mkdir, rm, stat, symlink } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ConfigValidationError,
  getConfigPaths,
  loadEffectiveConfig,
  saveConfig,
  validateConfig,
} from "../src/config.ts";
import { tempDir } from "./helpers.ts";

const cleanup: string[] = [];
afterEach(async () => Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

async function configTempDir(): Promise<string> {
  const path = await tempDir();
  cleanup.push(path);
  return path;
}

describe("configuration", () => {
  it("merges scalar layers and explicit hook modes", async () => {
    const root = await configTempDir();
    const agentDir = join(root, "agent");
    const project = join(root, "project");
    await mkdir(join(project, ".pi"), { recursive: true });
    const paths = getConfigPaths("repo-key", project, agentDir);
    await saveConfig(
      paths.global,
      {
        version: 1,
        branchPrefix: "work/",
        hooks: { preFinish: [{ command: "global-check" }] },
      },
      "global",
    );
    await saveConfig(
      paths.repo,
      {
        version: 1,
        hooks: { preFinish: { merge: "append", steps: [{ command: "repo-check" }] } },
      },
      "repo",
    );
    await saveConfig(
      paths.project,
      {
        version: 1,
        hooks: { prePr: [{ command: "project-pr-check" }] },
      },
      "project",
    );
    const config = await loadEffectiveConfig({ repoKey: "repo-key", projectRoot: project, projectTrusted: true, agentDir });
    expect((await stat(paths.repo)).mode & 0o777).toBe(0o600);
    expect((await stat(join(agentDir, "worktree", "repos"))).mode & 0o777).toBe(0o700);
    expect(config.branchPrefix).toBe("work/");
    expect(config.hooks.preFinish.map((step) => step.command)).toEqual(["global-check", "repo-check"]);
    expect(config.hooks.prePr.map((step) => step.command)).toEqual(["project-pr-check"]);
    expect(config.provenance["hooks.prePr"]).toBe(paths.project);
  });

  it("rejects a layered custom launcher that loses required pi placeholders", async () => {
    const root = await configTempDir();
    const agentDir = join(root, "agent");
    const project = join(root, "project");
    const paths = getConfigPaths("repo-key", project, agentDir);
    await saveConfig(
      paths.global,
      { version: 1, launcher: { mode: "custom", command: ["terminal", "{pi}", "{piArgs}"] } },
      "global",
    );
    await saveConfig(paths.repo, { version: 1, launcher: { command: ["terminal", "--new-tab"] } }, "repo");
    await expect(
      loadEffectiveConfig({ repoKey: "repo-key", projectRoot: project, projectTrusted: false, agentDir }),
    ).rejects.toThrow(/must include \{pi\}/);
  });

  it("does not load untrusted project config", async () => {
    const root = await configTempDir();
    const agentDir = join(root, "agent");
    const project = join(root, "project");
    const paths = getConfigPaths("repo-key", project, agentDir);
    await saveConfig(paths.project, { version: 1, branchPrefix: "evil/" }, "project");
    const config = await loadEffectiveConfig({ repoKey: "repo-key", projectRoot: project, projectTrusted: false, agentDir });
    expect(config.branchPrefix).toBe("wt/");
  });

  it("refuses a symlink-diverted project configuration directory", async () => {
    const root = await configTempDir();
    const project = join(root, "project");
    const external = join(root, "external");
    await mkdir(project, { recursive: true });
    await mkdir(external, { recursive: true });
    await symlink(external, join(project, ".pi"));
    const paths = getConfigPaths("repo-key", project, join(root, "agent"));
    await expect(saveConfig(paths.project, { version: 1 }, "project")).rejects.toThrow(/symlink-diverted/);
  });

  it("strictly rejects unknown keys and project launchers", () => {
    expect(() => validateConfig({ version: 1, surprise: true })).toThrow(ConfigValidationError);
    expect(() => validateConfig({ version: 1, launcher: { mode: "auto" } }, "project.json", "project")).toThrow(
      /cannot define launcher/,
    );
    expect(() =>
      validateConfig({ version: 1, hooks: { preFinish: [{ command: "x", shell: true, args: ["bad"] }] } }),
    ).toThrow(/shell steps/);
    expect(() =>
      validateConfig({ version: 1, launcher: { mode: "custom", command: ["terminal", "{path}"] } }),
    ).toThrow(/must include \{pi\}/);
    expect(() =>
      validateConfig({ version: 1, hooks: { postCreate: [{ command: "x", env: { PI_WT_PATH: "spoofed" } }] } }),
    ).toThrow(/reserved/);
  });
});
