// @vitest-environment jsdom
/**
 * The pool's tool row and `AccountTransfer` must not both print a heading.
 *
 * Reported from the rendered card: the dashed tool row carried a left label
 * ("export / import accounts") and the transfer section underneath printed its
 * own heading with the same words, so one pair of buttons appeared to be
 * described twice. `hideLabel` exists for exactly that mount; the roster keeps
 * the heading because nothing else labels it there.
 */
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  IconChevronDownOutline14: () => null,
}))

import * as React from 'react'
import { AccountTransfer } from '../src/client/AccountTransfer.tsx'
import { TRAE_CARD_CSS } from '../src/client/styles.ts'
import type { TraeSettingsKey } from '../src/client/locales.ts'

const t = ((key: TraeSettingsKey) => key) as (key: TraeSettingsKey) => string

afterEach(() => { cleanup() })

describe('AccountTransfer heading', () => {
  it('prints its own heading when nothing else labels it', () => {
    render(<AccountTransfer t={t} region="cn" accounts={[]} />)
    expect(screen.getByText('row.transferTitle')).toBeTruthy()
  })

  it('drops the heading when the caller already printed one', () => {
    const { container } = render(<AccountTransfer t={t} region="cn" accounts={[]} hideLabel />)
    expect(screen.queryByText('row.transferTitle')).toBeNull()
    // The buttons still render, and the section keeps its accessible name.
    expect(screen.getByText('row.transferExport')).toBeTruthy()
    expect(container.querySelector('.dsm-trae-transfer')?.getAttribute('aria-label')).toBe('row.transferTitle')
  })

  it('drops the divider too, so the two buttons sit in the caller’s row', () => {
    // Without this the section keeps `border-top` + top margin and the buttons
    // hang below a stray rule instead of standing beside the row's label.
    const { container } = render(<AccountTransfer t={t} region="cn" accounts={[]} hideLabel />)
    expect(container.querySelector('.dsm-trae-transfer-flat')).toBeTruthy()
    const flat = /\.dsm-trae-transfer-flat\{([^}]*)\}/.exec(TRAE_CARD_CSS)
    expect(flat?.[1]).toContain('border-top:0')
  })
})
