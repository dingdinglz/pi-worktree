# Changelog

All notable changes to this project are documented here. The project follows
[Semantic Versioning](https://semver.org/).

## [Unreleased]

- Add slash-command, skill, prompt-template, and `@` file completion to the task input in `/wt → new` and `/wt new` without a task.
- Allow `/wt new` from a source checkout with uncommitted changes by default. Create from committed HEAD without copying or changing source edits, and skip source synchronization when it is dirty. Keep `--allow-dirty` as a compatibility no-op.

## [0.1.1] - 2026-09-07

- First public npm release as `@dinglz/pi-worktree`, with npm installation, update, migration, and publishing instructions in both READMEs.
- Pin publishing to the official npm registry with public access.
- Fix Git operation detection outside the agent's working directory and revalidate checkout identity before source fast-forwards; preserve local creation when the upstream ref is missing.
- Recheck source, worktree, remote, and cancellation state before PR authorization; pin pushes to the approved commit even when a branch or tag shadows its SHA, and reject mismatched push URLs.
- Restore interrupted rebase recovery and local finish/cleanup for reopened PR worktrees.
- Prevent concurrent sessions from overwriting a worktree's finish transaction, and atomically bind legacy transactions to the resuming session before enabling finish tools.
- Reject non-string configuration enums, tolerate deleted PR head repositories, and expand launcher placeholders literally.

## [0.1.0] - 2026-09-02

- Initial release.
- Managed worktree creation, adoption, reopening, PR handoff, and linear local integration.
- Layered configuration, guarded hooks, transaction recovery, terminal launchers, and diagnostics.
