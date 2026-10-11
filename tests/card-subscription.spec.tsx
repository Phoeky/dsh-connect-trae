// @vitest-environment jsdom
/**
 * The card's international subscription status, shown in the ai account row.
 *
 * WHY THIS FILE EXISTS — read before deleting or weakening it:
 * issue #19 reported a Pro member seeing "No active package". The old row
 * judged the account on `has_package` ALONE, which answers "does a package
 * entitlement row exist", not "is this account on a paid plan". Trae publishes
 * the plan separately as `user_pay_identity_str`, and the card now reads it.
 *
 * Subscription lives in the international account row (per account, via the
 * status route), so these specs render the SHIPPED `TraeUsageCard` with an ai
 * roster and assert on the per-row verdict drawn. A future edit that quietly
 * drops the plan identity again fails here.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  IconChevronDownOutline14: () => null,
}))

import { TraeUsageCard } from '../src/client/TraeUsageCard.tsx'
import { TRAE_ACCOUNT_STATUS_PATH, TRAE_USAGE_PATH, traePlanIsPaid, withTraeRegion } from '../src/status-paths.ts'
import type { TraeSettingsKey } from '../src/client/locales.ts'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const t = ((key: TraeSettingsKey, params?: Record<string, unknown>) =>
  params === undefined ? key : `${key}:${JSON.stringify(params)}`) as never

function makeScope(initial: Record<string, unknown> = {}, writable = true) {
  let value: Record<string, unknown> = structuredClone(initial)
  const listeners = new Set<() => void>()
  return {
    scope: {
      getSnapshot: () => ({ status: 'ready', value, writable }),
      subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
      set: async (field: string, next: unknown) => {
        value = { ...value, [field]: structuredClone(next) }
        for (const listener of listeners) listener()
      },
    },
  }
}

const AI_ACCOUNT = { id: 'account-1', accountName: 'LaoDing', edition: 'sg', region: 'ai', source: 'desktop', tokenExpiresAtMs: Date.now() + 3_600_000, selected: true }

/** One signed-in ai document carrying the roster whose row holds subscription. */
function payDocument(overrides: Record<string, unknown> = {}) {
  return {
    status: 'signed-in',
    accountId: 'account-1',
    accountName: 'LaoDing',
    tokenExpiresAtMs: Date.now() + 3_600_000,
    region: 'ai',
    enabled: true,
    accounts: [AI_ACCOUNT],
    models: [],
    enabledModelIds: [],
    credits: undefined,
    ...overrides,
  }
}

function stubFetch(document: Record<string, unknown>, payStatus: Record<string, unknown>): void {
  vi.stubGlobal('fetch', async (input: string | URL | Request) => {
    const url = String(input)
    if (url.startsWith(TRAE_ACCOUNT_STATUS_PATH)) {
      return new Response(JSON.stringify({
        id: 'account-1',
        payStatus: {
          isDollarUsageBilling: true, hasPackage: false, isPayFreshman: false,
          inTrial: false, trialEndTimeMs: 0,
          enableSoloLite: false, enableSoloBuilder: false, enableSoloCoder: false, enableSoloWeb: false,
          ...payStatus,
        },
      }), { status: 200 })
    }
    if (url.startsWith(TRAE_USAGE_PATH)) return new Response(JSON.stringify(document), { status: 200 })
    throw new Error(`unexpected fetch: ${url}`)
  })
}

/** Render the card expanded, switch to the ai tab, and wait for the account row. */
async function renderArtificialAccount(): Promise<void> {
  const { scope } = makeScope()
  render(<TraeUsageCard t={t} settingsScope={scope as never} />)
  fireEvent.click(screen.getByRole('button', { name: /row\.title/ }))
  fireEvent.click(screen.getByRole('tab', { name: /row\.tabAi/ }))
  await waitFor(() => { expect(screen.getByText('LaoDing')).toBeTruthy() })
}

/** The account block, so its buttons are never confused with the model block's. */
function accountBlock(): HTMLElement {
  return screen.getByRole('region', { name: 'row.accountsTitle' })
}

/** One account row, by the account name it renders. */
function accountRow(name: string): HTMLLIElement {
  return within(accountBlock()).getByText(name).closest('li') as HTMLLIElement
}

describe('traePlanIsPaid', () => {
  it('treats only the exact Free identity as unpaid', () => {
    expect(traePlanIsPaid('Free')).toBe(false)
    expect(traePlanIsPaid('free')).toBe(false)
    expect(traePlanIsPaid('  Free  ')).toBe(false)
    expect(traePlanIsPaid(undefined)).toBe(false)
    expect(traePlanIsPaid('')).toBe(false)
    expect(traePlanIsPaid('Pro')).toBe(true)
    // An unrecognised tier is NOT "Free": understating a paid plan is the more
    // damaging error, and it is the one issue #19 hit.
    expect(traePlanIsPaid('Pro+')).toBe(true)
    expect(traePlanIsPaid('Trial')).toBe(true)
  })
})

/**
 * The international tab's subscription BOX — a separate surface from the roster
 * row.
 *
 * WHY IT NEEDS ITS OWN GUARD: the visual redesign deleted the standalone stat
 * blocks and left `rowValue` in each row as the only renderer of the plan.
 * `rowValue` returns NOTHING when `payStatus` has not arrived, so the ai tab
 * could show an empty strip where the CN tab keeps a credit panel — the report
 * 「国际版没有那个积分框」. These three specs pin the box as its own element:
 * it must render on the tab, and it must degrade to a labelled state rather
 * than disappear, because "nothing rendered" and "this feature was removed"
 * are indistinguishable to a reader.
 */
describe('TraeUsageCard subscription box (ai)', () => {
  it('renders a subscription box on the tab, naming the tier', async () => {
    stubFetch(payDocument(), { hasPackage: false, payIdentity: 5, payIdentityStr: 'Pro' })
    await renderArtificialAccount()

    // Wait for the TIER, not just for a status region: several regions share
    // role=status, and the roster's empty roster answers first. Once it lands,
    // the box must carry both the label and the plan Trae reports (issue #19:
    // a bare boolean says nothing).
    // BOTH the box and the roster row name the tier — two vantage points, so
    // the assertion must pick the one carrying the box's own class rather than
    // whichever React mounted first.
    const tier = await screen.findAllByText('row.planTier:{"tier":"Pro"}')
    const boxTier = tier.find(element => element.className.includes('dsm-trae-usage-expiry'))
    expect(boxTier).toBeDefined()
    expect(within(boxTier?.closest('.dsm-trae-usage-account') as HTMLElement).getByText('row.subscriptionLabel')).toBeTruthy()
  })

  it('does not render the box on the CN tab', async () => {
    stubFetch(payDocument(), { hasPackage: false, payIdentity: 5, payIdentityStr: 'Pro' })
    const { scope } = makeScope()
    render(<TraeUsageCard t={t} settingsScope={scope as never} />)
    fireEvent.click(screen.getByRole('button', { name: /row\.title/ }))
    await waitFor(() => { expect(screen.getByRole('region', { name: 'row.accountsTitle' })).toBeTruthy() })

    // CN reports credit packs, not a plan; a subscription box on that tab
    // would be answering a question the tab does not ask.
    expect(screen.queryByText('row.subscriptionLabel')).toBeNull()
  })

  it('renders a labelled box instead of an empty strip when payStatus never arrives', async () => {
    vi.stubGlobal('fetch', async (input: string | URL | Request) => {
      const url = String(input)
      // The status route answers, but WITHOUT `payStatus` — the degraded shape
      // that made the box vanish before this guard existed.
      if (url.startsWith(TRAE_ACCOUNT_STATUS_PATH)) return new Response(JSON.stringify({ id: 'account-1' }), { status: 200 })
      if (url.startsWith(TRAE_USAGE_PATH)) return new Response(JSON.stringify(payDocument()), { status: 200 })
      throw new Error(`unexpected fetch: ${url}`)
    })
    await renderArtificialAccount()

    // Not blank: the label plus an explicit "not loaded" state, so a missing
    // read is never mistaken for a removed feature.
    const box = await screen.findByRole('status')
    expect(within(box).getByText('row.subscriptionLabel')).toBeTruthy()
    expect(within(box).getByText('row.payStatusUnknown')).toBeTruthy()
  })
})

describe('TraeUsageCard subscription row (ai)', () => {
  it('shows a member as subscribed from the plan identity alone', async () => {
    // has_package stays false, exactly as the reporter's account behaved.
    stubFetch(payDocument(), { hasPackage: false, payIdentity: 5, payIdentityStr: 'Pro' })
    await renderArtificialAccount()

    // The row names the plan ON its balance line — one verdict, one line, no
    // separate subscription block beside the roster.
    await waitFor(() => { expect(within(accountRow('LaoDing')).getByText('row.planTier:{"tier":"Pro"}')).toBeTruthy() })
    expect(within(accountRow('LaoDing')).queryByText('row.noPackage')).toBeNull()
  })

  it('still reports a package entitlement without a plan identity', async () => {
    stubFetch(payDocument(), { hasPackage: true })
    await renderArtificialAccount()

    // Without a tier string the row renders the bare subscribed label; what
    // matters is that it is on and does not claim "no package".
    await waitFor(() => { expect(within(accountRow('LaoDing')).getByText('row.subscribed')).toBeTruthy() })
    expect(within(accountRow('LaoDing')).queryByText('row.noPackage')).toBeNull()
  })

  it('names the free tier instead of only saying there is no package', async () => {
    stubFetch(payDocument(), { hasPackage: false, payIdentity: 0, payIdentityStr: 'Free' })
    await renderArtificialAccount()

    await waitFor(() => { expect(within(accountRow('LaoDing')).getByText('row.noPackage')).toBeTruthy() })
    expect(within(accountRow('LaoDing')).queryByText('row.subscribed')).toBeNull()
  })

  it('reads the subscription through the region-scoped per-account status route', async () => {
    stubFetch(payDocument(), { hasPackage: true, payIdentity: 5, payIdentityStr: 'Pro' })
    const { scope } = makeScope()
    const readUrls: string[] = []
    vi.stubGlobal('fetch', async (input: string | URL | Request) => {
      const url = String(input)
      if (url.startsWith(TRAE_ACCOUNT_STATUS_PATH)) { readUrls.push(url); return new Response(JSON.stringify({ id: 'account-1' }), { status: 200 }) }
      if (url.startsWith(TRAE_USAGE_PATH)) return new Response(JSON.stringify(payDocument()), { status: 200 })
      throw new Error(`unexpected fetch: ${url}`)
    })
    render(<TraeUsageCard t={t} settingsScope={scope as never} />)
    fireEvent.click(screen.getByRole('button', { name: /row\.title/ }))
    fireEvent.click(screen.getByRole('tab', { name: /row\.tabAi/ }))
    await waitFor(() => { expect(screen.getByText('LaoDing')).toBeTruthy() })

    // The row's subscription is read from the per-account status route, and the
    // read is region-scoped to ai exactly like every other route on this card.
    expect(readUrls.length).toBe(1)
    expect(readUrls[0]).toContain(withTraeRegion(TRAE_ACCOUNT_STATUS_PATH, 'ai') + '&accountId=')
  })
})
