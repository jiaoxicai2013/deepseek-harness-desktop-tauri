# dp-harness-dt — DeepSeek Harness 本地客户端集成

把官方 [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 项目
集成为本地桌面客户端。

## 布局

```text
dp-harness-dt/
├── deepseek-harness/            # 官方源码（master，shallow clone）
├── .tools/                      # 工作区内的工具链（无系统权限要求）
│   ├── node/                    # Node.js v24.19.0（darwin-x64）
│   ├── pnpm/                    # pnpm 11.7.0
│   ├── cargo/  rustup/          # Rust 1.97（Tauri 构建用）
│   └── pnpm-store/ npm-cache/   # 包缓存
├── dsh-local-client/            # ★ 本地客户端工程（Tauri v2）
│   ├── src-tauri/               # Rust 壳（host sidecar 接线）
│   ├── src-tauri/resources/runtime/ # 打包进 .app 的运行时
│   ├── scripts/assemble-runtime.mjs
│   ├── scripts/gen-icon.mjs      # 图标生成（显示器 + 官方鲸鱼 logo）
│   └── README.md                # 客户端详细说明
├── assets/                      # 赞助收款码（微信/支付宝）
└── .ssh/                        # 推送用 SSH 密钥（不入库）
```

## 已完成

1. **源码就位**：clone 官方仓库（master @ v0.1.0-rc.7），`pnpm install` 装依赖，
   `npm run build` 构建全部库 + Web 前端（apps/web/dist）。
2. **运行时组装**（`dsh-local-client/resources/runtime`）：
   - Node 24 运行时（捆绑 sidecar）
   - dsh 宿主 = npm 安装的 `@deepseek-ai/dsh@0.1.0-rc.7`（含全部依赖与 peer），
     原生模块 node-pty / koffi / subprocess-local 已 rebuild
   - 自定义凭据插件 `dsh-local-credentials-keychain`（macOS Keychain，security CLI）
   - 客户端 patch 层 `desktop.patch.yml`（禁遥测 + 凭据换 Keychain）
3. **宿主验证通过**：`node app/lib/bin.js web --host 127.0.0.1 --port 0` 从组装运行时
   启动成功，伺服官方 UI（含 `window.__DSH_BOOT__` 注入），SIGTERM 干净退出。
4. **Tauri v2 壳**：Rust 主进程拉起 sidecar → 解析 URL 行 → WebView 打开
   localhost 端口 → 托盘/单实例/窗口状态/优雅退出。`cargo check` 通过。
5. **打包**：`npx tauri build` 产出 `DeepSeek Harness Local.app`（505MB，含 Node 24 运行时 + dsh 宿主 + 凭据插件）。
6. **端到端验证通过**：启动 → Rust 壳拉起看门狗 wrapper → Node 宿主伺服官方 UI（HTTP 200 + `window.__DSH_BOOT__` 注入）；单实例锁生效；外壳进程死亡（crash 模拟）时看门狗自动清理宿主、释放端口。

## 关键设计决策

- **不用 Electron**：宿主本身是 HTTP 服务，壳只需 WebView 打开 localhost URL，
  无需自造 dsh:// 协议与 IPC 桥；Tauri 产物 ~10MB 壳 + 系统 WebView，跨平台。
- **凭据安全**：官方桌面用 Electron safeStorage；我们自写 provider，密钥直接存
  macOS Keychain（service: "DeepSeek Harness Local"），磁盘上零明文。
- **复用官方 profile 机制**：patch 层 disable 明文 credentials 行、insert 自己的
  provider，与官方桌面同构（disable + insert 对）。

## 构建复现

```bash
cd dsh-local-client
npm run assemble          # 重装运行时
npx tauri build           # 打 .app（src-tauri/target/release/bundle/macos/）
```

未签名应用首次打开：右键 → 打开。
## 赞助支持 ☕

如果这个项目对你有帮助，欢迎请我喝杯咖啡：

<p align="center">
  <img src="assets/wechat.jpg" alt="微信收款码" width="240">
  &nbsp;&nbsp;&nbsp;&nbsp;
  <!-- 支付宝收款码：将图片保存为 assets/alipay.jpg 后取消本行注释
  <img src="assets/alipay.jpg" alt="支付宝收款码" width="240">
  -->
</p>
