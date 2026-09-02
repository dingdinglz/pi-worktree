import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";

export function assertSupportedPlatform(platform: NodeJS.Platform = process.platform): void {
  if (platform === "win32") {
    throw new Error("Native Windows is not supported. Use macOS, Linux, or WSL for mutating pi-worktree commands.");
  }
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function newId(): string {
  return randomUUID();
}

export function shortHash(value: string, length = 8): string {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}

export function expandHome(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith(`~${sep}`) || value.startsWith("~/")) return join(homedir(), value.slice(2));
  return value;
}

export function resolveConfiguredPath(value: string): string {
  const expanded = expandHome(value);
  if (!isAbsolute(expanded)) throw new Error(`Path must be absolute or start with ~: ${value}`);
  return resolve(expanded);
}

export async function canonicalPath(value: string, allowMissing = false): Promise<string> {
  const absolute = resolve(expandHome(value));
  try {
    return await realpath(absolute);
  } catch (error) {
    if (!allowMissing) throw error;
    const missing: string[] = [];
    let ancestor = absolute;
    while (true) {
      try {
        const canonicalAncestor = await realpath(ancestor);
        return join(canonicalAncestor, ...missing);
      } catch (ancestorError) {
        const code = (ancestorError as NodeJS.ErrnoException).code;
        if (code !== "ENOENT" && code !== "ENOTDIR") throw ancestorError;
        const parent = dirname(ancestor);
        if (parent === ancestor) throw error;
        missing.unshift(ancestor.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
        ancestor = parent;
      }
    }
  }
}

export function isPathInside(candidate: string, parent: string): boolean {
  const normalizedCandidate = resolve(candidate);
  const normalizedParent = resolve(parent);
  return normalizedCandidate === normalizedParent || normalizedCandidate.startsWith(`${normalizedParent}${sep}`);
}

export async function pathExists(value: string): Promise<boolean> {
  try {
    await lstat(value);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export async function isDirectoryEmpty(value: string): Promise<boolean> {
  try {
    const info = await lstat(value);
    if (!info.isDirectory() || info.isSymbolicLink()) return false;
    return (await readdir(value)).length === 0;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
}

export async function readTextFileSafe(path: string, maxBytes = 2 * 1024 * 1024): Promise<string | undefined> {
  try {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw new Error(`Path is not a regular file: ${path}`);
      if (info.size > maxBytes) throw new Error(`File exceeds the ${maxBytes}-byte safety limit: ${path}`);
      return await handle.readFile("utf8");
    } finally {
      await handle.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function readJsonFile<T>(path: string): Promise<T | undefined> {
  const text = await readTextFileSafe(path);
  return text === undefined ? undefined : JSON.parse(text) as T;
}

export async function writeJsonAtomic(path: string, value: unknown, mode = 0o600): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const text = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(text, "utf8") > 2 * 1024 * 1024) {
    throw new Error(`JSON output exceeds the 2 MiB safety limit: ${path}`);
  }
  const handle = await open(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    mode,
  );
  try {
    try {
      await handle.writeFile(text, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  try {
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  try {
    const { chmod } = await import("node:fs/promises");
    await chmod(path, mode);
  } catch {
    // Best effort on filesystems without POSIX permissions.
  }
}

async function readLockPid(lockPath: string): Promise<number> {
  const handle = await open(lockPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > 4_096) throw new Error("Unsafe lock file");
    const data = JSON.parse(await handle.readFile("utf8")) as { pid?: unknown };
    return typeof data.pid === "number" ? data.pid : 0;
  } finally {
    await handle.close();
  }
}

async function processIsAlive(pid: number): Promise<boolean> {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export async function withFileLock<T>(lockPath: string, fn: () => Promise<T>, timeoutMs = 10_000): Promise<T> {
  await mkdir(dirname(lockPath), { recursive: true });
  const started = Date.now();
  let ownedLock: { dev: number; ino: number } | undefined;
  while (true) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      let createdLock: { dev: number; ino: number } | undefined;
      try {
        const info = await handle.stat();
        createdLock = { dev: info.dev, ino: info.ino };
        await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: nowIso() }));
      } catch (error) {
        try {
          const current = await stat(lockPath);
          if (createdLock && current.dev === createdLock.dev && current.ino === createdLock.ino) {
            await rm(lockPath, { force: true });
          }
        } catch {
          // The failed lock entry was already removed or replaced.
        }
        throw error;
      } finally {
        await handle.close();
      }
      ownedLock = createdLock;
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const observed = await stat(lockPath);
        let stale = false;
        try {
          stale = !(await processIsAlive(await readLockPid(lockPath)));
        } catch {
          stale = Date.now() - observed.mtimeMs > 60_000;
        }
        if (stale) {
          const current = await stat(lockPath);
          if (current.dev === observed.dev && current.ino === observed.ino && current.mtimeMs === observed.mtimeMs) {
            await rm(lockPath, { force: true });
          }
          continue;
        }
      } catch {
        // The lock disappeared or is an unsafe special entry; retry without spinning forever.
        if (Date.now() - started >= timeoutMs) throw new Error(`Timed out waiting for lock: ${lockPath}`);
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
        continue;
      }
      if (Date.now() - started >= timeoutMs) throw new Error(`Timed out waiting for lock: ${lockPath}`);
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
    }
  }

  try {
    return await fn();
  } finally {
    try {
      const current = await stat(lockPath);
      if (ownedLock && current.dev === ownedLock.dev && current.ino === ownedLock.ino) {
        await rm(lockPath, { force: true });
      }
    } catch {
      // Already released or externally removed.
    }
  }
}

export async function withFileLocks<T>(lockPaths: string[], fn: () => Promise<T>, timeoutMs = 10_000): Promise<T> {
  const ordered = [...new Set(lockPaths)].sort();
  const acquire = (index: number): Promise<T> =>
    index >= ordered.length ? fn() : withFileLock(ordered[index], () => acquire(index + 1), timeoutMs);
  return acquire(0);
}

export function shellQuote(value: string): string {
  if (value.length === 0) return "''";
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function truncateText(value: string, maxBytes = 50 * 1024): string {
  const encoded = Buffer.from(value, "utf8");
  if (encoded.length <= maxBytes) return value;
  let start = Math.max(0, encoded.length - Math.max(0, maxBytes));
  while (start < encoded.length && (encoded[start] & 0xc0) === 0x80) start++;
  return `[earlier output truncated]\n${encoded.subarray(start).toString("utf8")}`;
}

export function sanitizeForDisplay(value: string): string {
  return value.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "�");
}

export function redactSecrets(value: string): string {
  const redacted = value
    .replace(/-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\r\n]*PRIVATE KEY-----/g, "[REDACTED_PRIVATE_KEY]")
    .replace(/\b(gh[opsu]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, "[REDACTED_GITHUB_TOKEN]")
    .replace(/\b(AKIA[0-9A-Z]{16})\b/g, "[REDACTED_AWS_ACCESS_KEY]")
    .replace(/\b(sk-[A-Za-z0-9_-]{20,})\b/g, "[REDACTED_API_KEY]")
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi, "$1[REDACTED]@")
    .replace(/([?&](?:access_token|token|api_key|key)=)[^&#\s]+/gi, "$1[REDACTED]")
    .replace(/(["']?(?:token|password|passwd|secret|api[_-]?key|access[_-]?key|credential)["']?\s*:\s*["'])[^"']+(["'])/gi, "$1[REDACTED]$2")
    .replace(/((?:token|password|passwd|secret|api[_-]?key|access[_-]?key|credential)\s*[=:]\s*)[^\s"']+/gi, "$1[REDACTED]")
    .replace(/(Authorization:\s*(?:Bearer|token)\s+)[^\s]+/gi, "$1[REDACTED]");
  return sanitizeForDisplay(redacted);
}

export function parseCommandLine(input: string): string[] {
  const result: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;
  let started = false;
  for (const char of input) {
    if (escaped) {
      current += char;
      escaped = false;
      started = true;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaped = true;
      started = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = undefined;
      else current += char;
      started = true;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      started = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (started) {
        result.push(current);
        current = "";
        started = false;
      }
      continue;
    }
    current += char;
    started = true;
  }
  if (escaped) current += "\\";
  if (quote) throw new Error("Unterminated quote in command arguments");
  if (started) result.push(current);
  return result;
}

export function slugifyTask(task: string, date = new Date()): string {
  const normalized = task
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
  if (normalized) return normalized;
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

export function safeRepoSegment(value: string): string {
  const segment = value.replace(/\.git$/i, "").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return !segment || segment === "." || segment === ".." ? "repo" : segment;
}
