# @dinglz/pi-worktree

为 [pi coding agent](https://github.com/earendil-works/pi-mono) 提供安全、可恢复并由 AI 辅助的 Git worktree 工作流。

> English documentation: [README.md](README.md) · [npm 包](https://www.npmjs.com/package/@dinglz/pi-worktree)

`pi-worktree` 会记录 worktree 是从**哪个 checkout 路径、哪个分支和哪个提交**创建的。本地完成时，结果会回到那个准确的目录和分支，而不是猜测某个 `main` 目录。

## 安装

建议全局安装，这样来源目录、工作 worktree 和恢复流程中都能使用命令：

```bash
pi install npm:@dinglz/pi-worktree
```

更新到最新 npm 版本：

```bash
pi update npm:@dinglz/pi-worktree
```

如果之前通过 Git 安装，先切换一次安装来源：

```bash
pi remove git:github.com/dingdinglz/pi-worktree
pi install npm:@dinglz/pi-worktree
```

本地开发：

```bash
npm install
pi -e ./src/index.ts
```

要求 Node.js 22.19+、支持 `git worktree` 的 Git 和具备当前 extension API 的 pi。PR 模式还要求已登录的 GitHub CLI (`gh`)，支持 GitHub Enterprise。若记录的来源分支没有 upstream，TUI 会要求显式选择 base remote 和分支。

## 快速开始

在已有至少一次提交的分支 checkout 中运行，允许存在未提交修改：

```text
/wt new 实现 token 刷新
```

新 worktree 仅基于已提交的 HEAD 创建。已暂存、未暂存的修改和未跟踪文件都保留在来源 checkout 中，不会被复制，也不会被改动。来源有未提交修改时，会跳过来源分支同步。

默认会创建类似下面的位置：

```text
~/.pi/worktrees/github.com/owner/repository/20260902-170000
```

中文任务无法安全转换为 ASCII 时会生成时间 slug，并允许你修改分支名。初始化 hook 完成后，extension 会在识别出的终端标签中启动全新的 pi；无法自动启动时会给出可复制命令。

任务完成后，在受管理 worktree 中运行：

```text
/wt finish pr
# 或
/wt finish merge
```

### 创建 PR

1. extension 检查并同步记录的来源 checkout。
2. 当前 agent 检查修改、stage、commit 并 rebase，此时还不能发布。
3. `worktree_prepare` 运行质量门禁，并展示 commits、PR title/body/draft。
4. 你批准后，agent 才使用明确的 push 和非交互 `gh pr create` 命令。Push 固定到已审核的提交 SHA，不会随之后的 `HEAD` 变化而发布其他提交。
5. `worktree_finalize` 验证远端 SHA、head/base、title/body 和 draft 状态。
6. 最后确认后，当前 pi 退出，独立 helper 删除 worktree。本地和远端 PR 分支保留。

### 合并回来源目录

假设从目录 `a` 的 `develop` 创建 worktree：

1. agent commit 并 rebase 到 `a/develop` 的最新 SHA。
2. 质量门禁通过后，extension 回到目录 `a` 执行 `git merge --ff-only <工作分支>`。
3. extension 不会自动 push `develop`。
4. 最终确认后删除 worktree，并用安全的 `git branch -d` 删除已经合入的本地工作分支。

如果来源分支在过程中变化，流程会停止并要求重新 rebase，不会偷偷制造 merge commit。Rebase 中断后可使用 `/wt finish <pr|merge> --resume` 继续处理。

选定的 push remote 必须只有一个 push URL，且与 fetch URL 指向同一仓库。如果 fork 的推送目标不同，请为其配置独立 remote；发布前会拒绝不匹配或多个推送目标。

## 命令

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

`/worktree` 是同义命令。直接运行 `/wt` 会打开向导。修改状态的命令只能在 TUI 中执行，首版不提供绕过确认的 `--yes`。

- `new`：默认允许来源存在未提交修改；旧的 `--allow-dirty` 参数仍兼容，但已无实际作用。
- `adopt`：为已有 worktree 明确选择来源目录并写入元数据。
- `reopen`：为当前 `init_failed` worktree 重试初始化，或在 PR 创建后需要继续修改时从保留分支重建 worktree。
- `doctor`：检查 Git、gh 登录、配置、状态目录及本机能力。
- `prune`：先预览，只清理 Git 已失效记录、失效 registry、超过 24 小时的中断创建、超过 7 天的暂停 finish 编排、过期历史/日志，以及用户批准且可安全删除的已合并 PR 分支。

## 配置

配置使用严格 JSON，必须包含 `version: 1`。优先级从低到高：

1. 内置默认值
2. `~/.pi/agent/worktree.json`（或 `PI_CODING_AGENT_DIR` 指向的位置）
3. 用户侧 per-repo 配置
4. 受信任项目中的 `.pi/worktree.json`

高层级覆盖标量。Hook 数组默认整体替换，也可显式指定 `append` 或 `prepend`。项目配置不能控制个人 launcher。

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

Hook 从目标 worktree 根目录顺序执行，并收到：

```text
PI_WT_PATH
PI_WT_SOURCE_PATH
PI_WT_BRANCH
PI_WT_SOURCE_BRANCH
PI_WT_MODE
PI_WT_ID
PI_WT_TRANSACTION_ID       # 仅 finish hook
```

默认采用结构化 argv，不经过 shell。只有明确设置 `shell: true` 才使用 shell。所有命令执行前都会展示。Hook 是受信任的任意程序，并会继承 pi 的进程环境，因此应像审核仓库脚本一样谨慎批准；finish hook 若改变 Git status，流程会停止并交回 agent 检查。

### AI 自动配置

缺少 `postCreate` 时，可以让隔离的 pi 生成建议。模型只能看到安全白名单中的 lockfile、package manifest、README、Makefile 和语言工具配置，没有工具权限，不能查看 `.env`，也不能执行建议。建议必须是结构化 argv；你审阅后才会保存到用户侧 per-repo 配置并运行。请求建议时，仅会把这些白名单 manifest 中经过大小限制和脱敏的摘要发送给你当前选择的模型提供方。

### Launcher

自动模式识别 tmux、Apple Terminal、iTerm2、WezTerm、Kitty、Ghostty、GNOME Terminal 和 Konsole；支持 zsh、bash、fish，最终回退 `/bin/sh`。VS Code/Cursor 集成终端、SSH、WSL GUI 及未知终端使用手动命令。

用户级配置可提供 argv 模板：

```json
{
  "version": 1,
  "launcher": {
    "mode": "custom",
    "command": ["wezterm", "cli", "spawn", "--cwd", "{path}", "--", "{pi}", "{piArgs}"]
  }
}
```

支持 `{path}`、`{root}`、`{branch}`、`{sourcePath}`、`{sourceBranch}`、`{task}`、`{pi}`，以及独立参数 `{piArgs}`。自定义模板必须同时包含 `{pi}` 与 `{piArgs}`。

## 安全模型

extension 明确不会：

- 使用 `git worktree remove --force`；
- 使用没有 lease 的强推；
- 自动 stash、reset、abort Git 操作、绕过 hooks/signing 或 push 来源分支；
- 猜测来源 checkout，或者静默切换来源分支；
- 运行项目仓库指定的 launcher；
- 收集遥测或上传日志。

来源分支修改、远端发布和删除 worktree 会分别确认。事务和来源分支锁会持久化，失败后可 resume。普通 untracked 文件阻止删除；ignored 依赖目录可由 Git 正常删除。初始化过的 submodule 必须干净并经确认后才 deinit。如果另一个受管理 worktree 把当前 worktree 记录为来源，当前 worktree 不会被删除。若移除 worktree 后安全的本地分支删除失败，extension 会保留已集成分支并记录日志，绝不会强删。

日志只保存在本机，权限为 `0600`，按期限删除并尽力脱敏；发送给 agent 的只有脱敏后的尾部和本地日志路径。脚本仍应避免输出秘密。

## 平台

- macOS/Linux：核心流程及已知终端 launcher
- WSL：核心流程，launcher 降级为手动命令
- 原生 Windows：0.1.x 不支持

## 开发

```bash
npm install
npm run check
```

测试使用临时本地 Git 仓库以及假的 gh/terminal adapter，不会创建真实 PR，也不会修改个人仓库。

### 发布

交互式发布需要使用有权发布到 `@dinglz` 作用域的 npm 账号，并启用双重验证。先登录 npm 官方仓库：

```bash
npm login --registry=https://registry.npmjs.org/
```

同步更新 `package.json`、`package-lock.json` 中的版本，并在 `CHANGELOG.md` 记录发布内容。安装好开发依赖后执行：

```bash
npm run check
npm pack --dry-run
npm publish
```

`publishConfig` 将 scoped 包设为公开，并固定发布到 npm 官方仓库，即使本机默认 registry 使用镜像也不受影响。包直接分发 TypeScript extension 源码，无需构建。

## License

MIT
