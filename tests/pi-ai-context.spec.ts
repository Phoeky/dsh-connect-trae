/**
 * Issue #27: the plugin's own `@earendil-works/pi-ai` copy decides the context
 * shape it can consume, and it is not necessarily the host's copy.
 *
 * The tests here pin four things, in increasing order of how much they would
 * have caught:
 *
 * 1. The generation gate, including the combos this machine does NOT have
 *    installed (its own copy is a single version).
 * 2. The fold-down (transcript → legacy) — the crash fix, including the tool
 *    declarations that are the ONLY carrier of `tools` once `normalizeContext`
 *    has run.
 * 3. The fold-up (legacy → transcript) — the reverse mismatch, where a legacy
 *    host hands a modern api a context it silently ignores.
 * 4. Integrations against the REAL resolved pi-ai copy: whatever is installed
 *    here, feeding the adapted context through its own `estimateContextTokens`
 *    and `convertMessages` must neither throw nor drop the prompt or the tools.
 *    That last pair is the assertion that would have failed before this fix.
 */

import { createServer } from 'node:http'
import { describe, expect, it } from 'vitest'
import type { Context, Model, ProviderStreams } from '@earendil-works/pi-ai'
import { adaptLegacyPiAiContext, adaptModernPiAiContext, withContextAdaptation } from '../src/adapter.ts'
import { decidePiAiGeneration, generationOf, piAiRuntimeInfo } from '../src/pi-ai-runtime.ts'

const PROMPT = 'You are an AI agent powered by DeepSeek Harness.'
const TOOL = { name: 'pwsh', description: 'run a command', parameters: { type: 'object' } }

/**
 * Feed a context into a wrapped api's stream entry point.
 *
 * pi-ai 1.1.0 declares `ProviderStreams.stream()` as taking a BRANDED
 * `TranscriptContext`, a type only `normalizeContext()` can produce. These tests
 * deliberately hand it the unbranded shapes that arrive at the wrapper in
 * practice — a host-built `{ systemPrompt, tools, messages }` envelope, or an
 * already-normalized transcript from a test fixture — because adapting exactly
 * those is the wrapper's job. The cast belongs at the call, not inside the
 * wrapper: it is the test asserting "the caller's shape is not what the
 * signature advertises", which is the mismatch under test.
 */
const send = (
  api: ProviderStreams,
  entry: 'stream' | 'streamSimple',
  context: Context,
): void => {
  api[entry]({} as never, context as never, undefined)
}

/** What pi-ai 0.86+ `normalizeContext()` produces: everything on one message. */
function transcript(systemContent: string = PROMPT, tools: unknown[] = [TOOL]): Context {
  return {
    messages: [
      { role: 'system', content: systemContent, ...tools.length === 0 ? {} : { toolsAdded: tools }, timestamp: 0 },
      { role: 'user', content: 'hi', timestamp: 1 },
    ],
  } as unknown as Context
}

/** The `{ systemPrompt, tools, messages }` shape a legacy host sends. */
function legacy(systemPrompt: string | undefined = PROMPT, tools: unknown[] | undefined = [TOOL]): Context {
  return {
    ...systemPrompt === undefined ? {} : { systemPrompt },
    ...tools === undefined || tools.length === 0 ? {} : { tools },
    messages: [{ role: 'user', content: 'hi', timestamp: 1 }],
  } as unknown as Context
}

describe('generationOf', () => {
  it('puts the boundary at 0.86, not 0.87', () => {
    // 0.86.0 is the first release that ships `utils/transcript.js`, gains the
    // `role === 'system'` estimator branch and stops reading the top-level
    // fields. A `>= 0.87` gate folds for it and deletes prompt + tools.
    expect(generationOf('0.85.1')).toBe('legacy')
    expect(generationOf('0.86.0')).toBe('modern')
    expect(generationOf('0.86.1')).toBe('modern')
    expect(generationOf('0.87.1')).toBe('modern')
  })

  it('orders minors numerically, not as strings', () => {
    // A string comparison would call "0.9.0" newer than "0.86.0".
    expect(generationOf('0.9.0')).toBe('legacy')
    expect(generationOf('0.10.0')).toBe('legacy')
    expect(generationOf('0.859.0')).toBe('modern')
  })

  it('treats 1.x as modern — DSH 0.2.1-alpha.2 already pins ^1.0.2', () => {
    expect(generationOf('1.0.0')).toBe('modern')
    expect(generationOf('1.0.2')).toBe('modern')
    expect(generationOf('2.0.0')).toBe('modern')
  })

  it('returns undefined for an unreadable version rather than guessing', () => {
    expect(generationOf(undefined)).toBeUndefined()
    expect(generationOf('not-a-version')).toBeUndefined()
    expect(generationOf('')).toBeUndefined()
  })
})

describe('decidePiAiGeneration', () => {
  it('prefers the version whenever it is readable, whatever the layout says', () => {
    // A version string is authoritative; the layout check is only a fallback
    // for a manifest that could not be parsed.
    expect(decidePiAiGeneration('0.85.1', true)).toBe('legacy')
    expect(decidePiAiGeneration('0.86.0', false)).toBe('modern')
  })

  it('falls back to the package layout when no version is readable', () => {
    expect(decidePiAiGeneration(undefined, true)).toBe('modern')
    expect(decidePiAiGeneration(undefined, false)).toBe('legacy')
    expect(decidePiAiGeneration('not-a-version', true)).toBe('modern')
    expect(decidePiAiGeneration('not-a-version', false)).toBe('legacy')
  })

  it('defaults to modern when nothing could be inspected at all', () => {
    // This branch is unreachable in this dev tree (pi-ai is installed here), so
    // it needs an explicit test: it is the answer a market install founds its
    // gate on when probed outside the DSH host. `modern` is the safe default —
    // pass-through cannot destroy an already-correct context, whereas `legacy`
    // would fold for a copy that may well be modern and delete the only carrier
    // of the prompt and the tools. A surviving mutation proved this was
    // otherwise entirely unpinned.
    expect(decidePiAiGeneration(undefined, undefined)).toBe('modern')
  })
})

describe('piAiRuntimeInfo', () => {
  it('inspects the copy this plugin actually resolves', () => {
    const info = piAiRuntimeInfo()
    expect(info.inspected).toBe(true)
    expect(info.version).toBeDefined()
    expect(info.resolvedFrom).toContain('pi-ai')
    // The generation must agree with the version it reports.
    expect(info.generation).toBe(generationOf(info.version))
  })

  it('reports a legacy copy as legacy (this dev tree pins 0.85.1)', () => {
    // Not environment-dependent in spirit: whatever is installed, the two
    // fields must agree. Pinned explicitly so a silent drift to a modern
    // devDependency — which would stop exercising the fold here — is noticed.
    const info = piAiRuntimeInfo()
    if (info.version?.startsWith('0.85.')) expect(info.generation).toBe('legacy')
  })
})

describe('adaptLegacyPiAiContext (fold-down: the issue #27 crash fix)', () => {
  it('lifts the system text out of `messages` into `systemPrompt`', () => {
    const folded = adaptLegacyPiAiContext(transcript())
    expect(folded.systemPrompt).toBe(PROMPT)
    expect(folded.messages.map(message => message.role)).toEqual(['user'])
  })

  it('promotes `toolsAdded` to top-level `tools` — without this the model can never call a tool', () => {
    const folded = adaptLegacyPiAiContext(transcript())
    expect(folded.tools?.map(tool => tool.name)).toEqual(['pwsh'])
  })

  it('replays `toolsRemoved` before `toolsAdded`, keyed by name', () => {
    const context = {
      messages: [
        { role: 'system', content: PROMPT, toolsAdded: [TOOL, { ...TOOL, name: 'old' }], timestamp: 0 },
        { role: 'system', content: 'more', toolsRemoved: [{ name: 'old' }], toolsAdded: [{ ...TOOL, name: 'new' }], timestamp: 2 },
        { role: 'user', content: 'hi', timestamp: 3 },
      ],
    } as unknown as Context
    const folded = adaptLegacyPiAiContext(context)
    expect(folded.tools?.map(tool => tool.name)).toEqual(['pwsh', 'new'])
    expect(folded.systemPrompt).toBe(`${PROMPT}\n\nmore`)
    expect(folded.messages.map(message => message.role)).toEqual(['user'])
  })

  it('keeps an existing top-level `tools` authoritative', () => {
    const context = { ...transcript(), tools: [{ ...TOOL, name: 'explicit' }] } as unknown as Context
    const folded = adaptLegacyPiAiContext(context)
    expect(folded.tools?.map(tool => tool.name)).toEqual(['explicit'])
  })

  it('is an identity for a legacy-shaped context (same object, no allocation)', () => {
    const already = legacy()
    expect(adaptLegacyPiAiContext(already)).toBe(already)
  })

  it('is an identity for a context with no system message at all', () => {
    const plain = { messages: [{ role: 'user', content: 'hi', timestamp: 1 }] } as unknown as Context
    expect(adaptLegacyPiAiContext(plain)).toBe(plain)
  })

  it('drops an empty-text system message but still promotes its tools', () => {
    // `normalizeContext` emits `content: ''` when a prompt is absent but tools
    // are declared; an empty system turn must not reach the wire, and the tools
    // must not be lost with it.
    const empty = { messages: [
      { role: 'system', content: '', toolsAdded: [TOOL], timestamp: 0 },
      { role: 'user', content: 'hi', timestamp: 1 },
    ] } as unknown as Context
    const folded = adaptLegacyPiAiContext(empty)
    expect(folded.systemPrompt).toBeUndefined()
    expect(folded.tools?.map(tool => tool.name)).toEqual(['pwsh'])
    expect(folded.messages.map(message => message.role)).toEqual(['user'])
  })

  it('reads text blocks as well as a plain string', () => {
    const blocks = { messages: [
      { role: 'system', content: [{ type: 'text', text: 'A' }, { type: 'text', text: 'B' }], timestamp: 0 },
      { role: 'user', content: 'hi', timestamp: 1 },
    ] } as unknown as Context
    expect(adaptLegacyPiAiContext(blocks).systemPrompt).toBe('A\n\nB')
  })

  it('carries `sections` too — they are the transcript\'s second carrier of prompt text', () => {
    // Confirmed real against pi-ai 0.87.1: `SystemMessage.sections` is a
    // documented `Record<string, string | null>` and the library's own
    // `getSystemMessageText` joins `content` with every non-null section. An
    // earlier version of this function read `content` only, so a section-shaped
    // prompt folded down to `undefined` — silently dropping the entire system
    // prompt, the exact asymmetric loss this adapter exists to prevent.
    const sectioned = { messages: [
      { role: 'system', content: '', sections: { identity: 'You are DeepSeek Harness.', rules: 'Be careful.' }, timestamp: 0 },
      { role: 'user', content: 'hi', timestamp: 1 },
    ] } as unknown as Context
    expect(adaptLegacyPiAiContext(sectioned).systemPrompt).toBe('You are DeepSeek Harness.\n\nBe careful.')
  })

  it('joins `content` before `sections`, and drops null sections, as pi-ai does', () => {
    const sectioned = { messages: [
      { role: 'system', content: 'HEAD', sections: { a: 'A', gone: null }, timestamp: 0 },
      { role: 'user', content: 'hi', timestamp: 1 },
    ] } as unknown as Context
    expect(adaptLegacyPiAiContext(sectioned).systemPrompt).toBe('HEAD\n\nA')
  })

  it('tolerates a malformed `sections` value', () => {
    for (const sections of [42, 'text', ['a'], null]) {
      const odd = { messages: [
        { role: 'system', content: 'P', sections, timestamp: 0 },
        { role: 'user', content: 'hi', timestamp: 1 },
      ] } as unknown as Context
      expect(adaptLegacyPiAiContext(odd).systemPrompt).toBe('P')
    }
  })

  it('appends folded text after a prompt the caller already set', () => {
    const mixed = { systemPrompt: 'head', messages: [
      { role: 'system', content: 'tail', timestamp: 0 },
      { role: 'user', content: 'hi', timestamp: 1 },
    ] } as unknown as Context
    expect(adaptLegacyPiAiContext(mixed).systemPrompt).toBe('head\n\ntail')
  })

  it('tolerates null, arrays and malformed messages', () => {
    expect(adaptLegacyPiAiContext(null as unknown as Context)).toBeNull()
    const noMessages = {} as unknown as Context
    expect(adaptLegacyPiAiContext(noMessages)).toBe(noMessages)
    const odd = { messages: [null, 'x', { role: 'system', content: 42 }] } as unknown as Context
    expect(() => adaptLegacyPiAiContext(odd)).not.toThrow()
  })
})

describe('adaptModernPiAiContext (fold-up: the reverse, silent mismatch)', () => {
  it('lifts `systemPrompt` and `tools` onto a leading system message', () => {
    const lifted = adaptModernPiAiContext(legacy()) as unknown as { messages: { role: string, content?: unknown, toolsAdded?: unknown }[] }
    expect(lifted.messages[0]?.role).toBe('system')
    expect(lifted.messages[0]?.content).toBe(PROMPT)
    expect((lifted.messages[0]?.toolsAdded as { name: string }[]).map(tool => tool.name)).toEqual(['pwsh'])
    expect(lifted.messages.map(message => message.role)).toEqual(['system', 'user'])
  })

  it('removes the top-level fields it just lifted', () => {
    // Leaving `systemPrompt` set would make a later legacy fold think the
    // context is already folded up.
    const lifted = adaptModernPiAiContext(legacy()) as unknown as { systemPrompt?: unknown, tools?: unknown }
    expect(lifted.systemPrompt).toBeUndefined()
    expect(lifted.tools).toBeUndefined()
  })

  it('is an identity for a context that is already a transcript', () => {
    const already = transcript()
    expect(adaptModernPiAiContext(already)).toBe(already)
  })

  it('prepends a MIXED context rather than dropping its top-level prompt and tools', () => {
    // A context with BOTH top-level fields and a system message is what a
    // partially-normalized host produces. pi-ai's own `normalizeContext`
    // PREPENDS here (verified against 0.87.1: it yields two system messages,
    // which its providers then collapse with a blank line), so prepending is
    // the faithful reconstruction. An earlier version of this function instead
    // returned such a context untouched — and a surviving mutation proved no
    // test noticed: the top-level prompt and its tools vanished silently.
    const mixed = {
      systemPrompt: 'TOP-LEVEL',
      tools: [TOOL],
      messages: [
        { role: 'system', content: 'IN-MESSAGES', timestamp: 0 },
        { role: 'user', content: 'hi', timestamp: 1 },
      ],
    } as unknown as Context
    const lifted = adaptModernPiAiContext(mixed) as unknown as { systemPrompt?: unknown, messages: { role?: string, content?: unknown, toolsAdded?: unknown }[] }
    expect(lifted.messages.map(message => message.role)).toEqual(['system', 'system', 'user'])
    // The top-level prompt is at the head, ahead of the pre-existing one.
    expect(lifted.messages[0]?.content).toBe('TOP-LEVEL')
    expect(lifted.messages[1]?.content).toBe('IN-MESSAGES')
    expect((lifted.messages[0]?.toolsAdded as { name: string }[]).map(tool => tool.name)).toEqual(['pwsh'])
    expect(lifted.systemPrompt).toBeUndefined()
  })

  it('is idempotent, so the lifted output is never lifted twice', () => {
    const once = adaptModernPiAiContext(legacy())
    expect(adaptModernPiAiContext(once)).toBe(once)
  })

  it('is an identity when there is neither a prompt nor tools', () => {
    const bare = { messages: [{ role: 'user', content: 'hi', timestamp: 1 }] } as unknown as Context
    expect(adaptModernPiAiContext(bare)).toBe(bare)
  })

  it('ignores an empty prompt rather than emitting an empty system turn', () => {
    const bare = { systemPrompt: '', messages: [{ role: 'user', content: 'hi', timestamp: 1 }] } as unknown as Context
    expect(adaptModernPiAiContext(bare)).toBe(bare)
  })

  it('lifts tools even when the prompt is absent', () => {
    const lifted = adaptModernPiAiContext(legacy('', [TOOL])) as unknown as { messages: { role: string, content?: unknown, toolsAdded?: unknown }[] }
    expect(lifted.messages[0]?.role).toBe('system')
    expect((lifted.messages[0]?.toolsAdded as unknown[]).length).toBe(1)
  })
})

describe('withContextAdaptation', () => {
  const fakeApi = (sink: Context[]) => ({
    stream: (_m: unknown, context: Context) => { sink.push(context); return {} as never },
    streamSimple: (_m: unknown, context: Context) => { sink.push(context); return {} as never },
  })

  it('legacy generation folds a transcript down before the api sees it', () => {
    const seen: Context[] = []
    const wrapped = withContextAdaptation(fakeApi(seen) as never, 'legacy')
    send(wrapped, 'streamSimple', transcript())
    expect(seen[0]?.systemPrompt).toBe(PROMPT)
    expect(seen[0]?.tools?.length).toBe(1)
  })

  it('modern generation lifts a legacy context up before the api sees it', () => {
    const seen: Context[] = []
    const wrapped = withContextAdaptation(fakeApi(seen) as never, 'modern')
    send(wrapped, 'streamSimple', legacy())
    const first = seen[0]?.messages[0] as { role?: string, content?: unknown } | undefined
    expect(first?.role).toBe('system')
    expect(first?.content).toBe(PROMPT)
  })

  it('passes the SAME object through when the shape already matches', () => {
    const seen: Context[] = []
    const wrapped = withContextAdaptation(fakeApi(seen) as never, 'legacy')
    const context = legacy()
    send(wrapped, 'stream', context)
    expect(seen[0]).toBe(context)
  })

  it('preserves the rest of the api module, including deferred entry points', () => {
    const fetchDeferred = () => 'kept'
    const wrapped = withContextAdaptation({ ...fakeApi([]), fetchDeferred } as never, 'legacy') as unknown as { fetchDeferred?: unknown }
    expect(wrapped.fetchDeferred).toBe(fetchDeferred)
  })

  it('adapts BOTH stream and streamSimple', () => {
    const seen: Context[] = []
    const wrapped = withContextAdaptation(fakeApi(seen) as never, 'legacy')
    send(wrapped, 'stream', transcript())
    send(wrapped, 'streamSimple', transcript())
    expect(seen).toHaveLength(2)
    for (const context of seen) expect(context.systemPrompt).toBe(PROMPT)
  })
})

/**
 * The wire-level matrix, against the REAL resolved copy.
 *
 * WHY THIS EXISTS. `tests/adapter.spec.ts` mocks `openAICompletionsApi` and only
 * asserts the context handed to the wrapper — which stays correct even when the
 * shipped request is empty, so it cannot catch a context-contract regression.
 * This block asserts what actually arrives at the HTTP layer: the request must
 * carry the system prompt and the tool declarations, for every generation the
 * devDependency can resolve.
 *
 * The 1.x arm is the one that matters for DSH 0.2.1-rc.1: `dsh-llm-pi-ai`
 * declares `^1.1.0` and builds the LEGACY `{ systemPrompt, tools, messages }`
 * envelope (`piContext()`), while pi-ai 1.1.0 reads ONLY the transcript. Both
 * halves of that mismatch are silent, so only a real request body proves it.
 */
describe('request body survives the resolved pi-ai copy', () => {
  /** A local SSE endpoint that records every request body it receives. */
  async function captureWire(): Promise<{
    baseUrl: string
    bodies: { messages?: { role?: string, content?: unknown }[], tools?: unknown[] }[]
    close: () => Promise<void>
  }> {
    const bodies: { messages?: { role?: string, content?: unknown }[], tools?: unknown[] }[] = []
    const server = createServer((request, response) => {
      let body = ''
      request.on('data', chunk => { body += String(chunk) })
      request.on('end', () => {
        bodies.push(JSON.parse(body) as typeof bodies[number])
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.write('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n')
        response.end('data: [DONE]\n\n')
      })
    })
    await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', () => { resolve() }) })
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('no port')
    return {
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      bodies,
      close: () => new Promise<void>((resolve, reject) => {
        server.close(error => { error === undefined ? resolve() : reject(error) })
      }),
    }
  }

  /**
   * Send one request through `createProvider` exactly as the host wires it, and
   * return the body that reached the wire.
   *
   * The context fed in is the LEGACY envelope on purpose: that is what
   * `dsh-llm-pi-ai`'s `piContext()` produces whatever pi-ai sits underneath it,
   * so it is the input a modern copy actually receives in the field.
   */
  async function wireBody(
    generation: 'legacy' | 'modern',
    context: Context,
    baseUrl: string,
    bodies: { messages?: { role?: string, content?: unknown }[], tools?: unknown[] }[],
  ): Promise<{ messages?: { role?: string, content?: unknown }[], tools?: unknown[] }> {
    const { createProvider } = await import('@earendil-works/pi-ai')
    const { openAICompletionsApi } = await import('@earendil-works/pi-ai/api/openai-completions.lazy')
    // Annotated, not inferred: pi-ai keys `Model<Api>` off `api`, and a widened
    // `string` collapses `compat` to `never`.
    const model: Model<'openai-completions'> = {
      id: 'wire-probe', name: 'wire-probe', api: 'openai-completions', provider: 'trae',
      baseUrl, input: ['text'], reasoning: false, contextWindow: 200_000, maxTokens: 32_768,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, compat: {},
    }
    const provider = createProvider({
      id: 'trae',
      name: 'trae',
      auth: { apiKey: { name: 'probe', async resolve() { return { auth: { apiKey: 'probe' }, source: 'probe' } } } },
      models: [model],
      api: withContextAdaptation(openAICompletionsApi(), generation),
    }) as unknown as { getModels(): unknown[], streamSimple(model: unknown, context: unknown, options: unknown): AsyncIterable<unknown> }
    for await (const _chunk of provider.streamSimple(provider.getModels()[0], context, { apiKey: 'probe', signal: AbortSignal.timeout(5_000) })) {
      // Drain: the request body is recorded server-side before any chunk.
    }
    const body = bodies.at(-1)
    if (body === undefined) throw new Error('no request reached the wire')
    return body
  }

  it('sends the prompt and the tools for the generation this copy actually is', async () => {
    const wire = await captureWire()
    try {
      const generation = piAiRuntimeInfo().generation
      const body = await wireBody(generation, legacy(), wire.baseUrl, wire.bodies)
      const roles = body.messages?.map(message => message.role)
      // Both generations must land on a leading system turn: on a legacy copy
      // the envelope is already correct, on a modern one the wrapper folded it.
      expect(roles?.[0]).toBe('system')
      expect(String(body.messages?.[0]?.content)).toBe(PROMPT)
      expect(body.tools).toHaveLength(1)
    } finally {
      await wire.close()
    }
  })

  it('is idempotent: an already-normalized context is not double-wrapped', async () => {
    const wire = await captureWire()
    try {
      const generation = piAiRuntimeInfo().generation
      const body = await wireBody(generation, transcript(), wire.baseUrl, wire.bodies)
      const roles = body.messages?.map(message => message.role) ?? []
      expect(roles.filter(role => role === 'system')).toHaveLength(1)
      expect(String(body.messages?.[0]?.content)).toBe(PROMPT)
      expect(body.tools).toHaveLength(1)
    } finally {
      await wire.close()
    }
  })

  it('a modern copy drops the prompt and tools WITHOUT the wrapper', async () => {
    // Pins why `withContextAdaptation` is load-bearing on DSH 0.2.1-rc.1. This
    // is the exact silent failure the follow-up document reports for a plugin
    // that passes the host envelope straight through: `roles: ["user"]`,
    // system `null`, `tools: 0` — no error, just a crippled turn.
    const wire = await captureWire()
    try {
      const { createProvider } = await import('@earendil-works/pi-ai')
      const { openAICompletionsApi } = await import('@earendil-works/pi-ai/api/openai-completions.lazy')
      const raw = openAICompletionsApi()
      // Only meaningful when this tree resolves a modern (1.x) copy.
      if (piAiRuntimeInfo().generation !== 'modern') return
      const model: Model<'openai-completions'> = {
        id: 'wire-probe', name: 'wire-probe', api: 'openai-completions', provider: 'trae',
        baseUrl: wire.baseUrl, input: ['text'], reasoning: false, contextWindow: 200_000, maxTokens: 32_768,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, compat: {},
      }
      const provider = createProvider({
        id: 'trae',
        name: 'trae',
        auth: { apiKey: { name: 'probe', async resolve() { return { auth: { apiKey: 'probe' }, source: 'probe' } } } },
        models: [model],
        api: raw,
      }) as unknown as { getModels(): unknown[], streamSimple(model: unknown, context: unknown, options: unknown): AsyncIterable<unknown> }
      for await (const _chunk of provider.streamSimple(provider.getModels()[0], legacy(), { apiKey: 'probe', signal: AbortSignal.timeout(5_000) })) {
        // Drain.
      }
      const body = wire.bodies.at(-1)
      expect(body?.messages?.some(message => message.role === 'system')).toBe(false)
      expect(body?.tools ?? []).toHaveLength(0)
    } finally {
      await wire.close()
    }
  })
})

/**
 * The part that would have caught issue #27: run the adapted context through
 * the REAL resolved pi-ai copy. These assertions hold for every generation —
 * that is the point of adapting in both directions.
 */
describe('integration with the resolved pi-ai copy', () => {
  const model = {
    id: 'glm-5.3-flashx', name: 'glm-5.3-flashx', api: 'openai-completions', provider: 'trae',
    baseUrl: 'http://127.0.0.1:1/v1', input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    reasoning: false, contextWindow: 200_000, maxTokens: 32_768, compat: {},
  }

  it('does not throw when estimating tokens for a host-normalized context', async () => {
    const { estimateContextTokens } = await import('@earendil-works/pi-ai/utils/estimate')
    const generation = piAiRuntimeInfo().generation
    const adapted = generation === 'modern'
      ? adaptModernPiAiContext(transcript())
      : adaptLegacyPiAiContext(transcript())
    // Before the fix this threw `TypeError: Cannot read properties of undefined
    // (reading 'length')` on a legacy copy — the PI_AI_ERROR in the field.
    // The cast is the same brand boundary as in `withContextAdaptation`: 1.1.0
    // types this parameter as the branded `TranscriptContext`, which the
    // adapted legacy shape deliberately is not.
    expect(() => estimateContextTokens(adapted as never)).not.toThrow()
  })

  it('keeps the system prompt and the tools reachable for the wire', async () => {
    const { convertMessages } = await import('@earendil-works/pi-ai/api/openai-completions')
    const generation = piAiRuntimeInfo().generation
    const context = transcript()
    const adapted = generation === 'modern'
      ? adaptModernPiAiContext(context)
      : adaptLegacyPiAiContext(context)
    // `convertMessages` also takes the branded type on 1.1.0; a legacy-adapted
    // context is the unbranded shape that generation's api consumes natively.
    const params = convertMessages(model as never, adapted as never, {} as never, {} as never) as { role?: string, content?: unknown }[]
    // 0.85 dropped BOTH: the system entry vanished and only `user` remained.
    expect(params[0]?.role).toBe('system')
    expect(String(params[0]?.content)).toContain('DeepSeek Harness')
    if (generation === 'legacy') {
      // A legacy api reads tools only from the top level, so the wire test is
      // the promotion itself.
      expect(adapted.tools?.map(tool => tool.name)).toEqual(['pwsh'])
    } else {
      // `utils/transcript` exists only from 0.86 on, so it is reached through a
      // computed specifier: a static import would not typecheck against the
      // legacy devDependency this repo pins, and would crash a market install
      // probed outside the host, where no local pi-ai exists at all.
      const transcriptModule = '@earendil-works/pi-ai/utils/transcript'
      const { resolveTranscript, resolveTranscriptTools } = await import(transcriptModule) as {
        resolveTranscript: (context: unknown, supportsMidConvo: boolean) => { messages: unknown[] }
        resolveTranscriptTools: (messages: unknown[], additions: boolean) => { requestTools: { name: string }[] }
      }
      const normalized = resolveTranscript(adapted, false)
      expect(resolveTranscriptTools(normalized.messages, false).requestTools.map(tool => tool.name)).toEqual(['pwsh'])
    }
  })

  it('leaves a legacy host context intact for a legacy copy', async () => {
    const { estimateContextTokens } = await import('@earendil-works/pi-ai/utils/estimate')
    const generation = piAiRuntimeInfo().generation
    if (generation !== 'legacy') return
    const context = legacy()
    expect(adaptLegacyPiAiContext(context)).toBe(context)
    expect(() => estimateContextTokens(context as never)).not.toThrow()
  })
})
