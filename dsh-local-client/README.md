# DeepSeek Harness Local — 本地客户端

把 deepseek-harness 项目打包成独立 macOS 桌面客户端（.app）。

## 架构（自设计接线，非 Electron）

```text
┌────────────────────────────────────────────────┐
│ DeepSeek Harness Local.app（Tauri v2，Rust 壳） │
│  · 启动 Node host sidecar（捆绑 Node 24）       │
│  · 解析宿主 stdout 的 URL 行拿到端口            │
│  · WebView 加载 http://127.0.0.1:<port>/        │
│  · 托盘 / 单实例 / 窗口状态 / 优雅退出          │
└──────────────────────┬─────────────────────────┘
                       │ spawn + stdout 端口信号
┌──────────────────────▼─────────────────────────┐
│ Node host（resources/runtime）                 │
│  · @deepseek-ai/dsh@0.1.0-rc.7（npm 发布包）    │
│  · dsh --profile web：伺服官方前端 + API/SSE    │
│  · desktop.patch.yml：禁遥测 + 凭据换 Keychain  │
│  · dsh-local-credentials-keychain 插件          │
│    （macOS Keychain 经 security CLI，绝不明文） │
└────────────────────────────────────────────────┘
```

关键点：宿主本身就是本地 HTTP 服务（官方 web GUI 就是它），所以壳无需
自造 dsh:// 协议或 IPC 桥——WebView 直接访问宿主 URL，boot manifest
（window.__DSH_BOOT__）由宿主注入。

## 图标

深色显示器 + 官方 DeepSeek 黑白鲸鱼 logo（屏幕内白色）：
- 源文件：`src-tauri/icons/icon-source.png`（1024×1024，由 `scripts/gen-icon.mjs` 生成）
- 预览：`src-tauri/icons/icon-preview.png`（512px）
- logo 路径取自 simple-icons 的官方 DeepSeek 矢量（24×24 viewBox），
  生成脚本自动按渲染像素扫描居中（无视觉预览也能精确对齐）
- 修改设计后重新生成：`node scripts/gen-icon.mjs && npx tauri icon src-tauri/icons/icon-source.png`

## 接入上游更新

上游 [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 发版频繁
（daily alpha、频繁 rc）。本客户端通过 npm 发布的 `@deepseek-ai/dsh` 追踪上游——
宿主、前端、插件同版本捆绑。接入流程：

```bash
node scripts/update-upstream.mjs --check                          # 检查是否有更新
node scripts/update-upstream.mjs --apply                           # 更新到 npm latest
node scripts/update-upstream.mjs --apply --channel alpha           # 更新到 alpha 线
node scripts/update-upstream.mjs --apply --version 0.1.2-alpha.5   # 指定版本
node scripts/update-upstream.mjs --apply --force                   # 无变化时强制重装+冒烟
```

**事务式**：管线 = 规范化插件 peer 范围 → 重新组装运行时（pnpm 安装 + 原生模块）→
启动新宿主冒烟（HTTP 200 + boot manifest）。全部通过后钉点（`runtime-version.json`）
才更新；任一步失败则回滚钉点并退出非零——上游发布损坏的版本不会卡死客户端。

**版本单一来源**：`runtime-version.json`（assemble 与 update 都读它）。
assemble 会把实际安装的上游版本写进 `resources/runtime/version.json`，
客户端窗口标题显示「DeepSeek Harness Local · dsh <版本>」便于核对嵌入版本。

**已知上游问题**（2026-08 观测）：npm `latest` 的 `0.1.1-rc.2` 依赖
`dsh-invariants@>=0.1.1 <0.2.0-0`，该范围按 semver 预发布规则排除了所有 0.1.1
预发布版 → 无法安装。当前钉点为可安装的 `0.1.0-rc.8`；待上游修复后
`--apply` 即可跟进。

## 目录

- `src-tauri/` — Rust 壳（main.rs / lib.rs / host.rs）
- `resources/runtime/` — 打包进 .app 的运行时
  - `node/` — Node.js 24 运行时（本地解包）
  - `app/` — dsh 宿主（npm 安装的发布包 + 插件）
  - `plugins/credentials-keychain/` — Keychain 凭据 provider 源码
  - `desktop.patch.yml` — 客户端 profile patch 层
- `scripts/assemble-runtime.mjs` — 一键重装运行时（可复现）

## 构建

```bash
# 1) 准备工具链（Node 24 + pnpm，工作区内）
#    .tools/node、.tools/pnpm（见项目根 README 的安装过程）

# 2) 组装运行时（npm 安装 dsh rc.7 + 原生模块 rebuild + 插件接线）
npm run assemble          # 等价于 node scripts/assemble-runtime.mjs

# 3) 打 .app（需要 Rust 工具链；CARGO_HOME/RUSTUP_HOME 在工作区）
export PATH="$PWD/../.tools/cargo/bin:$PATH"
cd src-tauri && cargo check && cargo build --release
cd .. && npx tauri build   # 产物：src-tauri/target/release/bundle/macos/*.app
```

未签名：首次打开需 右键 → 打开（或 xattr -dr com.apple.quarantine）。

## 运行行为

- **DSH_HOME 环境变量**：默认 `~/Library/Application Support/ai.deepseek.harness-local/dsh-home`；
  设置 `DSH_HOME` 可重定向（例如测试/便携模式）。
- **宿主看门狗**：`host-wrapper.sh` 把宿主作为子进程；外壳进程死亡时 stdin EOF
  触发优雅 TERM，外壳发送 TERM/INT 时转发给宿主——任何退出路径都不会留下孤儿进程。
- 已验证：启动 → 宿主伺服官方 UI（HTTP 200 + `window.__DSH_BOOT__`）→ 优雅退出全链路。

- 首次启动在 `~/Library/Application Support/ai.deepseek.harness-local/` 建
  `dsh-home`（profile / sessions）与 `logs/host.log`（宿主 stderr）。
- 凭据（DEEPSEEK_API_KEY 等）存 macOS Keychain（service: "DeepSeek Harness Local"），
  不落盘明文；旧明文 `.credentials.yaml` 首次启动自动迁移后删除。
- 托盘可隐藏/显示窗口；退出时先 SIGTERM 宿主（有界 dispose），3 秒后强杀兜底。
- 单实例：重复启动只会聚焦已有窗口。