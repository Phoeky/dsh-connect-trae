import type { TraeCredential } from './auth.ts'
import { parseTraeRemoteModel, type TraeDiscoveredModel } from './model-metadata.ts'
import { REGION_GATEWAYS, regionOfCredential, type TraeRegion } from './region.ts'
import { TRAE_DIRECTORY_FUNCTIONS } from './solo.ts'

export const TRAE_SOLO_REMOTE_BASE = 'https://solo.trae.cn/api/remote/v1'

/**
 * Remote-directory functions to ask for, per region.
 *
 * The remote `/models` answer is **grouped by function** and the groups are not
 * interchangeable (measured 2026-10-01, issue #19):
 *
 * ```
 * solo_agent        : 19 models   ← superset; also the ONLY source of
 *                                   gpt-6-astra / gpt-5.6-sol|terra|luna /
 *                                   glm-5.2 / gpt-5.5 / Seed-2.1-Turbo
 * solo_agent_remote : 10 models   ← what this client used to read, and all it
 *                                   read: the preferred group only
 * ```
 *
 * `solo_agent` ⊇ `solo_agent_remote`, so reading just the latter hid nine
 * models that the Trae IDE does show — exactly what the reporter saw. Both
 * groups are therefore requested, and every returned group is unioned.
 *
 * Asking for a function the gateway does not serve is harmless: unknown names
 * are ignored rather than rejected (`solo_work_remote` returns no group on
 * `ai`, and the request still answers HTTP 200).
 *
 * `chat_v3` was added on 2026-10-01 (issue #19 follow-up) because it carries
 * three ai-region models that appear in NO other group — `deepseek-v3.2`,
 * `gemini-3-flash-premium`, `gemini_2.5_flash_premium` — and those three are
 * callable through it (see TRAE_DIRECTORY_FUNCTIONS in solo.ts).
 *
 * Both regions now ask the SAME group list (2026-10-02). CN previously asked
 * only `solo_agent_remote` + `solo_work_remote`, which left its `solo_coder`
 * group (12 models) unread — the same shape of miss as the ai one. Every group
 * below was measured to exist on both gateways; a region that does not serve a
 * name simply returns no group for it, which the union tolerates. Reading costs
 * one query and the merge no longer discards rows for lacking a wire match (see
 * mergeTraeModelSources), so an unread group is a model silently missing from
 * the user's own list — the failure this list exists to prevent.
 *
 * `builder_v3` is included for the same reason even though neither region's
 * current wire lists name it: its rows are real directory entries, and whether
 * a paying account can call one is not something this client can determine.
 */
export const TRAE_REMOTE_DIRECTORY_FUNCTIONS: Readonly<Record<TraeRegion, readonly string[]>> = {
  cn: ['solo_agent', 'solo_agent_remote', 'solo_work_remote', 'solo_work_lite', 'chat_v3', 'solo_coder', 'builder_v3'],
  ai: ['solo_agent', 'solo_agent_remote', 'solo_work_remote', 'solo_work_lite', 'chat_v3', 'solo_coder', 'builder_v3'],
}

export interface TraeSoloRemoteCatalogOptions {
  credential(): Promise<TraeCredential>
  fetchImpl?: typeof fetch
  baseUrl?: string
  /**
   * Diagnostics sink (wired to `ctx.logger.warn` by the plugin). Called only
   * on the interesting path — when a NON-official host served the directory
   * or is reused as the remembered first candidate — never on the happy path
   * of official-host-first.
   */
  log?: (message: string, detail?: unknown) => void
}

/**
 * Backup bases for the model directory, in try order after the official base.
 *
 * In restricted (proxy-sandboxed) networks the official catalog host
 * `solo.trae.cn` is behind a CONNECT rejection while the region's chat gateway
 * stays reachable — and that gateway serves the SAME `/api/remote/v1/models`
 * endpoint with an identical response shape (verified against
 * `https://trae-api-cn.mchost.guru/api/remote/v1` 2026-10-20; `chat` already
 * carries `/api/remote/v1`'s parent in {@link REGION_GATEWAYS}). The backup is
 * therefore derived from the region's chat base, mirrored on the remote path;
 * `ai` shares a single host for chat and remote, so it yields no candidate and
 * keeps its single-host behavior. An explicit `baseUrl` disables the chain.
 */
export function traeSoloRemoteFallbackBases(region: TraeRegion, officialBase: string): string[] {
  const backupBase = `${REGION_GATEWAYS[region].chat}/api/remote/v1`
  return backupBase === officialBase ? [] : [backupBase]
}

/**
 * Of two rows for the SAME model id, the one that advertises the stronger
 * capacity (issue #23).
 *
 * The gateway groups its directory by function and reports a model's capacity
 * per group, with the group order varying between calls. Keeping the strongest
 * row makes the published window deterministic. The comparison is
 * LEXICOGRAPHIC and must be applied all the way down, or ordering leaks back in
 * at the next field:
 *
 *  1. a row with a Max tier beats one without (`maxContextWindow` is only set
 *     when the group reported `max_mode: true` with a positive max);
 *  2. two Max rows: the larger max wins;
 *  3. max equal (or absent on both): the WIDER dev window wins;
 *  4. both equal: keep the incumbent, so the model order stays the gateway's.
 *
 * Step 3 is not an afterthought. With equal `max` the first version of this
 * function stopped and kept the incumbent, which left the dev window decided by
 * arrival order — measured 2026-10-05: `glm-5.2` came back as `dev=116000` when
 * `chat_v3` won and `dev=200000` when `solo_agent_remote` did, both with
 * `max=1000000` (9 of 30 CN models behaved that way, reported by JiewiW on
 * Windows). A budgeted model still resolved to 1M either way, but the DEFAULT
 * window of an unbudgeted model — what DSH shows and compresses against — was
 * a coin flip, which is the same defect this function exists to remove.
 */
export function preferStrongerRow(
  candidate: TraeDiscoveredModel,
  incumbent: TraeDiscoveredModel | undefined,
): TraeDiscoveredModel {
  if (incumbent === undefined) return candidate
  const candidateMax = candidate.maxContextWindow
  const incumbentMax = incumbent.maxContextWindow
  if (candidateMax !== undefined && incumbentMax === undefined) return candidate
  if (candidateMax === undefined && incumbentMax !== undefined) return incumbent
  if (candidateMax !== undefined && incumbentMax !== undefined && candidateMax !== incumbentMax) {
    return candidateMax > incumbentMax ? candidate : incumbent
  }
  // Equal Max (or neither advertises one): the wider dev window wins.
  return (candidate.contextWindow ?? 0) > (incumbent.contextWindow ?? 0) ? candidate : incumbent
}

/**
 * Region-scoped request dressing. The CN portal is `solo.trae.cn` with the
 * CN locale headers; the international directory lives on the shared
 * `coresg-normal.trae.ai` gateway and was verified (2026-09-15) with the
 * English/Singapore headers — both forms are accepted, each region keeps the
 * shape its own portal sends.
 */
function remoteDressing(region: TraeRegion): { referer: string; timezone: string; language: string } {
  return region === 'ai'
    ? { referer: 'https://coresg-normal.trae.ai/', timezone: 'Asia/Singapore', language: 'en' }
    : { referer: 'https://solo.trae.cn/', timezone: 'Asia/Shanghai', language: 'zh-cn' }
}

/**
 * Read-only model catalog client for the SOLO Web API.
 *
 * This deliberately has no chat/session method: the Remote session protocol
 * only exposes a final answer and cannot preserve DSH's structured tool loop.
 */
export class TraeSoloRemoteCatalogClient {
  private readonly fetchImpl: typeof fetch
  private readonly baseUrl: string | undefined
  /**
   * The last base that answered the directory in this process. A proxy-blocked
   * network pays the failing official attempt on EVERY refresh otherwise; once
   * a backup has served the catalog it is tried first on later refreshes, with
   * the official base kept as the second candidate so it is re-attempted every
   * refresh (and takes over again the moment the network heals).
   */
  private lastSuccessfulBase: string | undefined

  constructor(private readonly options: TraeSoloRemoteCatalogOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch
    this.baseUrl = options.baseUrl
  }

  private async headers(region: TraeRegion): Promise<Record<string, string>> {
    const credential = await this.options.credential()
    const dressing = remoteDressing(region)
    return {
      'Authorization': `Cloud-IDE-JWT ${credential.accessToken}`,
      'Content-Type': 'application/json',
      'x-trae-client-type': 'web',
      'x-trae-user-timezone': dressing.timezone,
      'x-preferenced-language': dressing.language,
      'Referer': dressing.referer,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    }
  }

  async fetchModels(signal?: AbortSignal): Promise<TraeDiscoveredModel[]> {
    // The directory gateway follows the credential's own region; an explicit
    // baseUrl (tests, diagnostics) still pins the endpoint.
    const credential = await this.options.credential()
    const region = regionOfCredential(credential)
    const officialBase = this.baseUrl ?? REGION_GATEWAYS[region].remote
    const headers = await this.headers(region)
    const functions = TRAE_REMOTE_DIRECTORY_FUNCTIONS[region].join(',')
    // Try the bases in order. The default is official-first; a blocked network
    // (proxy CONNECT rejection of solo.trae.cn) falls through to the chat
    // gateway's mirrored /api/remote/v1 base. Fallback happens ONLY when the
    // attempt failed to connect or answered 5xx — a 401/403/404/429 is a
    // semantic verdict of the host being tried (token problem, proxy policy,
    // missing route) and must not be re-issued against another base. The last
    // successful base is remembered in-process and tried FIRST on later
    // refreshes (official second), so a restricted network stops paying the
    // failing attempt on every refresh while still re-probing the official
    // host each time.
    let lastError: unknown
    for (const base of this.candidateBases(region, officialBase)) {
      let response: Response
      try {
        response = await this.fetchImpl(`${base}/models?functions=${functions}`, { headers, signal: signal ?? AbortSignal.timeout(30_000) })
      } catch (error) {
        // Transport failure (proxy rejection, timeout, reset): the candidate is
        // unreachable, not answering — record it and try the next base. A
        // caller-aborted signal must propagate, though: that is the caller's
        // decision, not a host failure.
        if (signal?.aborted) throw error
        lastError = error
        continue
      }
      if (!response.ok) {
        if (response.status < 500) throw new Error(`SOLO remote models returned HTTP ${response.status}`)
        lastError = new Error(`SOLO remote models returned HTTP ${response.status}`)
        continue
      }
      if (base !== officialBase && this.lastSuccessfulBase !== base) {
        this.options.log?.(`model directory served by fallback host ${base}; the official host (${officialBase}) failed this refresh`, { officialBase })
      }
      this.lastSuccessfulBase = base
      const json = await response.json() as { code?: number; data?: { list?: { function?: string; models?: unknown[] }[] } }
      const models = this.collectModels(region, json.data?.list ?? [])
      // An empty catalog is a semantic answer ("nothing to serve"), not a host
      // failure — no fallback for it.
      if (models.length === 0) throw new Error('SOLO remote models response contained no models')
      return models
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError))
  }

  /** Bases to try for one refresh, in order (see the field note on {@link lastSuccessfulBase}). */
  private candidateBases(region: TraeRegion, officialBase: string): string[] {
    // An explicit baseUrl (tests, diagnostics) pins the endpoint: no fallback
    // chain, exactly the pre-fallback behavior.
    if (this.baseUrl !== undefined) return [officialBase]
    if (this.lastSuccessfulBase === undefined || this.lastSuccessfulBase === officialBase) {
      return [officialBase, ...traeSoloRemoteFallbackBases(region, officialBase)]
    }
    // The remembered host is a backup: try it first, but keep the official base
    // SECOND so it is re-attempted on this very refresh — a healed network
    // takes over immediately, and a still-blocked one costs one extra attempt.
    return [
      this.lastSuccessfulBase,
      officialBase,
      ...traeSoloRemoteFallbackBases(region, officialBase).filter(base => base !== this.lastSuccessfulBase),
    ]
  }

  /**
   * Union every returned group into one deduplicated list, attributing each
   * model to the directory function it was FIRST seen under.
   *
   * Each group is a roster the gateway is willing to serve; a model listed by
   * any of them is a model the IDE can offer, and the wire join downstream (see
   * mergeTraeModelSources) is what decides whether it is actually callable.
   * Restricting this to `solo_agent_remote` dropped the nine models issue #19
   * was opened about.
   *
   * FUNCTION ATTRIBUTION (2026-10-20): the group is the authoritative statement
   * of which SOLO function the model belongs to — the accepted `config_name`
   * is isolated per function (glm-5.3 answers `solo_work_remote` and 4001s
   * under `solo_work_lite`). The wire join prefers its own `get_detail_param`
   * function and falls back to this one when the roster says nothing, which
   * restricted networks often do (measured: an empty `config_info_list` for
   * every chat function but `chat_v3`). Chat-capable groups are walked FIRST,
   * in the request's `functions=` order, then the IDE/agent rosters: a model a
   * chat function lists must be attributed to that chat function even when a
   * non-chat group (`solo_agent`, `builder_v3`) appeared EARLIER in the request
   * — those rosters answer 4011/4001 for `llm_utils_chat`, so a plain
   * request-order first-wins would attribute `solo_agent` to models that ARE
   * callable (Doubao-Seed-Code lives on `solo_agent_remote`) and turn working
   * chats into 4001s. A model that only a non-chat group lists keeps that
   * attribution so the caller can exclude it (see `chatCallableModels`).
   *
   * A model appears in SEVERAL groups and the groups disagree about its
   * capacity, so dedupe keeps the MOST CAPABLE row rather than the first one
   * (issue #23). "First wins" assumed the group order was stable; measured
   * 2026-10-05 on a live CN credential it is not — five calls returned five
   * different orders — so the published window became a coin flip:
   * `Doubao-Seed-2.1-Pro` came back as `116000`/no-Max (`builder_v3`), or
   * `256000`/no-Max (`solo_work_*`), or `256000`/`1000000` (`chat_v3`,
   * `solo_agent*`) depending on which group answered first. The Max tier is
   * the one users enable in the IDE, and `applyContextBudgets` can only raise
   * a window to `maxContextWindow` — so losing that field silently capped
   * every configured 1M model at 256K or less, and DSH compressed far earlier
   * than the chosen budget implied.
   *
   * Ordering rule: a row advertising a Max tier beats one that does not, a
   * larger Max wins over a smaller one, and with no Max on either side the
   * wider dev window wins. Every row for one id carries the same
   * `multimodal` / `reasoning` / credit facts (verified the same day), so
   * choosing on capacity loses no capability. The result no longer depends on
   * the gateway's group order — and the FUNCTION does not either: the winning
   * row's capacity may come from a later group, but the separately-tracked
   * attribution is re-asserted on it.
   */
  private collectModels(region: TraeRegion, groups: { function?: string; models?: unknown[] }[]): TraeDiscoveredModel[] {
    const byId = new Map<string, TraeDiscoveredModel>()
    // First group (by walk order) to list an id owns its function; tracked
    // separately because preferStrongerRow may replace the row with one from a
    // LATER group.
    const attributedFunction = new Map<string, string>()
    const addGroup = (groupFunction: string | undefined, raws: readonly unknown[]): void => {
      for (const raw of raws) {
        const model = parseTraeRemoteModel(raw, groupFunction)
        if (model === undefined) continue
        if (groupFunction !== undefined && !attributedFunction.has(model.id)) attributedFunction.set(model.id, groupFunction)
        byId.set(model.id, preferStrongerRow(model, byId.get(model.id)))
      }
    }
    const requested = TRAE_REMOTE_DIRECTORY_FUNCTIONS[region]
    const byName = new Map<string, { function?: string; models?: unknown[] } | undefined>()
    for (const group of groups) byName.set(group.function ?? '', group)
    const chatFunctions = new Set(TRAE_DIRECTORY_FUNCTIONS[region])
    // Pass 1: chat-capable groups only, in the request's functions= order.
    for (const name of requested) {
      if (!chatFunctions.has(name)) continue
      const group = byName.get(name)
      if (group !== undefined) addGroup(name, group.models ?? [])
    }
    // Pass 2: the remaining requested groups (IDE/agent rosters), same order.
    for (const name of requested) {
      if (chatFunctions.has(name)) continue
      const group = byName.get(name)
      if (group !== undefined) addGroup(name, group.models ?? [])
    }
    // Pass 3: groups the gateway returned that the request did not name.
    for (const group of groups) {
      if (requested.includes(group.function ?? '')) continue
      addGroup(group.function, group.models ?? [])
    }
    return [...byId.values()].map(model => {
      const fn = attributedFunction.get(model.id)
      return fn === undefined || fn === model.function ? model : { ...model, function: fn }
    })
  }
}
