import { randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { EffectiveConfig, ManagedWorktree, PrPlan, RemoteIdentity } from "./types.ts";
import type { Registry } from "./registry.ts";
import {
  getUpstream,
  git,
  gitOk,
  isAncestor,
  remoteBranchSha,
  remoteIdentity,
  remoteNames,
  parseRemoteUrl,
} from "./git.ts";
import { redactSecrets, shellQuote } from "./util.ts";

export interface PullRequestInfo {
  url: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  title?: string;
  body?: string;
  isDraft?: boolean;
  headRefName: string;
  baseRefName: string;
  headRefOid?: string;
  headRepository?: { nameWithOwner?: string };
}

function parseRepoSpec(value: string, fallbackHost: string): { host: string; repoSpec: string } {
  const pieces = value.replace(/^https?:\/\//, "").replace(/\.git$/, "").split("/").filter(Boolean);
  if (pieces.length < 2) throw new Error(`Invalid GitHub repository: ${value}`);
  const hasHost = pieces.length >= 3 && pieces[0].includes(".");
  const host = hasHost ? pieces.shift()! : fallbackHost;
  return { host, repoSpec: `${host}/${pieces.join("/")}` };
}

export async function checkGh(pi: ExtensionAPI, cwd: string, host: string): Promise<void> {
  const version = await pi.exec("gh", ["--version"], { cwd, timeout: 10_000 });
  if (version.code !== 0) throw new Error("GitHub CLI (gh) is not installed or not available on PATH");
  const auth = await pi.exec("gh", ["auth", "status", "--hostname", host], { cwd, timeout: 20_000 });
  if (auth.code !== 0) throw new Error(`gh is not authenticated for ${host}. Run: gh auth login --hostname ${host}`);
}

async function choosePushRemote(
  pi: ExtensionAPI,
  record: ManagedWorktree,
  config: EffectiveConfig,
  select?: (title: string, options: string[]) => Promise<string | undefined>,
): Promise<{ name: string; identity: RemoteIdentity }> {
  const configured = config.pr.pushRemote;
  const workUpstream = await getUpstream(pi, record.path, record.branch);
  const names = await remoteNames(pi, record.path);
  const candidates = [configured, workUpstream?.remote, names.includes("origin") ? "origin" : undefined, ...names].filter(
    (item, index, all): item is string => Boolean(item) && all.indexOf(item) === index,
  );
  const valid: Array<{ name: string; identity: RemoteIdentity }> = [];
  for (const name of candidates) {
    const identity = await remoteIdentity(pi, record.path, name);
    if (identity) valid.push({ name, identity });
  }
  if (valid.length === 0) throw new Error("No GitHub-compatible push remote is configured");
  if (configured) {
    const match = valid.find((item) => item.name === configured);
    if (!match) throw new Error(`Configured push remote is unavailable: ${configured}`);
    return match;
  }
  if (valid.length === 1 || !select) return valid[0];
  const selected = await select(
    "Select the remote that will receive the work branch",
    valid.map((item) => `${item.name} — ${item.identity.repoSpec}`),
  );
  if (!selected) throw new Error("Push remote selection cancelled");
  const name = selected.split(" — ")[0];
  return valid.find((item) => item.name === name) ?? valid[0];
}

export async function createPrPlan(options: {
  pi: ExtensionAPI;
  registry: Registry;
  record: ManagedWorktree;
  config: EffectiveConfig;
  sourceHead: string;
  select?: (title: string, options: string[]) => Promise<string | undefined>;
}): Promise<PrPlan> {
  const sourceUpstream = await getUpstream(options.pi, options.record.sourcePath, options.record.sourceBranch);
  const names = await remoteNames(options.pi, options.record.sourcePath);
  const available: Array<{ name: string; identity: RemoteIdentity }> = [];
  for (const name of names) {
    const identity = await remoteIdentity(options.pi, options.record.sourcePath, name);
    if (identity) available.push({ name, identity });
  }
  if (available.length === 0) throw new Error("No GitHub-compatible remote is configured for the source checkout");

  const fallbackHost = sourceUpstream?.identity?.host ?? available[0].identity.host;
  const configuredBase = options.config.pr.baseRepo
    ? parseRepoSpec(options.config.pr.baseRepo, fallbackHost)
    : undefined;
  let baseRemote: string;
  let baseIdentity: RemoteIdentity;
  if (configuredBase) {
    const match = available.find(
      (item) => item.identity.host === configuredBase.host && item.identity.repoSpec === configuredBase.repoSpec,
    );
    if (!match) throw new Error(`No configured Git remote matches PR base repository ${configuredBase.repoSpec}`);
    baseRemote = match.name;
    baseIdentity = match.identity;
  } else if (sourceUpstream?.identity) {
    baseRemote = sourceUpstream.remote;
    baseIdentity = sourceUpstream.identity;
  } else {
    if (!options.select) throw new Error("Source branch has no upstream; select a PR base remote interactively");
    const selected = await options.select(
      "Source branch has no upstream; select the PR base repository",
      available.map((item) => `${item.name} — ${item.identity.repoSpec}`),
    );
    if (!selected) throw new Error("PR base selection cancelled");
    const name = selected.split(" — ")[0];
    const match = available.find((item) => item.name === name);
    if (!match) throw new Error("Selected PR base remote is no longer available");
    baseRemote = match.name;
    baseIdentity = match.identity;
  }
  await checkGh(options.pi, options.record.path, baseIdentity.host);
  await gitOk(options.pi, options.record.sourcePath, ["fetch", "--", baseRemote], `Unable to fetch ${baseRemote}`, { timeout: 120_000 });

  let baseBranch = sourceUpstream?.remote === baseRemote ? sourceUpstream.branch : options.record.sourceBranch;
  if (!sourceUpstream?.identity) {
    const branchResult = await git(options.pi, options.record.sourcePath, [
      "for-each-ref",
      "--format=%(refname)",
      `refs/remotes/${baseRemote}`,
    ]);
    const remotePrefix = `refs/remotes/${baseRemote}/`;
    const branches = branchResult.stdout
      .split("\n")
      .map((item) => item.trim())
      .filter((item) => item.startsWith(remotePrefix))
      .map((item) => item.slice(remotePrefix.length))
      .filter((item) => item && item !== "HEAD");
    if (branches.length === 0) throw new Error(`Remote ${baseRemote} has no branches available as a PR base`);
    if (!branches.includes(baseBranch) || branches.length > 1) {
      if (!options.select) throw new Error("Source branch has no upstream; select a PR base branch interactively");
      const ordered = [baseBranch, ...branches.filter((item) => item !== baseBranch)].filter((item, index, all) => branches.includes(item) && all.indexOf(item) === index);
      const selected = await options.select("Select the remote PR base branch", ordered);
      if (!selected) throw new Error("PR base branch selection cancelled");
      baseBranch = selected;
    }
  }

  const trackingRef = `refs/remotes/${baseRemote}/${baseBranch}`;
  const baseContainsSource = await isAncestor(options.pi, options.record.sourcePath, options.sourceHead, trackingRef);
  if (!baseContainsSource) {
    throw new Error(
      `Remote base ${baseRemote}/${baseBranch} does not contain source commit ${options.sourceHead.slice(0, 12)}. Push or reconcile the source branch first.`,
    );
  }

  const push = await choosePushRemote(options.pi, options.record, options.config, options.select);
  await assertPushDestination(options.pi, options.record.path, push.name, push.identity);
  if (push.identity.host !== baseIdentity.host) {
    throw new Error(`Push remote host ${push.identity.host} does not match PR host ${baseIdentity.host}`);
  }
  return {
    host: baseIdentity.host,
    baseRepo: baseIdentity.repoSpec,
    baseRemote,
    baseBranch,
    pushRemote: push.name,
    pushRepo: push.identity.repoSpec,
    headBranch: options.record.branch,
    headOwner: push.identity.owner,
  };
}

function isPullRequestInfo(item: unknown): item is PullRequestInfo {
  if (!item || typeof item !== "object" || Array.isArray(item)) return false;
  const value = item as Record<string, unknown>;
  const repository = value.headRepository as Record<string, unknown> | undefined;
  return typeof value.url === "string" && value.url.length <= 4_096 &&
    ["OPEN", "CLOSED", "MERGED"].includes(String(value.state)) &&
    typeof value.headRefName === "string" && value.headRefName.length <= 1_024 &&
    typeof value.baseRefName === "string" && value.baseRefName.length <= 1_024 &&
    typeof value.headRefOid === "string" && /^[0-9a-f]{40,64}$/i.test(value.headRefOid) &&
    typeof value.title === "string" && value.title.length <= 256 &&
    typeof value.body === "string" && Buffer.byteLength(value.body, "utf8") <= 1_048_576 &&
    typeof value.isDraft === "boolean" && repository !== null && typeof repository === "object" && !Array.isArray(repository) &&
    typeof repository.nameWithOwner === "string" && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository.nameWithOwner);
}

function parsePrList(output: string): PullRequestInfo[] {
  if (!output.trim()) return [];
  let data: unknown;
  try {
    data = JSON.parse(output) as unknown;
  } catch {
    throw new Error("GitHub CLI returned invalid pull request JSON");
  }
  if (!Array.isArray(data)) throw new Error("Unexpected gh PR response");
  return data.filter(isPullRequestInfo);
}

function prUrlMatchesPlan(url: string, plan: PrPlan): boolean {
  if (/[\u0000-\u0020\u007f-\u009f]/.test(url)) return false;
  try {
    const parsedUrl = new URL(url);
    const [expectedHost, ...repoParts] = plan.baseRepo.split("/");
    const expectedPath = `/${repoParts.join("/")}/pull/`.toLowerCase();
    const pathname = parsedUrl.pathname.toLowerCase();
    const suffix = pathname.slice(expectedPath.length);
    return parsedUrl.protocol === "https:" && !parsedUrl.username && !parsedUrl.password && !parsedUrl.port &&
      !parsedUrl.search && !parsedUrl.hash && parsedUrl.hostname.toLowerCase() === expectedHost.toLowerCase() && pathname.startsWith(expectedPath) && /^\d+\/?$/.test(suffix);
  } catch {
    return false;
  }
}

function prInfoMatchesPlan(info: PullRequestInfo, plan: PrPlan): boolean {
  const expectedHeadRepo = plan.pushRepo?.split("/").slice(1).join("/").toLowerCase();
  return prUrlMatchesPlan(info.url, plan) && info.headRefName === plan.headBranch && info.baseRefName === plan.baseBranch &&
    Boolean(expectedHeadRepo) && info.headRepository?.nameWithOwner?.toLowerCase() === expectedHeadRepo;
}

async function assertPushDestination(pi: ExtensionAPI, cwd: string, remote: string, identity: RemoteIdentity): Promise<void> {
  const output = await gitOk(pi, cwd, ["remote", "get-url", "--push", "--all", "--", remote], `Unable to inspect push URLs for ${remote}`);
  const urls = output.split("\n").filter(Boolean);
  const push = urls.length === 1 ? parseRemoteUrl(remote, urls[0]) : undefined;
  // Git push honors pushurl (and may push to several URLs); fetch/ls-remote do not.
  // Require one repository for both directions so verification covers publication.
  if (!push || push.repoSpec.toLowerCase() !== identity.repoSpec.toLowerCase()) {
    throw new Error(`Push remote ${remote} must have one push URL matching its fetch repository ${identity.repoSpec}; configure a separate remote for a different destination`);
  }
}

export async function validatePrPlanRemotes(
  pi: ExtensionAPI,
  worktreePath: string,
  sourcePath: string,
  plan: PrPlan,
): Promise<void> {
  const [push, base] = await Promise.all([
    remoteIdentity(pi, worktreePath, plan.pushRemote),
    remoteIdentity(pi, sourcePath, plan.baseRemote),
  ]);
  if (!push || push.host !== plan.host || push.repoSpec !== plan.pushRepo ||
      push.owner.toLowerCase() !== plan.headOwner?.toLowerCase()) {
    throw new Error(`Push remote ${plan.pushRemote} no longer matches the approved repository ${plan.pushRepo}`);
  }
  await assertPushDestination(pi, worktreePath, plan.pushRemote, push);
  if (!base || base.host !== plan.host || base.repoSpec !== plan.baseRepo) {
    throw new Error(`Base remote ${plan.baseRemote} no longer matches the approved repository ${plan.baseRepo}`);
  }
}

export async function findPullRequests(pi: ExtensionAPI, cwd: string, plan: PrPlan): Promise<PullRequestInfo[]> {
  const head = plan.pushRepo === plan.baseRepo ? plan.headBranch : `${plan.headOwner}:${plan.headBranch}`;
  const result = await pi.exec(
    "gh",
    [
      "pr",
      "list",
      "--repo",
      plan.baseRepo,
      "--head",
      head,
      "--base",
      plan.baseBranch,
      "--state",
      "all",
      "--limit",
      "20",
      "--json",
      "url,state,title,body,isDraft,headRefName,baseRefName,headRefOid,headRepository",
    ],
    { cwd, timeout: 30_000 },
  );
  if (result.code !== 0) throw new Error(redactSecrets(result.stderr.trim()) || "Unable to query pull requests");
  return parsePrList(result.stdout).filter((info) => prInfoMatchesPlan(info, plan));
}

export async function writeApprovedPrBody(
  registry: Registry,
  transactionId: string,
  body: string,
): Promise<string> {
  if (!/^[A-Za-z0-9_-]{1,256}$/.test(transactionId)) throw new Error("Invalid PR body transaction identifier");
  if (Buffer.byteLength(body, "utf8") > 65_536 || /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(body)) {
    throw new Error("PR body exceeds the safe limit or contains unsafe control characters");
  }
  await registry.ensure();
  const path = join(registry.baseDir, `pr-body-${transactionId}-${randomUUID()}.md`);
  try {
    await writeFile(path, body, { encoding: "utf8", mode: 0o600, flag: "wx" });
  } catch (error) {
    await rm(path, { force: true }).catch(() => undefined);
    throw error;
  }
  return path;
}

export function prCommands(plan: PrPlan, workHead: string): {
  push: string;
  create?: string;
  reopen?: string;
  edit?: string;
  draftStatus?: string;
} {
  if (!/^[0-9a-f]{40,64}$/i.test(workHead)) throw new Error("Publication requires an approved commit ID");
  const remoteRef = `refs/heads/${plan.headBranch}`;
  const ghCommand = (args: string[]) => `GH_PROMPT_DISABLED=1 ${args.map(shellQuote).join(" ")}`;
  const pushArgs = ["git", "-c", "credential.interactive=never", "push"];
  if (plan.forceLeaseSha) pushArgs.push(`--force-with-lease=${remoteRef}:${plan.forceLeaseSha}`);
  // Force revision parsing so a branch/tag named exactly workHead cannot shadow the approved commit.
  pushArgs.push("--", plan.pushRemote, `${workHead}^{commit}:${remoteRef}`);
  const result: { push: string; create?: string; reopen?: string; edit?: string; draftStatus?: string } = {
    push: `GIT_TERMINAL_PROMPT=0 GCM_INTERACTIVE=Never ${pushArgs.map(shellQuote).join(" ")}`,
  };
  if (plan.existingUrl) {
    if (plan.needsReopen) {
      result.reopen = ghCommand(["gh", "pr", "reopen", plan.existingUrl, "--repo", plan.baseRepo]);
    }
    result.edit = ghCommand([
      "gh",
      "pr",
      "edit",
      plan.existingUrl,
      "--repo",
      plan.baseRepo,
      "--title",
      plan.title ?? "",
      "--body-file",
      plan.bodyFile ?? "",
    ]);
    if (plan.existingIsDraft !== undefined && plan.draft !== undefined && plan.existingIsDraft !== plan.draft) {
      result.draftStatus = ghCommand([
        "gh",
        "pr",
        "ready",
        plan.existingUrl,
        "--repo",
        plan.baseRepo,
        ...(plan.draft ? ["--undo"] : []),
      ]);
    }
  } else {
    const head = plan.pushRepo === plan.baseRepo ? plan.headBranch : `${plan.headOwner}:${plan.headBranch}`;
    const createArgs = [
      "gh",
      "pr",
      "create",
      "--repo",
      plan.baseRepo,
      "--base",
      plan.baseBranch,
      "--head",
      head,
      "--title",
      plan.title ?? "",
      "--body-file",
      plan.bodyFile ?? "",
    ];
    if (plan.draft) createArgs.push("--draft");
    result.create = ghCommand(createArgs);
  }
  return result;
}

export async function verifyPublishedPr(
  pi: ExtensionAPI,
  cwd: string,
  plan: PrPlan,
  localHead: string,
  suppliedUrl?: string,
): Promise<PullRequestInfo> {
  const remoteSha = await remoteBranchSha(pi, cwd, plan.pushRemote, plan.headBranch);
  if (!remoteSha || remoteSha !== localHead) {
    throw new Error(`Remote work branch does not match local HEAD (local ${localHead.slice(0, 12)}, remote ${remoteSha?.slice(0, 12) ?? "missing"})`);
  }
  const url = suppliedUrl || plan.existingUrl;
  if (url && !prUrlMatchesPlan(url, plan)) throw new Error("Pull request URL does not belong to the approved base repository");
  let info: PullRequestInfo | undefined;
  if (url) {
    const result = await pi.exec(
      "gh",
      [
        "pr",
        "view",
        url,
        "--repo",
        plan.baseRepo,
        "--json",
        "url,state,title,body,isDraft,headRefName,baseRefName,headRefOid,headRepository",
      ],
      { cwd, timeout: 30_000 },
    );
    if (result.code !== 0) throw new Error(redactSecrets(result.stderr.trim()) || `Unable to verify PR ${url}`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout) as unknown;
    } catch {
      throw new Error("GitHub CLI returned invalid pull request JSON");
    }
    if (!isPullRequestInfo(parsed)) throw new Error("Unexpected gh PR response");
    info = parsed;
  } else {
    info = (await findPullRequests(pi, cwd, plan)).find((item) => item.state === "OPEN");
  }
  if (!info) throw new Error("No matching pull request was found");
  if (!prUrlMatchesPlan(info.url, plan)) throw new Error("Pull request URL does not belong to the approved base repository");
  if (url) {
    const requested = new URL(url);
    const returned = new URL(info.url);
    if (requested.hostname.toLowerCase() !== returned.hostname.toLowerCase() ||
        requested.pathname.replace(/\/$/, "").toLowerCase() !== returned.pathname.replace(/\/$/, "").toLowerCase()) {
      throw new Error("GitHub returned a different pull request than the requested URL");
    }
  }
  if (info.state !== "OPEN") throw new Error(`Pull request is ${info.state.toLowerCase()}, not open`);
  if (info.headRefName !== plan.headBranch || info.baseRefName !== plan.baseBranch) {
    throw new Error(
      `Pull request ref mismatch: expected ${plan.headBranch} -> ${plan.baseBranch}, got ${info.headRefName} -> ${info.baseRefName}`,
    );
  }
  if (info.headRefOid !== localHead) throw new Error("Pull request head SHA does not match local HEAD");
  const expectedHeadRepo = plan.pushRepo?.split("/").slice(1).join("/").toLowerCase();
  if (!expectedHeadRepo || info.headRepository?.nameWithOwner?.toLowerCase() !== expectedHeadRepo) {
    throw new Error("Pull request head repository does not match the approved push repository");
  }
  return info;
}
