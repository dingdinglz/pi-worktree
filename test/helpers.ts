import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import type { ExecLike } from "../src/git.ts";

const execFileAsync = promisify(execFile);

export const executor: ExecLike = {
  async exec(command, args, options = {}) {
    try {
      const result = await execFileAsync(command, args, {
        cwd: options.cwd,
        timeout: options.timeout,
        encoding: "utf8",
        maxBuffer: 10 * 1024 * 1024,
      });
      return { stdout: result.stdout, stderr: result.stderr, code: 0, killed: false };
    } catch (error) {
      const item = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number | string; killed?: boolean };
      return {
        stdout: item.stdout ?? "",
        stderr: item.stderr ?? item.message,
        code: typeof item.code === "number" ? item.code : 1,
        killed: item.killed ?? false,
      };
    }
  },
};

export async function tempDir(prefix = "pi-worktree-test-"): Promise<string> {
  return mkdtemp(`${tmpdir()}/${prefix}`);
}

export async function run(command: string, args: string[], cwd?: string): Promise<string> {
  const result = await executor.exec(command, args, { cwd });
  if (result.code !== 0) throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

export async function initRepo(path: string, branch = "main"): Promise<void> {
  await run("git", ["init", "-q", "-b", branch, path]);
  await run("git", ["config", "user.name", "pi-worktree test"], path);
  await run("git", ["config", "user.email", "test@example.com"], path);
}
