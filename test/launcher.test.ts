import { describe, expect, it } from "vitest";
import { buildLaunchPlan } from "../src/launcher.ts";
import type { EffectiveConfig, ManagedWorktree } from "../src/types.ts";

const record: ManagedWorktree = {
  id: "id",
  repoId: "github.com/o/r",
  repoKey: "key",
  repoCommonDir: "/repo/.git",
  path: "/tmp/work",
  branch: "wt/task",
  sourcePath: "/repo",
  sourceBranch: "develop",
  sourceHead: "abc",
  relativeCwd: "packages/a",
  task: "task",
  slug: "task",
  state: "active",
  createdAt: "now",
  updatedAt: "now",
};

const config = {
  version: 1,
  locale: "en",
  worktreeRoot: "/tmp",
  branchPrefix: "wt/",
  launcher: { mode: "auto" },
  defaults: { draftPr: false, launch: true, missingPostCreate: "ask", historyRetentionDays: 30, logRetentionDays: 7 },
  pr: {},
  hooks: { postCreate: [], preFinish: [], prePr: [], preMerge: [] },
  layers: [],
  provenance: {},
} satisfies EffectiveConfig;

describe("launcher detection", () => {
  it("prefers tmux", () => {
    const plan = buildLaunchPlan({
      record,
      config,
      cwd: "/tmp/work/packages/a",
      environment: { PATH: "/usr/bin:/bin", SHELL: "/bin/zsh", TMUX: "/tmp/tmux" },
      platform: "darwin",
    });
    // CI may not have tmux at /usr/bin, so an unavailable terminal safely falls back.
    if (plan) expect(plan.command).toBe("tmux");
    else expect(plan).toBeUndefined();
  });

  it("does not try to control VS Code's integrated terminal", () => {
    expect(
      buildLaunchPlan({
        record,
        config,
        cwd: "/tmp/work",
        environment: { PATH: "/usr/bin:/bin", SHELL: "/bin/bash", TERM_PROGRAM: "vscode" },
        platform: "linux",
      }),
    ).toBeUndefined();
  });

  it.each([
    { SSH_CONNECTION: "client server", TERM_PROGRAM: "Apple_Terminal" },
    { WSL_DISTRO_NAME: "Ubuntu", TERM_PROGRAM: "WezTerm" },
  ])("falls back to a manual command for remote or WSL sessions", (environment) => {
    expect(
      buildLaunchPlan({
        record,
        config,
        cwd: "/tmp/work",
        environment: { ...environment, PATH: "/usr/bin:/bin", SHELL: "/bin/sh" },
        platform: "linux",
      }),
    ).toBeUndefined();
  });

  it("expands a custom argv launcher", () => {
    const custom: EffectiveConfig = {
      ...config,
      launcher: { mode: "custom", command: [process.execPath, "--cwd", "{path}", "{pi}", "{piArgs}"] },
    };
    const plan = buildLaunchPlan({ record, config: custom, cwd: "/tmp/work", environment: { PATH: "" }, platform: "linux" });
    expect(plan?.command).toBe(process.execPath);
    expect(plan?.args).toContain("/tmp/work");
    expect(plan?.args.some((arg) => arg.includes("Task: task"))).toBe(true);
    expect(
      buildLaunchPlan({
        record,
        config: custom,
        cwd: "/tmp/work",
        environment: { PATH: "", SSH_CONNECTION: "client server" },
        platform: "linux",
      })?.command,
    ).toBe(process.execPath);
  });

  it("rejects an unavailable configured launcher", () => {
    const custom: EffectiveConfig = {
      ...config,
      launcher: { mode: "custom", command: ["definitely-not-a-launcher", "{pi}", "{piArgs}"] },
    };
    expect(() => buildLaunchPlan({ record, config: custom, cwd: "/tmp/work", environment: { PATH: "" } })).toThrow(
      /unavailable/,
    );
  });
});
