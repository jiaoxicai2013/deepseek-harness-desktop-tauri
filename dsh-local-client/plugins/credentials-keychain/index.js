/**
 * Local client credentials provider: secrets live only in the OS credential
 * facility (macOS Keychain via the security CLI), never as plaintext on disk.
 * Drop-in replacement for @deepseek-ai/dsh-credentials-local in the Tauri
 * desktop shell.
 *
 * The seam has two key spaces (upstream >=0.1.2):
 *  1. Reference half (CredentialRef): env-style names layered over the
 *     process environment, the Keychain, and .env files.
 *  2. Record half (CredentialKey "scope/id"): plugin-owned durable records
 *     (api-key / grant). Values live ONLY in the Keychain; a small index file
 *     under $DSH_HOME keeps just the record KEYS (no secrets) so enumeration
 *     (listRecords) works — the Keychain CLI cannot list items by service.
 *
 * One-time migration: legacy plaintext .credentials.yaml reference entries
 * are moved into the Keychain and the file removed.
 * @module dsh-local-credentials-keychain
 */

import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { CredentialProvider, credentialRef, parseCredentialKey } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { CREDENTIALS_FILENAME, parseCredentialsDocument } from '@deepseek-ai/dsh-credentials-local'

const execFileAsync = promisify(execFile)

/** macOS Keychain CLI. */
const SECURITY = '/usr/bin/security'

/** security find-generic-password exit code when the item does not exist. */
const NOT_FOUND = 44

/** Default Keychain service name under which all items live. */
const DEFAULT_SERVICE = 'DeepSeek Harness Local'

/** Record-key index basename under the harness home (keys only, no secrets). */
const RECORDS_INDEX_FILENAME = '.credentials.records.json'

/** Keychain access wrapper around the security CLI. */
export class KeychainClient {
  constructor(service) {
    this.service = service
  }

  available() {
    return process.platform === 'darwin' && existsSync(SECURITY)
  }

  async get(account) {
    try {
      const { stdout } = await execFileAsync(
        SECURITY, ['find-generic-password', '-s', this.service, '-a', account, '-w'],
        { timeout: 5000 },
      )
      return stdout
    } catch (error) {
      if (error?.code === NOT_FOUND) return undefined
      throw new Error('credentials-keychain: lookup failed for "' + account + '": ' + (error?.message ?? error))
    }
  }

  async set(account, value) {
    try {
      await execFileAsync(
        SECURITY, ['add-generic-password', '-U', '-s', this.service, '-a', account, '-w', value],
        { timeout: 5000 },
      )
    } catch (error) {
      throw new Error('credentials-keychain: store failed for "' + account + '": ' + (error?.message ?? error))
    }
  }

  async delete(account) {
    try {
      await execFileAsync(
        SECURITY, ['delete-generic-password', '-s', this.service, '-a', account],
        { timeout: 5000 },
      )
    } catch (error) {
      if (error?.code !== NOT_FOUND) {
        throw new Error('credentials-keychain: delete failed for "' + account + '": ' + (error?.message ?? error))
      }
    }
  }
}

/** Minimal validation mirroring upstream assertStorableApiKey / assertJsonValue. */
function assertStorableRecord(key, record) {
  if (record.kind === 'grant') return // any JSON value survives our JSON round trip
  if (record.kind !== 'api-key') {
    throw new Error('credentials-keychain: record "' + key + '" has unknown kind ' + JSON.stringify(record.kind))
  }
  const { key: apiKey, env } = record
  if (apiKey !== undefined && (typeof apiKey !== 'string' || apiKey.length === 0)) {
    throw new Error('credentials-keychain: api-key record "' + key + '" has an invalid key')
  }
  if (env !== undefined) {
    if (typeof env !== 'object' || env === null || Array.isArray(env)) {
      throw new Error('credentials-keychain: api-key record "' + key + '" has an invalid env map')
    }
    for (const [name, value] of Object.entries(env)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || typeof value !== 'string') {
        throw new Error('credentials-keychain: api-key record "' + key + '" has an invalid env entry ' + name)
      }
    }
  }
}

/**
 * Keychain credentials provider: references and records live in the Keychain;
 * the only on-disk document under $DSH_HOME is the record-key index.
 */
export class KeychainCredentialProvider extends CredentialProvider {
  static Config = z.object({
    dshHome: z.string(),
    service: z.string().default(DEFAULT_SERVICE),
  })

  constructor(ctx, config) {
    super(ctx)
    this.service = config.service ?? DEFAULT_SERVICE
    this.keychain = new KeychainClient(this.service)
    const home = resolveDshHome(config.dshHome)
    this.legacyFilename = resolve(join(home, CREDENTIALS_FILENAME))
    this.recordsIndexFile = resolve(join(home, RECORDS_INDEX_FILENAME))
    this.closed = false
    this.recordKeys = new Set()
    this.operations = Promise.resolve() // serialize record writes
    // In-memory backend for smoke tests / CI on restricted hosts (Keychain
    // writes can be denied by sandboxes). Production never sets this.
    this.memory = process.env.DSH_CREDENTIALS_BACKEND === 'memory' ? new Map() : null
    this.loadIndex()
  }

  /** Backend is writable: memory mode always, Keychain when the CLI works. */
  keychainAvailable() {
    return this.memory !== null || this.keychain.available()
  }

  /** Read one account's raw value through the active backend. */
  async readRaw(account) {
    if (this.memory !== null) return this.memory.get(account)
    return this.keychain.get(account)
  }

  /** Write one account's raw value through the active backend. */
  async writeRaw(account, value) {
    if (this.memory !== null) {
      this.memory.set(account, value)
      return
    }
    await this.keychain.set(account, value)
  }

  /** Delete one account through the active backend. */
  async deleteRaw(account) {
    if (this.memory !== null) {
      this.memory.delete(account)
      return
    }
    await this.keychain.delete(account)
  }

  // ---- record index ------------------------------------------------------
  loadIndex() {
    try {
      if (existsSync(this.recordsIndexFile)) {
        const doc = JSON.parse(readFileSync(this.recordsIndexFile, 'utf8'))
        this.recordKeys = new Set(Array.isArray(doc?.records) ? doc.records : [])
      }
    } catch {
      // corrupt index: fail loud on the next write rather than silently reset
      this.ctx?.logger?.warn?.('credentials-keychain: records index unreadable; starting empty')
      this.recordKeys = new Set()
    }
  }

  saveIndex() {
    if (this.memory !== null) return // memory backend: no index on disk
    mkdirSync(dirname(this.recordsIndexFile), { recursive: true })
    const tmp = this.recordsIndexFile + '.tmp'
    writeFileSync(tmp, JSON.stringify({ records: [...this.recordKeys].sort() }, null, 2) + '\n')
    renameSync(tmp, this.recordsIndexFile)
  }

  enqueue(operation) {
    const task = this.operations.then(operation)
    this.operations = task.then(() => undefined, () => undefined)
    return task
  }

  // ---- record helpers ----------------------------------------------------
  async readRecordParsed(key) {
    if (!this.keychainAvailable()) return undefined
    const raw = await this.readRaw(key)
    if (raw === undefined) return undefined
    try {
      return JSON.parse(raw)
    } catch {
      throw new Error('credentials-keychain: stored record "' + key + '" is not valid JSON; preserved, not overwritten')
    }
  }

  async writeRecord(key, record) {
    await this.writeRaw(key, JSON.stringify(record))
    this.recordKeys.add(key)
    this.saveIndex()
  }

  // ---- record half (upstream >=0.1.2 abstract API) -----------------------
  readRecord(key) {
    return this.readRecordParsed(key)
  }

  async describeRecord(key) {
    const writable = this.keychainAvailable()
    const stored = await this.readRecordParsed(key)
    if (stored === undefined) return { configured: false, writable }
    return { configured: true, kind: stored.kind, writable }
  }

  async listRecords() {
    const entries = []
    for (const joined of this.recordKeys) {
      const record = await this.readRecordParsed(joined)
      if (record !== undefined) {
        entries.push({ key: parseCredentialKey(joined), kind: record.kind })
      }
    }
    return entries
  }

  async modifyRecord(key, mutate) {
    if (this.closed) throw new Error('credentials-keychain is disposed: cannot modify "' + key + '"')
    return this.enqueue(async () => {
      if (this.closed) throw new Error('credentials-keychain was disposed before the queued modify ran')
      if (!this.keychainAvailable()) throw new Error('credentials-keychain: Keychain unavailable; cannot modify records')
      const current = await this.readRecordParsed(key)
      const next = await mutate(current)
      if (next === undefined) return current
      assertStorableRecord(key, next)
      await this.writeRecord(key, next)
      this.notifyRecordUpdated(parseCredentialKey(key))
      return next
    })
  }

  async deleteRecord(key) {
    if (this.closed) throw new Error('credentials-keychain is disposed: cannot delete "' + key + '"')
    await this.enqueue(async () => {
      if (this.closed) throw new Error('credentials-keychain was disposed before the queued delete ran')
      if ((await this.readRecordParsed(key)) !== undefined) {
        await this.deleteRaw(key)
        this.recordKeys.delete(key)
        this.saveIndex()
        this.notifyRecordUpdated(parseCredentialKey(key))
      }
    })
  }

  // ---- reference half ----------------------------------------------------
  inherited(ref) {
    const entry = launchEnvironmentOf(this.ctx).getFrom(ref, ['process'])
    return entry !== undefined && entry.value.length > 0 ? entry.value : undefined
  }

  dotenvFallback(ref) {
    const entry = launchEnvironmentOf(this.ctx).getFrom(ref, ['project-env', 'user-env'])
    return entry !== undefined && entry.value.length > 0 ? entry : undefined
  }

  async * [Service.init]() {
    yield () => {
      this.closed = true
    }
    await this.migrateLegacyPlaintext()
  }

  async migrateLegacyPlaintext() {
    if (!existsSync(this.legacyFilename)) return
    if (!this.keychainAvailable()) {
      this.ctx.logger.warn(
        'credentials-keychain: legacy plaintext %s found but the Keychain is unavailable; keeping it untouched',
        this.legacyFilename,
      )
      return
    }
    const entries = readLegacyPlaintextDocument(this.legacyFilename)
    let migrated = 0
    for (const [ref, value] of entries) {
      credentialRef(ref)
      if ((await this.readRaw(ref)) !== undefined) continue
      await this.writeRaw(ref, value)
      migrated += 1
    }
    unlinkSync(this.legacyFilename)
    this.ctx.logger.info(
      'credentials-keychain: migrated %d plaintext entr%s from %s to the Keychain',
      migrated, migrated === 1 ? 'y' : 'ies', this.legacyFilename,
    )
  }

  async resolve(ref) {
    const inherited = this.inherited(ref)
    if (inherited !== undefined) return Promise.resolve({ value: inherited, source: 'env' })
    const stored = this.keychainAvailable() ? await this.readRaw(ref) : undefined
    if (stored !== undefined && stored.length > 0) return Promise.resolve({ value: stored, source: 'keychain' })
    const fallback = this.dotenvFallback(ref)
    if (fallback !== undefined) return Promise.resolve({ value: fallback.value, source: fallback.source })
    return Promise.resolve(undefined)
  }

  async describe(ref) {
    const writable = this.keychainAvailable()
    if (this.inherited(ref) !== undefined) {
      return Promise.resolve({ configured: true, source: 'env', writable: false })
    }
    if (this.keychainAvailable() && (await this.readRaw(ref)) !== undefined) {
      return Promise.resolve({ configured: true, source: 'keychain', writable })
    }
    const fallback = this.dotenvFallback(ref)
    if (fallback !== undefined) return Promise.resolve({ configured: true, source: fallback.source, writable: true })
    return Promise.resolve({ configured: false, writable })
  }

  async set(ref, value) {
    if (value.length === 0) {
      throw new Error('credentials-keychain: an empty value cannot be stored for "' + ref + '"; use unset')
    }
    if (this.closed) throw new Error('credentials-keychain is disposed: cannot set "' + ref + '"')
    this.assertUnshadowed(ref, 'set')
    if (!this.keychainAvailable()) {
      throw new Error('credentials-keychain: Keychain unavailable; refusing to store a plaintext secret')
    }
    await this.writeRaw(ref, value)
    this.notifyUpdated(ref)
  }

  async unset(ref) {
    if (this.closed) throw new Error('credentials-keychain is disposed: cannot unset "' + ref + '"')
    this.assertUnshadowed(ref, 'unset')
    if (this.keychainAvailable() && (await this.readRaw(ref)) !== undefined) {
      await this.deleteRaw(ref)
      this.notifyUpdated(ref)
    }
  }

  assertUnshadowed(ref, verb) {
    if (this.inherited(ref) !== undefined) {
      throw new Error(
        'credentials-keychain: "' + ref + '" is supplied read-only by the launching environment, so ' + verb
        + ' would be shadowed; unset it in the shell you start the app from instead',
      )
    }
  }
}

/** Parse the legacy plaintext credentials document (reference half only). */
export function readLegacyPlaintextDocument(legacyFile) {
  return parseCredentialsDocument(readFileSync(legacyFile, 'utf8'), legacyFile)
}

export default KeychainCredentialProvider