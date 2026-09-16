import { describe, expect, it } from "vitest";
import { formatHookCommand, parseHookCommand, validatePostCreateSteps } from "../src/hook-commands.ts";
import { describeHookStep } from "../src/hooks.ts";
import type { HookStep } from "../src/types.ts";

describe("hook command lines", () => {
  it.each([
    ["pnpm install --frozen-lockfile", { command: "pnpm", args: ["install", "--frozen-lockfile"] }],
    ['npm run "build assets" -- --name=\'hello world\'', { command: "npm", args: ["run", "build assets", "--", "--name=hello world"] }],
    [String.raw`echo a\ b '' "" 'it'\''s'`, { command: "echo", args: ["a b", "", "", "it's"] }],
    [String.raw`echo "C:\path\file" "\$HOME" "a\\b\"c"`, { command: "echo", args: ["C:\\path\\file", "$HOME", 'a\\b"c'] }],
    ["  node\t--version  ", { command: "node", args: ["--version"] }],
    ["sh -c 'npm install && npm run build'", { command: "sh", args: ["-c", "npm install && npm run build"] }],
    ["env NODE_ENV=test npm test", { command: "env", args: ["NODE_ENV=test", "npm", "test"] }],
    [String.raw`echo $'one\ntwo\t\x41\u4e2d\'\\'`, { command: "echo", args: ["one\ntwo\tA中'\\"] }],
  ])("parses %s without executing shell syntax", (line, expected) => {
    expect(parseHookCommand(line)).toEqual(expected);
  });

  it("formats ordinary commands simply and round-trips quoted arguments losslessly", () => {
    expect(formatHookCommand({ command: "pnpm", args: ["install", "--frozen-lockfile"] })).toBe("pnpm install --frozen-lockfile");
    const step = {
      command: "/path with spaces/tool",
      args: ["", "plain", "with spaces", "中文 🚀", "a'b", 'a"b', "a\\b", "$HOME", "$(whoami)", "*", ";", "&&", "a\nb\t\x1b\x7f\x9b'\\"],
    };
    const line = formatHookCommand(step);
    expect(line).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
    expect(parseHookCommand(line)).toEqual(step);
  });

  it("keeps argument boundaries visible in the final execution review", () => {
    expect(describeHookStep({ command: "echo", args: ["hello world", ""] }))
      .toBe("echo 'hello world' '' (timeout=900000ms)");
    expect(describeHookStep({ command: "echo a && echo b", shell: true }))
      .toBe("[shell] echo a && echo b (timeout=900000ms)");
  });

  it("preserves timeout, environment, and execution mode while editing", () => {
    const previous: HookStep = { command: "npm", args: ["install"], timeoutMs: 12_345, env: { CI: "1" }, shell: false };
    expect(parseHookCommand("pnpm install --offline", previous)).toEqual({
      ...previous, command: "pnpm", args: ["install", "--offline"],
    });
    expect(previous.args).toEqual(["install"]);
    const shell: HookStep = { command: "echo first && echo second", shell: true, timeoutMs: 1000 };
    expect(formatHookCommand(shell)).toBe(shell.command);
    expect(parseHookCommand("echo changed | sort", shell)).toEqual({ ...shell, command: "echo changed | sort" });
  });

  it.each([
    "", "   ", "''", "npm 'install", 'npm "install', "npm install\\", "npm install\nnpm test", "npm\x1b[31m install",
    "npm install && npm test", "npm install;npm test", "echo hi | tee file", "echo hi > file", "echo `whoami`",
    "echo $(whoami)", 'echo "$HOME"', "echo ~/file", "echo *.ts", "echo {a,b}", "echo # comment", "NODE_ENV=test npm test",
    String.raw`echo $'\q'`, String.raw`echo $'\u0000'`,
  ])("rejects invalid or implicit shell input: %j", (line) => {
    expect(() => parseHookCommand(line)).toThrow();
  });

  it("enforces config and size limits on parsed commands and the whole list", () => {
    expect(() => parseHookCommand("x".repeat(8193))).toThrow("command");
    expect(() => parseHookCommand(`echo ${"a ".repeat(257)}`)).toThrow("args");
    expect(() => parseHookCommand(" ".repeat(2 * 1024 * 1024 + 1))).toThrow("2 MiB");
    expect(() => parseHookCommand("npm test", { command: "npm", timeoutMs: -1 })).toThrow("timeoutMs");
    expect(() => parseHookCommand("npm test", { command: "npm", env: { PI_WT_PATH: "spoofed" } })).toThrow("reserved");
    expect(() => validatePostCreateSteps(Array.from({ length: 1025 }, () => ({ command: "npm" })))).toThrow("1024");
    expect(() => validatePostCreateSteps([{ command: "echo", args: Array(256).fill("x".repeat(32768)) }])).toThrow("2 MiB");
    expect(() => validatePostCreateSteps([])).not.toThrow();
  });
});
