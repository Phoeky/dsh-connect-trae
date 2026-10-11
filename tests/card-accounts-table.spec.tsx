// @vitest-environment jsdom
/**
 * The card's account block — the table that replaced the account dropdown.
 *
 * WHY THIS FILE EXISTS: a machine can hold several Trae sign-ins, and the ONE
 * thing the card has to get right is which account a click binds. A dropdown
 * could only ever show the account already chosen; the table shows the roster.
 * Three properties have to hold, and each has a way of breaking silently:
 *
 *  1. the row the plugin is bound to is MARKED, and its own action is not
 *     offered (a disabled "switch to the account you are on" is noise, and an
 *     enabled one is a wasted settings write);
 *  2. switching writes ONLY that region's slot: the sibling region's pick is
 *     carried through, so switching the CN account never rebinds the
 *     international one (this plugin serves both at once — issue #11);
 *  3. balances are read ON DEMAND and never on open. The route pays one
 *     upstream read PER ACCOUNT, so a card that is merely being looked at must
 *     not bill the whole roster.
 *
 * It also pins the DELIBERATE absence of any bulk check-in: Trae allows one
 * check-in per DEVICE per day, so a "do it for every account" sweep could only
 * ever produce a refusal per account after the first. The check-in control stays
 * a single-account button, and this spec fails if a per-row or bulk claim
 * appears beside the table.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Primitives ships browser-only CSS modules that jsdom cannot transform; the
// card needs exactly one icon from it.
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  IconChevronDownOutline14: () => null,
}))

import { TraeUsageCard } from '../src/client/TraeUsageCard.tsx'
import { TRAE_ACCOUNT_CREDITS_PATH, TRAE_CHECKIN_PATH, TRAE_USAGE_PATH, withTraeRegion } from '../src/status-paths.ts'
import type { TraeSettingsKey } from '../src/client/locales.ts'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const t = ((key: TraeSettingsKey, params?: Record<string, unknown>) =>
  params === undefined ? key : `${key}:${JSON.stringify(params)}`) as never

/** A settings scope over a mutable document, recording every write. */
function makeScope(initial: Record<string, unknown> = {}, writable = true) {
  let value: Record<string, unknown> = structuredClone(initial)
  const listeners = new Set<() => void>()
  const writes: { field: string; value: unknown }[] = []
  return {
    writes,
    scope: {
      getSnapshot: () => ({ status: 'ready', value, writable }),
      subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
      set: async (field: string, next: unknown) => {
        writes.push({ field, value: structuredClone(next) })
        value = { ...value, [field]: structuredClone(next) }
        for (const listener of listeners) listener()
      },
    },
  }
}

const ACCOUNTS = [
  { id: 'account-1', accountName: 'LaoDing', edition: 'cn', region: 'cn', source: 'desktop', tokenExpiresAtMs: Date.now() + 3_600_000, selected: true },
  { id: 'account-2', accountName: 'SecondCN', edition: 'solo', region: 'cn', source: 'cli', tokenExpiresAtMs: Date.now() + 7_200_000, selected: false },
]

/** A signed-in CN document carrying the roster under test. */
function usageDocument(overrides: Record<string, unknown> = {}) {
  return {
    status: 'signed-in',
    accountId: 'account-1',
    accountName: 'LaoDing',
    tokenExpiresAtMs: Date.now() + 3_600_000,
    region: 'cn',
    enabled: true,
    accounts: ACCOUNTS,
    models: [],
    enabledModelIds: [],
    credits: { total: 7500, consumed: 5_879.63, available: 1_620.37, workAvailable: 0, generalAvailable: 20.37, accounts: [] },
    ...overrides,
  }
}

/**
 * Stub the card's routes and record what was requested.
 *
 * `creditsAnswer` is what the per-account balance route answers; a non-200 is
 * how the failure path is exercised.
 */
function stubFetch(
  document: Record<string, unknown>,
  creditsAnswer: { status?: number; body?: unknown } = {},
): { calls: { url: string; method: string }[] } {
  const calls: { url: string; method: string }[] = []
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, method: init?.method ?? 'GET' })
    if (url.startsWith(TRAE_ACCOUNT_CREDITS_PATH)) {
      return new Response(JSON.stringify(creditsAnswer.body ?? { accounts: [] }), { status: creditsAnswer.status ?? 200 })
    }
    if (url.startsWith(TRAE_CHECKIN_PATH)) {
      return new Response(JSON.stringify({ claimed: true, alreadyCheckedIn: false, code: 0, checkin: {} }), { status: 200 })
    }
    if (url.startsWith(TRAE_USAGE_PATH)) return new Response(JSON.stringify(document), { status: 200 })
    throw new Error(`unexpected fetch: ${url}`)
  })
  return { calls }
}

/** Render the card expanded and wait for the account table to exist. */
async function renderOpen(scope: unknown): Promise<void> {
  render(<TraeUsageCard t={t} settingsScope={scope as never} />)
  fireEvent.click(screen.getByRole('button', { name: /row\.title/ }))
  await waitFor(() => { expect(screen.getByRole('region', { name: 'row.accountsTitle' })).toBeTruthy() })
}

/** The account block, so its buttons are never confused with the model block's. */
function accountBlock(): HTMLElement {
  return screen.getByRole('region', { name: 'row.accountsTitle' })
}

/** One account row, by the account name it renders. */
function accountRow(name: string): HTMLTableRowElement {
  return within(accountBlock()).getByText(name).closest('tr') as HTMLTableRowElement
}

describe('the account table in the card', () => {
  it('lists every detected account with its product, source and expiry', async () => {
    stubFetch(usageDocument())
    const { scope } = makeScope()
    await renderOpen(scope)

    const rows = within(accountBlock()).getAllByRole('row')
    // Two accounts plus the header row.
    expect(rows).toHaveLength(3)

    // The raw `edition` token used to be all the user got: "solo" told them
    // nothing about which product the credential came from (issue #25).
    expect(accountRow('SecondCN').textContent).toContain('row.editionSolo')
    expect(accountRow('SecondCN').textContent).toContain('row.sourceCli')
    expect(accountRow('LaoDing').textContent).toContain('row.sourceDesktop')
  })

  it('marks the bound account and does not offer it an action', async () => {
    stubFetch(usageDocument())
    const { scope } = makeScope()
    await renderOpen(scope)

    const current = accountRow('LaoDing')
    expect(current.className).toContain('dsm-trae-accounts-row-current')
    expect(current.textContent).toContain('row.accountCurrentBadge')

    const other = accountRow('SecondCN')
    expect(other.className).not.toContain('dsm-trae-accounts-row-current')

    const [currentAction, otherAction] = within(accountBlock()).getAllByRole('button').filter(
      button => /row\.accountCurrentBadge|row\.accountSwitch/.test(button.textContent ?? ''),
    ) as HTMLButtonElement[]
    expect(currentAction?.disabled).toBe(true)
    expect(otherAction?.disabled).toBe(false)
  })

  it('switches to a clicked account, writing only its own region slot', async () => {
    // The international tab already points at its own account: switching the CN
    // one must carry that slot through untouched, not clear it.
    stubFetch(usageDocument())
    const holder = makeScope({ accounts: { ai: 'account-sg' } })
    await renderOpen(holder.scope)

    const action = within(accountRow('SecondCN')).getByRole('button', { name: 'row.accountSwitch' })
    fireEvent.click(action)

    await vi.waitFor(() => { expect(holder.writes.length).toBeGreaterThan(0) })
    expect(holder.writes[0]).toEqual({ field: 'accounts', value: { ai: 'account-sg', cn: 'account-2' } })
  })

  it('shows the bound account balance from the usage document without any extra read', async () => {
    // The bound account's figure is already in the document the card fetched:
    // paying a per-account read for it would be a charge for nothing.
    const { calls } = stubFetch(usageDocument())
    const { scope } = makeScope()
    await renderOpen(scope)

    expect(accountRow('LaoDing').textContent).toMatch(/20/)
    // The unknown account stays unknown — and the column is honest about it.
    expect(accountRow('SecondCN').textContent).toContain('—')
    expect(calls.filter(call => call.url.startsWith(TRAE_ACCOUNT_CREDITS_PATH))).toEqual([])
  })

  it('reads every balance only when asked, and fills the column', async () => {
    const { calls } = stubFetch(usageDocument(), {
      body: {
        accounts: [
          { id: 'account-1', accountName: 'LaoDing', selected: true, generalAvailable: 20.37 },
          { id: 'account-2', accountName: 'SecondCN', selected: false, generalAvailable: 1_234.56 },
        ],
      },
    })
    const { scope } = makeScope()
    await renderOpen(scope)

    expect(calls.filter(call => call.url.startsWith(TRAE_ACCOUNT_CREDITS_PATH))).toEqual([])

    fireEvent.click(within(accountBlock()).getByRole('button', { name: 'row.accountsReadCredits' }))

    await vi.waitFor(() => { expect(accountRow('SecondCN').textContent).toMatch(/1,?23[45]/) })
    const reads = calls.filter(call => call.url.startsWith(TRAE_ACCOUNT_CREDITS_PATH))
    expect(reads).toHaveLength(1)
    // Region-scoped like every other route on this card.
    expect(reads[0]?.url).toBe(withTraeRegion(TRAE_ACCOUNT_CREDITS_PATH, 'cn'))
  })

  it('reports a failed balance read instead of pretending the accounts are empty', async () => {
    stubFetch(usageDocument(), { status: 502, body: { message: 'gateway' } })
    const { scope } = makeScope()
    await renderOpen(scope)

    fireEvent.click(within(accountBlock()).getByRole('button', { name: 'row.accountsReadCredits' }))

    await waitFor(() => {
      expect(within(accountBlock()).getByRole('alert').textContent).toContain('row.accountsCreditsFailed')
    })
    // The roster itself is untouched by a failed figure.
    expect(accountRow('SecondCN')).toBeTruthy()
  })

  it('offers exactly ONE check-in control for the whole roster — never a per-account sweep', async () => {
    // Trae's rule, verified live 2026-10-11: `did_checked_in` is keyed on the
    // DEVICE, so after the first account claims, every further account on this
    // machine answers 9095. A "check in every account" button could therefore
    // only ever fail after the first one, which is why the card offers none.
    stubFetch(usageDocument({
      checkin: { checkedIn: false, didCheckedIn: false, credits: 150, enabled: true, extraCredits: 50 },
    }))
    const { scope } = makeScope()
    await renderOpen(scope)

    await waitFor(() => { expect(screen.getByText(/row\.checkinLabel/)).toBeTruthy() })
    expect(screen.getAllByRole('button', { name: /row\.checkinClaim/ })).toHaveLength(1)
    // ...and it lives OUTSIDE the account table, so no row can carry its own.
    expect(within(accountBlock()).queryByRole('button', { name: /row\.checkin/ })).toBeNull()
  })
})
