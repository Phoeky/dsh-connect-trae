/**
 * The one-click availability test.
 *
 * The classification rules matter more than the plumbing: this feature's failure
 * mode is telling a user a working model is dead. Trae throttles, proxies drop
 * requests, and a 200 body can still carry a refusal — so the tests below pin
 * every branch where an INCONCLUSIVE answer must stay `unknown` rather than
 * becoming a negative verdict.
 */
import { describe, expect, it, vi } from 'vitest'
import { classifyProbeResult, probeBody, probeModelsSequentially, probeOneModel, TRAE_PROBE_TIMEOUT_MS } from '../src/model-probe.ts'
import type { TraeChatResult } from '../src/upstream.ts'

/**
 * What `TraeSoloBridge` hands back: an OpenAI-shaped chunk stream, NOT Trae's
 * own events. The probe reads this side of the bridge, so the fixtures must
 * speak the same shape the production path does.
 */
function bridgedResponse(content = 'pong'): Response {
  return new Response(`data: {"choices":[{"index":0,"delta":{"content":"${content}"},"finish_reason":null}]}\n\ndata: [DONE]\n\n`, {
    headers: { 'content-type': 'text/event-stream' },
  })
}

describe('classifyProbeResult', () => {
  it('reports an answer with output as available', () => {
    expect(classifyProbeResult({ ok: true, response: new Response('') }, true))
      .toEqual({ verdict: 'available', detail: 'upstream answered' })
  })

  it('treats a stream that carried no output as inconclusive, not unavailable', () => {
    const classified = classifyProbeResult({ ok: true, response: new Response('') }, false)
    expect(classified.verdict).toBe('unknown')
    expect(classified.detail).toContain('without any output')
  })

  it('reads the subscription gate back out of the translated message', () => {
    // What the bridge produces for an in-stream 1005: a 402 hard_credit whose
    // message names the code.
    const classified = classifyProbeResult({
      ok: false, status: 402, kind: 'hard_credit',
      message: "Trae requires a paid plan for this model; the current account's plan does not cover it · plan 4 · Trae code 1005",
    }, false)
    expect(classified.verdict).toBe('gated')
    expect(classified.detail).toContain('plan 4')
  })

  it('reads 4001 as "this channel does not serve it" — the only code that may say so', () => {
    const classified = classifyProbeResult({
      ok: false, status: 400, kind: 'client',
      message: 'Trae does not serve this model under the SOLO function the request used (config_name rejected) · Trae code 4001',
    }, false)
    expect(classified.verdict).toBe('unsupported')
  })

  it('reports 4011 as throttled, never as a model the channel does not serve (issue #33)', () => {
    // Issue #33: 4011 is Trae's rate limit (its own text says so). Reporting it
    // as `unsupported` told the user a working model was dead — the exact
    // "turn an inconclusive answer into unavailable" failure this module's
    // header forbids.
    const classified = classifyProbeResult({
      ok: false, status: 429, kind: 'soft_rate',
      message: 'Trae throttled the SOLO channel for this account (a rate limit, not the credit balance) · Trae code 4011 · upstream: exceeded the rate limit',
    }, false)
    expect(classified.verdict).toBe('rate_limited')
  })

  it('still reads a bare 4011 code out of a message that arrives without a 429 status', () => {
    const classified = classifyProbeResult({
      ok: false, status: 0, kind: 'client',
      message: 'Trae throttled the SOLO channel for this account · Trae code 4011',
    }, false)
    expect(classified.verdict).toBe('rate_limited')
  })

  it('keeps an exhausted account quota (4008) inconclusive about the model', () => {
    const classified = classifyProbeResult({
      ok: false, status: 400, kind: 'client',
      message: "Trae reports the account's SOLO quota is exhausted for this request · Trae code 4008 · upstream: Your requests have exceeded the quota.",
    }, false)
    expect(classified.verdict).toBe('unknown')
    expect(classified.detail).toContain('4008')
  })

  it('treats an unauthenticated answer as an auth stop, not a dead model', () => {
    const classified = classifyProbeResult({ ok: false, status: 401, kind: 'authentication', message: 'token rejected' }, false)
    expect(classified.verdict).toBe('auth')
  })

  it('separates throttling from a refusal', () => {
    expect(classifyProbeResult({ ok: false, status: 429, kind: 'soft_rate', message: 'slow down' }, false).verdict).toBe('rate_limited')
  })

  it('never turns a transport failure or a server fault into a negative verdict', () => {
    // status 0 is the transport/timeout signal the client reports.
    expect(classifyProbeResult({ ok: false, status: 0, kind: 'server', message: 'transport error: socket hang up' }, false).verdict).toBe('unknown')
    expect(classifyProbeResult({ ok: false, status: 500, kind: 'server', message: 'HTTP 500' }, false).verdict).toBe('unknown')
  })

  it('treats an unnamed 4xx client refusal as unsupported', () => {
    // One that arrives without a code label is still a request refusal, not an
    // unknown.
    expect(classifyProbeResult({ ok: false, status: 400, kind: 'client', message: 'bad request' }, false).verdict).toBe('unsupported')
  })

  it('gives each recognised code exactly one verdict, whatever order it is read in', () => {
    // Issue #33 hardened this: when the codes lived in one Set per verdict, a
    // code present in two sets was decided by which branch happened to run
    // first, so re-adding 4011 to the "unsupported" set was undetectable. The
    // table must therefore agree with itself for every code it knows.
    const expectations: [number, string][] = [
      [1005, 'gated'],
      [4001, 'unsupported'],
      [4008, 'unknown'],
      [4011, 'rate_limited'],
    ]
    for (const [code, verdict] of expectations) {
      // The bare message is what the probe sees when the bridge translated it;
      // a 400 status here is the ordering trap — the code, not the status, must
      // decide the verdict.
      const bare = classifyProbeResult({
        ok: false, status: 400, kind: 'client', message: `Trae refused the request · Trae code ${String(code)}`,
      }, false)
      expect([code, bare.verdict]).toEqual([code, verdict])
    }
  })

  it('keeps 4001 and 4011 apart under a status that would mask the difference', () => {
    // Both arrive as an in-band `event: error` translated by the bridge; the
    // point of the fix is that 400 is NOT enough to call a model unsupported.
    const asUnsupported = classifyProbeResult({
      ok: false, status: 400, kind: 'client', message: 'Trae does not serve this model · Trae code 4001',
    }, false)
    const asThrottled = classifyProbeResult({
      ok: false, status: 400, kind: 'client', message: 'Trae throttled the SOLO channel · Trae code 4011',
    }, false)
    expect(asUnsupported.verdict).toBe('unsupported')
    expect(asThrottled.verdict).toBe('rate_limited')
  })
})

describe('probeOneModel', () => {
  it('sends a minimal one-word prompt and no tools', () => {
    const body = JSON.parse(probeBody('glm-5.2')) as Record<string, unknown>
    // The default probe is still the one-word request: padding spends credit and
    // must be an explicit choice.
    expect(body['model']).toBe('glm-5.2')
    expect(body['messages']).toEqual([{ role: 'user', content: 'ping' }])
    expect(body).not.toHaveProperty('tools')
    expect(JSON.stringify(body).length).toBeLessThan(200)
  })

  it('pads the probe to the requested size and caps it', () => {
    const contentOf = (tokens: number): string => {
      const body = JSON.parse(probeBody('glm-5.2', tokens)) as { messages: { content: string }[] }
      return body.messages[0]?.content ?? ''
    }
    // Roughly one token per `x`, so 2k tokens is ~4k characters of padding.
    const padded = contentOf(2_000)
    expect(padded.length).toBeGreaterThan(3_900)
    expect(padded.length).toBeLessThan(4_200)
    // A hand-edited config cannot turn one click into a multi-megabyte upload.
    expect(contentOf(10_000_000).length).toBeLessThan(210_000)
    // Junk degrades to the minimal probe instead of throwing.
    expect(contentOf(Number.NaN)).toBe('ping')
    expect(contentOf(-5)).toBe('ping')
    // Padding never changes the model or adds tools: it is the same call, bigger.
    const body = JSON.parse(probeBody('glm-5.2', 1_000)) as Record<string, unknown>
    expect(body['model']).toBe('glm-5.2')
    expect(body).not.toHaveProperty('tools')
  })

  it('records the model id alongside the verdict', async () => {
    const chat = vi.fn(async () => ({ ok: true, response: bridgedResponse() }) as TraeChatResult)
    await expect(probeOneModel(chat, 'glm-5.2')).resolves.toEqual({
      id: 'glm-5.2', verdict: 'available', detail: 'upstream answered',
    })
  })

  it('classifies a refusal carried inside a 200 body', async () => {
    const chat = async (): Promise<TraeChatResult> => ({
      ok: false, status: 402, kind: 'hard_credit', message: "needs a paid plan · Trae code 1005",
    })
    await expect(probeOneModel(chat, 'gpt-6-astra')).resolves.toMatchObject({ id: 'gpt-6-astra', verdict: 'gated' })
  })

  it('classifies a mid-stream refusal thrown by the bridge, without calling it unknown', async () => {
    // The bridge errors the stream (rather than returning a result) when the
    // refusal arrives after output started; its message still names the code.
    // A 4001 there is the model genuinely not being served — a real refusal,
    // so the verdict is a negative one rather than `unknown`.
    const chat = async (): Promise<TraeChatResult> => ({ ok: true, response: new Response('') })
    const poisoned = new Response(new ReadableStream({
      start(controller) { controller.error(new Error('Trae does not serve this model under the SOLO function the request used (config_name rejected) · Trae code 4001')) },
    }))
    const streamChat = async (): Promise<TraeChatResult> => ({ ok: true, response: poisoned })
    expect((await probeOneModel(streamChat, 'gpt-5.6-sol')).verdict).toBe('unsupported')
    expect(chat).toBeDefined()
  })

  it('classifies a mid-stream 4011 throttle as throttled, not as a dead model', async () => {
    const poisoned = new Response(new ReadableStream({
      start(controller) { controller.error(new Error('Trae throttled the SOLO channel for this account (a rate limit, not the credit balance) · Trae code 4011')) },
    }))
    const streamChat = async (): Promise<TraeChatResult> => ({ ok: true, response: poisoned })
    expect((await probeOneModel(streamChat, 'glm-5.3')).verdict).toBe('rate_limited')
  })

  it('reports a timeout as unknown, never as unavailable', async () => {
    const chat = (_body: string, signal?: AbortSignal): Promise<TraeChatResult> => new Promise((_resolve, reject) => {
      signal?.addEventListener('abort', () => { reject(new Error('aborted')) })
    })
    const result = await probeOneModel(chat, 'glm-5.2', 20)
    expect(result.verdict).toBe('unknown')
    expect(result.detail).toContain('no answer within')
  })

  it('defaults its timeout to the exported budget', () => {
    expect(TRAE_PROBE_TIMEOUT_MS).toBeGreaterThan(5_000)
  })
})

describe('probeModelsSequentially', () => {
  it('runs one model at a time, in order, reporting each as it lands', async () => {
    const order: string[] = []
    const chat = async (body: string): Promise<TraeChatResult> => {
      const model = (JSON.parse(body) as { model: string }).model
      order.push(model)
      return { ok: true, response: bridgedResponse() }
    }
    const seen: string[] = []
    const results = await probeModelsSequentially(chat, ['a', 'b', 'c'], result => { seen.push(result.id) })
    expect(order).toEqual(['a', 'b', 'c'])
    expect(seen).toEqual(['a', 'b', 'c'])
    expect(results).toHaveLength(3)
  })

  it('stops at the first authentication failure instead of spending every call', async () => {
    const chat = vi.fn(async (): Promise<TraeChatResult> => ({ ok: true, response: bridgedResponse('x') }))
    let calls = 0
    const authThenFail = async (): Promise<TraeChatResult> => {
      calls += 1
      return calls === 2
        ? { ok: false, status: 401, kind: 'authentication', message: 'token rejected' }
        : { ok: true, response: bridgedResponse('x') }
    }
    const results = await probeModelsSequentially(authThenFail, ['a', 'b', 'c', 'd'])
    expect(results.map(r => r.verdict)).toEqual(['available', 'auth'])
    expect(chat).toBeDefined()
  })
})
