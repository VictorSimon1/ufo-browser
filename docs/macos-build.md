# UFO-Browser macOS 构建与发包

本文区分日常开发构建、临时安装包和正式内部发包。默认开发命令不会修改 Claude Code、Codex 或其他 Agent 的全局 Skill 目录；只有正式发包命令会执行全局 Skill 同步。

## 命令总览

| 目的 | 命令 | 全局 Skill 同步 | 输出 |
|---|---|---:|---|
| 日常 Native 运行 | `npm run start:native` | 否 | CEF Chrome Runtime |
| 临时 Native App/DMG | `npm run dist:mac` 或 `npm run package:mac:test` | 否 | `release-native/` |
| 正式 Native CEF 包 | `npm run package:mac` | 安装后同步 | `release-native/UFO-Browser-*.dmg` |
| Electron 迁移回退包 | `npm run package:mac:electron` | 否 | `release/` |
| 安装并替换本地 App | `npm run install:mac -- release-native/UFO-Browser-*.dmg` | 安装后同步 | `/Applications/UFO-Browser.app`、CLI、Skills |

通常使用 Native 命令即可。`package:mac` 现在是 CEF 正式包入口；Electron 只保留给迁移期间的旧测试和回退，必须显式使用带 `:electron` 后缀的命令。

## 日常临时构建

Native CEF 开发调试：

```bash
npm run start:native
```

构建并验证 Native macOS App/DMG：

```bash
npm run dist:mac
npm run native:cef:install:smoke
```

需要测试安装镜像，但不希望改动任何 Agent 全局目录：

```bash
npm run package:mac:test
```

Native 包由 CEF host、AppKit launcher、独立 Node Agent 和系统 `hdiutil` 生成，不包含 Electron、`app.asar` 或 Electron Builder 运行时。CEF 二进制来自本地 `test/cef-runtime`，需要时运行 `npm run native:cef:fetch`。

旧 Electron 回退包仅用于迁移测试：

```bash
npm run dist:mac:electron
npm run package:mac:test:electron
```

## 正式内部发包

先查看本次会更新哪些 Agent：

```bash
npm run skills:sync:dry-run
```

执行完整 Native CEF 流程：

```bash
npm run package:mac
```

该命令依次执行：

1. 构建 Native CEF Agent、renderer 和 CLI。
2. 构建 CEF Chrome host 和 AppKit launcher。
3. 生成不含 Electron/app.asar 的 `release-native/UFO-Browser.app` 和拖拽安装 DMG。
4. 运行 Native bundle、relocated install、CLI/Skill sync 和 Electron-free 进程树 smoke。
5. 安装流程从 App 内 Skill 目录同步 Claude、Codex 和其他已安装 Agent。

`npm run release:mac` 是同一正式流程的别名。

## 从 DMG 安装到 `/Applications`

DMG 生成后，使用明确的 DMG 路径执行安装流程：

```bash
npm run install:mac -- release-native/UFO-Browser-0.1.7-native.dmg
```

该流程只替换明确的 `/Applications/UFO-Browser.app`：

1. 以只读方式挂载 DMG，并确认镜像中包含 `UFO-Browser.app`。
2. 仅结束 UFO-Browser 自己的 `UFO-Browser` 进程，不影响 Ego Lite 或其他 Electron 应用。
3. 先复制到 `/Applications/.UFO-Browser.app.install-*`，再原子替换旧 App；替换失败会尝试恢复旧 App。
4. 卸载 DMG，并校验已安装 Native App 的 CEF host、内置 Skill 和版本信息。
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
