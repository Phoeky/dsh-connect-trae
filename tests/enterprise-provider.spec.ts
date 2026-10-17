/**
 * Enterprise (tenant) provider: the second CN chat pool.
 *
 * These cases pin the three properties that make the split safe:
 *  1. the pool a turn reaches is decided by the PROVIDER, never per call;
 *  2. `trae-enterprise` never falls back to the consumer pool; and
 *  3. the tenant gateway's wire quirks are handled — a per-call `session_id`,
 *     and a refusal that arrives as HTTP 200 with an `event:error` first frame.
 *
 * A fourth group covers the case-sensitive `config_name` mapping that made
 * `deepseek-v4.1-flash` unusable: the Remote directory id is lowercase while
 * the gateway's `config_name` is `DeepSeek-V4.1-Flash`.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import z from '@deepseek-ai/schemastery'
import {
  displayNameOfTraeProvider,
  regionOfTraeProvider,
  routeOfTraeProvider,
  TRAE_AI_PROVIDER,
  TRAE_ENTERPRISE_PROVIDER,
  TRAE_PROVIDER,
  TRAE_PROVIDER_IDS,
  TRAE_PROVIDER_ROUTES,
} from '../src/adapter.ts'
import { TraeCatalog } from '../src/catalog.ts'
import { TRAE_ENTERPRISE_HOST } from '../src/region.ts'
import { createTraeShim, type TraeShim, type TraeShimRoute } from '../src/shim.ts'
import { TraeSoloBridge } from '../src/solo-bridge.ts'
import { TraeSoloUpstreamClient } from '../src/solo.ts'
import type { TraeChatResult, TraeUpstreamClient } from '../src/upstream.ts'
import type { TraeCredential } from '../src/auth.ts'
import type { TraeIdentity } from '../src/identity.ts'

const credential: TraeCredential = {
  accessToken: 'test-token-not-a-real-credential',
  userId: 'tenant-user',
  userRegion: 'cn',
  edition: 'cn',
  host: 'https://trae.cn',
} as TraeCredential

const identity: TraeIdentity = {
  machineId: 'machine',
  deviceId: 'device',
  platform: 'darwin',
  deviceBrand: 'MacBookPro17,1',
  deviceCpu: 'Apple',
  osVersion: 'macOS 26.3.1',
  appVersion: '3.3.72',
  buildVersion: '20260630',
} as TraeIdentity

/** Client bound to a recording `fetchImpl`, so the wire body is observable. */
function recordingClient(route: 'solo' | 'enterprise', respond?: (url: string, init: RequestInit) => Response) {
  const calls: { url: string; body: Record<string, unknown> }[] = []
  const client = new TraeSoloUpstreamClient({
    credential: async () => credential,
    identity: async () => identity,
    route,
    log: () => {},
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)) as Record<string, unknown> })
      return respond?.(String(url), init as RequestInit) ?? new Response('event:output\ndata:{"response":"PONG"}\n\n', {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    },
  })
  return { client, calls }
}

function sse(body: string): Response {
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

const ASK = JSON.stringify({ messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], model: 'glm-5.3-flash' })

describe('enterprise provider ids', () => {
  it('publishes the enterprise provider beside the consumer one on cn only', () => {
    expect(TRAE_PROVIDER_IDS.cn).toEqual([TRAE_PROVIDER, TRAE_ENTERPRISE_PROVIDER])
    expect(TRAE_PROVIDER_IDS.ai).toEqual([TRAE_AI_PROVIDER])
  })

  it('maps each provider to its billing pool', () => {
    expect(routeOfTraeProvider(TRAE_PROVIDER)).toBe('solo')
    expect(routeOfTraeProvider(TRAE_ENTERPRISE_PROVIDER)).toBe('enterprise')
    expect(routeOfTraeProvider(TRAE_AI_PROVIDER)).toBe('solo')
    expect(routeOfTraeProvider('not-a-trae-provider')).toBeUndefined()
    expect(TRAE_PROVIDER_ROUTES).not.toHaveProperty('trae-enterprise-vision')
  })

  it('keeps the enterprise provider in the cn region and gives it its own name', () => {
    expect(regionOfTraeProvider(TRAE_ENTERPRISE_PROVIDER)).toBe('cn')
    expect(regionOfTraeProvider(TRAE_PROVIDER)).toBe('cn')
    expect(regionOfTraeProvider(TRAE_AI_PROVIDER)).toBe('ai')
    expect(displayNameOfTraeProvider(TRAE_ENTERPRISE_PROVIDER)).toBe('Trae 企业版')
    expect(displayNameOfTraeProvider(TRAE_PROVIDER)).toBe('Trae')
  })
})

describe('enterprise route wire shape', () => {
  it('sends the tenant gateway and stamps a per-call session_id', async () => {
    const { client, calls } = recordingClient('enterprise')
    const result = await client.chatStream(ASK, undefined, 'solo_work_remote')
    expect(result.ok).toBe(true)
    expect(calls).toHaveLength(1)
    expect(new URL(calls[0]!.url).host).toBe(new URL(TRAE_ENTERPRISE_HOST).host)
    expect(typeof calls[0]!.body['session_id']).toBe('string')
    expect((calls[0]!.body['session_id'] as string).length).toBeGreaterThan(8)
  })

  it('gives every call its own session_id', async () => {
    const { client, calls } = recordingClient('enterprise')
    await client.chatStream(ASK)
    await client.chatStream(ASK)
    expect(calls[0]!.body['session_id']).not.toBe(calls[1]!.body['session_id'])
  })

  it('keeps the consumer route on the consumer gateway with no session_id', async () => {
    const { client, calls } = recordingClient('solo')
    await client.chatStream(ASK)
    expect(new URL(calls[0]!.url).host).not.toBe(new URL(TRAE_ENTERPRISE_HOST).host)
    expect(calls[0]!.body).not.toHaveProperty('session_id')
  })

  it('reads the ROSTER from the route it is pinned to', async () => {
    // The two pools publish different rosters (`DeepSeek-V4.1-Flash` is listed
    // only by the enterprise one), so a route-pinned client that read the
    // consumer roster would never discover its own pool's exclusive models.
    for (const route of ['solo', 'enterprise'] as const) {
      const asked: string[] = []
      const client = new TraeSoloUpstreamClient({
        credential: async () => credential,
        identity: async () => identity,
        route,
        log: () => {},
        fetchImpl: async (url) => {
          asked.push(new URL(String(url)).host)
          return new Response(JSON.stringify({ config_info_list: [{ config_name: `model-of-${route}` }] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        },
      })
      await client.fetchModels()
      const expected = route === 'enterprise' ? new URL(TRAE_ENTERPRISE_HOST).host : 'trae-api-cn.mchost.guru'
      expect(new Set(asked)).toEqual(new Set([expected]))
    }
  })
})

describe('enterprise refusal handling', () => {
  const refusal = 'event:error\ndata:{"code":4001,"message":"We\'re sorry, the param is invalid. Please try with a valid param.","extra":null}\n\n'

  it('turns an HTTP 200 + event:error into a real client error', async () => {
    const { client } = recordingClient('enterprise', () => sse(refusal))
    const result = await client.chatStream(ASK)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.kind).toBe<'client'>('client')
    expect(result.message).toContain('4001')
  })

  it('passes a normal stream through byte-for-byte', async () => {
    const body = 'id:1\nevent:output\ndata:{"response":"PONG"}\n\nid:2\nevent:done\ndata:{"finish_reason":"stop"}\n\n'
    const { client } = recordingClient('enterprise', () => sse(body))
    const result = await client.chatStream(ASK)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(await result.response.text()).toBe(body)
  })

  it('does not reinterpret a consumer 200 (the consumer gateway never refuses that way)', async () => {
    const { client } = recordingClient('solo', () => sse(refusal))
    const result = await client.chatStream(ASK)
    expect(result.ok).toBe(true)
  })
})

describe('case-sensitive config_name mapping', () => {
  /** Bridge over a fixed catalog + resolver, recording what reaches the wire. */
  function bridgeWith(catalogRows: Parameters<TraeCatalog['set']>[0], resolver?: (id: string) => { configName: string, function?: string } | undefined) {
    const sent: Record<string, unknown>[] = []
    const upstream: TraeUpstreamClient = {
      async chatStream(bodyJson): Promise<TraeChatResult> {
        sent.push(JSON.parse(bodyJson) as Record<string, unknown>)
        return { ok: true, response: sse('event:output\ndata:{"response":"PONG"}\n\n') }
      },
    }
    const catalog = new TraeCatalog('cn')
    catalog.set(catalogRows)
    return { sent, bridge: new TraeSoloBridge(upstream, catalog, resolver) }
  }

  it('resolves a lowercase request to the row\'s canonical id when nothing maps it', async () => {
    // The discovered row IS the wire id, so the merge emits no wireConfigName.
    const { sent, bridge } = bridgeWith([{ id: 'DeepSeek-V4.1-Flash', name: 'DeepSeek-V4.1-Flash', input: ['text'] }])
    await bridge.chatStream(JSON.stringify({ messages: [], model: 'deepseek-v4.1-flash' }))
    expect(sent[0]!['model']).toBe('DeepSeek-V4.1-Flash')
  })

  it('prefers the row\'s wireConfigName when the merge supplied one', async () => {
    const { sent, bridge } = bridgeWith([{ id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', input: ['text'], wireConfigName: 'DeepSeek-V4.1-Flash', wireFunction: 'solo_work_remote' }])
    await bridge.chatStream(JSON.stringify({ messages: [], model: 'DEEPSEEK-V4.1-FLASH' }))
    expect(sent[0]!['model']).toBe('DeepSeek-V4.1-Flash')
    expect(sent[0]!['function']).toBe('solo_work_remote')
  })

  it('never rewrites a model whose id is already correct', async () => {
    const { sent, bridge } = bridgeWith([{ id: 'glm-5.3-flash', name: 'GLM-5.3-Flash', input: ['text'] }])
    await bridge.chatStream(JSON.stringify({ messages: [], model: 'glm-5.3-flash' }))
    expect(sent[0]!['model']).toBe('glm-5.3-flash')
  })
})

describe('settings schema keeps the wire mapping', () => {
  /** The model row schema as the settings channel rebuilds it. */
  const model = z.object({
    id: z.string().required(),
    name: z.string().required(),
    wireFunction: z.string(),
    wireConfigName: z.string(),
  })

  it('survives a settings round-trip (the 4001 root cause when it is missing)', () => {
    const row = { id: 'deepseek-v4.1-flash', name: 'DeepSeek-V4.1-Flash', wireFunction: 'solo_work_remote', wireConfigName: 'DeepSeek-V4.1-Flash' }
    const parsed = model(row) as unknown as Record<string, unknown>
    expect(parsed['wireConfigName']).toBe('DeepSeek-V4.1-Flash')
    expect(parsed['wireFunction']).toBe('solo_work_remote')
  })
})

describe('shim dispatches by bearer', () => {
  let shim: TraeShim | undefined
  beforeEach(async () => { shim = undefined })

  async function start(): Promise<{ shim: TraeShim; seen: string[] }> {
    const seen: string[] = []
    const mk = (label: string): TraeUpstreamClient => ({
      async chatStream(): Promise<TraeChatResult> {
        seen.push(label)
        return { ok: true, response: sse(`event:output\ndata:{"response":"${label}"}\n\n`) }
      },
    })
    const routes: TraeShimRoute[] = [{ label: 'solo', client: mk('solo') }, { label: 'enterprise', client: mk('enterprise') }]
    const started = createTraeShim({ catalog: new TraeCatalog('cn'), routes, logger: { warn() {}, error() {} } })
    await started.ready
    shim = started
    return { shim: started, seen }
  }

  async function call(base: string, token: string): Promise<{ status: number; text: string }> {
    const response = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ model: 'glm-5.3-flash', messages: [] }),
    })
    return { status: response.status, text: await response.text() }
  }

  it('gives each route its own secret and routes accordingly', async () => {
    const { shim: started, seen } = await start()
    try {
      const solo = started.tokenOf('solo')
      const enterprise = started.tokenOf('enterprise')
      expect(solo).not.toBe(enterprise)
      expect((await call(started.baseUrl(), solo)).text).toContain('solo')
      expect((await call(started.baseUrl(), enterprise)).text).toContain('enterprise')
      expect(seen).toEqual(['solo', 'enterprise'])
    } finally { await started.close() }
  })

  it('rejects an unknown bearer instead of falling back to a pool', async () => {
    const { shim: started, seen } = await start()
    try {
      const bogus = 'x'.repeat(started.tokenOf('solo').length)
      expect((await call(started.baseUrl(), bogus)).status).toBe(401)
      expect(seen).toEqual([])
    } finally { await started.close() }
  })

  it('keeps the single-client form working (one route, token())', async () => {
    const upstream: TraeUpstreamClient = {
      async chatStream(): Promise<TraeChatResult> { return { ok: true, response: sse('event:output\ndata:{"response":"only"}\n\n') } },
    }
    const started = createTraeShim({ catalog: new TraeCatalog('cn'), client: upstream })
    await started.ready
    try {
      expect(started.tokenOf('solo')).toBe(started.token())
      expect((await call(started.baseUrl(), started.token())).text).toContain('only')
    } finally { await started.close() }
  })
})
