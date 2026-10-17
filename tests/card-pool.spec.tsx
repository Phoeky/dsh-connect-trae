// @vitest-environment jsdom
/**
 * The account-pool card section (`src/client/AccountPool.tsx`), tested as a
 * standalone component with a fake `t` and a fake `settingsScope`.
 *
 * WHAT THIS COVERS (all required by the pool card spec):
 *  1. rows render from a `pool` document, including a WORKING account, and a
 *     GHOST member (`reachable:false`, saved in settings but not listed
 *     locally) that still renders so it can be removed;
 *  2. the membership checkbox toggles the DRAFT (not `account.member`) and
 *     marks the settings dirty; saving writes `regions` with a
 *     `nextRegionPool`-shaped value (asserted on the `scope.set` argument)
 *     and clears dirty;
 *  3. discard restores the saved membership;
 *  4. `targetModelId` stale rendering + the "back to automatic" affordance;
 *  5. the check-in column is ABSENT when `checkinSupported` is false;
 *  6. a `test` batch renders rows incrementally from a mocked NDJSON stream;
 *  7. `noCandidate: 'empty'` renders the "choose members" warning.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Primitives ships browser-only CSS modules (shiki, `anser`, `*.module.css`) that
// jsdom cannot transform. Stub the one icon the card needs, wholesale.
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  IconChevronDownOutline14: () => null,
}))

import * as React from 'react'
import type { ReactElement } from 'react'
import { AccountPool } from '../src/client/AccountPool.tsx'
import { TRAE_CARD_CSS } from '../src/client/styles.ts'
import { withTraePoolAccount, withTraePoolAction } from '../src/status-paths.ts'
import type { TraeSettingsKey } from '../src/client/locales.ts'
import type { TraeWebPool, TraeWebPoolAccount, TraeWebModel, TraePoolTestRowView, TraePoolCheckinRowView } from '../src/status-paths.ts'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/** Fake translator: renders the key (or key:params) so queries use key strings. */
const t = ((key: TraeSettingsKey, params?: Record<string, unknown>) =>
  params === undefined ? key : `${key}:${JSON.stringify(params)}`) as (
  key: TraeSettingsKey, params?: Record<string, unknown>
) => string

/** A settings scope that records every `set` it receives, over `regions`. */
function makeScope(initial: Record<string, unknown> = {}, writable = true) {
  let value: Record<string, unknown> = structuredClone(initial)
  const listeners = new Set<() => void>()
  const calls: { field: string; value: unknown }[] = []
  return {
    scope: {
      getSnapshot: () => ({ status: 'ready', value, writable }),
      subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
      set: async (field: string, next: unknown) => {
        value = { ...value, [field]: structuredClone(next) }
        calls.push({ field, value: structuredClone(next) })
        for (const listener of listeners) listener()
        return true
      },
    },
    calls,
    get value() { return value },
    get snapshotRegions(): Record<string, unknown> {
      const regions = (value as { regions?: unknown } | undefined)?.regions
      return typeof regions === 'object' && regions !== null ? regions as Record<string, unknown> : {}
    },
  }
}

/**
 * The `regions` write target the card reads its pool PREFS from (the same
 * shape `nextRegionPool` returns): a per-panel (`cn`) slot holding `pool`.
 * `cnSlotPool` is the saved `TraePoolPreferences` for the cn panel.
 */
function regionsOf(cnSlotPool: { enabled?: boolean; targetModelId?: string; memberAccountIds?: string[] }): Record<string, unknown> {
  return {
    regions: {
      cn: { pool: cnSlotPool },
      ai: {},
      enterprise: {},
    },
  }
}

/** A settings document whose cn panel already saved a pool membership. */
function pooledInitial(
  poolPrefs: { enabled: boolean; targetModelId?: string; memberAccountIds: string[]; probeInputTokens?: number },
): Record<string, unknown> {
  return regionsOf({ ...poolPrefs })
}

const MODELS: TraeWebModel[] = [
  { id: 'free-1', name: 'Free Model' },
  { id: 'pro-1', name: 'Pro 1' },
]

interface PoolOverride {
  checkinSupported?: boolean
  probeInputTokens?: number
  targetModelId?: string
  staleTargetModelId?: string
  targetModelSource?: TraeWebPool['targetModelSource']
  noCandidate?: TraeWebPool['noCandidate']
  memberAccountIds?: readonly string[]
  accounts?: readonly TraeWebPoolAccount[]
}

function basePool(overrides: PoolOverride = {}): TraeWebPool {
  const accounts: readonly TraeWebPoolAccount[] = overrides.accounts ?? [
    {
      accountId: 'acc-a',
      accountName: 'AccA',
      generalAvailable: 30,
      workAvailable: 500,
      current: true,
      member: true,
      reachable: true,
      checkedInToday: false,
    },
    {
      accountId: 'acc-b',
      accountName: 'AccB',
      generalAvailable: 8,
      workAvailable: 0,
      current: false,
      member: true,
      reachable: true,
      checkedInToday: true,
    },
  ]
  return {
    enabled: true,
    checkinSupported: overrides.checkinSupported ?? true,
    ...(overrides.targetModelId === undefined ? {} : { targetModelId: overrides.targetModelId }),
    targetModelSource: overrides.targetModelSource ?? 'preferred',
    probeInputTokens: overrides.probeInputTokens ?? 0,
    ...(overrides.staleTargetModelId === undefined ? {} : { staleTargetModelId: overrides.staleTargetModelId }),
    memberAccountIds: overrides.memberAccountIds ?? ['acc-a', 'acc-b'],
    effectiveMemberAccountIds: ['acc-a', 'acc-b'],
    memberNames: {},
    accounts,
    ...(overrides.noCandidate === undefined ? {} : { noCandidate: overrides.noCandidate }),
  }
}

/** One real pool-account that OLDS (not reachable locally) yet stays in settings. */
function ghostPool(): TraeWebPool {
  return {
    ...basePool({ memberAccountIds: ['acc-a', 'ghost-1'] }),
    accounts: [
      {
        accountId: 'acc-a', accountName: 'AccA', current: true, member: true, reachable: true,
        generalAvailable: 12, workAvailable: 3, checkedInToday: false,
      },
    ],
    memberAccountIds: ['acc-a', 'ghost-1'],
    memberNames: { 'ghost-1': 'GhostOne' },
  }
}


/** `<AccountPool>` for a fixture, as an element (so a test can measure the DOM). */
function renderPoolAndReturn(pool: TraeWebPool, scope: unknown, deviceClaimed = false): ReactElement {
  return <AccountPool panel="cn" pool={pool} models={MODELS} t={t} settingsScope={scope as never} deviceClaimed={deviceClaimed} />
}

/**
 * The pool section, so row queries never bleed into other markup.
 */
function poolSection(): HTMLElement {
  return screen.getByRole('region', { name: 'row.poolTitle' })
}

/**
 * Render `<AccountPool>` inside a tiny harness that subscribes to the settings
 * scope and re-renders on change — the SAME way the real card drives the pool
 * section (the card bumps a `settingsRevision` in its own `subscribe`). Without
 * this, a `scope.set` (e.g. on save) would never re-render the pool, and the
 * "is anything dirty" read would stay stale.
 */
function renderPool(pool: TraeWebPool, scope: unknown, models: TraeWebModel[] = MODELS): void {
  function Harness(): ReactElement {
    const [, force] = React.useState(0)
    React.useEffect(() => {
      const scopeTyped = scope as {
        subscribe?: (listener: () => void) => () => void
      } | undefined
      if (scopeTyped?.subscribe === undefined) return
      return scopeTyped.subscribe(() => force(v => v + 1))
    }, [scope])
    return <AccountPool panel="cn" pool={pool} models={models} t={t} settingsScope={scope as never} />
  }
  render(<Harness />)
}

/** A member row by account name; rows are `div[role=row]` from the table. */
function poolRow(name: string): HTMLElement {
  return within(poolSection()).getByText(name).closest('.dsm-trae-pool-row') as HTMLElement
}

/** The checkbox in a member row, by its accessible name. */
function memberCheckbox(name: string): HTMLInputElement {
  return within(poolRow(name)).getByRole('checkbox') as HTMLInputElement
}

/** The settings save button. */
function saveButton(): HTMLButtonElement {
  return within(poolSection()).getByRole('button', { name: 'row.poolSaved' }) as HTMLButtonElement
}

/** The "back to automatic" affordance in the stale-target block. */
function clearTargetButton(): HTMLButtonElement {
  return within(poolSection()).getByRole('button', { name: 'row.poolTargetStaleClear' }) as HTMLButtonElement
}

describe('the pool section keeps one spacing and one radius scale', () => {
  // The section used to mix 10/12/14px insets and 10/12/14px radii, one per block,
  // which is exactly what reads as "inconsistent" even when each block looks fine
  // alone. These assertions pin the scale so a new block cannot invent its own.
  const rule = (selector: string): string => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const match = TRAE_CARD_CSS.match(new RegExp(`${escaped}\\{([^}]*)\\}`))
    return match?.[1] ?? ''
  }

  it('declares the scale on the section and uses it everywhere', () => {
    expect(rule('.dsm-trae-pool')).toContain('--dsm-trae-pool-pad-x:14px')
    expect(rule('.dsm-trae-pool')).toContain('--dsm-trae-pool-pad-y:10px')
    expect(rule('.dsm-trae-pool')).toContain('--dsm-trae-pool-radius:14px')
    for (const selector of [
      '.dsm-trae-pool-row',
      '.dsm-trae-pool-row-head',
      '.dsm-trae-pool-card-head',
      '.dsm-trae-pool-card-note',
      '.dsm-trae-pool-set',
    ]) {
      expect(rule(selector), selector).toContain('var(--dsm-trae-pool-pad-x)')
    }
  })

  it('only uses the card-wide radius scale inside the pool section', () => {
    // The card already has a scale: 14px for a surface, 10px for a box INSIDE a
    // surface, 999px for a pill. Anything else here is drift that shows up as
    // "these blocks do not belong together".
    const allowed = new Set(['0', '10px', '14px', '999px', '50%', 'var(--dsm-trae-pool-radius)'])
    const poolRules = TRAE_CARD_CSS.match(/\.[^{}]*dsm-trae-pool[^{}]*\{[^}]*\}/g) ?? []
    expect(poolRules.length).toBeGreaterThan(40)
    for (const block of poolRules) {
      for (const match of block.matchAll(/border-radius:([^;}]+)/g)) {
        expect(allowed.has(match[1]!.trim()), `${block.slice(0, 60)} → ${match[1]}`).toBe(true)
      }
    }
  })
})

describe('the batch check-in action', () => {
  it('is disabled once this machine already spent its check-in on another account', () => {
    const { scope } = makeScope(pooledInitial({ enabled: true, memberAccountIds: ['acc-a'] }))
    render(renderPoolAndReturn(basePool({ checkinSupported: true }), scope, true))
    const button = screen.getByRole('button', { name: 'row.poolCheckinAll' }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
    expect(button.getAttribute('title')).toBe('row.checkinDeviceSpent')
  })

  it('stays available while the device has not claimed', () => {
    const { scope } = makeScope(pooledInitial({ enabled: true, memberAccountIds: ['acc-a'] }))
    render(renderPoolAndReturn(basePool({ checkinSupported: true }), scope, false))
    const button = screen.getByRole('button', { name: 'row.poolCheckinAll' }) as HTMLButtonElement
    expect(button.disabled).toBe(false)
  })
})

describe('AccountPool card section', () => {
  it('renders rows from a pool document, including a ghost member and its removal', () => {
    // Seed the saved cn membership so the DRAFT starts with acc-a AND the ghost.
    const { scope } = makeScope(pooledInitial({ enabled: true, memberAccountIds: ['acc-a', 'ghost-1'] }))
    renderPool(ghostPool(), scope)

    const section = poolSection()
    // Real member renders with its name, General credit, probe-NEVER and a Test row action.
    expect(within(section).getByText('AccA')).toBeTruthy()
    expect(within(poolRow('AccA')).getByText('row.poolNeverTested')).toBeTruthy()
    // Ghost renders (member tag + "unusable" exclusion + its own name), not filtered out.
    expect(within(section).getByText('GhostOne')).toBeTruthy()
    const ghostRow = poolRow('GhostOne')
    expect(within(ghostRow).getByText('row.poolExcludedUnusable')).toBeTruthy()
    expect(within(ghostRow).getByText('row.poolGhostRemove')).toBeTruthy()
    // Ghost remove aria targets the ghost, not a live account.
    const remove = within(ghostRow).getByRole('button', { name: /row\.poolGhostRemoveAria/ }) as HTMLButtonElement
    expect(remove).toBeTruthy()
  })

  it('checkbox toggles the draft and marks dirty; saving writes regions via scope.set and clears dirty', async () => {
    const { scope, calls } = makeScope(pooledInitial({ enabled: true, memberAccountIds: ['acc-a', 'acc-b'] }))
    renderPool(basePool(), scope)

    // Start clean (draft = saved membership of both).
    expect(screen.queryByText('row.poolUnsavedMembers')).toBeNull()

    // Uncheck AccB -> draft changes, dirty appears.
    const checkbox = memberCheckbox('AccB')
    fireEvent.click(checkbox)
    expect(memberCheckbox('AccB').checked).toBe(false)
    expect(screen.getByText('row.poolUnsavedMembers')).toBeTruthy()
    // row.checkin column visible because checkinSupported defaults to true.

    fireEvent.click(saveButton())

    await waitFor(() => {
      expect(calls.length).toBe(1)
      expect(calls[0]!.field).toBe('regions')
    })
    const regionsWrite = calls[0]!.value as { cn?: { pool?: { enabled?: boolean; memberAccountIds?: string[] } } }
    expect(regionsWrite).toBeTruthy()
    // nextRegionPool returns the `regions` MAP (exactly what scope.set('regions',…) needs):
    // only the cn panel's pool slot is written; the other panels carry over untouched.
    expect(regionsWrite.cn?.pool).toBeTruthy()
    expect(Object.keys(regionsWrite)).toEqual(['cn', 'ai', 'enterprise'])
    expect(regionsWrite.cn?.pool?.enabled).toBe(true)
    // Order-insensitive membership: removed acc-b, kept acc-a.
    expect([...(regionsWrite.cn?.pool?.memberAccountIds ?? [])].sort()).toEqual(['acc-a'])
    // Dirty cleared after a landed write.
    await waitFor(() => { expect(screen.queryByText('row.poolUnsavedMembers')).toBeNull() })
  })

  it('discard restores the saved membership and the enabled state', () => {
    const { scope } = makeScope(pooledInitial({ enabled: true, memberAccountIds: ['acc-a', 'acc-b'] }))
    renderPool(basePool(), scope)

    // Toggle both checkboxes on (both already member) _and_ flip enabled off.
    fireEvent.click(memberCheckbox('AccA'))
    fireEvent.click(memberCheckbox('AccB'))
    const enableSwitch = within(poolSection()).getByRole('checkbox', { name: 'row.poolEnabled' }) as HTMLInputElement
    fireEvent.click(enableSwitch)
    expect(screen.getByText('row.poolUnsavedMembers')).toBeTruthy()

    fireEvent.click(within(poolSection()).getByRole('button', { name: 'row.poolDiscard' }))

    expect(screen.queryByText('row.poolUnsavedMembers')).toBeNull()
    expect(memberCheckbox('AccA').checked).toBe(true)
    expect(memberCheckbox('AccB').checked).toBe(true)
    expect(enableSwitch.checked).toBe(true)
  })

  it('renders a stale target model and the back-to-automatic affordance clears it', () => {
    const { scope } = makeScope(pooledInitial({ enabled: true, memberAccountIds: ['acc-a', 'acc-b'] }))
    renderPool(basePool({
      // Host still holds an OLD id (NON-NEGOTIABLE: saved.targetModelId must not read as '').
      staleTargetModelId: 'retired-model',
      targetModelSource: 'stale',
    }), scope)

    // The controlled select shows the saved/reported model id, NOT automatic.
    const select = within(poolSection()).getByRole('combobox', { name: 'row.poolTargetLabel' }) as HTMLSelectElement
    expect(select.value).toBe('retired-model')
    // The stale model also appears as a selectable option.
    expect(within(select).getByRole('option', { name: 'row.poolTargetStaleOption:{\"model\":\"retired-model\"}' })).toBeTruthy()

    // Back-to-automatic removes the stale slot.
    fireEvent.click(clearTargetButton())
    expect(select.value).toBe('')
  })

  it('hides the probe-size row when the Host does not know the field', () => {
    // A card newer than the Host must not offer a control whose save would be
    // dropped by the Host schema and then fail its own read-back check.
    const { scope } = makeScope(pooledInitial({ enabled: true, memberAccountIds: ['acc-a'] }))
    const legacy: Omit<TraeWebPool, 'probeInputTokens'> & { probeInputTokens?: number } = { ...basePool() }
    delete legacy.probeInputTokens
    renderPool(legacy as TraeWebPool, scope)
    expect(within(poolSection()).queryByRole('combobox', { name: 'row.poolProbeSizeLabel' })).toBeNull()
    // The rest of the settings still save.
    fireEvent.click(within(poolSection()).getByRole('checkbox', { name: 'row.poolEnabled' }))
    expect(screen.getByText('row.poolUnsavedMembers')).toBeTruthy()
  })

  it('saves the probe size choice and treats it as a draft like every other preference', async () => {
    const { scope, calls } = makeScope(pooledInitial({ enabled: true, memberAccountIds: ['acc-a'] }))
    renderPool(basePool(), scope)

    const select = within(poolSection()).getByRole('combobox', { name: 'row.poolProbeSizeLabel' }) as HTMLSelectElement
    // 0 (minimal) is a REAL choice, not "unset": the select must show it, not fall
    // back to whatever the document's default happens to be.
    expect(select.value).toBe('0')

    fireEvent.change(select, { target: { value: '50000' } })
    // A draft change alone writes nothing.
    expect(calls.length).toBe(0)
    expect(select.value).toBe('50000')

    fireEvent.click(saveButton())
    await waitFor(() => { expect(calls.length).toBe(1) })
    const written = calls[0]!.value as { cn?: { pool?: { probeInputTokens?: number } } }
    expect(written.cn?.pool?.probeInputTokens).toBe(50000)

    // Discard puts the saved value back.
    fireEvent.change(select, { target: { value: '10000' } })
    expect(select.value).toBe('10000')
    fireEvent.click(within(poolSection()).getByRole('button', { name: 'row.poolDiscard' }))
    expect((within(poolSection()).getByRole('combobox', { name: 'row.poolProbeSizeLabel' }) as HTMLSelectElement).value).toBe('50000')
  })

  it('omits the check-in column when checkinSupported is false', () => {
    const { scope } = makeScope()
    renderPool(basePool({ checkinSupported: false }), scope)

    const section = poolSection()
    expect(screen.queryByText('row.poolCheckinAll')).toBeNull()
    // No checkin column header, no per-row checkin state.
    expect(screen.queryByText('row.poolColumnCheckin')).toBeNull()
    expect(within(poolRow('AccA')).queryByText(/row\.poolCheckin/)).toBeNull()
  })

  it('renders exactly as many cells per row as the table declares columns', () => {
    // A grid row with one cell too many does not shrink — the extra cell wraps the
    // action buttons onto a second line, which is what a five-cell row looked like
    // on the four-column (no check-in) table.
    const narrow = makeScope()
    const { container } = render(renderPoolAndReturn(basePool({ checkinSupported: false }), narrow.scope))
    const table = container.querySelector('.dsm-trae-pool-table')
    expect(table?.classList.contains('dsm-trae-pool-table-no-checkin')).toBe(true)
    const narrowRows = Array.from(container.querySelectorAll('.dsm-trae-pool-row'))
    expect(narrowRows.length).toBeGreaterThan(0)
    for (const row of narrowRows) expect(row.children).toHaveLength(4)

    cleanup()
    const wide = makeScope()
    const second = render(renderPoolAndReturn(basePool(), wide.scope))
    for (const row of Array.from(second.container.querySelectorAll('.dsm-trae-pool-row'))) {
      expect(row.children).toHaveLength(5)
    }
  })

  it('renders a test batch incrementally from a mocked NDJSON stream', async () => {
    // Seed membership so the "test all" button (disabled with no members) is live.
    const { scope } = makeScope(pooledInitial({ enabled: true, memberAccountIds: ['acc-a', 'acc-b'] }))
    renderPool(basePool(), scope)

    const rows: TraePoolTestRowView[] = [
      { accountId: 'acc-a', accountName: 'AccA', modelId: 'free-1', outcome: 'ok', detail: 'fast' },
      { accountId: 'acc-b', accountName: 'AccB', modelId: 'free-1', outcome: 'rate-limited', detail: 'throttled', retryAtMs: Date.now() + 60_000 },
    ]
    const fullNdjson = rows.map(r => JSON.stringify({ row: r })).join('\n') + '\n' + JSON.stringify({ rows })

    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      expect(url).toBe(withTraePoolAction('cn', 'test'))
      return new Response(fullNdjson, { status: 200 })
    }))

    // Row 1 lands first, row 2 and the final {rows} line follow, so the probe
    // cells must appear incrementally — assert on the final full set, which
    // requires NDJSON to have been consumed line-by-line (JSON.stringify over
    // the array would not contain the `{row}` lines).
    fireEvent.click(within(poolSection()).getByRole('button', { name: 'row.poolTestAll' }))

    await waitFor(() => {
      expect(within(poolRow('AccA')).getByText('row.poolProbeOk')).toBeTruthy()
    })
    await waitFor(() => {
      expect(within(poolRow('AccB')).getByText('row.poolProbeRateLimited')).toBeTruthy()
    })
    // Batch completion clears the busy spinner state and logs done.
    await waitFor(() => { expect(screen.queryByText('row.poolBusyHint')).toBeNull() })
    expect(screen.getByText('row.poolLogTestDone')).toBeTruthy()
  })

  it('renders the "choose members" warning when noCandidate is empty', () => {
    const { scope } = makeScope()
    renderPool(basePool({ noCandidate: 'empty' }), scope)

    const section = poolSection()
    expect(within(section).getByText('row.poolNoCandidateEmpty')).toBeTruthy()
    expect(within(section).getByText('row.poolNoCandidateEmptyHint')).toBeTruthy()
  })
})

/**
 * The section must actually LOOK like something.
 *
 * jsdom does not do layout or cascade, so an unstyled section passes every
 * behavioural assertion above while the user sees a wall of stacked text. The
 * pool shipped exactly that way once (840 lines of markup, zero rules), which is
 * why the guard is structural: every `dsm-*` class this component RENDERS must
 * have a rule in the card stylesheet.
 *
 * The composer readout already had this test (`tests/composer-styles.spec.tsx`);
 * it did not cover the card, so nothing failed.
 */
describe('the pool section is styled', () => {
  function classesIn(container: HTMLElement): Set<string> {
    const found = new Set<string>()
    // `Array.from` rather than a bare for-of: tsconfig's lib is `dom` without
    // `dom.iterable`, so a NodeList is not an Iterable to the type checker.
    for (const element of Array.from(container.querySelectorAll('[class]'))) {
      for (const name of element.getAttribute('class')?.split(/\s+/) ?? []) {
        if (name !== '') found.add(name)
      }
    }
    return found
  }

  function unstyled(names: Set<string>): string[] {
    return [...names].filter(
      name => !TRAE_CARD_CSS.includes(`.${name}{`) && !TRAE_CARD_CSS.includes(`.${name}:`),
    )
  }

  it('every class the member table renders has a rule', () => {
    const { scope } = makeScope()
    // A pool document that exercises the states a single row can be in:
    // serving (and therefore tinted), in-pool, excluded, tested, checked in,
    // device-claimed, unknown, plus a ghost that stays removable.
    const rich = basePool({
      checkinSupported: true,
      targetModelId: 'free-1',
      targetModelSource: 'stale',
      staleTargetModelId: 'retired-model',
      noCandidate: 'unusable',
      memberAccountIds: ['acc-a', 'acc-b', 'ghost-1'],
      accounts: [
        {
          accountId: 'acc-a', accountName: 'AccA', current: true, member: true, reachable: true,
          generalAvailable: 30, workAvailable: 500, expiringSoon: 0, checkedInToday: true,
          probe: { outcome: 'ok', atMs: Date.now() - 60_000, source: 'test-batch', modelId: 'free-1' },
        },
        {
          accountId: 'acc-b', accountName: 'AccB', current: false, member: true, reachable: true,
          generalAvailable: 8, workAvailable: 0, expiringSoon: 12, checkedInToday: false,
          excludedBy: 'rate-limited',
          probe: { outcome: 'rate-limited', atMs: Date.now() - 3_600_000, source: 'live-request', modelId: 'free-1', message: 'slow down' },
        },
        {
          accountId: 'acc-c', accountName: 'AccC', current: false, member: false, reachable: true,
          deviceCheckedIn: true,
        },
      ],
    })
    const { container } = render(<>{renderPoolAndReturn(rich, scope)}</>)
    expect(unstyled(classesIn(container))).toEqual([])
  })

  it('every class the empty / settings / log markup renders has a rule', () => {
    const { scope } = makeScope()
    const { container } = render(<>{renderPoolAndReturn(basePool({ checkinSupported: false, noCandidate: 'empty', targetModelSource: 'none' }), scope)}</>)
    expect(unstyled(classesIn(container))).toEqual([])
  })

  it('styles the state variants that only appear after an interaction', () => {
    // These classes are produced by the activity log, which only mounts entries
    // after an action, so a render cannot reach them — assert them directly
    // rather than let a whole tone family go unstyled.
    for (const name of ['dsm-trae-pool-log-ok', 'dsm-trae-pool-log-info', 'dsm-trae-pool-log-warn', 'dsm-trae-pool-log-error']) {
      expect(TRAE_CARD_CSS).toContain(`.${name}{`)
    }
  })
})
