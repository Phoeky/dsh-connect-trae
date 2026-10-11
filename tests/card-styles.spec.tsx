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
    expect(rendered).toContain('dsm-trae-pref')
    expect(rendered).toContain('dsm-trae-switch')
    expect(rendered).toContain('dsm-trae-account-table')
    expect(rendered).toContain('dsm-trae-account-row-head')
    expect(rendered).toContain('dsm-trae-account-checkin')
    expect(rendered.length).toBeGreaterThan(15)

    expect(rendered.filter(name => !defined.has(name) && !UNSTYLED_BY_DESIGN.has(name))).toEqual([])
  })

  /**
   * The switches are the PLATFORM checkbox, tinted with `accent-color` — the
   * same idiom the composer-line switch already used, and the one the sibling
   * dsh-connect-workbuddy card uses.
   *
   * This replaced a hand-drawn 34x20 track with a 14px knob. That design read
   * its ON state from `--dsw-alias-brand-primary`, which is DSH's CONTRAST
   * colour (#0f1115 light / #f9fafb dark) rather than an accent, so a ticked
   * box rendered as a solid black pill. Nothing caught it: `accent-color` on a
   * native box is the host's business, so there is no knob geometry left to
   * assert — what has to hold is that the hand-drawn track is GONE and the
   * native tint is what remains.
   */
  it('tints the platform checkbox instead of drawing its own knob', () => {
    expect(TRAE_CARD_CSS).toMatch(/\.dsm-trae-switch input\{[^}]*accent-color:var\(--dsw-alias-brand-primary/)
    expect(TRAE_CARD_CSS).toMatch(/\.dsm-trae-switch:has\(input:disabled\)/)
    // The removed knob, spelled out: a reintroduced track would bring back the
    // black pill and its mismatched ON state.
    expect(TRAE_CARD_CSS).not.toContain('dsm-trae-switch-track')
    expect(TRAE_CARD_CSS).not.toMatch(/\.dsm-trae-switch input\{[^}]*clip:rect/)
  })

  /**
   * The account block keeps a titled container; the PREFERENCE block no longer
   * does, and that asymmetry is deliberate.
   *
   * The roster needs a heading — "Trae 账号" plus its rescan button is how the
   * user knows what the block is and that it can be re-detected. The two
   * preference checkboxes do not: they are bare lines that commit on the click,
   * exactly like the sibling dsh-connect-workbuddy card, and wrapping two
   * booleans in a titled box with a Save button asked the user to remember
   * something that had no reason to need remembering.
   */
  it('titles the account block, and leaves the preference switches as bare lines', () => {
    expect(TRAE_CARD_CSS).toMatch(/\.dsm-trae-accounts\{/)
    expect(TRAE_CARD_CSS).toMatch(/\.dsm-trae-account-table\{/)
    expect(TRAE_CARD_CSS).toMatch(/\.dsm-trae-pref\{/)
    // The removed box: a restored .dsm-trae-set would bring back the draft
    // footer it was the container for.
    expect(TRAE_CARD_CSS).not.toMatch(/\.dsm-trae-set\{/)
  })
})

/**
 * Two ways the stylesheet can be silently dead, both of which shipped once and
 * neither of which any behavioural test can see (jsdom does no cascade, and an
 * unstyled element still has the right classes and text).
 *
 * 1. A STRAY `}`. One orphan brace after `.dsm-trae-models-actions` closed the
 *    block early and took out the very next rule — the credit-exhausted notice,
 *    which is exactly the panel the user pointed at: it rendered as bare text
 *    with the button pushed underneath instead of beside it, and every test
 *    stayed green. Brace balance is the whole check.
 * 2. A TOKEN DSH DOES NOT DEFINE. `var(--nope, #333740)` is valid CSS, so it
 *    LOOKS handled, but the fallback then wins in BOTH themes. That is how the
 *    notice button's hover became a dark slab with near-black text on it in the
 *    light theme, while in the dark theme it barely changed at all: the rule
 *    asked for `--dsw-alias-bg-layer-4`, which does not exist.
 *
 * The allowlist below is deliberately explicit. A new token has to be added by
 * hand, which is the moment to check it against the DSH tokens (`grep` the app
 * bundle) instead of inventing a plausible-looking name.
 */
const TOKENS_VERIFIED_AGAINST_DSH = new Set([
  '--dsw-alias-bg-layer-2',
  '--dsw-alias-bg-layer-3',
  '--dsw-alias-border-l1',
  '--dsw-alias-border-l2',
  '--dsw-alias-brand-primary',
  '--dsw-alias-interactive-bg-hover',
  '--dsw-alias-label-dimmed',
  '--dsw-alias-label-primary',
  '--dsw-alias-label-secondary',
  '--dsw-alias-label-tertiary',
  '--dsw-alias-state-error-primary',
  '--dsw-alias-state-success-primary',
  '--dsw-alias-state-warn-primary',
  '--dsw-alias-state-warn-secondary',
  '--dsw-alias-state-warn-tertiary',
])

describe('the stylesheet cannot be silently dead', () => {
  it('has balanced braces, so no rule is skipped as malformed', () => {
    let depth = 0
    let firstStray = -1
    for (let index = 0; index < TRAE_CARD_CSS.length; index += 1) {
      const char = TRAE_CARD_CSS[index]
      if (char === '{') depth += 1
      else if (char === '}') {
        depth -= 1
        if (depth < 0 && firstStray === -1) firstStray = index
      }
    }
    // Report the offset, because "expected -1 to be 1" says nothing useful.
    expect({ firstStray, depth }).toEqual({ firstStray: -1, depth: 0 })
  })

  it('only asks DSH for tokens that actually exist', () => {
    const used = new Set<string>()
    for (const match of TRAE_CARD_CSS.matchAll(/var\((--dsw-[a-z0-9-]+)/gi)) {
      if (match[1] !== undefined) used.add(match[1])
    }
    // Nothing may be invented: a name DSH does not define silently falls back.
    expect([...used].filter(name => !TOKENS_VERIFIED_AGAINST_DSH.has(name)).sort()).toEqual([])
    // ...and the list must not rot into a superset nobody prunes.
    expect(TOKENS_VERIFIED_AGAINST_DSH.size).toBe(used.size)
  })
})
