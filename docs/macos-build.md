# UFO-Browser macOS 构建与发包

本文区分日常开发构建、临时安装包和正式内部发包。默认开发命令不会修改 Claude Code、Codex 或其他 Agent 的全局 Skill 目录；只有正式发包命令会执行全局 Skill 同步。

## 命令总览

| 目的 | 命令 | 全局 Skill 同步 | 输出 |
|---|---|---:|---|
| 日常运行 | `npm run test:app` | 否 | 隔离测试 Profile 的开发 App |
| 快速重开 | `npm run test:app:reuse` | 否 | 复用现有构建和测试 Profile |
| 临时 `.app` | `npm run dist:mac` | 否 | `release/mac-*/UFO-Browser.app` |
| 临时 DMG/ZIP | `npm run package:mac:test` | 否 | `release/*.dmg`、`release/*.zip` |
| 正式内部包 | `npm run package:mac` | 是 | 已验证的 App、DMG 和 ZIP |
| 安装并替换本地 App | `npm run install:mac -- release/UFO-Browser-*.dmg` | 安装后同步 | `/Applications/UFO-Browser.app`、CLI、Skills |

通常使用前三个命令即可。`package:mac` 会更新用户级 Agent Skill，只有准备正式内部包时才运行。

## 日常临时构建

开发调试：

```bash
npm run test:app
```

只验证 macOS App Bundle，不制作磁盘镜像：

```bash
npm run dist:mac
npm run smoke
```

需要测试安装镜像，但不希望改动任何 Agent 全局目录：

```bash
npm run package:mac:test
```

临时构建会优先使用 `node_modules/electron/dist` 中已经安装的 Electron，避免重复联网下载 Chromium/Electron。App Bundle 由 electron-builder 生成，ZIP 使用 macOS `ditto`，DMG 使用系统 `hdiutil`，制作安装包本身不再下载额外的 `dmgbuild` 工具。

## 正式内部发包

先查看本次会更新哪些 Agent：

```bash
npm run skills:sync:dry-run
```

执行完整流程：

```bash
npm run package:mac
```

该命令依次执行：

1. 清理仓库内生成的 `release/` 目录。
2. 运行 TypeScript 类型检查。
3. 构建并运行完整单元测试。
4. 计算 `skills/ufo-browser` 的 SHA-256，并同步到已安装的 Agent。
5. 重新构建主进程、preload、renderer、CLI 和测试产物。
6. 使用 electron-builder 生成 UFO-Browser App，再由 macOS `ditto` 和 `hdiutil` 生成 ZIP 与 DMG。
7. 验证 App 内的 `app.asar`、App Icon、Skill、OpenAI Agent manifest、可执行 `ufo-keychain-helper`、`chrome-cookie-worker.js` 及 DMG/ZIP 均存在。
8. 使用隔离 Chrome fixture 与 Mock Keychain 直接启动打包后的 App，完成一次 Chrome 登录态导入成功 E2E，证明 ASAR Worker、打包路径、Cookie/CHIPS 与站点存储导入在正式 Bundle 结构中可运行。
9. 连续三次在页面注册 `beforeunload` 的情况下执行原生 `app.quit()`，要求打包 App 均以退出码 0 结束且不出现 macOS `NSAlert` 与窗口销毁重入崩溃。

`npm run release:mac` 是同一正式流程的别名。

## 从 DMG 安装到 `/Applications`

DMG 生成后，使用明确的 DMG 路径执行安装流程：

```bash
npm run install:mac -- release/UFO-Browser-0.1.8-arm64.dmg
```

该流程只替换明确的 `/Applications/UFO-Browser.app`：

1. 以只读方式挂载 DMG，并确认镜像中包含 `UFO-Browser.app`。
2. 仅结束 UFO-Browser 自己的 `UFO-Browser` 进程，不影响 Ego Lite 或其他 Electron 应用。
3. 先复制到 `/Applications/.UFO-Browser.app.install-*`，再原子替换旧 App；替换失败会尝试恢复旧 App。
4. 卸载 DMG，并校验已安装 App 的可执行文件、ASAR、内置 Skill 和版本信息。
5. 让 `~/.local/bin/ufo-browser`、`~/.local/bin/x-browser` 指向已安装 App 内的 CLI，避免继续使用仓库旧构建。
6. 从已安装 App 的 `Contents/Resources/skills/ufo-browser` 同步 Claude、Codex、Cursor、Gemini、Copilot、OpenCode 和 Agent Skills 目录。

安装脚本默认不会覆盖用户手动维护的同名 Skill；只有带 `.ufo-browser-managed.json` 标记的目录会自动更新。CLI 使用 `--force` 是因为它明确管理 `~/.local/bin` 中的 UFO-Browser 两个入口。如果需要自定义目标，可继续使用 `UFO_BROWSER_CLI_BIN`、`UFO_BROWSER_EXTRA_SKILL_ROOTS` 等环境变量。

这是未签名、未公证的本地内部测试安装流程。它不等同于面向用户发布的安装器，也不会自动删除浏览器 Profile 数据。

## Agent Skill 自动同步

正式发包会检测以下 Agent Skills 根目录；只有对应 Agent 已安装、命令可用或配置目录已经存在时才同步：

| Agent | 目标目录 |
|---|---|
| Claude Code | `~/.claude/skills/ufo-browser` |
| Codex | `$CODEX_HOME/skills/ufo-browser`，未设置时为 `~/.codex/skills/ufo-browser` |
| Cursor | `~/.cursor/skills/ufo-browser` |
| Gemini CLI | `~/.gemini/skills/ufo-browser` |
| GitHub Copilot CLI | `~/.copilot/skills/ufo-browser` |
| OpenCode | `~/.config/opencode/skills/ufo-browser` |
| Agent Skills 标准目录 | `~/.agents/skills/ufo-browser` |

额外 Agent 可以通过 macOS 冒号分隔的 Skill 根目录加入：

```bash
UFO_BROWSER_EXTRA_SKILL_ROOTS="$HOME/.example-agent/skills:$HOME/.another-agent/skills" \
  npm run skills:sync
```

同步采用同目录临时副本加原子替换。安装后会写入 `.ufo-browser-managed.json`，记录来源哈希和更新时间。来源与目标内容哈希一致时不会重复写入；后续自动更新只覆盖带该管理标记的目录。如果目标目录已经存在但不是 UFO-Browser 管理的内容，流程会跳过并保留原内容。

已经运行中的 Agent CLI 或桌面任务通常需要重新启动进程或新建任务，才会重新扫描刚同步的 Skill。

确实需要接管一个现有同名目录时，可以显式执行：

```bash
npm run skills:sync -- --force
```

`--force` 会替换准确的 `skills/ufo-browser` 目标，应先自行备份其中的自定义内容。

## App 内置 Skill

无论是临时包还是正式包，App Bundle 都包含：

```text
UFO-Browser.app/Contents/Resources/skills/ufo-browser/
```

App 启动后还会把该随包版本同步到自己的 Assistant Workspace，因此内置 Agent 使用的 Skill 与当前 App 构建保持一致，不依赖开发仓库或网络。

## 签名与对外发布

当前 `package.json` 使用 `identity: null`，生成的是本地开发和内部测试用的未公证包，不会修改 `/Applications/UFO-Browser.app`，也不会删除正式 Profile 数据。

真正对外分发前还需要单独补齐：

- Developer ID Application 签名
- Hardened Runtime 与 entitlements 审计
- Apple notarization
- DMG stapling
- 版本号、更新通道和回滚验证

在这些发布凭据配置完成前，不应把当前 DMG 当作面向公众的正式签名版本。
