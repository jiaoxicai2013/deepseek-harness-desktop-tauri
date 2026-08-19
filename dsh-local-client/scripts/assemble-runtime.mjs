#!/usr/bin/env node
/**
 * Assemble the bundled runtime for the DeepSeek Harness Local client.
 *
 * Layout produced under resources/runtime:
 *   node/                      the Node.js runtime (extracted, self-contained)
 *   app/                       the dsh host runtime (npm-installed published packages)
 *   plugins/credentials-keychain/   the local Keychain credentials provider (source)
 *   desktop.patch.yml          the client profile patch layer
 *
 * The shell (src-tauri/src/host.rs) spawns resources/runtime/node/bin/node with
 * resources/runtime/app/lib/bin.js, DSH_HOME pointed at the app-data dir, and
 * the profile patch appended.
 */

import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const runtime = join(root, 'src-tauri', 'resources', 'runtime')
const appDir = join(runtime, 'app')
const nodeDir = join(runtime, 'node')
const tools = join(root, '..', '.tools')

const NODE_SRC = process.env.DSH_NODE_DIR ?? join(tools, 'node')
const NPM_CACHE = join(tools, 'npm-cache')

function sh(cmd, args, opts = {}) {
  console.log('$', cmd, ...args)
  return execFileSync(cmd, args, { stdio: 'inherit', ...opts })
}

// 1. Node runtime
console.log('\n== 1/4 Node runtime ==')
if (!existsSync(join(NODE_SRC, 'bin', 'node'))) {
  throw new Error(`node distribution not found at ${NODE_SRC}; set DSH_NODE_DIR or install Node 24 first`)
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
console.log('\n== 2/4 dsh host runtime ==')
rmSync(appDir, { recursive: true, force: true })
mkdirSync(appDir, { recursive: true })
writeFileSync(join(appDir, 'package.json'), JSON.stringify({
  name: 'dsh-local-runtime',
  private: true,
  version: '0.1.0',
  type: 'module',
  dependencies: {
    '@deepseek-ai/dsh': '0.1.0-rc.7',
    'dsh-local-credentials-keychain': 'file:../plugins/credentials-keychain',
  },
}, null, 2) + '\n')
sh(join(NODE_SRC, 'bin', 'npm'), ['install', '--cache', NPM_CACHE, '--no-audit', '--no-fund'], { cwd: appDir })
// Native modules' install scripts were skipped by npm's allow-scripts policy.
console.log('\n-- rebuilding native modules --')
sh(join(NODE_SRC, 'bin', 'npm'), ['rebuild', 'node-pty', 'koffi', '@deepseek-ai/dsh-subprocess-local', '--cache', NPM_CACHE], { cwd: appDir })

// 3. Credentials provider: physical copy inside app/node_modules so the
//    plugin's own imports resolve from the app installation.
console.log('\n== 3/4 credentials provider ==')
rmSync(join(appDir, 'node_modules', 'dsh-local-credentials-keychain'), { recursive: true, force: true })
mkdirSync(join(appDir, 'node_modules', 'dsh-local-credentials-keychain'), { recursive: true })
cpSync(join(root, 'plugins', 'credentials-keychain', 'package.json'),
  join(appDir, 'node_modules', 'dsh-local-credentials-keychain', 'package.json'))
cpSync(join(root, 'plugins', 'credentials-keychain', 'index.js'),
  join(appDir, 'node_modules', 'dsh-local-credentials-keychain', 'index.js'))
// The manifest dependency spec must be a plain version for the flat fallback
// closure walk (healProfilesModuleFallback reads the app manifest).
const manifest = JSON.parse(execFileSync(join(NODE_SRC, 'bin', 'node'), ['-e',
  `console.log(JSON.stringify(require('${join(appDir, 'package.json')}')))`]).toString())
manifest.dependencies['dsh-local-credentials-keychain'] = '0.1.0'
writeFileSync(join(appDir, 'package.json'), JSON.stringify(manifest, null, 2) + '\n')

// 4. Report
console.log('\n== 4/4 done ==')
const { execSync } = await import('node:child_process')
console.log(execSync(`du -sh '${runtime}'`).toString().trim())