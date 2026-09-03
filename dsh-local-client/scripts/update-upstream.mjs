#!/usr/bin/env node
/**
 * Upstream update workflow for the DeepSeek Harness Local client.
 *
 * The runtime bundles the npm-published @deepseek-ai/dsh host. Upstream ships
 * fast (daily alphas, frequent rcs), so this script turns "接入新上游版本"
 * into one repeatable pipeline:
 *
 *   --check                                   report drift only
 *   --apply [--version 0.1.1-rc.2]            bump pin + normalize plugin peers
 *           [--channel alpha|latest]          (default: npm 'latest')
 *           [--skip-source]                   don't refresh the source clone
 *           [--skip-assemble]                 skip the runtime rebuild
 *           [--skip-smoke]                    skip the host boot smoke test
 *           [--force]                         rerun even when nothing changed
 *
 * The apply phase is TRANSACTIONAL: the pin in runtime-version.json moves only
 * after the runtime reassembles AND the host smoke test passes, so an upstream
 * release that does not install (or boots broken) never strands the client on
 * a bad pin.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const repoRoot = join(root, '..')
const tools = join(repoRoot, '.tools')
const NODE = join(tools, 'node', 'bin', 'node')
const NODE_BIN_DIR = join(tools, 'node', 'bin')

const args = process.argv.slice(2)
const mode = args.includes('--check') ? 'check' : 'apply'
const opt = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined)
const flag = (name) => args.includes(name)
const VERSION_FILE = join(root, 'runtime-version.json')
const PLUGIN_MANIFEST = join(root, 'plugins', 'credentials-keychain', 'package.json')
const ASSEMBLE = join(root, 'scripts', 'assemble-runtime.mjs')

function sh(cmd, cargs, opts = {}) {
  console.log('  run>', cmd.split('/').pop(), ...cargs)
  const env = { ...process.env, ...(opts.env ?? {}), PATH: NODE_BIN_DIR + ':' + (process.env.PATH ?? '') }
  return execFileSync(cmd, cargs, { encoding: 'utf8', stdio: 'inherit', ...opts, env })
}

// ---- version helpers -------------------------------------------------------
function parseV(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-(\w[\w.]*))?$/.exec(String(v).trim())
  if (!m) throw new Error('bad version: ' + v)
  return { maj: +m[1], min: +m[2], pat: +m[3], pre: m[4] ?? null }
}
function cmpVer(a, b) {
  const A = parseV(a), B = parseV(b)
  for (const k of ['maj', 'min', 'pat']) {
    if (A[k] !== B[k]) return A[k] - B[k]
  }
  if (A.pre === null && B.pre === null) return 0
  if (A.pre === null) return 1 // release > prerelease
  if (B.pre === null) return -1
  return A.pre.localeCompare(B.pre)
}
// ---- npm registry ----------------------------------------------------------
async function npmInfo() {
  const res = await fetch('https://registry.npmjs.org/@deepseek-ai%2Fdsh')
  if (!res.ok) throw new Error('registry fetch failed: ' + res.status)
  return (await res.json())['dist-tags'] ?? {}
}
// ---- peer ranges -----------------------------------------------------------
/**
 * npm's prerelease gate: a prerelease version only satisfies a range when some
 * comparator shares its <maj>.<min>.<pat> tuple (verified empirically). Upstream
 * versions are 0.1.<patch>-rc/alpha, so the union over patches 0..targetPat of
 * ^0.1.<p>-0 covers every prerelease/release of the current patch line.
 */
function coverageRange(target) {
  const v = parseV(target)
  const parts = []
  for (let p = 0; p <= v.pat; p++) parts.push('^' + v.maj + '.' + v.min + '.' + p + '-0')
  return parts.join(' || ')
}
/** Rewrite the credentials plugin dsh-* peers to cover target. Returns changed. */
function normalizePeers(target) {
  const manifest = JSON.parse(readFileSync(PLUGIN_MANIFEST, 'utf8'))
  const range = coverageRange(target)
  let changed = false
  for (const dep of Object.keys(manifest.peerDependencies ?? {})) {
    if (!dep.startsWith('@deepseek-ai/dsh-')) continue
    if (manifest.peerDependencies[dep] !== range) {
      manifest.peerDependencies[dep] = range
      changed = true
    }
  }
  if (changed) {
    writeFileSync(PLUGIN_MANIFEST, JSON.stringify(manifest, null, 2) + '\n')
    console.log('  peer 范围规范化: ' + range)
  } else {
    console.log('  peer 范围已覆盖 ' + target)
  }
  return changed
}
// ---- smoke test ------------------------------------------------------------
async function smokeTest() {
  const runtime = join(root, 'src-tauri', 'resources', 'runtime')
  const nodeBin = join(runtime, 'node', 'bin', 'node')
  // The host entry lives under the installed @deepseek-ai/dsh package.
  const bin = join(runtime, 'app', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  const patch = join(runtime, 'desktop.patch.yml')
  if (!existsSync(bin)) throw new Error('runtime 未组装（先跑 assemble）: ' + bin)
  const home = mkdtempSync(join(tmpdir(), 'dsh-smoke-'))
  const { spawn } = await import('node:child_process')
  console.log('  冒烟测试: 启动新宿主 …')
  const child = spawn(nodeBin, [bin, 'web', '--patch', patch, '--host', '127.0.0.1', '--port', '0'], {
    env: { ...process.env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1', DSH_CREDENTIALS_BACKEND: 'memory' },
  })
  let url
  let out = ''
  const killer = setTimeout(() => child.kill('SIGKILL'), 90000)
  await new Promise((resolve, reject) => {
    const failTimer = setTimeout(() => reject(new Error('超时未就绪\n' + out.slice(-800))), 60000)
    child.stdout.on('data', (chunk) => {
      out += chunk
      const m = out.match(/http:\/\/127\.0\.0\.1:\d+(\/[^\s]*)?/)
      if (m && !url) { url = m[0]; clearTimeout(failTimer); resolve() }
    })
    child.on('exit', (code) => reject(new Error('宿主提前退出 code=' + code + '\n' + out.slice(-800))))
  })
  clearTimeout(killer)
  // 0.1.2+ requires a browser-session token: GET the printed URL (303 -> cookie),
  // then request the root with that cookie.
  const urlRoot = url.split('?')[0]
  const first = await fetch(url, { redirect: 'manual' }) // keep the 303: it carries the session cookie
  const setCookies = typeof first.headers.getSetCookie === 'function'
    ? first.headers.getSetCookie()
    : (first.headers.get('set-cookie') ? [first.headers.get('set-cookie')] : [])
  const cookie = (setCookies[0] ?? '').split(';')[0]
  const res = await fetch(urlRoot, { headers: cookie ? { Cookie: cookie } : {} })
  const html = await res.text()
  child.kill('SIGTERM')
  await new Promise((r2) => child.once('exit', r2))
  rmSync(home, { recursive: true, force: true })
  if (res.status !== 200 || !html.includes('__DSH_BOOT__')) {
    throw new Error('冒烟测试未通过: HTTP ' + res.status + (cookie ? '' : ' (无会话 cookie)'))
  }
  console.log('  冒烟测试通过 ✓  HTTP 200 + boot manifest | ' + urlRoot)
}

// =============================================================================
const versionManifest = JSON.parse(readFileSync(VERSION_FILE, 'utf8'))
const current = versionManifest.dsh
const tags = await npmInfo()
const latest = tags['latest']
const alpha = tags['alpha'] ?? tags['next']
const target = opt('--version') ?? (opt('--channel') === 'alpha' ? alpha : latest)

console.log('== 上游更新检查 ==')
console.log('  当前钉住 :', current)
console.log('  npm latest:', latest, '| alpha:', alpha ?? '-')

if (mode === 'check') {
  const drift = cmpVer(target, current)
  console.log(drift > 0 ? '  → 有可用更新: ' + target : '  → 已是最新（按 ' + (opt('--channel') ?? 'latest') + '）')
  process.exit(drift > 0 ? 1 : 0)
}

// ---- apply (transactional) --------------------------------------------------
console.log('== 应用更新 →', target, '==')
const pinChanged = cmpVer(target, current) !== 0
const peersChanged = normalizePeers(target)
if (!pinChanged && !peersChanged && !flag('--force')) {
  console.log('  无变更（已是最新且 peer 覆盖完整）。用 --force 可强制重装/冒烟')
  process.exit(0)
}
if (!flag('--skip-source') && existsSync(join(repoRoot, 'deepseek-harness', '.git'))) {
  console.log('  刷新源码 clone (dev reference) …')
  try { execFileSync('git', ['-C', join(repoRoot, 'deepseek-harness'), 'pull', '--ff-only'], { stdio: 'inherit' }) }
  catch (e) { console.log('    (源码刷新失败，可忽略)') }
}
if (!flag('--skip-assemble')) {
  console.log('  组装运行时 (DSH_VERSION=' + target + ') …')
  try {
    sh(NODE, [ASSEMBLE], { env: { DSH_VERSION: target } })
  } catch (e) {
    console.error('\n✗ 组装失败——钉点未变更（仍是 ' + current + '）')
    console.error('  常见原因: 上游该版本依赖不可解析/安装错误（如 0.1.1-rc.2 的 dsh-invariants 范围缺陷），见上方日志')
    process.exit(1)
  }
}
if (!flag('--skip-smoke')) {
  try { await smokeTest() }
  catch (e) {
    console.error('\n✗ 冒烟测试未通过——钉点未变更（仍是 ' + current + '）')
    console.error('  ' + e.message)
    process.exit(1)
  }
}
if (pinChanged) {
  writeFileSync(VERSION_FILE, JSON.stringify(
    { dsh: target, channel: opt('--channel') ?? 'latest', note: versionManifest.note }, null, 2) + '\n')
  console.log('  ① 钉点已更新: ' + current + ' → ' + target)
} else {
  console.log('  钉点未变（已是 ' + target + '），运行时已按该版本重建')
}

console.log('\n== 下一步 ==')
console.log('  npx tauri build                                    # 重新打包 .app + dmg')
console.log('  客户端版本递增: tauri.conf.json / Cargo.toml version + git tag')
console.log('  GITHUB_TOKEN=… node scripts/publish-release.mjs    # 发布新 Release')