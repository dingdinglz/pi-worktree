# @dinglz/pi-worktree

Safe, AI-assisted Git worktree workflows for the [pi coding agent](https://github.com/earendil-works/pi-mono).

> 中文文档：[README.zh-CN.md](README.zh-CN.md) · [npm package](https://www.npmjs.com/package/@dinglz/pi-worktree)

`pi-worktree` remembers the exact checkout and branch from which a worktree was created. A local finish returns work to that exact checkout—not to an assumed `main` directory—and a PR finish verifies the pushed SHA and GitHub PR before cleaning up.

## Install

Global installation is recommended so recovery commands remain available from both the source checkout and managed worktrees:

```bash
pi install npm:@dinglz/pi-worktree
```

To update to the latest npm release:

```bash
pi update npm:@dinglz/pi-worktree
```

If you previously installed from Git, switch sources once:

```bash
pi remove git:github.com/dingdinglz/pi-worktree
pi install npm:@dinglz/pi-worktree
```

For local development:

```bash
npm install
pi -e ./src/index.ts
```

Requires Node.js 22.19+, a Git implementation with `git worktree`, and pi with the current extension API. PR mode additionally requires an authenticated GitHub CLI (`gh`); GitHub Enterprise hosts are supported. If the recorded source branch has no upstream, the TUI requires an explicit base remote/branch choice.

## Quick start

From any branch checkout with at least one commit (uncommitted changes are allowed):

```text
/wt new implement token refresh
```

The new worktree starts from committed HEAD only. Staged changes, unstaged changes, and untracked files stay in the source checkout unchanged; they are not copied. If the source has uncommitted changes, source synchronization is skipped.

The extension creates `wt/implement-token-refresh` under a default path such as:

```text
~/.pi/worktrees/github.com/owner/repository/implement-token-refresh
```

It then runs approved initialization hooks and opens a fresh pi session in a detected terminal tab (or prints an exact manual command).

When the task is ready, from the managed worktree:

```text
/wt finish pr
# or
/wt finish merge
```

### PR finish

1. The extension validates and synchronizes the recorded source checkout.
2. The current agent reviews, stages, commits, and rebases—but cannot publish yet.
3. `worktree_prepare` runs configured quality gates and asks you to approve commits and PR content.
4. The agent uses explicit, approved push and `gh pr create` commands. Pushes are pinned to the reviewed commit SHA, not a potentially changed `HEAD`.
5. `worktree_finalize` verifies the remote SHA, head/base refs, title/body, and draft state.
6. After a final confirmation, pi exits and a helper removes the worktree. The local and remote PR branches remain.

### Local merge finish

1. The current agent commits and rebases onto the latest recorded source SHA.
2. Quality gates run.
3. After approval, the extension executes `git merge --ff-only` in the **original source checkout and branch**.
4. It never pushes the source branch automatically.
5. After confirmation, the worktree is removed and the integrated local work branch is deleted with `git branch -d`.

If the source branch changes during the workflow, publication/integration stops and the agent must rebase again. No merge commit is silently introduced. An interrupted rebase can be continued with `/wt finish <pr|merge> --resume`.

The selected push remote must have a single push URL pointing to the same repository as its fetch URL. For forks with a different destination, configure a separate remote; mismatched or multiple push destinations are rejected before publication.

## Commands

```text
/wt new [task] [--branch <name>] [--path <absolute>] [--no-launch]
/wt finish <pr|merge> [--resume|--cancel]
/wt adopt
/wt reopen [id]
/wt list [--all]
/wt status
/wt config [show|edit|export|reset]
/wt doctor [--fix]
/wt prune
```

`/worktree` is an alias. Running `/wt` without arguments opens a guided menu. Mutating commands require interactive TUI mode and intentionally have no `--yes` bypass.

- **new** allows uncommitted source changes by default. The legacy `--allow-dirty` flag is still accepted but has no effect.
- **adopt** records an explicit source checkout for an existing worktree.
- **reopen** retries initialization for the current `init_failed` worktree, or recreates a deleted PR worktree for review changes.
- **doctor** checks Git, gh authentication, config, state, and local capabilities.
- **prune** previews and removes only Git-stale admin data, stale registry entries, interrupted creations older than 24 hours, paused finish orchestration older than 7 days, expired history/logs, and optionally safely merged PR branches.

## Configuration

Configuration is strict JSON with `version: 1` and is layered in this order:

1. Built-in defaults
2. `~/.pi/agent/worktree.json` (or the active `PI_CODING_AGENT_DIR`)
3. User-local per-repository config under the agent state directory
4. Trusted project config at `.pi/worktree.json`

Higher layers override scalar values. Hook arrays replace lower layers unless they explicitly set `merge` to `append` or `prepend`. Project config cannot define `launcher`.

```json
{
  "$schema": "https://raw.githubusercontent.com/dingdinglz/pi-worktree/main/schema/worktree.schema.json",
  "version": 1,
  "locale": "auto",
  "worktreeRoot": "~/.pi/worktrees",
  "branchPrefix": "wt/",
  "defaults": {
    "draftPr": false,
    "launch": true,
    "missingPostCreate": "ask",
    "historyRetentionDays": 30,
    "logRetentionDays": 7
  },
  "hooks": {
    "postCreate": [
      { "command": "npm", "args": ["install"], "timeoutMs": 900000 }
    ],
    "preFinish": [
      { "command": "npm", "args": ["test"], "timeoutMs": 900000 }
    ],
    "prePr": [],
    "preMerge": []
  }
}
```

Hook steps run sequentially from the target worktree root and receive:

```text
PI_WT_PATH
PI_WT_SOURCE_PATH
PI_WT_BRANCH
PI_WT_SOURCE_BRANCH
PI_WT_MODE
PI_WT_ID
PI_WT_TRANSACTION_ID       # finish hooks only
```

Structured argv execution is the default. A step may explicitly set `shell: true`, but all configured commands are shown before execution. Hooks are trusted arbitrary programs and inherit pi's process environment, so approve them as carefully as repository scripts. Pre-finish hooks must not alter Git status.

### AI setup

When no `postCreate` hook exists, `/wt new` can ask an isolated pi process for a proposal. The model receives only an allowlist of setup manifests (lockfiles, package manifests, README, Makefile, and language tool files), has no tools, and must return structured argv steps. It cannot inspect `.env` or execute its proposal. You review the exact steps before they are stored in user-local per-repository config and run. Requesting a proposal sends only bounded, redacted excerpts from those allowlisted manifests to your selected model provider.

### Launcher

Auto mode recognizes tmux, Apple Terminal, iTerm2, WezTerm, Kitty, Ghostty, GNOME Terminal, and Konsole. zsh, bash, fish, and `/bin/sh` fallback are supported. VS Code/Cursor integrated terminals, SSH, WSL GUI launch, and unknown terminals receive a manual command.

A user-only custom launcher is an argv template:

```json
{
  "version": 1,
  "launcher": {
    "mode": "custom",
    "command": ["wezterm", "cli", "spawn", "--cwd", "{path}", "--", "{pi}", "{piArgs}"]
  }
}
```

Supported placeholders are `{path}`, `{root}`, `{branch}`, `{sourcePath}`, `{sourceBranch}`, `{task}`, `{pi}`, and the standalone `{piArgs}` token. Custom templates must include both `{pi}` and `{piArgs}`.

## Safety model

The extension deliberately does **not**:

- use `git worktree remove --force`;
- use an unleased force push;
- automatically stash, reset, abort a Git operation, bypass hooks/signing, or push a source branch;
- guess a source checkout or silently switch its branch;
- execute repository-provided launchers;
- send telemetry or upload logs.

Source checkout modifications, remote publication, and worktree deletion receive separate confirmations. Transactions and source-branch locks are persisted so failures remain resumable. Ordinary untracked files block deletion; ignored dependency trees are handled by normal Git removal. Initialized submodules must be clean and are deinitialized only after approval. A worktree cannot be removed while another managed worktree records it as its source. If safe local branch deletion fails after worktree removal, the integrated branch is retained and the failure is logged rather than force-deleted.

Logs are local, mode `0600`, retention-limited, and best-effort redacted. Only a redacted tail and local path are returned to the agent; scripts should still avoid printing secrets.

## Platform support

- macOS and Linux: core workflow and known terminal launchers
- WSL: core workflow, manual launcher fallback
- Native Windows: not supported in 0.1.x

## Development

```bash
npm install
npm run check
```

Tests use temporary local Git repositories and fake gh/terminal adapters; they do not create real PRs or mutate personal repositories.

### Publishing

Interactive publishing requires an npm account with access to the `@dinglz` scope and two-factor authentication enabled. Authenticate against the official registry:

```bash
npm login --registry=https://registry.npmjs.org/
```

Update the version in `package.json` and `package-lock.json`, and record the release in `CHANGELOG.md`. Then, from a checkout with dependencies installed:

```bash
npm run check
npm pack --dry-run
npm publish
```

`publishConfig` makes the scoped package public and publishes to the official npm registry even when the local default registry is a mirror. The package ships its TypeScript extension sources directly; no build step is required.

## License

MIT
