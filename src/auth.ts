import { readFile, rm, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { parseTraeCliToken, parseTraeStorageDocument } from './decrypt.ts'
import { traeStorageCandidates, type TraeCredentialSource, type TraeEdition, type TraeStorageCandidate } from './paths.ts'
import { regionOfCredential, regionOfEdition, type TraeRegion } from './region.ts'

export interface TraeCredential {
  accessToken: string
  refreshToken?: string
  userId: string
  accountName?: string
  /**
   * Trae tenant this account belongs to (`account.tenant_id`, e.g. `272193024`
   * for a `tob_online` enterprise), absent for a personal account.
   *
   * This is what decides whether the ENTERPRISE pool can serve the account at
   * all. The tenant gateway accepts any CN token for its DIRECTORY read — a
   * personal account gets the full 49-model roster back — so "the roster
   * loaded" proves nothing about billing rights. Its chat endpoint is what
   * refuses: a personal account answers `4019` (risk control), a tenant account
   * streams normally. Because the two are indistinguishable from the roster,
   * the account list itself has to carry the flag.
   */
  tenantId?: string
  host: string
  /**
   * Region claim from the decrypted storage document (`userRegion.region`,
   * 'CN' | 'SG', possibly lowercase). Drives the routing bucket together with
   * `host`; see `regionOfCredential`.
   */
  userRegion?: string
  expiresAtMs: number
  refreshExpiresAtMs?: number
  edition: TraeEdition
  source: 'desktop' | 'dsh' | 'cli'
}

export interface TraeRefreshOutcome {
  accessToken: string
  refreshToken?: string
  expiresAtMs: number
  refreshExpiresAtMs?: number
  host?: string
}

export interface TraeCredentialStoreOptions {
  storagePath?: string
  edition?: TraeEdition | 'auto'
  accountId?: string
  ownPath?: string
  /**
   * Region this store serves. When set, only credentials whose own claim maps
   * to this region are discovered, selected, or refreshed — the two regions'
   * stores run side by side without seeing each other's accounts.
   */
  region?: TraeRegion
  /**
   * Only consider credentials that belong to a Trae tenant.
   *
   * The enterprise panel's store runs with this on: a personal account cannot
   * bill that pool, and because the tenant gateway still serves it a directory,
   * binding it here would fail only at the first chat (`4019`). With the flag
   * set, an explicit binding to a personal account falls through to the preferred
   * TENANT account instead of being silently honoured.
   */
  requireTenant?: boolean
  /**
   * Withhold TENANT (enterprise) accounts from this store's account list.
   *
   * Set on the consumer panels: an enterprise login belongs to the enterprise
   * panel, and offering it here would let a tenant account be bound to the
   * personal pool without the user ever seeing which pool they picked. A
   * machine that has ONLY a tenant login still resolves it — an empty list must
   * not turn a working install into "signed out" — so the filter is applied to
   * the OFFERED list, never to the resolved credential.
   */
  hideTenantAccounts?: boolean
  /** Legacy single-copy path read as a migration source; injectable for tests. */
  legacyOwnPath?: string
  refresh: (credential: TraeCredential) => Promise<TraeRefreshOutcome>
  refreshMarginMs?: number
}

export interface TraeAccountChoice {
  id: string
  accountName: string
  edition: TraeEdition
  /**
   * Whether this account may bill the CN ENTERPRISE pool.
   *
   * Derived from the credential's own tenant claim, because nothing else can
   * tell: the tenant gateway answers a directory read for ANY CN token, so a
   * personal account looks perfectly serviceable right up to its first chat,
   * which it answers with `4019`. The enterprise panel filters its account list
   * and its default binding on this flag.
   */
  enterprise: boolean
  /** Routing bucket of this account (`cn` | `ai`), derived from its credential. */
  region: TraeRegion
  source: 'desktop' | 'dsh' | 'cli'
  tokenExpiresAtMs: number
  /**
   * When this account's refresh token lapses, when the credential carries one.
   * The access token above renews itself automatically until this expires; see
   * the mirror field on `TraeWebAccount` in status-paths.ts for why the card
   * needs it.
   */
  refreshExpiresAtMs?: number
  selected: boolean
}

/**
 * Why one candidate path did not yield an account. These are safe to surface:
 * they carry paths and error text, never token material.
 */
export interface TraeCandidateFailure {
  path: string
  edition: TraeEdition
  source: TraeCredentialSource
  reason: 'missing' | 'unreadable' | 'invalid'
  message?: string
}

/** Host used for CLI tokens, which carry no host claim of their own. */
const CLI_DEFAULT_HOST = 'https://api.trae.cn'

/**
 * On-disk format of the plugin-owned per-region file.
 *
 * Version 1 held exactly ONE credential (`{ version, credential }`), which was
 * enough while every account came from a Trae install the plugin can discover
 * itself. Import (issue #37) breaks that assumption: a user can hold several
 * accounts as transferable files, and they have to live somewhere. Version 2
 * keeps the same per-region file but stores `{ version, credentials: [...] }`
 * instead, so the file stays the unit of region isolation (see
 * {@link traeOwnAuthPath}) while holding as many accounts as were imported.
 *
 * Version 1 remains READ (see {@link parseOwn}), so an existing install keeps
 * working and upgrades itself the next time a credential is written; it is
 * never written again.
 */
const OWN_VERSION = 2
/** The superseded single-credential layout, still read for migration. */
const OWN_VERSION_SINGLE = 1
export const TRAE_AUTH_FILENAME = '.trae-auth.json'

/** Prefix of the plugin-owned per-region credential copies. */
const TRAE_OWN_PREFIX = '.trae-auth'

/**
 * Plugin-owned copy path for one region. Each region's store refreshes into
 * its own file so two simultaneously signed-in regions never overwrite each
 * other's refreshed token.
 */
export function traeOwnAuthPath(region: TraeRegion): string {
  return join(resolveDshHome(), `${TRAE_OWN_PREFIX}.${region}.json`)
}

/**
 * Pre-dual-provider single-copy path. Still read as a migration source (a
 * legacy credential serves the region it belongs to until that region's own
 * first refresh writes the per-region file), and removed by `logout`.
 */
export function legacyTraeOwnAuthPath(): string {
  return join(resolveDshHome(), TRAE_AUTH_FILENAME)
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

function timeToMs(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value > 1e12 ? value : value * 1000
  if (typeof value !== 'string' || value.trim() === '') return undefined
  const numeric = Number(value)
  if (Number.isFinite(numeric) && numeric > 0) return numeric > 1e12 ? numeric : numeric * 1000
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

/** Extract the `userRegion.region` string from either on-disk shape. */
function userRegionOf(value: unknown): string | undefined {
  const raw = typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)['region']
    : value
  return typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : undefined
}

export function normalizeTraeCredential(raw: unknown, edition: TraeEdition, source: TraeCredential['source']): TraeCredential | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const value = raw as Record<string, unknown>
  const accessToken = optionalString(value['token']) ?? optionalString(value['accessToken'])
  if (accessToken === undefined) return undefined
  const expiresAtMs = timeToMs(value['expiredAt'] ?? value['expiresAt']) ?? 0
  const refreshExpiresAtMs = timeToMs(value['refreshExpiredAt'] ?? value['refreshExpiresAt'])
  const refreshToken = optionalString(value['refreshToken'])
  const userRegion = userRegionOf(value['userRegion'])
  const account = typeof value['account'] === 'object' && value['account'] !== null && !Array.isArray(value['account'])
    ? value['account'] as Record<string, unknown>
    : undefined
  const accountName = optionalString(account?.['username'])
  // `tenant_id` is a number or a string depending on the client that wrote it.
  const tenantId = optionalString(account?.['tenant_id']) ?? (typeof account?.['tenant_id'] === 'number' ? String(account['tenant_id']) : undefined)
  return {
    accessToken,
    ...refreshToken === undefined ? {} : { refreshToken },
    userId: optionalString(value['userId']) ?? '',
    ...accountName === undefined ? {} : { accountName },
    ...tenantId === undefined ? {} : { tenantId },
    host: optionalString(value['host']) ?? '',
    ...userRegion === undefined ? {} : { userRegion },
    expiresAtMs,
    ...refreshExpiresAtMs === undefined ? {} : { refreshExpiresAtMs },
    edition,
    source,
  }
}

/**
 * Whether this account belongs to a Trae tenant, i.e. may bill the enterprise
 * pool.
 *
 * Evidence (2026-10-17, live): the tenant's own account carries
 * `account.tenant_id` / `tenant_name` and `scope: 'saas'`; the personal SOLO
 * account carries neither and reports `scope: 'marscode'`. Only the tenant one
 * streams on the enterprise gateway — the other answers `4019` risk control.
 */
export function isEnterpriseAccount(credential: Pick<TraeCredential, 'tenantId'> | undefined): boolean {
  return credential?.tenantId !== undefined && credential.tenantId.trim() !== ''
}

export function traeAccountId(credential: Pick<TraeCredential, 'edition' | 'userId' | 'accountName'>): string {
  const stable = `${credential.edition}\0${credential.userId || credential.accountName || 'unknown'}`
  return createHash('sha256').update(stable).digest('hex').slice(0, 24)
}

/**
 * The exact shape of an account id — sha256 hex sliced to 24 characters, which is
 * what {@link traeAccountId} emits and therefore the only string a request may
 * legitimately name.
 *
 * This regex is a traversal guard as much as a validator: an id becomes part of a
 * path (`$DSH_HOME/.trae-pool.<panel>.json` uses it as a key, and a credential
 * lookup receives it), so `../../etc/passwd` has to fail here rather than fail
 * somewhere closer to the filesystem. Exported so an HTTP route can answer a bad
 * id with 400 instead of letting an exception surface as a 500.
 */
export const TRAE_ACCOUNT_ID_RE = /^[0-9a-f]{24}$/

/** Whether a request-supplied value is a well-formed Trae account id. */
export function isTraeAccountId(value: unknown): value is string {
  return typeof value === 'string' && TRAE_ACCOUNT_ID_RE.test(value)
}

/** One stored credential, validated. Returns undefined for a malformed row. */
function credentialOfStored(stored: unknown): TraeCredential | undefined {
  if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) return undefined
  const record = stored as Record<string, unknown>
  const edition = record['edition']
  if (edition !== 'cn' && edition !== 'sg' && edition !== 'solo' && edition !== 'solo-sg') return undefined
  return normalizeTraeCredential({
    token: record['accessToken'], refreshToken: record['refreshToken'], userId: record['userId'], host: record['host'],
    userRegion: record['userRegion'],
    account: record['accountName'] === undefined && record['tenantId'] === undefined
      ? undefined
      : { ...record['accountName'] === undefined ? {} : { username: record['accountName'] }, ...record['tenantId'] === undefined ? {} : { tenant_id: record['tenantId'] } },
    expiredAt: record['expiresAtMs'], refreshExpiredAt: record['refreshExpiredAtMs'],
  }, edition, 'dsh')
}

/**
 * Read the plugin-owned file into its stored credentials.
 *
 * Accepts BOTH layouts: version 2 (`credentials: [...]`, the import-capable
 * shape) and the superseded version 1 (`credential: {...}`). A version-1 file
 * keeps working until the next write upgrades it, so no migration step is
 * needed and an older install's file is never rejected. A malformed row is
 * dropped rather than failing the whole file — one bad imported account must
 * not hide the rest.
 */
function parseOwn(text: string): TraeCredential[] {
  try {
    const document = JSON.parse(text) as { version?: unknown; credential?: unknown, credentials?: unknown }
    if (document.version === OWN_VERSION) {
      if (!Array.isArray(document.credentials)) return []
      return document.credentials.map(credentialOfStored).filter((value): value is TraeCredential => value !== undefined)
    }
    if (document.version === OWN_VERSION_SINGLE) {
      const single = credentialOfStored(document.credential)
      return single === undefined ? [] : [single]
    }
    return []
  } catch { return [] }
}

/**
 * Write the plugin-owned file: every credential of the region, in the version-2
 * array layout.
 *
 * One writer for both paths that persist to this file (a refresh, and an
 * import) so the read-modify-write in `refreshNow` and the additive write in
 * {@link TraeCredentialStore.importAccounts} cannot drift apart. Always writes
 * `OWN_VERSION`, which is what upgrades a version-1 file on its first write.
 */
async function writeOwn(path: string, credentials: readonly TraeCredential[]): Promise<void> {
  const document = { version: OWN_VERSION, credentials: credentials.map(credential => ({ ...credential })) }
  await writeFileAtomic(path, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600, dirMode: 0o700 })
}

export class TraeCredentialStore {
  private storagePathOverride: string | undefined
  private edition: TraeEdition | 'auto'
  private accountId: string | undefined
  private readonly region: TraeRegion | undefined
  private readonly requireTenant: boolean
  private readonly hideTenantAccounts: boolean
  private readonly ownPathExplicit: string | undefined
  private readonly legacyOwnPath: string
  private readonly legacyOwnPathExplicit: string | undefined
  private readonly refresh: TraeCredentialStoreOptions['refresh']
  private readonly refreshMarginMs: number
  private inflight: Promise<TraeCredential> | undefined
  /**
   * The account the NEXT request should bill, when a pool — not the user's
   * binding — is choosing (issue #44).
   *
   * Runtime only, never persisted: the binding in settings is what a save
   * writes and what the card's account table reports as selected, while this is
   * "who serves right now". Keeping them apart is what lets the pool rotate
   * without silently rewriting the user's choice, and what makes turning the
   * pool off restore the bound account with no rebind at all.
   */
  private rotatedAccountId: string | undefined

  constructor(options: TraeCredentialStoreOptions) {
    this.storagePathOverride = options.storagePath
    this.edition = options.edition ?? 'auto'
    this.accountId = options.accountId
    this.region = options.region
    this.requireTenant = options.requireTenant === true
    this.hideTenantAccounts = options.hideTenantAccounts === true
    this.ownPathExplicit = options.ownPath
    this.legacyOwnPath = options.legacyOwnPath ?? legacyTraeOwnAuthPath()
    this.legacyOwnPathExplicit = options.legacyOwnPath
    this.refresh = options.refresh
    this.refreshMarginMs = options.refreshMarginMs ?? 5 * 60_000
  }

  /** Whether a credential's own claim belongs to this store's region. */
  private matchesRegion(credential: TraeCredential): boolean {
    return this.region === undefined || regionOfCredential(credential) === this.region
  }

  /**
   * The path this store refreshes into: the per-region file for a
   * region-scoped store, the legacy single file otherwise, or an explicitly
   * injected path in tests.
   */
  ownAuthPath(): string {
    if (this.ownPathExplicit !== undefined) return this.ownPathExplicit
    return this.region !== undefined ? traeOwnAuthPath(this.region) : this.legacyOwnPath
  }

  /**
   * Every plugin-owned copy to read, most preferred first. A region-scoped
   * store reads the legacy single copy as its migration source (readAll's
   * region filter drops it when it carries the other region's credential); an
   * unscoped store reads everything so diagnostics see both regions.
   *
   * With an explicitly injected own path the legacy source is read ONLY when
   * it was injected too — a test that pins one file must not accidentally see
   * the real machine's legacy copy.
   */
  private ownCandidates(): string[] {
    if (this.ownPathExplicit !== undefined) {
      return this.legacyOwnPathExplicit !== undefined
        ? [this.ownPathExplicit, this.legacyOwnPathExplicit]
        : [this.ownPathExplicit]
    }
    if (this.region !== undefined) {
      return [traeOwnAuthPath(this.region), this.legacyOwnPath]
    }
    return [this.legacyOwnPath, traeOwnAuthPath('cn'), traeOwnAuthPath('ai')]
  }

  setSource(storagePath: string | undefined, edition: TraeEdition | 'auto' = 'auto', accountId?: string): void {
    this.storagePathOverride = storagePath
    this.edition = edition
    this.accountId = accountId
    this.inflight = undefined
  }

  selectAccount(accountId: string | undefined): void {
    this.accountId = accountId
    this.inflight = undefined
  }

  candidates(): TraeStorageCandidate[] {
    if (this.storagePathOverride !== undefined) {
      const edition = this.edition === 'auto' ? 'cn' : this.edition
      // An explicit override points at a user-supplied file whose shape is not
      // known ahead of time, so it is probed as both a desktop storage document
      // and a CLI token file.
      return [
        { edition, path: this.storagePathOverride, source: 'desktop' },
        { edition, path: this.storagePathOverride, source: 'cli' },
      ]
    }
    const all = traeStorageCandidates()
    // Every desktop edition is discovered (the plugin routes by the
    // credential's own region, see region.ts); an explicit `edition` config
    // narrows the scan. The international CLI home (`~/.trae`) stays excluded:
    // its bare JWT carries no host claim and the SG default host has not been
    // verified (docs/INTL_SG_EVIDENCE.md §5), so only the CN CLI home
    // (`.trae-cn`) is probed.
    const cliEdition: TraeEdition = 'cn'
    return this.edition === 'auto'
      ? all.filter(candidate => candidate.source === 'desktop' || candidate.edition === cliEdition)
      : all.filter(candidate => candidate.edition === this.edition && (candidate.source === 'desktop' || candidate.edition === cliEdition))
  }

  /**
   * Deterministic default when no account is explicitly selected: the account
   * the Trae desktop app is signed in to RIGHT NOW, else the first discovered
   * one. This is NOT credit-seeking — it never reorders accounts to find one
   * with general credits. The plugin bills exactly the account the user
   * selected, the app's current sign-in when nothing has been selected, and
   * only then the first account.
   *
   * The app's live sign-in outranks the plugin's own refreshed copies (issue
   * #29): after the user switches accounts in Trae, the desktop storage file
   * holds the NEW login while the plugin's copy of the old one still resolves,
   * so a bare `credentials[0]` kept defaulting to a sign-in the app has
   * abandoned — and `dsh-connect-workbuddy`, whose `preferred()` ranks the live
   * file first, followed the app instead. Ordering only: the VALUE behind an
   * account id is still whichever copy expires later (`readAll`), so a refresh
   * the plugin performed is never discarded by this preference.
   */
  private preferred(credentials: TraeCredential[]): TraeCredential | undefined {
    const eligible = this.requireTenant
      ? credentials.filter(credential => isEnterpriseAccount(credential))
      : credentials
    if (eligible.length === 0) return undefined
    return eligible.find(credential => credential.source === 'desktop') ?? eligible[0]
  }

  /**
   * The account the Trae app is signed in to right now, when that differs from
   * the account this store is bound to (issue #29).
   *
   * This is a READ, not a rebind: `current()` keeps resolving the bound
   * account verbatim so billing never moves without a decision — the store
   * only reports the mismatch, and the card (hint row) or the host (follow
   * switch) turns it into a settings write the user can see and undo. Absent
   * when nothing is live, when the live account IS the bound one, or when the
   * binding itself already fell through to the live account.
   */
  async liveLogin(): Promise<TraeAccountChoice | undefined> {
    // No explicit bind: the default (`preferred`) already IS the live login,
    // so `current()` resolves it — there is no mismatch to report.
    if (this.accountId === undefined || this.accountId === '') return undefined
    const credentials = await this.readAll()
    const live = this.preferred(credentials)
    if (live === undefined) return undefined
    const liveId = traeAccountId(live)
    if (liveId === this.accountId) return undefined
    return {
      id: liveId,
      accountName: live.accountName ?? (live.userId || `${live.edition} account`),
      edition: live.edition,
      enterprise: isEnterpriseAccount(live),
      region: regionOfCredential(live),
      source: live.source,
      tokenExpiresAtMs: live.expiresAtMs,
      ...live.refreshExpiresAtMs === undefined ? {} : { refreshExpiresAtMs: live.refreshExpiresAtMs },
      selected: false,
    }
  }

  /**
   * The accounts this store is willing to OFFER.
   *
   * Scoped to who this store may bill:
   *   - a consumer store withholds tenant accounts (the enterprise pool is a
   *     separate tab and a separate billing decision), and
   *   - a tenant store withholds personal accounts (they cannot bill that
   *     pool; the tenant gateway answers their chat with 4019).
   *
   * Either filter backs off when it would hide EVERYTHING, so a machine whose
   * only login is on the other side keeps working instead of reading as
   * "signed out".
   */
  private offered(discovered: TraeCredential[]): TraeCredential[] {
    const eligible = this.requireTenant
      ? discovered.filter(credential => isEnterpriseAccount(credential))
      : this.hideTenantAccounts
        ? discovered.filter(credential => !isEnterpriseAccount(credential))
        : discovered
    return eligible.length > 0 ? eligible : discovered
  }

  async accounts(): Promise<TraeAccountChoice[]> {
    const discovered = await this.readAll()
    const offered = this.offered(discovered)
    const inUse = this.inUse(discovered, offered)
    /**
     * Never hide the account we are actually billing.
     *
     * An explicit binding outranks the display filter (`inUse` honours it even
     * when the offered list withholds it), and a list whose active row is
     * invisible is worse than no list: the card's "save the selected account"
     * press reads `selected`, so a hidden binding would be rewritten to whichever
     * account merely happened to be DISPLAYED — silently moving the user's
     * billing to an account they never chose. Re-appending it costs one extra
     * row and makes the card tell the truth.
     */
    const credentials = inUse !== undefined && !offered.includes(inUse) ? [...offered, inUse] : offered
    const inUseId = inUse === undefined ? undefined : traeAccountId(inUse)
    return credentials.map(credential => ({
      id: traeAccountId(credential),
      accountName: credential.accountName ?? (credential.userId || `${credential.edition} account`),
      edition: credential.edition,
      enterprise: isEnterpriseAccount(credential),
      region: regionOfCredential(credential),
      source: credential.source,
      tokenExpiresAtMs: credential.expiresAtMs,
      ...credential.refreshExpiresAtMs === undefined ? {} : { refreshExpiresAtMs: credential.refreshExpiresAtMs },
      // Exactly one row reads as `selected`, and it is the SAME account
      // `current()` bills. Deriving this flag any other way is how the card and
      // the chat came to disagree.
      selected: inUseId !== undefined && traeAccountId(credential) === inUseId,
    }))
  }

  /**
   * The credential this store bills, given every credential it can see.
   *
   * This is the ONE resolution rule, and it exists so that `current()` and
   * `accounts()` cannot disagree: `current()` applies it to `readAll()`, and
   * `accounts()` applies the SAME verdict to decide which row reads as
   * `selected`. Deriving that flag independently is exactly how the two drifted
   * apart — and a card that marks a different account than the one the chat
   * bills is worse than no card at all, because a press that "saves the
   * selected account" then rewrites the binding to the account that was only
   * ever DISPLAYED.
   *
   * Order of business:
   *   1. No binding — the detected default (`preferred`) is in use, chosen from
   *      the OFFERED list rather than from every login on the machine. A
   *      consumer store that withholds tenant accounts must not default its
   *      billing to the tenant pool merely because that login sorts first;
   *      withholding is a billing decision, not a display detail.
   *   2. A binding — honour it verbatim, even when the OFFERED list hides that
   *      account. Resolution is never scoped by `hideTenantAccounts`: the user's
   *      explicit choice outranks a display filter.
   *   3. A tenant-scoped store cannot bill through a personal account, and the
   *      tenant gateway only reveals that at the first chat (`4019`). Honour the
   *      binding when it is eligible; otherwise fall back to the preferred
   *      tenant account, which is the one the user's enterprise tab is meant to
   *      use.
   *   4. A saved account can disappear when Trae replaces its local login. Do
   *      NOT silently fall back to a different account: that would bill a
   *      different account than the one the user explicitly selected. Return
   *      undefined so the caller surfaces "no signed-in account" and the user
   *      can re-select, instead of the plugin quietly switching accounts behind
   *      their back.
   */
  private inUse(discovered: TraeCredential[], offered: TraeCredential[]): TraeCredential | undefined {
    if (this.accountId === undefined) return this.preferred(offered)
    const selected = discovered.find(credential => traeAccountId(credential) === this.accountId)
    if (this.requireTenant && !isEnterpriseAccount(selected)) return this.preferred(offered)
    return selected
  }

  /**
   * Point this store at one specific account for the NEXT request, without
   * touching the user's saved binding (issue #44).
   *
   * Called by the account pool before each chat request. `undefined` clears the
   * override, which is how switching the pool off immediately restores the
   * binding — no rebind, no settings write, nothing to undo.
   *
   * A rotation is a REQUEST, not an assertion: `current()` honours it only when
   * the account still exists locally and this store's own eligibility rules
   * allow it, and otherwise falls back to the binding. So a rotation can never
   * invent a credential that {@link current} would refuse.
   */
  setRotatedAccount(accountId: string | undefined): void {
    if (this.rotatedAccountId === accountId) return
    this.rotatedAccountId = accountId
    // A pending refresh belongs to the account that was being resolved when it
    // started. Serving it to a different account would hand out the wrong token,
    // so a rotation starts clean.
    this.inflight = undefined
  }

  /** The rotation currently in effect, for diagnostics and the pool's own card. */
  rotatedAccount(): string | undefined {
    return this.rotatedAccountId
  }

  /**
   * The credential a rotation points at, or `undefined` when it cannot be
   * honoured (the login was removed from this machine, or a tenant-scoped store
   * refuses a personal account).
   *
   * Never substitutes a different account here: the caller then applies the
   * user's binding, which is the honest answer when the pool's choice is gone.
   */
  private rotated(discovered: readonly TraeCredential[], offered: readonly TraeCredential[]): TraeCredential | undefined {
    const id = this.rotatedAccountId
    if (id === undefined) return undefined
    // The OFFERED list first, because that is the roster the pool enumerated; the
    // discovered list still honours an explicit id the display filter hides, the
    // same way a binding does.
    const credential = offered.find(item => traeAccountId(item) === id)
      ?? discovered.find(item => traeAccountId(item) === id)
    if (credential === undefined) return undefined
    if (this.requireTenant && !isEnterpriseAccount(credential)) return undefined
    return credential
  }

  async current(): Promise<TraeCredential | undefined> {
    const discovered = await this.readAll()
    const offered = this.offered(discovered)
    const rotated = this.rotated(discovered, offered)
    if (rotated !== undefined) return rotated
    return this.inUse(discovered, offered)
  }

  /**
   * The stored credential of one specific account, without changing which
   * account this store is bound to (issue #25).
   *
   * The card needs to answer "the account I am bound to has run out of credits
   * — is another account on this machine usable?" and {@link resolve} cannot
   * help: it always returns the BOUND account, and switching the bound account
   * just to read one number would race every in-flight chat request sharing
   * this store, and would persist a selection the user never made.
   *
   * So this is a pure lookup: read-only, no refresh side effects (a stale token
   * is returned as-is and the caller's request then fails honestly), and
   * `accountId` is left untouched. An unknown id yields undefined rather than a
   * fallback, for the same reason {@link current} refuses to fall back.
   */
  async credentialOf(accountId: string): Promise<TraeCredential | undefined> {
    if (accountId === '') return undefined
    const credentials = await this.readAll()
    return credentials.find(credential => traeAccountId(credential) === accountId)
  }

  /**
   * Store imported credentials (issue #37), replacing any entry with the same
   * account id and leaving every other entry alone.
   *
   * Why an additive write rather than the refresh path: an imported credential
   * has NO desktop file behind it, so unlike a refresh result it cannot be
   * rediscovered from the machine. If it were written the way a refresh is —
   * as the whole document — importing account B would delete account A, and a
   * later refresh would delete both. `readAll`'s desktop-first preference is
   * therefore also not enough on its own: these entries survive only because
   * `readOwns` reads them back and the dedupe keeps the longest-lived copy.
   *
   * Returns the account ids actually written, so the caller can report how many
   * landed without re-reading the store.
   */
  async importAccounts(credentials: readonly Omit<TraeCredential, 'source'>[]): Promise<string[]> {
    if (credentials.length === 0) return []
    const ownPath = this.ownAuthPath()
    const written: string[] = []
    await withFileLock(ownPath, async () => {
      // Merge onto what is already stored, so this never drops an account the
      // user did not touch — including a refreshed copy this store wrote.
      const existing = await readFile(ownPath, 'utf8').then(parseOwn, () => [])
      const byId = new Map<string, TraeCredential>()
      for (const item of existing) byId.set(traeAccountId(item), item)
      for (const credential of credentials) {
        const stored: TraeCredential = { ...credential, source: 'dsh' }
        const id = traeAccountId(stored)
        byId.set(id, stored)
        written.push(id)
      }
      await writeOwn(ownPath, [...byId.values()])
    })
    // A newly imported account is now the one the user wants to use; bind it so
    // the next request does not silently keep billing the previous account.
    if (written.length > 0) {
      this.accountId = written[written.length - 1]
      this.inflight = undefined
    }
    return written
  }

  async resolve(): Promise<TraeCredential> {
    const credential = await this.current()
    if (credential === undefined) throw new Error(`trae: no signed-in account found (${this.candidates().map(item => item.path).join(' or ')})`)
    if (credential.expiresAtMs > Date.now() + this.refreshMarginMs) return credential
    this.inflight ??= this.refreshNow(credential).finally(() => { this.inflight = undefined })
    return this.inflight
  }

  async status(): Promise<{ state: 'signed-in' | 'signed-out'; edition?: TraeEdition; expiresAtMs?: number; source?: TraeCredential['source'] }> {
    try {
      const value = await this.current()
      return value === undefined ? { state: 'signed-out' } : { state: 'signed-in', edition: value.edition, expiresAtMs: value.expiresAtMs, source: value.source }
    } catch { return { state: 'signed-out' } }
  }

  async desktopFilePresent(): Promise<boolean> {
    for (const candidate of this.candidates()) {
      try { if ((await stat(candidate.path)).isFile()) return true } catch {}
    }
    return false
  }

  /**
   * Remove every plugin-owned copy this store could read (per-region file,
   * legacy single file, and their lock siblings); the desktop storage files
   * are untouched. A region store's logout therefore also clears the legacy
   * migration source — deliberate: `logout` is the user's "forget what the
   * plugin stored" action, not a per-account toggle.
   */
  async logout(): Promise<void> {
    for (const path of this.ownCandidates()) {
      await rm(path, { force: true })
      await rm(`${path}.lock`, { force: true })
    }
  }

  /**
   * Every local credential of this store's region, deduplicated by account id.
   * A region-scoped store sees only its own region's credentials: the other
   * region's accounts are invisible to selection, refresh, and status alike,
   * which is what keeps the two regions' providers from cross-billing.
   */
  private async readAll(): Promise<TraeCredential[]> {
    const { credentials: desktop } = await this.readDesktopAll()
    // One entry per ACCOUNT, holding the FRESHEST copy of it.
    //
    // Keeping the desktop copy whenever both exist looks harmless — the desktop
    // file is the Trae app's own login — but it silently discards every refresh
    // this plugin performs, because a refreshed credential is written to the
    // plugin's own file, not to the app's. The account then reads as "token
    // expired" forever while a valid token sits on disk one file over: the
    // composer table showed a dash for an account whose own copy was refreshed
    // minutes earlier (`.trae-auth.cn.json` valid to 10-14, desktop copy from
    // 09-27 winning the dedupe).
    //
    // Insertion order still follows the desktop list, so `preferred()` and the
    // default selection are unchanged; only the VALUE behind a duplicate id can
    // be replaced, and only by a copy that lives longer.
    const byAccount = new Map<string, TraeCredential>()
    const consider = (credential: TraeCredential): void => {
      if (!this.matchesRegion(credential)) return
      const id = traeAccountId(credential)
      const incumbent = byAccount.get(id)
      if (incumbent === undefined || credential.expiresAtMs > incumbent.expiresAtMs) byAccount.set(id, credential)
    }
    for (const credential of desktop) consider(credential)
    // The own copies are accepted for every edition: they are refresh results
    // the plugin itself wrote, so an international account's refreshed
    // credential must not be dropped just because it is not a CN edition.
    for (const own of await this.readOwns()) consider(own)
    return [...byAccount.values()]
  }

  /**
   * Which paths were tried and why each one failed. Read-only and token-free:
   * it exists so a signed-out card can explain itself instead of showing a bare
   * "not signed in", which is undiagnosable on a machine whose layout differs
   * from the ones the plugin was written against.
   */
  async diagnose(): Promise<{ tried: TraeStorageCandidate[]; failures: TraeCandidateFailure[] }> {
    const tried = this.candidates()
    const failures: TraeCandidateFailure[] = []
    for (const candidate of tried) {
      const raw = await readFile(candidate.path, 'utf8').then(
        text => ({ text }),
        (error: unknown) => ({ error }),
      )
      if ('error' in raw) {
        const code = typeof raw.error === 'object' && raw.error !== null && 'code' in raw.error
          ? (raw.error as { code?: unknown }).code
          : undefined
        failures.push({
          path: candidate.path,
          edition: candidate.edition,
          source: candidate.source,
          reason: code === 'ENOENT' ? 'missing' : 'unreadable',
          ...code === 'ENOENT' ? {} : { message: String(raw.error) },
        })
        continue
      }
      try {
        this.credentialFrom(candidate, raw.text)
      } catch (error: unknown) {
        failures.push({
          path: candidate.path,
          edition: candidate.edition,
          source: candidate.source,
          reason: 'invalid',
          message: error instanceof Error ? error.message : String(error),
        })
      }
    }
    return { tried, failures }
  }

  /** Parse one candidate file's text into a credential, or throw. */
  private credentialFrom(candidate: TraeStorageCandidate, text: string): TraeCredential {
    let credential: TraeCredential | undefined
    if (candidate.source === 'cli') {
      // The CLI token carries no host claim and no userRegion, so the CN host
      // is used rather than an empty string. Only the CN CLI home
      // (`.trae-cn`) is verified: an international CLI token cannot be routed
      // correctly yet (see docs/INTL_SG_EVIDENCE.md §5) and is rejected with
      // a diagnosable error instead of being silently misrouted to the CN
      // gateway.
      if (regionOfEdition(candidate.edition) !== 'cn') {
        throw new Error(`Trae CLI tokens are only verified for the CN region; ${candidate.edition} CLI homes are not supported yet`)
      }
      const claims = parseTraeCliToken(text)
      credential = normalizeTraeCredential({
        token: claims.accessToken,
        userId: claims.userId,
        host: CLI_DEFAULT_HOST,
        expiredAt: claims.expiresAtMs,
      }, candidate.edition, 'cli')
    } else {
      credential = normalizeTraeCredential(parseTraeStorageDocument(text), candidate.edition, 'desktop')
    }
    if (credential === undefined) throw new Error(`${candidate.source} candidate could not be normalized into a credential`)
    return credential
  }

  private async readDesktopAll(): Promise<{ credentials: TraeCredential[]; failures: TraeCandidateFailure[] }> {
    const credentials: TraeCredential[] = []
    const failures: TraeCandidateFailure[] = []
    for (const candidate of this.candidates()) {
      try {
        const credential = this.credentialFrom(candidate, await readFile(candidate.path, 'utf8'))
        if (!credentials.some(existing => traeAccountId(existing) === traeAccountId(credential))) credentials.push(credential)
      } catch (error: unknown) {
        // One stale, partially written, unsupported, or signed-out Trae
        // installation must not hide valid accounts from the others. The
        // failure is recorded rather than dropped so `diagnose()` can explain
        // an otherwise silent "not signed in".
        const code = typeof error === 'object' && error !== null && 'code' in error
          ? (error as { code?: unknown }).code
          : undefined
        failures.push({
          path: candidate.path,
          edition: candidate.edition,
          source: candidate.source,
          reason: code === 'ENOENT' ? 'missing' : code === undefined ? 'invalid' : 'unreadable',
          ...code === 'ENOENT' || (code === undefined && !(error instanceof Error)) ? {} : { message: error instanceof Error ? error.message : String(error) },
        })
        continue
      }
    }
    return { credentials, failures }
  }

  /**
   * Every readable plugin-owned copy, in candidate order; absent or corrupt
   * files are skipped rather than propagated.
   */
  private async readOwns(): Promise<TraeCredential[]> {
    const copies: TraeCredential[] = []
    for (const path of this.ownCandidates()) {
      try {
        // A v2 file can hold several accounts, so this spreads rather than
        // pushing the single credential a v1 file carried.
        copies.push(...parseOwn(await readFile(path, 'utf8')))
      } catch {
        // absent or unreadable — the next candidate is tried
      }
    }
    return copies
  }

  private async refreshNow(credential: TraeCredential): Promise<TraeCredential> {
    if (credential.refreshToken === undefined || (credential.refreshExpiresAtMs !== undefined && credential.refreshExpiresAtMs <= Date.now())) {
      if (credential.expiresAtMs > Date.now() + 30_000) return credential
      throw new Error('trae: access token expired and no valid refresh token is available; sign in again in Trae')
    }
    try {
      const outcome = await this.refresh(credential)
      const refreshed: TraeCredential = {
        ...credential,
        accessToken: outcome.accessToken,
        ...outcome.refreshToken === undefined ? {} : { refreshToken: outcome.refreshToken },
        expiresAtMs: outcome.expiresAtMs,
        ...outcome.refreshExpiresAtMs === undefined ? {} : { refreshExpiresAtMs: outcome.refreshExpiresAtMs },
        ...outcome.host === undefined ? {} : { host: outcome.host },
        source: 'dsh',
      }
      const ownPath = this.ownAuthPath()
      await withFileLock(ownPath, async () => {
        // Read-modify-write, NOT overwrite. Since version 2 this file holds
        // every account of the region — including imported ones that have no
        // desktop file behind them and could not be re-discovered — so writing
        // a single refreshed credential as the whole document would silently
        // delete the others. The account whose token was just refreshed
        // replaces its own entry; every other entry is carried over verbatim.
        const existing = await readFile(ownPath, 'utf8').then(parseOwn, () => [])
        const refreshedId = traeAccountId(refreshed)
        const entries = existing.filter(item => traeAccountId(item) !== refreshedId)
        entries.push(refreshed)
        await writeOwn(ownPath, entries)
      })
      return refreshed
    } catch (error: unknown) {
      if (credential.expiresAtMs > Date.now() + 30_000) return credential
      throw new Error(`trae: token refresh failed and access token is expired (${String(error)}); sign in again in Trae`)
    }
  }
}
