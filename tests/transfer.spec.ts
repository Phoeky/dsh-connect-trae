import { describe, expect, it } from 'vitest'
import {
  credentialOfTransferRecord,
  knownRegionOfCredential,
  mergeTransferRecords,
  parseTransferFile,
  previewTransferFile,
  traeTransferRecordOf,
  TraeTransferRecord,
} from '../src/transfer.ts'
import { traeAccountId, TraeCredential } from '../src/auth.ts'

/**
 * The transfer module is the INTEROP contract with sibling credential managers
 * (dsh-connect-workbuddy ships the identical file format): a JSON array of
 * snake_case records, account-id-keyed merge, preview without token material.
 *
 * These tests pin the format from BOTH directions — parsing a file a sibling
 * tool writes, and producing a file a sibling tool can read back — and — most
 * importantly — the region gate: trae runs CN and AI as parallel provider
 * stacks that must never cross-bill, and `regionOfCredential()` defaults
 * anything unrecognised to CN. The gate here is a POSITIVE match, so an
 * imported record whose region cannot be positively established is skipped and
 * counted in `skipped`, never admitted into a region's vault by a default.
 */

/** A minimal sibling-format record (as another tool exports it). */
function siblingRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    access_token: 'at-1',
    refresh_token: 'rt-1',
    uid: 'u-1',
    nickname: '小明',
    email: 'a@b.c',
    domain: 'https://api.trae.cn',
    expiresAt: 1893456000000,
    ...overrides,
  }
}

/** A vault-shaped credential for export / round-trip tests. */
function vaultCredential(overrides: Partial<TraeCredential> = {}): TraeCredential {
  return {
    accessToken: 'at-vault',
    refreshToken: 'rt-vault',
    userId: 'u-9',
    accountName: '阿九',
    host: 'https://api.trae.cn',
    expiresAtMs: 1893456000000,
    refreshExpiresAtMs: 1896048000000,
    edition: 'cn',
    source: 'dsh',
    ...overrides,
  }
}

/** The nested {auth, account} block this plugin exports as its auth_raw. */
function nestedRaw(credential: TraeCredential): Record<string, unknown> {
  return {
    auth: {
      token: credential.accessToken,
      refreshToken: credential.refreshToken,
      // All times here are already epoch ms; no sec↔ms conversion in trae.
      expiredAt: credential.expiresAtMs,
      ...credential.userRegion === undefined ? {} : { userRegion: credential.userRegion },
      host: credential.host,
    },
    account: { username: credential.accountName, userId: credential.userId },
  }
}

/** A raw desktop storage document (the pre-normalize shape auth.ts reads). */
function rawDesktopDocument(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    token: 'at-desktop',
    refreshToken: 'rt-desktop',
    userId: 'uid-desktop',
    userRegion: { region: 'CN', _aiRegion: 'CN' },
    account: { username: '桌面账号' },
    host: 'https://api.trae.cn',
    expiredAt: 1893456000000,
    ...overrides,
  }
}

describe('parseTransferFile', () => {
  it('accepts a JSON array of objects and rejects everything else with a positioned error', () => {
    expect(parseTransferFile(JSON.stringify([siblingRecord(), siblingRecord({ uid: 'u-2' })]))).toHaveLength(2)
    expect(() => parseTransferFile('')).toThrow('empty')
    expect(() => parseTransferFile('   \n\t ')).toThrow('empty')
    expect(() => parseTransferFile('not json')).toThrow('JSON')
    expect(() => parseTransferFile('{"a":1}')).toThrow('array')
    // A non-object element must be rejected with the 1-based item position.
    expect(() => parseTransferFile('[{"uid":"u1"},42]')).toThrow('item 2')
    expect(() => parseTransferFile('[null,{}]')).toThrow('item 1')
    expect(() => parseTransferFile('[[],{}]')).toThrow('item 1')
  })
})

describe('previewTransferFile', () => {
  it('exposes only desensitized fields plus hasToken, normalizing dirty display values', () => {
    const dirty = JSON.stringify([
      { uid: { nested: true }, nickname: { zh: '信封昵称' }, email: ['a@b.c'], access_token: 'tok' },
      { uid: 'u-2', nickname: 12345, email: 'x@y.z' },
    ])
    const preview = previewTransferFile(dirty)
    expect(preview.total).toBe(2)
    const [first, second] = preview.accounts
    expect(first?.hasToken).toBe(true)
    // A non-renderable display value must empty out, not leak an object/array.
    expect(first?.uid).toBe('')
    expect(first?.nickname).toBe('')
    expect(second?.hasToken).toBe(false)
    // A numeric nickname is legitimate data: stringified, not dropped.
    expect(second?.nickname).toBe('12345')
  })

  it('never lets token material reach the serialized preview', () => {
    const text = JSON.stringify([
      siblingRecord({ access_token: 'SECRET_TOK_123', refresh_token: 'SECRET_REF_456' }),
    ])
    const preview = previewTransferFile(text)
    const serialized = JSON.stringify(preview)
    expect(serialized).not.toContain('SECRET_TOK_123')
    expect(serialized).not.toContain('SECRET_REF_456')
    expect(serialized).not.toContain('at-1')
    expect(preview.accounts[0]?.hasToken).toBe(true)
  })
})

describe('credentialOfTransferRecord', () => {
  it('maps a record into a credential with the ms expiry passed through verbatim (no rescale)', () => {
    const credential = credentialOfTransferRecord(siblingRecord() as never)
    expect(credential).toBeDefined()
    if (credential === undefined) return
    expect(credential.accessToken).toBe('at-1')
    expect(credential.refreshToken).toBe('rt-1')
    // The transfer contract's expiresAt is epoch MS and trae's runtime field is
    // MS too — this must be carried through unchanged. A rescale bug (e.g. *1000
    // or /1000) here would silently corrupt every imported account's expiry.
    expect(credential.expiresAtMs).toBe(1893456000000)
    expect(credential.refreshExpiresAtMs).toBeUndefined() // this record omits it
    expect(credential.userId).toBe('u-1')
    expect(credential.accountName).toBe('小明')
    expect(credential.host).toBe('https://api.trae.cn')
    // The host is positive so the region-aware edition is restored as cn.
    expect(credential.edition).toBe('cn')
  })

  it('passes refreshExpiresAt through in ms and restores the ai edition from an ai host', () => {
    const credential = credentialOfTransferRecord(siblingRecord({
      domain: 'https://coresg-normal.trae.ai',
      refreshExpiresAt: 1896048000000,
    }) as never)
    expect(credential).toBeDefined()
    if (credential === undefined) return
    expect(credential.refreshExpiresAtMs).toBe(1896048000000)
    expect(credential.edition).toBe('sg')
  })

  it('skips records without a token (the importer\'s skip rule)', () => {
    expect(credentialOfTransferRecord(siblingRecord({ access_token: '' }) as never)).toBeUndefined()
    expect(credentialOfTransferRecord(siblingRecord({ access_token: undefined }) as never)).toBeUndefined()
    expect(credentialOfTransferRecord(siblingRecord({ access_token: 42 }) as never)).toBeUndefined()
  })

  it('tolerates a missing refresh_token', () => {
    const credential = credentialOfTransferRecord(siblingRecord({ refresh_token: undefined }) as never)
    expect(credential).toBeDefined()
    expect(credential?.refreshToken).toBeUndefined()
  })

  it('recovers userId / accountName / userRegion from a nested {auth, account} auth_raw', () => {
    // The contract fields are the flat snake_case tops; auth_raw is extra
    // fidelity. Recovery reads the auth_raw ROOT for `userId` / `userRegion`
    // (both the desktop-shape and the nested-block root carry them there) and
    // the `account.username` for the display name. `host` is the flat `domain`.
    const credential = credentialOfTransferRecord({
      access_token: 'at-1',
      domain: 'https://coresg-normal.trae.ai',
      auth_raw: {
        userId: 'uid-in-raw',
        userRegion: { region: 'SG' },
        auth: { token: 'at-1', host: 'https://coresg-normal.trae.ai' },
        account: { username: '原声账号' },
      },
    } as TraeTransferRecord)
    expect(credential).toBeDefined()
    if (credential === undefined) return
    // No flat uid/nickname/userRegion here — recovered from auth_raw.
    expect(credential.userId).toBe('uid-in-raw')
    expect(credential.accountName).toBe('原声账号')
    expect(credential.userRegion).toBe('SG')
    // host is the contract's flat `domain` field, carried here from the tops.
    expect(credential.host).toBe('https://coresg-normal.trae.ai')
    // The SG claim + ai host drive a positive ai classification.
    expect(knownRegionOfCredential(credential)).toBe('ai')
  })

  it('recovers userId / accountName / userRegion from a raw desktop storage document auth_raw', () => {
    // The raw desktop document holds `userId`, `userRegion:{region}`, and
    // `account:{username}` at the auth_raw root — exactly where the importer
    // looks. `host` is still the flat `domain`.
    const credential = credentialOfTransferRecord({
      access_token: 'at-1',
      domain: 'https://api.trae.cn',
      auth_raw: rawDesktopDocument(),
    } as TraeTransferRecord)
    expect(credential).toBeDefined()
    if (credential === undefined) return
    expect(credential.userId).toBe('uid-desktop')
    expect(credential.accountName).toBe('桌面账号')
    expect(credential.userRegion).toBe('CN')
    expect(credential.host).toBe('https://api.trae.cn')
    expect(knownRegionOfCredential(credential)).toBe('cn')
  })
})

describe('traeTransferRecordOf (export shape)', () => {
  it('emits snake_case fields with ms expiry and the nested auth_raw document', () => {
    const credential = vaultCredential()
    const record = traeTransferRecordOf(credential, nestedRaw(credential))
    expect(record['access_token']).toBe('at-vault')
    expect(record['refresh_token']).toBe('rt-vault')
    expect(record['uid']).toBe('u-9')
    expect(record['nickname']).toBe('阿九')
    expect(record['domain']).toBe('https://api.trae.cn')
    // Export expiry is in MILLISECONDS and carries through verbatim — trae's
    // credential is already ms, unlike workbuddy's sec-storing vault.
    expect(record['expiresAt']).toBe(1893456000000)
    expect(record['refreshExpiresAt']).toBe(1896048000000)
    const raw = record['auth_raw'] as { auth: Record<string, unknown>, account: Record<string, unknown> }
    expect(raw['auth']['token']).toBe('at-vault')
    expect(raw['account']['username']).toBe('阿九')
  })

  it('omits the optional fields that are absent', () => {
    // A credential without a refresh token / account name / host / known expiry
    // (e.g. a bare CLI token) must not fabricate snake_case tops for them.
    const credential: TraeCredential = {
      accessToken: 'at-bare',
      userId: '',
      host: '',
      expiresAtMs: 0,
      edition: 'cn',
      source: 'dsh',
    }
    const record = traeTransferRecordOf(credential, {})
    expect('refresh_token' in record).toBe(false)
    expect('nickname' in record).toBe(false)
    expect('domain' in record).toBe(false)
    expect('expiresAt' in record).toBe(false)
    expect('refreshExpiresAt' in record).toBe(false)
    expect('uid' in record).toBe(false)
    expect(record['access_token']).toBe('at-bare')
  })
})

describe('export → import round-trip (pins the millisecond unit boundary)', () => {
  it('re-imports an exported credential to the SAME account id with expiry preserved', () => {
    const credential = vaultCredential()
    const record = traeTransferRecordOf(credential, nestedRaw(credential))
    const parsed = parseTransferFile(JSON.stringify([record]))
    const merged = mergeTransferRecords(parsed, [0], 'cn')
    expect(merged.imported).toBe(1)
    expect(merged.skipped).toBe(0)
    const restored = [...merged.changes.values()][0]
    expect(restored).toBeDefined()
    if (restored === undefined) return
    // The whole point of the unit test: expiry survives the boundary verbatim.
    expect(restored.expiresAtMs).toBe(1893456000000)
    expect(restored.refreshExpiresAtMs).toBe(1896048000000)
    expect(restored.accessToken).toBe('at-vault')
    expect(restored.userId).toBe('u-9')
    // The account id must converge on the ORIGINAL stored id, not duplicate
    // under a different key — a rescale or edition drift would fork the id.
    expect(traeAccountId(restored)).toBe(traeAccountId(credential))
  })
})

describe('knownRegionOfCredential (positive-match classifier)', () => {
  it('classifies a real host positively and leaves empty/foreign hosts undefined', () => {
    expect(knownRegionOfCredential({ host: 'https://api.trae.cn' })).toBe('cn')
    expect(knownRegionOfCredential({ host: 'https://coresg-normal.trae.ai' })).toBe('ai')
    expect(knownRegionOfCredential({ userRegion: 'CN' })).toBe('cn')
    expect(knownRegionOfCredential({ userRegion: 'SG' })).toBe('ai')
    // An unrecognised host is undefined — this is the whole security point.
    expect(knownRegionOfCredential({ host: '' })).toBeUndefined()
    expect(knownRegionOfCredential({ host: 'https://evil.com' })).toBeUndefined()
    expect(knownRegionOfCredential({ host: 'https://trae.cn.evil.com' })).toBeUndefined()
    expect(knownRegionOfCredential({ host: 'https://trae.ai.evil.com' })).toBeUndefined()
    expect(knownRegionOfCredential({})).toBeUndefined()
  })

  it('lets the userRegion claim win when it disagrees with the host', () => {
    // A CN-domain host carrying an SG claim reads ai (claim is authoritative).
    expect(knownRegionOfCredential({ host: 'https://api.trae.cn', userRegion: 'SG' })).toBe('ai')
  })
})

describe('mergeTransferRecords', () => {
  it('overwrites the same account id and counts it as imported', () => {
    const records = [
      siblingRecord({ uid: 'u-1', access_token: 'old' }),
      siblingRecord({ uid: 'u-1', access_token: 'new' }),
    ] as never[]
    const merged = mergeTransferRecords(records, [0, 1], 'cn')
    expect(merged.imported).toBe(2)
    expect(merged.changes.size).toBe(1)
    expect([...merged.changes.values()][0]?.accessToken).toBe('new')
  })

  it('skips token-less records, bad indexes, and the other region\'s records', () => {
    const records = [
      siblingRecord({ access_token: '' }),
      siblingRecord({ uid: 'u-2', domain: 'https://coresg-normal.trae.ai' }),
      siblingRecord({ uid: 'u-3', domain: 'https://api.trae.cn' }),
    ] as never[]
    const merged = mergeTransferRecords(records, [0, 1, 2, 9], 'cn')
    expect(merged.imported).toBe(1)
    expect(merged.skipped).toBe(3)
    // The global/ai record is NOT in the cn changeset.
    expect([...merged.changes.keys()]).toEqual([traeAccountId({ edition: 'cn', userId: 'u-3', accountName: '小明' })])
  })

  it('SKIPS a record whose region cannot be positively classified — never admits by a default', () => {
    // The security property. `domain` comes from a file someone handed the
    // plugin, so "unrecognised" means "cannot be classified". trae's
    // `regionOfCredential` would fall back to `cn` for each of these; the gate
    // must NOT, or a spoofed foreign credential would be filed in the CN vault.
    for (const domain of [
      '',                                  // empty
      'https://',                          // parse-empty
      'evil.com',                          // entirely foreign
      'https://example.com',               // foreign
      'https://trae.cn.evil.com',          // registrable-domain lookalike
      'https://trae.ai.evil.com',          // registrable-domain lookalike
      'https://notatrae.cn',               // substring lookalike
    ]) {
      const merged = mergeTransferRecords([siblingRecord({ domain })] as never[], [0], 'cn')
      expect(merged.imported, `domain ${JSON.stringify(domain)} must not be admitted to cn`).toBe(0)
      expect(merged.skipped).toBe(1)
      expect(merged.changes.size).toBe(0)
    }
  })

  it('skips the same spoofed domain for the ai region too', () => {
    const merged = mergeTransferRecords(
      [siblingRecord({ domain: 'https://trae.ai.evil.com' })] as never[],
      [0], 'ai',
    )
    expect(merged.imported).toBe(0)
    expect(merged.skipped).toBe(1)
    expect(merged.changes.size).toBe(0)
  })

  it('admits a positively classified record in its own region, and rejects it in the other', () => {
    const cn = mergeTransferRecords([siblingRecord({ domain: 'https://api.trae.cn' })] as never[], [0], 'cn')
    expect(cn.imported).toBe(1)
    expect(cn.skipped).toBe(0)

    const aiInCn = mergeTransferRecords([siblingRecord({ domain: 'https://coresg-normal.trae.ai' })] as never[], [0], 'cn')
    expect(aiInCn.imported).toBe(0)
    expect(aiInCn.skipped).toBe(1)

    const ai = mergeTransferRecords([siblingRecord({ domain: 'https://coresg-normal.trae.ai' })] as never[], [0], 'ai')
    expect(ai.imported).toBe(1)

    const cnInAi = mergeTransferRecords([siblingRecord({ domain: 'https://api.trae.cn' })] as never[], [0], 'ai')
    expect(cnInAi.imported).toBe(0)
    expect(cnInAi.skipped).toBe(1)
  })

  it('honours the injected judge exactly as the default gate (positive match)', () => {
    // Passing the exported positive-match helper explicitly is the same decision
    // as the default gate — both must skip a spoofed domain.
    const spoofed = mergeTransferRecords(
      [siblingRecord({ domain: 'https://trae.cn.evil.com' })] as never[],
      [0], 'cn', knownRegionOfCredential,
    )
    expect(spoofed.imported).toBe(0)
    expect(spoofed.skipped).toBe(1)
    const cn = mergeTransferRecords(
      [siblingRecord({ domain: 'https://api.trae.cn' })] as never[],
      [0], 'cn', knownRegionOfCredential,
    )
    expect(cn.imported).toBe(1)
  })

  it('never imports records not selected in `indexes`', () => {
    const records = [
      siblingRecord({ uid: 'u-1', domain: 'https://api.trae.cn' }),
      siblingRecord({ uid: 'u-2', domain: 'https://api.trae.cn' }),
      siblingRecord({ uid: 'u-3', domain: 'https://api.trae.cn' }),
    ] as never[]
    // Only index 1 is selected; the others must not be admitted.
    const merged = mergeTransferRecords(records, [1], 'cn')
    expect(merged.imported).toBe(1)
    expect(merged.skipped).toBe(0)
    expect([...merged.changes.keys()]).toEqual([
      traeAccountId({ edition: 'cn', userId: 'u-2', accountName: '小明' }),
    ])
  })

  it('re-importing the same file is idempotent (identical changes map)', () => {
    const text = JSON.stringify([
      siblingRecord({ uid: 'u-1', domain: 'https://api.trae.cn' }),
      siblingRecord({ uid: 'u-2', domain: 'https://api.trae.cn' }),
      siblingRecord({ uid: 'u-3', access_token: '', domain: 'https://api.trae.cn' }),
    ])
    const records = parseTransferFile(text)
    const indexes = [0, 1, 2]
    const first = mergeTransferRecords(records, indexes, 'cn')
    const second = mergeTransferRecords(records, indexes, 'cn')
    expect(first.imported).toBe(2)
    expect(first.skipped).toBe(1)
    expect(first.imported).toBe(second.imported)
    expect(first.skipped).toBe(second.skipped)
    expect(JSON.stringify([...first.changes])).toBe(JSON.stringify([...second.changes]))
    expect([...first.changes.entries()]).toEqual([...second.changes.entries()])
  })
})