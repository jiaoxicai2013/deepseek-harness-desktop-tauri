#!/usr/bin/env node
/**
 * Assemble the bundled runtime for the DeepSeek Harness Local client.
 *
 * Layout produced under src-tauri/resources/runtime:
 *   node/                      the Node.js runtime (extracted, self-contained)
 *   app/                       the dsh host runtime (npm-installed published packages)
 *   plugins/credentials-keychain/   the local Keychain credentials provider (source)
 *   desktop.patch.yml          the client profile patch layer
 *   version.json               the actually-installed dsh runtime version
 *
 * The upstream version comes from runtime-version.json (single source of
 * truth); scripts/update-upstream.mjs bumps it. The shell (host.rs) spawns
 * resources/runtime/node/bin/node with resources/runtime/app/lib/bin.js,
 * DSH_HOME pointed at the app-data dir, and the profile patch appended.
 */

import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const runtime = join(root, 'src-tauri', 'resources', 'runtime')
const appDir = join(runtime, 'app')
const nodeDir = join(runtime, 'node')
const tools = join(root, '..', '.tools')

const NODE_SRC = process.env.DSH_NODE_DIR ?? join(tools, 'node')
// Canonical upstream pin: runtime-version.json is the single source of truth.
const versionManifest = JSON.parse(readFileSync(join(root, 'runtime-version.json'), 'utf8'))
const DSH_VERSION = process.env.DSH_VERSION ?? versionManifest.dsh

function sh(cmd, args, opts = {}) {
  console.log('$', cmd.split('/').pop(), ...args)
  // npm is a shebang script needing node on PATH; always prepend our node dir.
  const env = { ...process.env, PATH: join(NODE_SRC, 'bin') + ':' + (process.env.PATH ?? '') }
  return execFileSync(cmd, args, { stdio: 'inherit', ...opts, env })
}

// 1. Node runtime
console.log('\n== 1/4 Node runtime ==')
if (!existsSync(join(NODE_SRC, 'bin', 'node'))) {
  throw new Error('node distribution not found at ' + NODE_SRC + '; set DSH_NODE_DIR or install Node 24 first')
}
rmSync(nodeDir, { recursive: true, force: true })
cpSync(NODE_SRC, nodeDir, { recursive: true })

// 2a. Canonical plugin + patch sources -> runtime (the npm file: dep and the
//     shell's --patch need them at their runtime locations).
mkdirSync(join(runtime, 'plugins'), { recursive: true })
rmSync(join(runtime, 'plugins', 'credentials-keychain'), { recursive: true, force: true })
cpSync(join(root, 'plugins', 'credentials-keychain'),
  join(runtime, 'plugins', 'credentials-keychain'), { recursive: true })
cpSync(join(root, 'desktop.patch.yml'), join(runtime, 'desktop.patch.yml'))

// 2. dsh host runtime via npm (published packages; peers auto-installed)
console.log('\n== 2/4 dsh host runtime (' + DSH_VERSION + ') ==')
rmSync(appDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 })
mkdirSync(appDir, { recursive: true })
writeFileSync(join(appDir, 'package.json'), JSON.stringify({
  name: 'dsh-local-runtime',
  private: true,
  version: '0.1.0',
  type: 'module',
  dependencies: {
    '@deepseek-ai/dsh': DSH_VERSION,
    'dsh-local-credentials-keychain': 'file:../plugins/credentials-keychain',
  },
}, null, 2) + '\n')
// pnpm: reliable network stack in constrained environments; hoisted layout
// mirrors the flat node_modules the host and heal-fallback were validated with.
// pnpm >=10 denies lifecycle scripts by default; allow the native ones we need.
writeFileSync(join(appDir, 'pnpm-workspace.yaml'), [
  'packages:', '  - .', '',
  'nodeLinker: hoisted',
  'autoInstallPeers: true',
  'allowBuilds:',
  "  node-pty: true",
  "  koffi: true",
  "  '@deepseek-ai/dsh-subprocess-local': true",
  "  esbuild: true",
  "  '@google/genai': false",
  "  protobufjs: false",
  '', '',
].join('\n'))
const PNPM = process.env.DSH_PNPM ?? join(tools, 'pnpm', 'bin', 'pnpm')
sh(PNPM, [
  'install',
  '--store-dir', join(tools, 'pnpm-store'),
  '--config.nodeLinker=hoisted',
  '--config.autoInstallPeers=true',
  '--fetch-retries', '10',
  '--fetch-timeout', '120000',
  '--network-concurrency', '6',
], { cwd: appDir })
// Native modules (node-pty/koffi) run their build scripts during install; the
// subprocess-local postinstall restores the spawn helper's exec bit.
sh(PNPM, ['rebuild', 'node-pty', 'koffi', '@deepseek-ai/dsh-subprocess-local'], { cwd: appDir })

// 2b. Record the actually-installed dsh runtime version (window title / reports).
const dshManifestPath = join(appDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
const installedDsh = JSON.parse(execFileSync(join(NODE_SRC, 'bin', 'node'), [
  '-e', 'process.stdout.write(JSON.stringify(require(process.argv[1])))',
  dshManifestPath,
]).toString())
writeFileSync(join(runtime, 'version.json'),
  JSON.stringify({ dsh: installedDsh.version, builtAt: new Date().toISOString() }, null, 2) + '\n')
console.log('bundled dsh runtime version:', installedDsh.version)

// 3. Credentials provider: physical copy inside app/node_modules so the
//    plugin's own imports resolve from the app installation.
console.log('\n== 3/4 credentials provider ==')
rmSync(join(appDir, 'node_modules', 'dsh-local-credentials-keychain'), { recursive: true, force: true })
mkdirSync(join(appDir, 'node_modules', 'dsh-local-credentials-keychain'), { recursive: true })
cpSync(join(root, 'plugins', 'credentials-keychain', 'package.json'),
  join(appDir, 'node_modules', 'dsh-local-credentials-keychain', 'package.json'))
cpSync(join(root, 'plugins', 'credentials-keychain', 'index.js'),
  join(appDir, 'node_modules', 'dsh-local-credentials-keychain', 'index.js'))
// The host entry lives inside the installed @deepseek-ai/dsh package, whose
// manifest is the profile-boot INSTALL_ANCHOR: healProfilesModuleFallback BFS
// walks ITS dependency closure to build the $DSH_HOME/profiles/node_modules
// fallback. Declare our plugin there so boot can resolve it from any profile.
const anchorManifest = JSON.parse(execFileSync(join(NODE_SRC, 'bin', 'node'), ['-e',
  'process.stdout.write(JSON.stringify(require(process.argv[1])))',
  join(appDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')]).toString())
anchorManifest.dependencies ??= {}
anchorManifest.dependencies['dsh-local-credentials-keychain'] = '0.1.0'
writeFileSync(join(appDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
  JSON.stringify(anchorManifest, null, 2) + '\n')

// 4. Report
console.log('\n== 4/4 done ==')
const { execSync } = await import('node:child_process')
console.log(execSync("du -sh '" + runtime + "'").toString().trim())