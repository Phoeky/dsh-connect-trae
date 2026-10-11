// @vitest-environment jsdom
/**
 * The card's 设置 block — the composer-credit readout switch, and the
 * follow-the-app switch beside it.
 *
 * WHY THIS FILE EXISTS: `showPointsInMainUi` is the ONLY switch for a readout
 * that lives in the shared composer toolbar, and the card is its ONLY writer. A
 * switch that renders but commits nothing — or commits a value the readout does
 * not read — leaves the feature unreachable with no way for the user to tell,
 * which is exactly the failure mode this plugin already shipped once (the 2.9.x
 * switch that painted but never persisted). So this spec renders the SHIPPED
 * card, clicks the real input, and asserts on the settings WRITE rather than on
 * internals.
 *
 * The switch is carried in BOTH regions, because the readout it gates serves
 * both provider routes (a CN balance on `trae`, the plan on `trae-global`). It
 * is one setting and one write on either tab — see the 国际版 specs below, which
 * exist because this box used to be hidden there.
 *
 * The block commits on 保存, so the write assertions go through the button: a
 * tick must NOT reach the settings document on its own (that is what makes
 * 放弃修改 mean something), and the save must write exactly the fields the
 * draft moved.
 *
 * The control is selected by its LABEL, never by position: the card also
 * carries the two per-region provider switches, and a positional pick would
 * silently start asserting about the wrong control. The block's buttons are
 * looked up inside the 设置 SECTION, because the model block above carries
 * 保存/放弃修改 buttons of its own with the same labels.
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { TraeUsageCard } from '../src/client/TraeUsageCard.tsx'
import { composerPointsEnabledOf } from '../src/client/ComposerPointsGate.tsx'
import type { TraeSettingsKey } from '../src/client/locales.ts'

afterEach(cleanup)

const t = ((key: TraeSettingsKey, params?: Record<string, unknown>) =>
  params === undefined ? key : `${key}:${JSON.stringify(params)}`) as never

/** A settings scope over a mutable section document, recording every write. */
function makeScope(initial: Record<string, unknown>, writable = true) {
  let value: Record<string, unknown> = { ...initial }
  const listeners = new Set<() => void>()
  const writes: { field: string; value: unknown }[] = []
  return {
    writes,
    snapshot: () => value,
    scope: {
      getSnapshot: () => ({ status: 'ready', value, writable }),
      subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
      set: async (field: string, next: unknown) => {
        writes.push({ field, value: next })
        value = { ...value, [field]: next }
        for (const listener of listeners) listener()
      },
    },
  }
}

/** The card body only exists once the card is expanded. */
function renderOpen(scope: unknown): void {
  render(<TraeUsageCard t={t} settingsScope={scope as never} />)
  fireEvent.click(screen.getByRole('button', { name: /row\.title/ }))
}

/** The composer-credits checkbox, by its own label. */
function creditsSwitch(): HTMLInputElement {
  // The label WRAPS the hint, so the accessible name is the label plus the hint
  // text — anchoring on the start keeps this independent of how the hint reads.
  const [box] = screen.getAllByRole('checkbox', { name: /^row\.showPointsInMainUi\b/ }) as HTMLInputElement[]
  if (box === undefined) throw new Error('the composer-credits checkbox is missing from the card')
  return box
}

/** The follow-the-app checkbox, by its own label. */
function followSwitch(): HTMLInputElement {
  const [box] = screen.getAllByRole('checkbox', { name: /^row\.followAppLogin\b/ }) as HTMLInputElement[]
  if (box === undefined) throw new Error('the follow-the-app checkbox is missing from the card')
  return box
}

/**
 * Wait for one preference write to reach the recorded document.
 *
 * There is no 保存 button any more: the 设置 block's switches commit on the
 * click that flips them, matching the sibling dsh-connect-workbuddy card. So the
 * assertion is simply that the write follows the tick.
 */
async function waitForWrite(writes: { field: string; value: unknown }[]): Promise<void> {
  await vi.waitFor(() => { expect(writes.length).toBeGreaterThan(0) })
}

describe('the composer-credits switch in the card', () => {
  it('exists and is UNCHECKED when nothing is stored (the host default is off)', () => {
    renderOpen(makeScope({}).scope)
    expect(creditsSwitch().checked).toBe(false)
  })

  it('is checked when the stored value is true, so an existing opt-in survives', () => {
    // The field is reused from the retired sidebar switch on purpose: a user who
    // had it on must keep the readout after upgrading, not find it silently off.
    renderOpen(makeScope({ showPointsInMainUi: true }).scope)
    expect(creditsSwitch().checked).toBe(true)
  })

  it('writes on the click that flips it — there is no 保存 to press', async () => {
    const holder = makeScope({})
    renderOpen(holder.scope)
    expect(creditsSwitch().checked).toBe(false)
    fireEvent.click(creditsSwitch())
    // The whole point of dropping the draft: one click, one write. A leftover
    // 保存/放弃 pair would leave this tick uncommitted and the readout off.
    await waitForWrite(holder.writes)
    expect(holder.writes).toEqual([{ field: 'showPointsInMainUi', value: true }])
    expect(composerPointsEnabledOf(holder.scope as never)).toBe(true)
  })

  it('writes false when unticked again, leaving the readout with nothing to render', async () => {
    const holder = makeScope({ showPointsInMainUi: true })
    renderOpen(holder.scope)
    const box = creditsSwitch()
    expect(box.checked).toBe(true)
    fireEvent.click(box)
    await waitForWrite(holder.writes)
    expect(holder.writes).toEqual([{ field: 'showPointsInMainUi', value: false }])
    expect(composerPointsEnabledOf(holder.scope as never)).toBe(false)
  })

  it('writes ONLY the switch that was clicked, never its sibling', async () => {
    // `followAppLogin` is already true in the document. An immediate write must
    // still name exactly one field: sending both would let this click clobber a
    // change made elsewhere with the value this card happened to read.
    const holder = makeScope({ followAppLogin: true })
    renderOpen(holder.scope)
    expect(followSwitch().checked).toBe(true)
    fireEvent.click(creditsSwitch())
    await waitForWrite(holder.writes)
    expect(holder.writes).toEqual([{ field: 'showPointsInMainUi', value: true }])
  })

  it('gives the flipped box the value the write landed, with no dirty badge to show', async () => {
    const holder = makeScope({})
    renderOpen(holder.scope)
    fireEvent.click(creditsSwitch())
    // The optimistic overlay is dropped once the write settles, so the box then
    // reads the committed document. Nothing may be left saying "unsaved".
    await waitForWrite(holder.writes)
    expect(creditsSwitch().checked).toBe(true)
    expect(screen.queryByText('row.settingsDirty')).toBeNull()
  })

  it('is PRESENT on the 国际版 tab too: that region has a plan readout to mirror', () => {
    // The switch was CN-only while the underlying readout was. It is not any
    // more: the composer readout serves BOTH provider routes, showing a CN
    // BALANCE on `trae` and the PLAN on `trae-global` (see `ComposerPoints`).
    // Hiding the switch on the international tab left that readout reachable
    // from nowhere, so the box is carried in both regions — it is the same
    // setting and the same write, not a second switch.
    renderOpen(makeScope({}).scope)
    expect(creditsSwitch()).not.toBeNull()

    fireEvent.click(screen.getByRole('tab', { name: /row\.tabAi/ }))
    expect(creditsSwitch()).not.toBeNull()

    // ...and it is still there on the CN tab.
    fireEvent.click(screen.getByRole('tab', { name: /row\.tabCn/ }))
    expect(creditsSwitch()).not.toBeNull()
  })

  it('still writes the same field from the 国际版 tab', async () => {
    // One setting, two regions: the box on the ai tab must commit exactly the
    // field the readout reads. A per-region copy of this switch would need two
    // settings and would let the readout disagree with the tab it was set on.
    const holder = makeScope({})
    renderOpen(holder.scope)
    fireEvent.click(screen.getByRole('tab', { name: /row\.tabAi/ }))
    fireEvent.click(creditsSwitch())
    await waitForWrite(holder.writes)
    expect(holder.writes).toEqual([{ field: 'showPointsInMainUi', value: true }])
    expect(composerPointsEnabledOf(holder.scope as never)).toBe(true)
  })

  it('names the readout this tab actually gets in the hint', () => {
    // The hint used to describe both regions at once ("…on the CN side, …on the
    // international one") because it only ever rendered on one tab. Now that it
    // renders on both, the hint is scoped to the tab it is on, so the box
    // answers "what do I get if I tick this?" without a tab switch.
    renderOpen(makeScope({}).scope)
    expect(screen.getByText('row.showPointsInMainUiHint')).toBeTruthy()

    fireEvent.click(screen.getByRole('tab', { name: /row\.tabAi/ }))
    expect(screen.getByText('row.showPointsInMainUiHintAi')).toBeTruthy()
    expect(screen.queryByText('row.showPointsInMainUiHint')).toBeNull()
  })

  it('refuses to write on a read-only scope, and stays unchecked', () => {
    const holder = makeScope({}, false)
    renderOpen(holder.scope)
    const box = creditsSwitch()
    expect(box.disabled).toBe(true)
    fireEvent.click(box)
    expect(holder.writes).toHaveLength(0)
  })
})
