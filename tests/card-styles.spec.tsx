// @vitest-environment jsdom
/**
 * The card's settings and account blocks must actually LOOK like something.
 *
 * WHY THIS FILE EXISTS: the complaint that started 3.2.0 was "I see no change in
 * the settings menu" — and the way a rebuilt settings area fails is by rendering
 * with no rules behind it. jsdom does no layout and no cascade, so an unstyled
 * block passes every behavioural assertion: the card had already shipped that
 * exact bug once (the 2.9.x composer-credit switch rendered as a bare browser
 * checkbox, so it read as absent). `composer-styles.spec.tsx` pinned this for the
 * composer readout; the card itself had no such check, which is what this adds.
 *
 * The assertions are structural, not visual:
 *  - every `dsm-trae-*` class the SHIPPED card renders has a rule in
 *    `TRAE_CARD_CSS` (or is explicitly allowlisted below with a reason);
 *  - the switch's ON state has a rule, because a switch whose knob never moves
 *    is indistinguishable from a disabled one.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  IconChevronDownOutline14: () => null,
}))

import { TraeUsageCard } from '../src/client/TraeUsageCard.tsx'
import { TRAE_CARD_CSS } from '../src/client/styles.ts'

import type { TraeSettingsKey } from '../src/client/locales.ts'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const t = ((key: TraeSettingsKey, params?: Record<string, unknown>) =>
  params === undefined ? key : `${key}:${JSON.stringify(params)}`) as never

/**
 * Classes the card renders that deliberately carry no rule of their own.
 * Anything added here needs a reason, because the allowlist is the only place a
 * genuinely unstyled block could hide.
 */
const UNSTYLED_BY_DESIGN = new Set([
  // Styled inline from the account/region status colour (`dotStyle`), like the
  // tab dots and the composer panel's dot.
  'dsm-trae-usage-dot',
])

function scope() {
  const value = {}
  return {
    getSnapshot: () => ({ status: 'ready', value, writable: true }),
    subscribe: () => () => {},
    set: async () => {},
  }
}

function usageDocument(): Record<string, unknown> {
  return {
    status: 'signed-in',
    accountId: 'account-1',
    accountName: 'LaoDing',
    tokenExpiresAtMs: Date.now() + 3_600_000,
    region: 'cn',
    enabled: true,
    accounts: [
      { id: 'account-1', accountName: 'LaoDing', edition: 'cn', region: 'cn', source: 'desktop', tokenExpiresAtMs: Date.now() + 3_600_000, selected: true },
      { id: 'account-2', accountName: 'SecondCN', edition: 'solo', region: 'cn', source: 'cli', tokenExpiresAtMs: Date.now() + 7_200_000, selected: false },
    ],
    models: [],
    enabledModelIds: [],
    credits: { total: 7500, consumed: 5_879.63, available: 1_620.37, workAvailable: 0, generalAvailable: 20.37, accounts: [] },
    checkin: { checkedIn: false, didCheckedIn: false, credits: 150, enabled: true, extraCredits: 50 },
  }
}

/** Every class the rendered card actually carries, deduped. */
function renderedClasses(): string[] {
  const found = new Set<string>()
  // Index loops, not iteration: this project's test tsconfig carries no
  // DOM.Iterable lib, so a NodeList / DOMTokenList is not iterable to tsc.
  for (const element of Array.from(document.querySelectorAll('[class]'))) {
    const list = element.classList
    for (let index = 0; index < list.length; index += 1) {
      const name = list.item(index)
      if (name !== null && name.startsWith('dsm-trae-')) found.add(name)
    }
  }
  return [...found].sort()
}

/** The selector names the card stylesheet defines. */
function styledClasses(): Set<string> {
  const defined = new Set<string>()
  for (const match of TRAE_CARD_CSS.matchAll(/\.(dsm-trae-[a-z0-9-]+)/gi)) {
    if (match[1] !== undefined) defined.add(match[1])
  }
  return defined
}

describe('the card stylesheet behind the 3.2.0 settings and account blocks', () => {
  it('has a rule for every dsm-trae-* class the expanded card renders', async () => {
    vi.stubGlobal('fetch', async (input: string | URL | Request) =>
      new Response(JSON.stringify(usageDocument()), { status: 200 }))
    render(<TraeUsageCard t={t} settingsScope={scope() as never} />)
    fireEvent.click(screen.getByRole('button', { name: /row\.title/ }))
    // The tab hint is part of the block under test and only renders expanded.
    await screen.findByText('row.tabHint')

    const defined = styledClasses()
    const rendered = renderedClasses()
    // The new blocks are really in the DOM (an empty collection would make the
    // "nothing is missing" assertion below pass for the wrong reason).
    expect(rendered).toContain('dsm-trae-set-row')
    expect(rendered).toContain('dsm-trae-switch-track')
    expect(rendered).toContain('dsm-trae-accounts-table')
    expect(rendered).toContain('dsm-trae-accounts-badge')
    expect(rendered.length).toBeGreaterThan(15)

    expect(rendered.filter(name => !defined.has(name) && !UNSTYLED_BY_DESIGN.has(name))).toEqual([])
  })

  it('styles the switch ON state, so a ticked switch cannot look disabled', () => {
    // The knob's travel is the only thing that distinguishes an opt-in from an
    // opt-out; without it the control reads as broken rather than as off.
    expect(TRAE_CARD_CSS).toMatch(/\.dsm-trae-switch input:checked\+\.dsm-trae-switch-track/)
    expect(TRAE_CARD_CSS).toMatch(/\.dsm-trae-switch-track::after/)
  })

  it('gives the two new blocks a titled container, not a bare checkbox row', () => {
    expect(TRAE_CARD_CSS).toMatch(/\.dsm-trae-set\{/)
    expect(TRAE_CARD_CSS).toMatch(/\.dsm-trae-accounts\{/)
    expect(TRAE_CARD_CSS).toMatch(/\.dsm-trae-accounts-table\{/)
  })
})
