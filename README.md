# CodexBridge

CodexBridge 是一个用于 Codex Desktop 的会话桥接工具。它可以在 API 模式、登录账号模式、不同 profile 和不同设备之间复制、克隆、导出和导入 Codex 会话。

## 为什么需要它

Codex Desktop 的本地会话并不只是简单的聊天文本。API 模式和登录账号模式可能共用一部分本地数据，但会话列表会按内部状态和 provider 过滤，导致切换登录方式后看不到原来的项目和聊天。

CodexBridge 的目标是把这些本地会话安全地“桥接”过去，让你可以继续使用已有上下文。

## 功能

- `API 到登录`：把 API 模式下的会话克隆到登录账号视图。
- `登录到 API`：把登录账号下的会话克隆到 API 视图。
- `两端同步`：在两个 Codex profile 目录之间复制会话。
- `导出聊天`：生成可迁移的会话包，适合换设备。
- `导入会话`：把迁移包写回目标 Codex profile。
- `按项目筛选`：只处理某个 `cwd` 对应的项目。

## 桌面应用

CodexBridge 是中文桌面应用，不是网页工具。

界面包含：

- 模式切换
- Codex profile 目录选择
- 项目列表
- 预览结果
- 执行按钮

## 下载

发布版会放在 GitHub Releases。

计划提供：

- Windows：`CodexBridge-Desktop.exe`
- macOS：`.zip`
- Linux：`.zip`

## 使用提示

执行写入前请先关闭 Codex Desktop。Codex 正在运行时可能会占用或覆盖 SQLite 状态。

首次使用请先点 `预览`，确认会处理的项目、会话数量和目标位置，再执行写入。

## 开发

```powershell
npm install
npm run check
npm run desktop:app
```

## 构建

Windows 绿色版：

```powershell
npm run package:win
```

Windows 目录版：

```powershell
npm run package:win:dir
```

macOS zip：

```bash
npm run package:mac
```

Linux zip：

```bash
npm run package:linux
```

多平台安装包建议通过 GitHub Actions 在对应系统上构建，并上传到 GitHub Releases。

## 项目结构

- `src/cli.js`：文件同步、导出、导入逻辑
- `src/provider-clone.js`：同一 profile 内的 API/登录互转克隆
- `src/state-sync.js`：SQLite `threads` 表同步
- `src/profile-utils.js`：profile 和项目识别
- `src/electron-main.js`：Electron 主进程
- `src/electron-preload.cjs`：安全 IPC 桥
- `web/`：桌面 UI

## 注意

CodexBridge 依赖 Codex Desktop 当前的本地数据结构，包括 `sessions`、`archived_sessions`、`session_index.jsonl` 和 `state_5.sqlite`。如果 Codex Desktop 未来调整内部格式，本项目也需要跟进。
