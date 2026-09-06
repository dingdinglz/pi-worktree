import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { ExecOptions, ExecResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type {
  GitWorktreeEntry,
  RemoteIdentity,
  RepoInfo,
  UpstreamInfo,
} from "./types.ts";
import { canonicalPath, pathExists, redactSecrets, safeRepoSegment, shortHash, truncateText } from "./util.ts";

export type ExecLike = Pick<ExtensionAPI, "exec">;

export class GitError extends Error {
  readonly args: string[];
  readonly result: ExecResult;

  constructor(message: string, args: string[], result: ExecResult) {
    const safeResult = {
      ...result,
      stdout: redactSecrets(result.stdout),
      stderr: redactSecrets(result.stderr),
    };
    super(`${message}: ${safeResult.stderr.trim() || safeResult.stdout.trim() || `git exited ${safeResult.code}`}`);
    this.name = "GitError";
    this.args = args;
    this.result = safeResult;
  }
}

export async function git(
  executor: ExecLike,
  cwd: string,
  args: string[],
  options: Omit<ExecOptions, "cwd"> = {},
): Promise<ExecResult> {
  return executor.exec("git", args, { ...options, cwd });
}

export async function gitOk(
  executor: ExecLike,
  cwd: string,
  args: string[],
  message = `git ${args[0] ?? "command"} failed`,
  options: Omit<ExecOptions, "cwd"> = {},
): Promise<string> {
  const result = await git(executor, cwd, args, options);
  if (result.code !== 0) throw new GitError(message, args, result);
  return result.stdout.trim();
}

export function parseRemoteUrl(remote: string, url: string): RemoteIdentity | undefined {
  let host = "";
  let pathname = "";
  const scp = url.match(/^(?:[^@/]+@)?([^:/]+):(.+)$/);
  if (scp && !url.includes("://")) {
    host = scp[1];
    pathname = scp[2];
  } else {
    try {
      const parsed = new URL(url);
      host = parsed.hostname;
      pathname = parsed.pathname.replace(/^\//, "");
    } catch {
      return undefined;
    }
  }
  const parts = pathname.replace(/\.git\/?$/i, "").split("/").filter(Boolean);
  if (!host || parts.length < 2) return undefined;
  const repo = parts.pop()!;
  const owner = parts.join("/");
  const safeUrl = url.includes("://")
    ? url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@]+@/i, "$1")
    : url.replace(/^(?:[^@/]+@)([^:/]+):/, "$1:");
  return {
    remote,
    url: redactSecrets(safeUrl),
    host: host.toLowerCase(),
    owner,
    repo,
    repoSpec: `${host.toLowerCase()}/${owner}/${repo}`,
  };
}

export async function getUpstream(executor: ExecLike, cwd: string, branch: string): Promise<UpstreamInfo | undefined> {
  const remoteResult = await git(executor, cwd, ["config", "--get", `branch.${branch}.remote`]);
  const mergeResult = await git(executor, cwd, ["config", "--get", `branch.${branch}.merge`]);
  if (remoteResult.code !== 0 || mergeResult.code !== 0) return undefined;
  const remote = remoteResult.stdout.trim();
  const mergeRef = mergeResult.stdout.trim();
  if (!remote || !mergeRef.startsWith("refs/heads/") || remote === ".") return undefined;
  const branchName = mergeRef.slice("refs/heads/".length);
  if ((await git(executor, cwd, ["check-ref-format", "--branch", branchName])).code !== 0) return undefined;
  const remoteUrlResult = await git(executor, cwd, ["remote", "get-url", "--", remote]);
  const remoteUrl = remoteUrlResult.code === 0 ? remoteUrlResult.stdout.trim() : undefined;
  return {
    remote,
    mergeRef,
    branch: branchName,
    short: `${remote}/${branchName}`,
    remoteUrl,
    identity: remoteUrl ? parseRemoteUrl(remote, remoteUrl) : undefined,
  };
}

async function chooseIdentity(
  executor: ExecLike,
  cwd: string,
  upstream?: UpstreamInfo,
): Promise<RemoteIdentity | undefined> {
  const remotes = (await git(executor, cwd, ["remote"])).stdout.trim().split("\n").filter(Boolean);
  const ordered = [
    remotes.includes("origin") ? "origin" : undefined,
    upstream?.remote,
    ...remotes,
  ].filter((remote, index, all): remote is string => Boolean(remote) && all.indexOf(remote) === index);
  for (const remote of ordered) {
    const result = await git(executor, cwd, ["remote", "get-url", "--", remote]);
    if (result.code !== 0) continue;
    const parsed = parseRemoteUrl(remote, result.stdout.trim());
    if (parsed) return parsed;
  }
  return undefined;
}

export async function discoverRepo(executor: ExecLike, cwd: string): Promise<RepoInfo> {
  const root = await gitOk(executor, cwd, ["rev-parse", "--show-toplevel"], "Not inside a non-bare Git worktree");
  const branchResult = await git(executor, root, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  const branch = branchResult.code === 0 ? branchResult.stdout.trim() : "";
  const headResult = await git(executor, root, ["rev-parse", "--verify", "HEAD"]);
  const head = headResult.code === 0 ? headResult.stdout.trim() : "";
  const gitDirRaw = await gitOk(executor, root, ["rev-parse", "--absolute-git-dir"]);
  let commonRaw: string;
  const absoluteCommon = await git(executor, root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (absoluteCommon.code === 0 && isAbsolute(absoluteCommon.stdout.trim())) commonRaw = absoluteCommon.stdout.trim();
  else {
    const relativeCommon = await gitOk(executor, root, ["rev-parse", "--git-common-dir"]);
    commonRaw = isAbsolute(relativeCommon) ? relativeCommon : resolve(root, relativeCommon);
  }
  const canonicalRoot = await canonicalPath(root);
  const gitDir = await canonicalPath(gitDirRaw);
  const commonDir = await canonicalPath(commonRaw);
  const upstream = branch ? await getUpstream(executor, canonicalRoot, branch) : undefined;
  const identity = await chooseIdentity(executor, canonicalRoot, upstream);
  const localName = safeRepoSegment(basename(dirname(commonDir) === canonicalRoot ? canonicalRoot : dirname(commonDir)));
  const repoId = identity?.repoSpec ?? `local/${localName}-${shortHash(commonDir)}`;
  const repoKeyBase = safeRepoSegment(repoId.replaceAll("/", "--")).slice(0, 200);
  const repoKey = `${repoKeyBase}-${shortHash(repoId)}`;
  return { root: canonicalRoot, gitDir, commonDir, branch, head, repoId, repoKey, identity, upstream };
}

export function repositoryNamespace(root: string, repo: RepoInfo): string {
  if (repo.identity) {
    return join(root, safeRepoSegment(repo.identity.host), ...repo.identity.owner.split("/").map(safeRepoSegment), safeRepoSegment(repo.identity.repo));
  }
  const suffix = repo.repoId.replace(/^local\//, "");
  return join(root, "local", safeRepoSegment(suffix));
}

export function parseWorktreePorcelain(output: string): GitWorktreeEntry[] {
  const records = output.split("\0\0").map((record) => record.replace(/^\0+|\0+$/g, "")).filter(Boolean);
  const result: GitWorktreeEntry[] = [];
  for (const record of records) {
    const fields = record.split("\0").filter(Boolean);
    const entry: GitWorktreeEntry = { path: "", head: "", detached: false, bare: false };
    for (const field of fields) {
      const separator = field.indexOf(" ");
      const key = separator === -1 ? field : field.slice(0, separator);
      const value = separator === -1 ? "" : field.slice(separator + 1);
      if (key === "worktree") entry.path = value;
      else if (key === "HEAD") entry.head = value;
      else if (key === "branch") entry.branch = value.replace(/^refs\/heads\//, "");
      else if (key === "detached") entry.detached = true;
      else if (key === "bare") entry.bare = true;
      else if (key === "prunable") entry.prunable = value;
      else if (key === "locked") entry.locked = value;
    }
    if (entry.path) result.push(entry);
  }
  return result;
}

export async function listWorktrees(executor: ExecLike, cwd: string): Promise<GitWorktreeEntry[]> {
  const output = await gitOk(executor, cwd, ["worktree", "list", "--porcelain", "-z"]);
  const entries = parseWorktreePorcelain(output);
  for (const entry of entries) {
    try {
      entry.path = await canonicalPath(entry.path, true);
    } catch {
      // Keep Git's path for stale entries.
    }
  }
  return entries;
}

export async function statusEntries(executor: ExecLike, cwd: string): Promise<string[]> {
  const result = await git(executor, cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  if (result.code !== 0) throw new GitError("Unable to inspect Git status", ["status"], result);
  return result.stdout.split("\0").filter(Boolean);
}

export async function isClean(executor: ExecLike, cwd: string): Promise<boolean> {
  return (await statusEntries(executor, cwd)).length === 0;
}

const OPERATION_PATHS = [
  "rebase-merge",
  "rebase-apply",
  "MERGE_HEAD",
  "CHERRY_PICK_HEAD",
  "REVERT_HEAD",
  "REBASE_HEAD",
  "BISECT_START",
  "sequencer",
];

export async function gitOperationInProgress(executor: ExecLike, cwd: string): Promise<string | undefined> {
  for (const name of OPERATION_PATHS) {
    const path = await gitOk(executor, cwd, ["rev-parse", "--git-path", name]);
    // Git may return a path relative to its cwd, not the extension process cwd.
    if (await pathExists(resolve(cwd, path))) return name;
  }
  return undefined;
}

export async function fastForwardCheckout(
  executor: ExecLike,
  expected: Pick<RepoInfo, "root" | "commonDir" | "branch" | "head">,
  targetHead: string,
  signal?: AbortSignal,
): Promise<void> {
  if (!/^[0-9a-f]{40,64}$/i.test(targetHead)) throw new Error("Fast-forward requires an exact commit ID");
  const before = await discoverRepo(executor, expected.root);
  if (before.root !== expected.root || before.commonDir !== expected.commonDir ||
      before.branch !== expected.branch || before.head !== expected.head) {
    throw new Error("Source checkout, branch, or HEAD changed after fast-forward confirmation");
  }
  const operation = await gitOperationInProgress(executor, expected.root);
  if (operation || !(await isClean(executor, expected.root))) {
    throw new Error("Source checkout must be clean and have no Git operation in progress before fast-forwarding");
  }
  signal?.throwIfAborted();
  await gitOk(executor, expected.root, ["merge", "--ff-only", targetHead], "Unable to fast-forward source branch", { signal });
  const after = await discoverRepo(executor, expected.root);
  if (after.root !== expected.root || after.commonDir !== expected.commonDir ||
      after.branch !== expected.branch || after.head !== targetHead || !(await isClean(executor, expected.root))) {
    throw new Error("Source checkout changed unexpectedly during fast-forward hooks; inspect it before resuming");
  }
}

export async function branchExists(executor: ExecLike, cwd: string, branch: string): Promise<boolean> {
  return (await git(executor, cwd, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`])).code === 0;
}

export async function validBranchName(executor: ExecLike, cwd: string, branch: string): Promise<boolean> {
  return (await git(executor, cwd, ["check-ref-format", "--branch", branch])).code === 0;
}

export async function isAncestor(executor: ExecLike, cwd: string, ancestor: string, descendant: string): Promise<boolean> {
  return (await git(executor, cwd, ["merge-base", "--is-ancestor", ancestor, descendant])).code === 0;
}

export async function currentHead(executor: ExecLike, cwd: string): Promise<string> {
  return gitOk(executor, cwd, ["rev-parse", "HEAD"]);
}

export async function currentBranch(executor: ExecLike, cwd: string): Promise<string | undefined> {
  const result = await git(executor, cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  return result.code === 0 ? result.stdout.trim() : undefined;
}

export async function aheadBehind(
  executor: ExecLike,
  cwd: string,
  left = "HEAD",
  right = "@{upstream}",
): Promise<{ ahead: number; behind: number } | undefined> {
  const result = await git(executor, cwd, ["rev-list", "--left-right", "--count", `${left}...${right}`]);
  if (result.code !== 0) return undefined;
  const [ahead, behind] = result.stdout.trim().split(/\s+/).map(Number);
  if (!Number.isFinite(ahead) || !Number.isFinite(behind)) return undefined;
  return { ahead, behind };
}

export async function remoteNames(executor: ExecLike, cwd: string): Promise<string[]> {
  const result = await git(executor, cwd, ["remote"]);
  return result.code === 0 ? result.stdout.trim().split("\n").filter(Boolean) : [];
}

export async function remoteIdentity(executor: ExecLike, cwd: string, remote: string): Promise<RemoteIdentity | undefined> {
  const result = await git(executor, cwd, ["remote", "get-url", "--", remote]);
  return result.code === 0 ? parseRemoteUrl(remote, result.stdout.trim()) : undefined;
}

export async function remoteBranchSha(
  executor: ExecLike,
  cwd: string,
  remote: string,
  branch: string,
): Promise<string | undefined> {
  const result = await git(executor, cwd, ["ls-remote", "--heads", "--", remote, `refs/heads/${branch}`], { timeout: 30_000 });
  if (result.code !== 0) throw new GitError(`Unable to query remote ${remote}/${branch}`, ["ls-remote"], result);
  if (!result.stdout.trim()) return undefined;
  const [sha, ref] = result.stdout.trim().split(/\s+/);
  if (!/^[0-9a-f]{40,64}$/i.test(sha) || ref !== `refs/heads/${branch}`) {
    throw new Error(`Remote ${remote}/${branch} returned an invalid branch or commit ID`);
  }
  return sha;
}

export async function sparsePatterns(executor: ExecLike, cwd: string): Promise<string[] | undefined> {
  const result = await git(executor, cwd, ["sparse-checkout", "list"]);
  if (result.code !== 0) return undefined;
  return result.stdout.split("\n").map((line) => line.trim()).filter(Boolean).sort();
}

export async function commitSummary(executor: ExecLike, cwd: string, sourceHead: string): Promise<string> {
  const [log, stat] = await Promise.all([
    git(executor, cwd, ["log", "--oneline", "--decorate=no", `${sourceHead}..HEAD`]),
    git(executor, cwd, ["diff", "--stat", `${sourceHead}...HEAD`]),
  ]);
  return truncateText(redactSecrets(["Commits:", log.stdout.trim() || "(none)", "", "Diffstat:", stat.stdout.trim() || "(none)"].join("\n")));
}
