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
  const [box] = screen.getAllByRole('checkbox', { name: /row\.showPointsInMainUi$/ }) as HTMLInputElement[]
  if (box === undefined) throw new Error('the composer-credits checkbox is missing from the card')
  return box
}

/** The follow-the-app checkbox, by its own label. */
function followSwitch(): HTMLInputElement {
  const [box] = screen.getAllByRole('checkbox', { name: /row\.followAppLogin$/ }) as HTMLInputElement[]
  if (box === undefined) throw new Error('the follow-the-app checkbox is missing from the card')
  return box
}

/** The 设置 section, so its 保存/放弃修改 are never confused with the model block's. */
function settingsBlock(): HTMLElement {
  return screen.getByRole('region', { name: 'row.settingsTitle' })
}

function settingsButton(name: string): HTMLElement {
  return within(settingsBlock()).getByRole('button', { name })
}

/** Press 保存 and wait for the write chain to reach the recorded document. */
async function saveSettings(writes: { field: string; value: unknown }[]): Promise<void> {
  fireEvent.click(settingsButton('row.save'))
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

  it('stages the tick without writing: nothing reaches the settings document until 保存', () => {
    const holder = makeScope({})
    renderOpen(holder.scope)
    fireEvent.click(creditsSwitch())
    expect(holder.writes).toEqual([])
    expect(composerPointsEnabledOf(holder.scope as never)).toBe(false)
    // The draft is visible, so an unsaved tick can never look saved.
    expect(within(settingsBlock()).getByRole('status').textContent).toBe('row.settingsDirty')
  })

  it('writes showPointsInMainUi=true on 保存 and drops the dirty badge', async () => {
    const holder = makeScope({})
    renderOpen(holder.scope)
    fireEvent.click(creditsSwitch())
    await saveSettings(holder.writes)
    expect(holder.writes).toEqual([{ field: 'showPointsInMainUi', value: true }])
    // The readout's own predicate must agree with what the card committed.
    expect(composerPointsEnabledOf(holder.scope as never)).toBe(true)
    expect(within(settingsBlock()).queryByRole('status')).toBeNull()
  })

  it('writes false when unticked again, leaving the readout with nothing to render', async () => {
    const holder = makeScope({ showPointsInMainUi: true })
    renderOpen(holder.scope)
    const box = creditsSwitch()
    expect(box.checked).toBe(true)
    fireEvent.click(box)
    await saveSettings(holder.writes)
    expect(holder.writes).toEqual([{ field: 'showPointsInMainUi', value: false }])
    expect(composerPointsEnabledOf(holder.scope as never)).toBe(false)
  })

  it('saves both switches in one press, writing only the fields the draft moved', async () => {
    // `followAppLogin` is already true in the document: a save must not rewrite
    // it, or a draft that never touched it would be able to clobber a change
    // made elsewhere with the value this card happened to read.
    const holder = makeScope({ followAppLogin: true })
    renderOpen(holder.scope)
    expect(followSwitch().checked).toBe(true)
    fireEvent.click(creditsSwitch())
    await saveSettings(holder.writes)
    expect(holder.writes).toEqual([{ field: 'showPointsInMainUi', value: true }])
  })

  it('放弃修改 drops the draft and writes nothing', () => {
    const holder = makeScope({})
    renderOpen(holder.scope)
    fireEvent.click(creditsSwitch())
    expect(creditsSwitch().checked).toBe(true)
    fireEvent.click(settingsButton('row.discard'))
    expect(creditsSwitch().checked).toBe(false)
    expect(holder.writes).toEqual([])
    expect(within(settingsBlock()).queryByRole('status')).toBeNull()
  })

  it('is ABSENT on the 国际版 tab: that region has no balance to mirror', () => {
    // The switch is CN-only because the DATA is. The Host builds the `ai` usage
    // document from `payStatus` and never sets `credits` on it, so an
    // international tab offering "show the credit readout" would promise
    // something that cannot render.
    renderOpen(makeScope({}).scope)
    expect(screen.queryByRole('checkbox', { name: /row\.showPointsInMainUi$/ })).not.toBeNull()

    fireEvent.click(screen.getByRole('tab', { name: /row\.tabAi/ }))
    expect(screen.queryByRole('checkbox', { name: /row\.showPointsInMainUi$/ })).toBeNull()

    // ...and it comes back on the CN tab.
    fireEvent.click(screen.getByRole('tab', { name: /row\.tabCn/ }))
    expect(screen.queryByRole('checkbox', { name: /row\.showPointsInMainUi$/ })).not.toBeNull()
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
