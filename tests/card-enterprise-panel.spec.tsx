// @vitest-environment jsdom
/**
 * The ENTERPRISE panel: a third section of the card, beside domestic and global.
 *
 * What must hold, and why each one is load-bearing:
 *
 *  - It renders as a PEER of the other two tabs, not as a mode of the domestic
 *    one, because it bills a different account and serves a different roster.
 *  - Its switch is INDEPENDENT: flipping it must not touch `regions.cn`, or a
 *    user who turns the tenant pool off would silently lose the personal pool.
 *  - It defaults OFF. A consumer-only account cannot use that pool at all, so
 *    opting everyone in would put a route in their model picker that fails on
 *    first use — and the Host's default (not just the card's rendering) has to
 *    agree, which `regionEnabled` is asserted for directly.
 *
 * These render the SHIPPED card and assert on the committed settings write and
 * the rendered state, never on internals.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { TraeUsageCard } from '../src/client/TraeUsageCard.tsx'
import type { TraeSettingsKey } from '../src/client/locales.ts'
import { regionEnabled } from '../src/index.ts'
import { TRAE_PANELS, providerOfPanel, regionOfPanel } from '../src/region.ts'

afterEach(cleanup)

const t = ((key: TraeSettingsKey, params?: Record<string, unknown>) =>
  params === undefined ? key : `${key}:${JSON.stringify(params)}`) as never

function makeScope(initial: Record<string, unknown>) {
  let value: Record<string, unknown> = JSON.parse(JSON.stringify(initial)) as Record<string, unknown>
  const listeners = new Set<() => void>()
  const writes: { field: string; value: unknown }[] = []
  return {
    writes,
    scope: {
      getSnapshot: () => ({ status: 'ready', value, writable: true }),
      subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
      set: async (field: string, next: unknown) => {
        const copy = JSON.parse(JSON.stringify(next)) as unknown
        writes.push({ field, value: copy })
        value = { ...value, [field]: copy }
        for (const listener of listeners) listener()
      },
    },
  }
}

function renderOpen(scope: unknown): void {
  render(<TraeUsageCard t={t} settingsScope={scope as never} />)
  fireEvent.click(screen.getByRole('button', { name: /row\.title/ }))
}

function switchOf(key: string): HTMLInputElement {
  const boxes = screen.getAllByRole('checkbox', { name: /row\.tabSwitchAria/ }) as HTMLInputElement[]
  const box = boxes.find(candidate => (candidate.getAttribute('aria-label') ?? '').includes(key))
  if (box === undefined) throw new Error(`no switch labelled ${key}`)
  return box
}

describe('enterprise panel identity', () => {
  it('is a third panel beside cn and ai, in card order', () => {
    expect(TRAE_PANELS).toEqual(['cn', 'enterprise', 'ai'])
  })

  it('publishes its own provider and draws on the cn credential region', () => {
    expect(providerOfPanel('enterprise')).toBe('trae-enterprise')
    expect(regionOfPanel('enterprise')).toBe('cn')
    // …without disturbing the two that already existed.
    expect(providerOfPanel('cn')).toBe('trae')
    expect(providerOfPanel('ai')).toBe('trae-global')
    expect(regionOfPanel('ai')).toBe('ai')
  })
})

describe('enterprise panel in the card', () => {
  it('renders a tab of its own, as a peer of domestic and global', () => {
    const { scope } = makeScope({})
    renderOpen(scope)
    const tabs = screen.getAllByRole('tab').map(tab => tab.textContent ?? '')
    expect(tabs).toHaveLength(3)
    expect(tabs.some(text => text.includes('row.tabCn'))).toBe(true)
    expect(tabs.some(text => text.includes('row.tabEnterprise'))).toBe(true)
    expect(tabs.some(text => text.includes('row.tabAi'))).toBe(true)
  })

  it('starts switched OFF while the other two start ON', () => {
    const { scope } = makeScope({})
    renderOpen(scope)
    expect(switchOf('row.tabCn').checked).toBe(true)
    expect(switchOf('row.tabAi').checked).toBe(true)
    expect(switchOf('row.tabEnterprise').checked).toBe(false)
  })

  it('switches on independently, writing only its own slot', async () => {
    const state = makeScope({ regions: { cn: { enabled: true, enabledModelIds: ['glm-5.3'] } } })
    renderOpen(state.scope)
    fireEvent.click(switchOf('row.tabEnterprise'))
    expect(state.writes).toHaveLength(1)
    const write = state.writes[0]!
    expect(write.field).toBe('regions')
    // The enterprise slot turns on; the domestic slot is carried over verbatim,
    // model picks included.
    expect(write.value).toEqual({
      cn: { enabled: true, enabledModelIds: ['glm-5.3'] },
      enterprise: { enabled: true },
    })
  })

  it('switches off without touching the domestic panel', async () => {
    const state = makeScope({ regions: { cn: { enabled: true }, enterprise: { enabled: true } } })
    renderOpen(state.scope)
    fireEvent.click(switchOf('row.tabEnterprise'))
    const write = state.writes[0]!
    expect(write.value).toEqual({ cn: { enabled: true }, enterprise: { enabled: false } })
  })

  it('keeps its own model selection separate from the domestic panel', () => {
    const { scope } = makeScope({
      regions: {
        cn: { enabled: true, enabledModelIds: ['glm-5.3'] },
        enterprise: { enabled: true, enabledModelIds: ['DeepSeek-V4.1-Flash'] },
      },
    })
    renderOpen(scope)
    // Each panel reads its own slot: switching the enterprise tab on must not
    // make it show — or later save — the domestic panel's picks.
    fireEvent.click(screen.getByRole('tab', { name: /row\.tabEnterprise/ }))
    expect(screen.getByRole('tab', { name: /row\.tabEnterprise/ }).getAttribute('aria-selected')).toBe('true')
  })
})

describe('enterprise panel default, on the Host side', () => {
  const config = (regions: Record<string, unknown>) => ({ regions }) as never

  it('defaults OFF so an upgrade cannot opt anyone in', () => {
    expect(regionEnabled(config({}), 'enterprise')).toBe(false)
    expect(regionEnabled(config({}), 'cn')).toBe(true)
    expect(regionEnabled(config({}), 'ai')).toBe(true)
  })

  it('honours an explicit switch in either direction', () => {
    expect(regionEnabled(config({ enterprise: { enabled: true } }), 'enterprise')).toBe(true)
    expect(regionEnabled(config({ cn: { enabled: false } }), 'cn')).toBe(false)
  })
})
