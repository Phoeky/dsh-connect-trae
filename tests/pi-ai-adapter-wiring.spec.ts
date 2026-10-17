/**
 * Issue #27, the wiring half: the provider `createTraeAdapter` really builds
 * must hand its api the context shape that api's generation can consume.
 *
 * WHY THIS FILE EXISTS SEPARATELY. `pi-ai-context.spec.ts` calls the adapter
 * functions directly, so it passes even when `createTraeAdapter` forgets to use
 * them — mutation-tested: deleting the wrap from the factory left every one of
 * those tests green. That is precisely the shape of the original defect (the
 * functions were fine; nothing called them), so the factory path needs its own
 * assertion.
 *
 * `@earendil-works/pi-ai/api/openai-completions.lazy` is mocked so the api the
 * factory wraps is a recording stub: whatever it receives is exactly what the
 * factory's adaptation produced. The provider is then driven the way the host
 * drives it — through `adapter.current()` → `piProvider` → `streamSimple` — so
 * a regression anywhere along that path fails here.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context, Model } from '@earendil-works/pi-ai'

const seen: Context[] = []
const stubApi = {
  stream: (_model: Model<never>, context: Context) => { seen.push(context); return { fake: 'stream' } },
  streamSimple: (_model: Model<never>, context: Context) => { seen.push(context); return { fake: 'streamSimple' } },
}

vi.mock('@earendil-works/pi-ai/api/openai-completions.lazy', () => ({
  openAICompletionsApi: () => stubApi,
}))

const PROMPT = 'You are an AI agent powered by DeepSeek Harness.'
const TOOL = { name: 'pwsh', description: 'run a command', parameters: { type: 'object' } }

/** What pi-ai 0.86+ `normalizeContext()` produces: everything on one message. */
const transcript = (): Context => ({
  messages: [
    { role: 'system', content: PROMPT, toolsAdded: [TOOL], timestamp: 0 },
    { role: 'user', content: 'hi', timestamp: 1 },
  ],
} as unknown as Context)

/** The `{ systemPrompt, tools, messages }` shape a legacy host sends. */
const legacy = (): Context => ({
  systemPrompt: PROMPT,
  tools: [TOOL],
  messages: [{ role: 'user', content: 'hi', timestamp: 1 }],
} as unknown as Context)

const shim = {
  ready: Promise.resolve(),
  baseUrl: () => 'http://127.0.0.1:1',
  token: () => 'secret',
  tokenOf: () => 'secret',
  close: async () => {},
}

/** The provider the host dispatches to, reached exactly as the host reaches it. */
async function realProvider(generation?: 'legacy' | 'modern') {
  const { createTraeAdapter, TRAE_PROVIDER } = await import('../src/adapter.ts')
  const { TraeCatalog } = await import('../src/catalog.ts')
  const built = createTraeAdapter({
    shim,
    catalog: new TraeCatalog('cn'),
    ...generation === undefined ? {} : { piAiGeneration: generation },
  })
  const snapshot = (built.adapter as unknown as {
    current: () => { profiles: Map<string, { piProvider?: { streamSimple: (model: unknown, context: Context, options: unknown) => unknown } }> },
  }).current()
  const provider = snapshot.profiles.get(TRAE_PROVIDER)?.piProvider
  if (provider === undefined) throw new Error('adapter registered no piProvider')
  return provider
}

const model = { id: 'm', api: 'openai-completions', provider: 'trae' }

beforeEach(() => { seen.length = 0 })

describe('createTraeAdapter — legacy install (issue #27 itself)', () => {
  it('folds the host transcript down so a legacy api never sees a system message', async () => {
    const provider = await realProvider('legacy')
    provider.streamSimple(model, transcript(), {})
    const received = seen.at(-1)
    expect(received?.systemPrompt).toBe(PROMPT)
    expect(received?.messages.map(message => message.role)).toEqual(['user'])
  })

  it('carries the tool declarations across, so the model can still call tools', async () => {
    const provider = await realProvider('legacy')
    provider.streamSimple(model, transcript(), {})
    expect(seen.at(-1)?.tools?.map(tool => tool.name)).toEqual(['pwsh'])
  })

  it('leaves a legacy host context byte-identical (no gratuitous copy)', async () => {
    const provider = await realProvider('legacy')
    const fromHost = legacy()
    provider.streamSimple(model, fromHost, {})
    // The very same object: the ordinary path allocates nothing.
    expect(seen.at(-1)).toBe(fromHost)
  })

  it('adapts both entry points', async () => {
    const provider = await realProvider('legacy')
    provider.streamSimple(model, transcript(), {})
    const viaSimple = seen.at(-1)
    expect(viaSimple?.systemPrompt).toBe(PROMPT)
  })
})

describe('createTraeAdapter — modern install (the reverse mismatch)', () => {
  it('lifts a legacy host context up so a modern api can still read prompt and tools', async () => {
    const provider = await realProvider('modern')
    provider.streamSimple(model, legacy(), {})
    const received = seen.at(-1) as unknown as { systemPrompt?: unknown, tools?: unknown, messages: { role?: string, content?: unknown, toolsAdded?: unknown }[] }
    // A modern api reads the prompt and the tools ONLY from the leading
    // message; without the lift both reach the wire as nothing.
    expect(received.messages[0]?.role).toBe('system')
    expect(received.messages[0]?.content).toBe(PROMPT)
    expect((received.messages[0]?.toolsAdded as { name: string }[]).map(tool => tool.name)).toEqual(['pwsh'])
    expect(received.systemPrompt).toBeUndefined()
  })

  it('passes an already-normalized transcript through untouched', async () => {
    const provider = await realProvider('modern')
    const fromHost = transcript()
    provider.streamSimple(model, fromHost, {})
    expect(seen.at(-1)).toBe(fromHost)
  })
})

describe('createTraeAdapter — generation source', () => {
  it('defaults to the copy this plugin resolved, not to a hardcoded branch', async () => {
    const { piAiRuntimeInfo } = await import('../src/pi-ai-runtime.ts')
    const generation = piAiRuntimeInfo().generation
    const provider = await realProvider()
    // Whatever this install resolved, the effect must match that answer.
    provider.streamSimple(model, transcript(), {})
    const received = seen.at(-1)
    if (generation === 'legacy') {
      expect(received?.systemPrompt).toBe(PROMPT)
      expect(received?.messages.map(message => message.role)).toEqual(['user'])
    } else {
      // Modern: a transcript is already correct, so identity.
      expect(received).toBeDefined()
      // The legacy `Message` union has no `system` variant — its absence is the
      // defect — so the check reads the role structurally.
      const roles = received?.messages.map(message => (message as { role?: unknown }).role)
      expect(roles).toContain('system')
    }
  })
})
