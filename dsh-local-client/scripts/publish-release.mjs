#!/usr/bin/env node
/**
 * Publish a GitHub Release for the DeepSeek Harness Local client.
 *
 * Usage:
 *   GITHUB_TOKEN=github_pat_... node scripts/publish-release.mjs [--tag v0.1.0]
 *
 * Creates the release on the pushed tag and uploads the DMG + PKG installers.
 * The token is read from the environment ONLY (never written to disk).
 */

const OWNER = 'jiaoxicai2013'
const REPO = 'deepseek-harness-desktop-tauri'
const TAG = process.argv.includes('--tag')
  ? process.argv[process.argv.indexOf('--tag') + 1]
  : 'v0.1.0'

const token = process.env.GITHUB_TOKEN
if (!token) {
  console.error('缺少 GITHUB_TOKEN 环境变量。创建方式：')
  console.error('  GitHub → Settings → Developer settings → Fine-grained tokens')
  console.error('  仓库权限：Contents → Read and write')
  process.exit(1)
}

const API = 'https://api.github.com'
const headers = {
  Authorization: 'Bearer ' + token,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'dsh-local-publisher',
}

const NOTES = `## DeepSeek Harness Local v0.1.0

基于 Tauri v2 的 DeepSeek Harness 本地桌面客户端（macOS x64）。

### 特性
- 官方 DeepSeek Harness Web UI（Node 宿主 sidecar 本地伺服，含 boot manifest 注入）
- 凭据存 macOS Keychain（自写 provider，磁盘零明文，旧明文自动迁移）
- 托盘 / 单实例 / 崩溃看门狗 / 优雅退出
- 显示器 + 官方 DeepSeek 鲸鱼 logo 图标

### 安装
- \`DeepSeek Harness Local_0.1.0_x64.dmg\`：双击打开，拖入 Applications
- \`DeepSeek Harness Local.pkg\`：向导式安装

> 未签名应用：首次打开请 **右键 → 打开**。

### 已知限制
- 仅 macOS x64（Intel）；Apple Silicon 需在 arm64 环境重新构建
- 未签名 / 未公证（正式分发需 Apple 开发者证书）`

async function api(path, opts = {}) {
  const res = await fetch(API + path, { ...opts, headers })
  const body = res.status === 204 ? null : await res.json().catch(() => null)
  if (!res.ok) {
    throw new Error(`API \${res.status} \${path}: \${JSON.stringify(body).slice(0, 300)}`)
  }
  return body
}

// 1. create release
const release = await api('/repos/' + OWNER + '/' + REPO + '/releases', {
  method: 'POST',
  body: JSON.stringify({
    tag_name: TAG,
    name: 'DeepSeek Harness Local ' + TAG,
    body: NOTES,
    draft: false,
    prerelease: false,
  }),
})
console.log('release created:', release.html_url)

// 2. upload assets (DMG + PKG)
const assets = [
  { path: 'dist/DeepSeek Harness Local_0.1.0_x64.dmg', name: 'DeepSeek Harness Local_0.1.0_x64.dmg' },
  { path: 'dist/DeepSeek Harness Local.pkg', name: 'DeepSeek Harness Local.pkg' },
]
for (const a of assets) {
  const { readFileSync } = await import('node:fs')
  const { fileURLToPath } = await import('node:url')
  const { dirname, join } = await import('node:path')
  const here = dirname(fileURLToPath(import.meta.url))
  const file = join(here, '..', a.path)
  const data = readFileSync(file)
  const up = await fetch(
    release.upload_url.replace('{?name,label}', '') + '?name=' + encodeURIComponent(a.name),
    {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/octet-stream', 'Content-Length': String(data.length) },
      body: new Uint8Array(data),
    },
  )
  const upBody = await up.json().catch(() => null)
  if (!up.ok) throw new Error(`asset upload failed \${up.status}: \${JSON.stringify(upBody).slice(0, 300)}`)
  console.log('asset uploaded:', a.name, '(', (data.length / 1048576).toFixed(1), 'MB )')
}

console.log('\n发布完成：https://github.com/' + OWNER + '/' + REPO + '/releases/tag/' + TAG)
