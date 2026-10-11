import { afterEach, describe, expect, it, vi } from 'vitest'
import { generateKeyPairSync, verify } from 'node:crypto'
import {
  refreshClientIdOf,
  refreshPlatformCodeOf,
  refreshTraeCredential,
  signTraeDeviceProof,
  traeDeviceProofMessage,
  TRAE_EXCHANGE_TOKEN_PATH,
  TRAE_LEGACY_EXCHANGE_TOKEN_PATH,
  type TraeRefreshDevice,
} from '../src/refresh.ts'
import type { TraeCredential } from '../src/auth.ts'

function credential(edition: TraeCredential['edition'], host: string): TraeCredential {
  return {
    accessToken: 'at',
    refreshToken: 'rt',
    userId: 'uid',
    host,
    expiresAtMs: Date.now() - 1000,
    edition,
    source: 'desktop',
  }
}

/** A real P-256 keypair, so the proof is genuinely signed (never a stub). */
function keyPair(): { privateKeyPEM: string; publicKeyPEM: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ec', {
    namedCurve: 'P-256',
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  })
  return { privateKeyPEM: privateKey, publicKeyPEM: publicKey }
}

function device(overrides: Partial<TraeRefreshDevice> = {}): TraeRefreshDevice {
  return { deviceId: 'device-1', machineId: 'machine-1', deviceKeyPair: keyPair(), ...overrides }
}

interface CapturedRequest {
  url: string
  body: Record<string, unknown>
}

/** Stub a 200 for the CURRENT path and 401 for anything else (or vice versa). */
function stubFetch(options: { currentStatus?: number; legacyStatus?: number } = {}): CapturedRequest[] {
  const captured: CapturedRequest[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: { body: string }) => {
    captured.push({ url, body: JSON.parse(init.body) as Record<string, unknown> })
    const isCurrent = url.endsWith(TRAE_EXCHANGE_TOKEN_PATH)
    const status = isCurrent ? options.currentStatus ?? 200 : options.legacyStatus ?? 200
    if (status !== 200) return new Response('nope', { status })
    return new Response(JSON.stringify({
      Result: { Token: 'fresh', RefreshToken: 'rt2', TokenExpireAt: Date.now() + 60_000, RefreshExpireAt: Date.now() + 86_400_000 },
    }), { status: 200 })
  }))
  return captured
}

afterEach(() => { vi.unstubAllGlobals() })

describe('refreshTraeCredential per-edition contract', () => {
  it('every edition refreshes on the CURRENT /trae/api/v3 path with its own ClientID and PlatformCode', async () => {
    const expected: ReadonlyArray<[TraeCredential['edition'], string, string]> = [
      ['cn', 'ono9krqynydwx5', 'IDE_PC'],
      ['sg', 'ono9krqynydwx5', 'IDE_PC'],
      ['solo', 'en1oxy7wnw8j9n', 'SOLO_PC'],
      ['solo-sg', 'en1oxy7wnw8j9n', 'SOLO_PC'],
    ]
    for (const [edition, clientId, platformCode] of expected) {
      const captured = stubFetch()
      await refreshTraeCredential(credential(edition, 'https://api.trae.cn'), undefined, device())
      expect(captured).toHaveLength(1)
      expect(captured[0]!.url).toBe(`https://api.trae.cn${TRAE_EXCHANGE_TOKEN_PATH}`)
      expect(captured[0]!.body['ClientID']).toBe(clientId)
      expect(captured[0]!.body['ClientSecret']).toBe('')
      // The SOLO CN edition takes the SOLO ClientID on the CURRENT contract;
      // the legacy path is the only place the desktop ClientID was universal.
      expect(captured[0]!.body['DeviceInfo']).toMatchObject({ PlatformCode: platformCode, DeviceType: 'PC' })
      // The current contract carries no UserID.
      expect(captured[0]!.body['UserID']).toBeUndefined()
      vi.unstubAllGlobals()
    }
    expect(refreshClientIdOf('solo')).toBe('en1oxy7wnw8j9n')
    expect(refreshPlatformCodeOf('solo-sg')).toBe('SOLO_PC')
  })

  it('the international desktop edition hangs off its own host', async () => {
    const captured = stubFetch()
    await refreshTraeCredential(credential('sg', 'https://api-sg-central.trae.ai'), undefined, device())
    expect(captured[0]!.url).toBe(`https://api-sg-central.trae.ai${TRAE_EXCHANGE_TOKEN_PATH}`)
  })

  it('signs the device proof over the newline-joined message the official client signs', async () => {
    const keys = keyPair()
    const captured = stubFetch()
    const result = await refreshTraeCredential(
      credential('cn', 'https://api.trae.cn'), undefined,
      device({ deviceKeyPair: keys }),
    )
    const proof = captured[0]!.body['DeviceProof'] as { Signature: string; Timestamp: number; Nonce: string }
    expect(proof).toBeDefined()
    expect(typeof proof.Timestamp).toBe('number')

    // Reproduce the official client's message: the separator is a NEWLINE, and
    // a space-joined variant of the same fields is rejected by the server with
    // 20403 — so this assertion is the difference between working and not.
    const message = traeDeviceProofMessage({
      path: TRAE_EXCHANGE_TOKEN_PATH,
      clientId: 'ono9krqynydwx5',
      refreshToken: 'rt',
      timestamp: proof.Timestamp,
      nonce: proof.Nonce,
    })
    expect(message.split('\n')).toEqual(['POST', TRAE_EXCHANGE_TOKEN_PATH, 'ono9krqynydwx5', 'rt', String(proof.Timestamp), proof.Nonce])
    expect(verify('sha256', Buffer.from(message), keys.publicKeyPEM, Buffer.from(proof.Signature, 'base64'))).toBe(true)
    // ...and the same fields space-joined must NOT verify.
    expect(verify('sha256', Buffer.from(message.replace(/\n/g, ' ')), keys.publicKeyPEM, Buffer.from(proof.Signature, 'base64'))).toBe(false)
    expect(result).toMatchObject({ accessToken: 'fresh', refreshToken: 'rt2' })
  })

  it('sends the install public key and records RefreshExpireAt', async () => {
    const keys = keyPair()
    const captured = stubFetch()
    const outcome = await refreshTraeCredential(
      credential('cn', 'https://api.trae.cn'), undefined,
      device({ deviceKeyPair: keys, appVersion: '3.4.2', deviceName: 'host', deviceModel: 'MacBookPro18,2' }),
    )
    expect(captured[0]!.body['DeviceInfo']).toMatchObject({
      DeviceID: 'device-1',
      MachineID: 'machine-1',
      DeviceType: 'PC',
      DevicePublicKey: keys.publicKeyPEM,
    })
    expect(captured[0]!.body['IDEVersion']).toBe('3.4.2')
    expect(outcome.refreshExpiresAtMs).toBeGreaterThan(Date.now())
  })

  it('signTraeDeviceProof honours pinned inputs and produces a verifiable proof', () => {
    const keys = keyPair()
    const input = { path: TRAE_EXCHANGE_TOKEN_PATH, clientId: 'ono9krqynydwx5', refreshToken: 'rt', privateKeyPEM: keys.privateKeyPEM, timestamp: 1791691531, nonce: 'b41f0c56570354c91c01e6c5b0993030' }
    const proof = signTraeDeviceProof(input)
    expect(proof.Timestamp).toBe(1791691531)
    expect(proof.Nonce).toBe('b41f0c56570354c91c01e6c5b0993030')
    // ECDSA is randomised, so two signatures over one message legitimately
    // differ; what must hold is that each one VERIFIES against that message.
    expect(verify('sha256', Buffer.from(traeDeviceProofMessage(input)), keys.publicKeyPEM, Buffer.from(proof.Signature, 'base64'))).toBe(true)
    expect(verify('sha256', Buffer.from(traeDeviceProofMessage(input)), keys.publicKeyPEM, Buffer.from(signTraeDeviceProof(input).Signature, 'base64'))).toBe(true)
  })

  it('falls back to the LEGACY /cloudide path when no device keypair is available', async () => {
    // A CLI-only machine (or an install that predates the keypair) has nothing
    // to sign with, so the current contract is skipped rather than sent
    // unsigned to be rejected.
    const captured = stubFetch()
    const outcome = await refreshTraeCredential(
      credential('cn', 'https://api.trae.cn'), undefined,
      { deviceId: 'device-1', machineId: 'machine-1' },
    )
    expect(captured).toHaveLength(1)
    expect(captured[0]!.url).toBe(`https://api.trae.cn${TRAE_LEGACY_EXCHANGE_TOKEN_PATH}`)
    expect(captured[0]!.body).toMatchObject({ ClientID: 'ono9krqynydwx5', ClientSecret: '-', UserID: 'uid' })
    expect(captured[0]!.body['DeviceInfo']).toBeUndefined()
    expect(outcome).toMatchObject({ accessToken: 'fresh' })
  })

  it('the LEGACY fallback keeps the per-edition ClientID split', async () => {
    // The ClientID split belongs to the OAuth CLIENT, not to the endpoint: a
    // SOLO refresh token is refused by the desktop client on BOTH paths with
    // `10101 refresh token is not matched to the client`. The pre-3.1.0 code
    // hardcoded the desktop ClientID here, which is what left an international
    // SOLO account with no working fallback at all.
    for (const [edition, clientId] of [['cn', 'ono9krqynydwx5'], ['sg', 'ono9krqynydwx5'], ['solo', 'en1oxy7wnw8j9n'], ['solo-sg', 'en1oxy7wnw8j9n']] as const) {
      const captured = stubFetch()
      await refreshTraeCredential(credential(edition, 'https://api.trae.cn'), undefined, { deviceId: 'd', machineId: 'm' })
      expect(captured).toHaveLength(1)
      expect(captured[0]!.url).toBe(`https://api.trae.cn${TRAE_LEGACY_EXCHANGE_TOKEN_PATH}`)
      expect(captured[0]!.body).toMatchObject({ ClientID: clientId, ClientSecret: '-', UserID: 'uid' })
      expect(captured[0]!.body['DeviceProof']).toBeUndefined()
      vi.unstubAllGlobals()
    }
  })

  it('falls back to the LEGACY path when the current contract is refused', async () => {
    const captured = stubFetch({ currentStatus: 401 })
    const outcome = await refreshTraeCredential(credential('cn', 'https://api.trae.cn'), undefined, device())
    expect(captured.map(item => item.url)).toEqual([
      `https://api.trae.cn${TRAE_EXCHANGE_TOKEN_PATH}`,
      `https://api.trae.cn${TRAE_LEGACY_EXCHANGE_TOKEN_PATH}`,
    ])
    expect(outcome).toMatchObject({ accessToken: 'fresh' })
  })

  it('omits DeviceInfo rather than sending an empty object when no device resolved', async () => {
    // No device at all: the current contract cannot be attempted, and the
    // legacy body carries no device block.
    const captured = stubFetch()
    await refreshTraeCredential(credential('cn', 'https://api.trae.cn'))
    expect(captured).toHaveLength(1)
    expect(captured[0]!.url).toBe(`https://api.trae.cn${TRAE_LEGACY_EXCHANGE_TOKEN_PATH}`)
    expect(captured[0]!.body['DeviceInfo']).toBeUndefined()
  })

  it('requires a refresh token and reports every attempted contract on failure', async () => {
    const { refreshToken: _omit, ...withoutRefresh } = credential('cn', 'https://api.trae.cn')
    await expect(refreshTraeCredential(withoutRefresh))
      .rejects.toThrow(/refresh token is missing/)

    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 401 })))
    // The message must name BOTH paths, so a failure is diagnosable.
    await expect(refreshTraeCredential(credential('cn', 'https://api.trae.cn'), undefined, device()))
      .rejects.toThrow(/Trae token refresh failed — .*\/trae\/api\/v3\/oauth\/ExchangeToken.*\/cloudide\/api\/v3\/trae\/oauth\/ExchangeToken/s)
  })

  it('reports both attempts when both contracts are refused', async () => {
    // solo-sg DOES have a usable legacy variant (verified live: its own ClientID
    // answers 200 there), so this is the general both-failed path rather than a
    // "no fallback exists" special case.
    const captured = stubFetch({ currentStatus: 401, legacyStatus: 400 })
    await expect(refreshTraeCredential(credential('solo-sg', 'https://growsg-normal.trae.ai'), undefined, device()))
      .rejects.toThrow(/http 401.*http 400/s)
    expect(captured).toHaveLength(2)
    expect(captured[1]!.body).toMatchObject({ ClientID: 'en1oxy7wnw8j9n' })
  })
})
