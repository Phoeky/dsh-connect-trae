// @vitest-environment jsdom
/**
 * WHERE the credit readout sits — learned from dsh-connect-workbuddy issue #62.
 *
 * WHY THIS FILE EXISTS: the readout used to have ONE fixed seat, the composer
 * tool row (`conversation.input.left`). That row is a LIST seat shared with the
 * shell's own controls and with EVERY other bundle, and a list seat cannot
 * promise that every occupant is visible — the report behind #62 is exactly
 * that, a third-party plugin installed and the readout stopped appearing at
 * all. This plugin has already lost this line once to a shared seat (it lived
 * at the sidebar foot, where it was clipped to "Tr" beside
 * dsh-connect-workbuddy's rows), so the seat becomes the user's choice:
 *
 *   - `composer` (default) — the composer tool row with the model picker;
 *   - `stats` — the ambient dock below the composer card
 *     (`conversation.composer.dock`), where the shell renders its own
 *     round/step/token pills.
 *
 * Two properties are pinned, and neither is cosmetic:
 *   1. the reader/writer round-trip, per REGION — the seat survives a settings
 *      write without disturbing the rest of the slot, and a profile written
 *      before the setting existed reads as `composer`;
 *   2. the GATE renders in the chosen seat and nowhere else, so the readout
 *      cannot appear twice (once per seat) or vanish while the setting says
 *      otherwise.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import {
  nextRegionCreditPosition,
  regionCreditPositionOf,
  regionEnabledOf,
} from '../src/status-paths.ts'
import { ComposerPointsGate } from '../src/client/ComposerPointsGate.tsx'
import type { TraeSettingsKey } from '../src/client/locales.ts'

const t = ((key: TraeSettingsKey) => key) as (key: TraeSettingsKey, params?: Record<string, unknown>) => string

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

/**
 * A settings scope over a mutable section, recording every write.
 *
 * `showPointsInMainUi` is ON by default so the seat is the ONLY thing deciding
 * whether the readout draws — a case where the switch is off would pass for the
 * wrong reason and stop testing the seat rule at all.
 */
function scopeOf(section: Record<string, unknown>): { scope: unknown; writes: { field: string; value: unknown }[] } {
  const value: Record<string, unknown> = { showPointsInMainUi: true, ...section }
  const writes: { field: string; value: unknown }[] = []
  return {
    writes,
    scope: {
      getSnapshot: () => ({ status: 'ready', value, writable: true }),
      subscribe: () => () => {},
      set: async (field: string, next: unknown) => { writes.push({ field, value: next }); return true },
    },
  }
}

/**
 * Render the gate as a slot does, and report WHAT was drawn.
 *
 * A real render rather than calling the component: the gate reads a settings
 * scope and subscribes to it, so the decision only exists inside React's
 * lifecycle. The count is of the readout's own trigger — the one node the gate
 * produces — which is what makes "renders in exactly one seat" observable.
 */
function drawGate(input: {
  position?: 'composer' | 'stats'
  scope?: unknown
  provider?: string
}): number {
  // The readout fetches its balance on mount; an empty answer keeps this about
  // the SEAT decision rather than about credits.
  vi.stubGlobal('fetch', async (input: string | URL | Request) => {
    const url = String(input)
    void url
    return new Response(JSON.stringify({ status: 'signed-out', accounts: [] }), { status: 200 })
  })
  const { container } = render(
    <ComposerPointsGate
      t={t}
      {...input.position === undefined ? {} : { position: input.position }}
      {...input.scope === undefined ? {} : { settingsScope: input.scope as never }}
      useProjection={() => ({ next: { provider: input.provider ?? 'trae' } })}
    />,
  )
  return container.querySelectorAll('.dsm-trae-composer-points').length
}

describe('the credit readout seat', () => {
  it('defaults to the composer row, including for a profile written before the setting', () => {
    // The whole point of the default: an upgrade moves nothing on screen.
    expect(regionCreditPositionOf({ regions: { cn: {} } }, 'cn')).toBe('composer')
    expect(regionCreditPositionOf({ regions: { cn: { enabled: false } } }, 'cn')).toBe('composer')
    // An unknown value from a hand-edited config reads as the default too,
    // rather than rendering nowhere — falling back to a seat that draws is
    // deliberate, because "disappears" is the very defect this feature fixes.
    expect(regionCreditPositionOf({ regions: { cn: { creditPosition: 'sidebar' } } }, 'cn')).toBe('composer')
  })

  it('reads the seat per REGION, not globally', () => {
    // The two tabs move independently: a user who relocated only the CN readout
    // must not find the international one relocated too.
    const value = { regions: { cn: { creditPosition: 'stats' }, ai: {} } }
    expect(regionCreditPositionOf(value, 'cn')).toBe('stats')
    expect(regionCreditPositionOf(value, 'ai')).toBe('composer')
  })

  it('accepts the whole settings section as well as the bare regions map', () => {
    // `regionsMapOf` tolerates both shapes, and passing the section where the
    // map was expected was a real shipped bug on this card — it made every
    // region read as absent. Both call shapes are pinned so a future reader
    // cannot narrow it back.
    expect(regionCreditPositionOf({ regions: { cn: { creditPosition: 'stats' } } }, 'cn')).toBe('stats')
    expect(regionCreditPositionOf({ cn: { creditPosition: 'stats' } }, 'cn')).toBe('stats')
  })

  it('writes one region\'s seat without disturbing its other fields', () => {
    // Same merge rule as every other region write: only the target field
    // changes, so a seat change cannot drop the model list, budgets, or the
    // sibling region.
    const value = {
      regions: {
        cn: { enabled: false, enabledModelIds: ['m1'], contextBudgets: { m1: 4096 }, creditPosition: 'composer' },
        ai: { creditPosition: 'stats' },
      },
    }
    // The return value is the REGIONS MAP (not the whole section), which is
    // what `settingsScope.set('regions', ...)` needs. Indexed through a helper
    // so the assertions read the slot rather than repeating the cast.
    const next = nextRegionCreditPosition(value, 'cn', 'stats')
    const slotOf = (region: string): Record<string, unknown> => next[region] as Record<string, unknown>
    expect(slotOf('cn')['creditPosition']).toBe('stats')
    expect(slotOf('cn')['enabledModelIds']).toEqual(['m1'])
    expect(slotOf('cn')['contextBudgets']).toEqual({ m1: 4096 })
    expect(slotOf('cn')['enabled']).toBe(false)
    expect(slotOf('ai')['creditPosition']).toBe('stats')
    // …and the reader agrees with what was written, given the section shape it
    // actually reads.
    expect(regionCreditPositionOf({ regions: next }, 'cn')).toBe('stats')
  })

  it('keeps the seat independent of the show/hide switch and the provider switch', () => {
    // The three answer different questions. A hidden readout must not lose
    // where it was going to sit: turning it back on should return it to the
    // chosen seat rather than resetting to the default.
    const hidden = nextRegionCreditPosition({ regions: { cn: { enabled: false } } }, 'cn', 'stats')
    expect(regionEnabledOf({ regions: hidden }, 'cn')).toBe(false)
    expect(regionCreditPositionOf({ regions: hidden }, 'cn')).toBe('stats')
  })

  it('resolves the seat on the HOST the same way the browser does', async () => {
    // The Host's own reader is the authority the gate's scope mirrors. It must
    // agree with `regionCreditPositionOf`, and it must survive the 0.1.7 shape
    // where a volatile field arrives as a `{get(): T}` live reference — reading
    // through that without unwrapping is how "settings written but not read
    // back" shipped on this plugin before.
    const { creditPosition, Config } = await import('../src/index.ts')
    const parsed = new Config({ regions: { cn: { creditPosition: 'stats' } } } as never) as never
    expect(creditPosition(parsed, 'cn')).toBe('stats')
    expect(creditPosition(parsed, 'ai')).toBe('composer')
    // The schema default keeps an upgrade from moving anyone's readout.
    expect(creditPosition(new Config({} as never) as never, 'cn')).toBe('composer')
  })
})

describe('the gate renders in the seat the setting names', () => {
  it('renders in the composer seat when the setting says composer', () => {
    expect(drawGate({ position: 'composer', scope: scopeOf({ regions: { cn: {} } }).scope })).toBe(1)
  })

  it('renders NOTHING in the seat the setting does not name', () => {
    // The defect this prevents: the readout appearing twice (once per seat)
    // while the setting names only one.
    const scope = scopeOf({ regions: { cn: { creditPosition: 'stats' } } }).scope
    expect(drawGate({ position: 'composer', scope })).toBe(0)
    expect(drawGate({ position: 'stats', scope })).toBe(1)
  })

  it('treats an absent seat as `composer`, so an existing caller is unchanged', () => {
    // Every registration before this setting existed passed no `position`; they
    // must keep rendering exactly as they did.
    expect(drawGate({ scope: scopeOf({ regions: { cn: {} } }).scope })).toBe(1)
    expect(drawGate({ scope: scopeOf({ regions: { cn: { creditPosition: 'stats' } } }).scope })).toBe(0)
  })

  it('moves the readout when the setting changes, with no re-registration', () => {
    // The whole reason BOTH seats stay registered: the seat is decided at
    // render time, so a settings write is all it takes. Here the SAME
    // registration draws in one seat and stops in the other, which is what pins
    // that the decision is not baked into the registration.
    expect(drawGate({ position: 'stats', scope: scopeOf({ regions: { cn: { creditPosition: 'stats' } } }).scope })).toBe(1)
    expect(drawGate({ position: 'stats', scope: scopeOf({ regions: { cn: { creditPosition: 'composer' } } }).scope })).toBe(0)
    expect(drawGate({ position: 'composer', scope: scopeOf({ regions: { cn: { creditPosition: 'composer' } } }).scope })).toBe(1)
  })

  it('renders in NEITHER seat for a region whose readout is hidden or off', () => {
    // Ownership and the switches are decided BEFORE the seat test, so a region
    // that is switched off renders nothing anywhere rather than drawing in the
    // inactive seat first.
    const hidden = scopeOf({ showPointsInMainUi: false, regions: { cn: { creditPosition: 'stats' } } }).scope
    expect(drawGate({ position: 'stats', scope: hidden })).toBe(0)
    expect(drawGate({ position: 'composer', scope: hidden })).toBe(0)
    const off = scopeOf({ regions: { cn: { enabled: false } } }).scope
    expect(drawGate({ position: 'composer', scope: off })).toBe(0)
    expect(drawGate({ position: 'stats', scope: off })).toBe(0)
  })

  it('renders in neither seat for another provider, whatever the seat says', () => {
    const scope = scopeOf({ regions: { cn: { creditPosition: 'stats' }, ai: { creditPosition: 'stats' } } }).scope
    expect(drawGate({ position: 'composer', scope, provider: 'workbuddy' })).toBe(0)
    expect(drawGate({ position: 'stats', scope, provider: 'workbuddy' })).toBe(0)
  })

  it('reads the seat of the region the SESSION is pointed at, not of the other tab', () => {
    // The seat is per region, so the gate must consult the selected provider's
    // own slot. With CN moved to `stats` and the international region left
    // alone, the stats seat draws for a `trae` session and the composer seat
    // draws for a `trae-global` one.
    const scope = scopeOf({ regions: { cn: { creditPosition: 'stats' }, ai: { creditPosition: 'composer' } } }).scope
    expect(drawGate({ position: 'stats', scope, provider: 'trae' })).toBe(1)
    expect(drawGate({ position: 'composer', scope, provider: 'trae' })).toBe(0)
    expect(drawGate({ position: 'composer', scope, provider: 'trae-global' })).toBe(1)
    expect(drawGate({ position: 'stats', scope, provider: 'trae-global' })).toBe(0)
  })
})
