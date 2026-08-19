/**
 * Local client credentials provider: secrets live only in the OS credential
 * facility (macOS Keychain via the `security` CLI), never as plaintext on
 * disk. Drop-in replacement for `@deepseek-ai/dsh-credentials-local` in the
 * Tauri desktop shell: where the local provider writes plaintext to
 * `$DSH_HOME/.credentials.yaml`, this provider stores each value as a
 * Keychain generic-password item and keeps nothing on disk at all.
 *
 * Layering mirrors credentials-local exactly:
 *
 * ```text
 * inherited process environment      (read-only, wins)
 * > macOS Keychain                    (provider-managed, writable)
 * > <invocation cwd>/.env            (read-only fallback)
 * > $DSH_HOME/.env                   (read-only fallback)
 * ```
 *
 * One-time migration: on activation, entries still sitting in the legacy
 * plaintext `.credentials.yaml` are moved into the Keychain and the legacy
 * file is removed, so an existing installation never keeps plaintext behind.
 *
 * Failure semantics follow credentials-local and the desktop safe-storage
 * provider: resolution is per call (no caching), an empty stored value is
 * absent, a read-only environment layer shadows writes (set/unset reject),
 * and a Keychain failure fails loud rather than masquerading as "no
 * credentials stored". When the Keychain is unavailable (non-macOS, or the
 * `security` tool missing) the provider degrades: environment layers still
 * resolve, writes are rejected, and migration is skipped (the legacy file
 * stays untouched rather than being destroyed without a Keychain copy).
 * @module dsh-local-credentials-keychain
 */

import { execFile } from 'node:child_process'
import { existsSync, readFileSync, unlinkSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { CredentialProvider, credentialRef } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { CREDENTIALS_FILENAME, parseCredentialsDocument } from '@deepseek-ai/dsh-credentials-local'

const execFileAsync = promisify(execFile)

/** macOS Keychain CLI; paths are stable across supported macOS releases. */
const SECURITY = '/usr/bin/security'

/** `security find-generic-password` exit code when the item does not exist. */
const NOT_FOUND = 44

/** Default Keychain service name under which all credential items live. */
const DEFAULT_SERVICE = 'DeepSeek Harness Local'

/**
 * Keychain access wrapper around the `security` CLI. Every call is a fresh
 * subprocess: Keychain writes are not atomic anyway, and per-call resolution
 * is the seam's contract (a changed credential reaches the next operation).
 */
export class KeychainClient {
  constructor(service) {
    this.service = service
  }

  /** The Keychain backend is available on this platform. */
  available() {
    return process.platform === 'darwin' && existsSync(SECURITY)
  }

  /** Read one item's password; `undefined` when the item is absent. */
  async get(account) {
    try {
      const { stdout } = await execFileAsync(
        SECURITY, ['find-generic-password', '-s', this.service, '-a', account, '-w'],
        { timeout: 5000 },
      )
      return stdout
    } catch (error) {
      if (error?.code === NOT_FOUND) return undefined
      throw new Error(`credentials-keychain: lookup failed for "${account}": ${error?.message ?? error}`)
    }
  }

  /** Create or update (`-U`) one item. */
  async set(account, value) {
    try {
      await execFileAsync(
        SECURITY, ['add-generic-password', '-U', '-s', this.service, '-a', account, '-w', value],
        { timeout: 5000 },
      )
    } catch (error) {
      throw new Error(`credentials-keychain: store failed for "${account}": ${error?.message ?? error}`)
    }
  }

  /** Remove one item; removing an absent item is a no-op. */
  async delete(account) {
    try {
      await execFileAsync(
        SECURITY, ['delete-generic-password', '-s', this.service, '-a', account],
        { timeout: 5000 },
      )
    } catch (error) {
      if (error?.code !== NOT_FOUND) {
        throw new Error(`credentials-keychain: delete failed for "${account}": ${error?.message ?? error}`)
      }
    }
  }
}

/**
 * Keychain credentials provider: `$DSH_HOME/.credentials.yaml` is replaced
 * by per-value Keychain items; the on-disk document disappears entirely.
 */
export class KeychainCredentialProvider extends CredentialProvider {
  static Config = z.object({
    dshHome: z.string(),
    service: z.string().default(DEFAULT_SERVICE),
  })

  constructor(ctx, config) {
    super(ctx)
    // Programmatic construction may bypass Schemastery normalization; resolve
    // the same defaults in one explicit step either way.
    this.service = config.service ?? DEFAULT_SERVICE
    this.keychain = new KeychainClient(this.service)
    this.legacyFilename = resolve(join(resolveDshHome(config.dshHome), CREDENTIALS_FILENAME))
    this.closed = false
  }

  /** The Keychain backend, or `undefined` when unavailable on this platform. */
  encryption() {
    return this.keychain.available() ? this.keychain : undefined
  }

  /** The inherited-environment value for a reference, or `undefined` when empty or unset. */
  inherited(ref) {
    const entry = launchEnvironmentOf(this.ctx).getFrom(ref, ['process'])
    return entry !== undefined && entry.value.length > 0 ? entry.value : undefined
  }

  /**
   * The `.env` fallback for a reference — below the Keychain, never above
   * it. The invoking project ranks over the user's home file, matching the
   * environment layering: the more specific location wins.
   */
  dotenvFallback(ref) {
    const entry = launchEnvironmentOf(this.ctx).getFrom(ref, ['project-env', 'user-env'])
    return entry !== undefined && entry.value.length > 0 ? entry : undefined
  }

  async * [Service.init]() {
    yield () => {
      this.closed = true
    }
    this.migrateLegacyPlaintext()
  }

  /**
   * One-time plaintext-to-Keychain migration: legacy `.credentials.yaml`
   * entries are stored into the Keychain, then the plaintext file is removed.
   * Skipped (with a warning, legacy file untouched) when the Keychain is
   * unavailable — destroying the only copy without a Keychain counterpart
   * would lose the user's credentials. An invalid legacy document fails the
   * activation loud, exactly like credentials-local's boot read.
   */
  migrateLegacyPlaintext() {
    if (!existsSync(this.legacyFilename)) return
    if (this.encryption() === undefined) {
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
      if (this.keychain.get(ref) !== undefined) continue
      this.keychain.set(ref, value)
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
    // Per-call lookup: resolution is re-read on every operation, never
    // cached, so a changed credential reaches the next operation.
    const stored = this.keychain.available() ? await this.keychain.get(ref) : undefined
    if (stored !== undefined && stored.length > 0) return Promise.resolve({ value: stored, source: 'keychain' })
    const fallback = this.dotenvFallback(ref)
    if (fallback !== undefined) return Promise.resolve({ value: fallback.value, source: fallback.source })
    return Promise.resolve(undefined)
  }

  async describe(ref) {
    // Only the inherited environment is unwritable: it is the one layer this
    // process cannot edit. The Keychain is writable only while available.
    const writable = this.encryption() !== undefined
    if (this.inherited(ref) !== undefined) {
      return Promise.resolve({ configured: true, source: 'env', writable: false })
    }
    if (this.keychain.available() && (await this.keychain.get(ref)) !== undefined) {
      return Promise.resolve({ configured: true, source: 'keychain', writable })
    }
    const fallback = this.dotenvFallback(ref)
    if (fallback !== undefined) return Promise.resolve({ configured: true, source: fallback.source, writable: true })
    return Promise.resolve({ configured: false, writable })
  }

  async set(ref, value) {
    if (value.length === 0) {
      throw new Error(`credentials-keychain: an empty value cannot be stored for "${ref}"; use unset`)
    }
    if (this.closed) throw new Error(`credentials-keychain is disposed: cannot set "${ref}"`)
    this.assertUnshadowed(ref, 'set')
    if (this.encryption() === undefined) {
      throw new Error('credentials-keychain: Keychain unavailable; refusing to store a plaintext secret')
    }
    await this.keychain.set(ref, value)
    // After the commit: a broken observer must never make the durable write
    // look failed (an INVARIANT failure still rethrows).
    this.notifyUpdated(ref)
  }

  async unset(ref) {
    if (this.closed) throw new Error(`credentials-keychain is disposed: cannot unset "${ref}"`)
    this.assertUnshadowed(ref, 'unset')
    if (this.keychain.available() && (await this.keychain.get(ref)) !== undefined) {
      await this.keychain.delete(ref)
      this.notifyUpdated(ref)
    }
  }

  /**
   * Reject a write the inherited environment would shadow into apparent
   * no-effect — same seam rule as credentials-local.
   */
  assertUnshadowed(ref, verb) {
    if (this.inherited(ref) !== undefined) {
      throw new Error(
        `credentials-keychain: "${ref}" is supplied read-only by the launching environment, so ${verb} would be`
        + ' shadowed; unset it in the shell you start the app from instead',
      )
    }
  }
}

/**
 * Parse the legacy plaintext credentials document. Reuses the upstream parser
 * so the legacy format is interpreted byte-for-byte as credentials-local
 * wrote it (strict ref-to-string mapping; invalid documents throw with the
 * same diagnostics, never quoting values).
 * @param {string} legacyFile - absolute path of the legacy document.
 * @returns {Map<string, string>} parsed entries.
 */
export function readLegacyPlaintextDocument(legacyFile) {
  return parseCredentialsDocument(readFileSync(legacyFile, 'utf8'), legacyFile)
}

export default KeychainCredentialProvider
