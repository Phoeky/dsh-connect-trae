/**
 * The account-pool card UI for Trae, ported from the WorkBuddy sibling.
 *
 * Mounted by {@link TraeUsageCard} inside the signed-in branch, below the
 * account table, rendered only when the usage document carries `pool` (the Host
 * omits it when the panel is unconfigured).
 *
 * This half of the feature is deliberately dumb about rules: every verdict an
 * account needs — credits, exclusion, the in-pool flag, the serving row — comes
 * pre-derived by the Host (`TraeWebPoolAccount`), so the card never re-ranks on
 * its own idea of "which account should bill". It drafts the saved preferences
 * (`TraePoolPreferences`) and writes them back through the card's verified
 * regions-write helper.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import {
  regionPoolOf,
  nextRegionPool,
  withTraePoolAction,
  withTraePoolAccount,
} from '../status-paths.ts'
import type {
  TraePanel,
  TraePoolPreferences,
  TraePoolCheckinRowView,
  TraePoolTestRowView,
  TraeWebModel,
  TraeWebPool,
  TraeWebPoolAccount,
  TraeWebPoolExclusion,
  TraeWebPoolOutcome,
  TraeWebPoolRemoveAnswer,
} from '../status-paths.ts'
import { writeSettingsField } from './TraeUsageCard.tsx'
import type { TraeSettingsKey } from './locales.ts'

interface AccountPoolProps {
  panel: TraePanel
  pool: TraeWebPool
  /** The panel's live model catalog, for the target-model select. */
  models: readonly TraeWebModel[]
  t: (key: TraeSettingsKey, params?: Record<string, unknown> | undefined) => string
  settingsScope?: {
    getSnapshot(): { status: string; value?: unknown; writable: boolean }
    subscribe(listener: () => void): () => void
    set(field: string, value: unknown): Promise<boolean>
  } | undefined
  /** Called after a successful save so the card can re-read the pool document. */
  onChanged?: () => void
  /** Re-read the region's usage after a remove/checkin/test so rows refresh. */
  onRefresh?: () => void
}

interface LogEntry {
  id: number
  tone: 'ok' | 'info' | 'warn' | 'error'
  text: string
}

/** Compare two arrays of ids order-insensitively. */
function sameIds(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  const lhs = [...(a ?? [])].sort()
  const rhs = [...(b ?? [])].sort()
  return lhs.length === rhs.length && lhs.every((v, i) => v === rhs[i])
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(value)
}

type T = AccountPoolProps['t']

function relativeAt(atMs: number, now: number, t: T): string {
  const mins = Math.max(0, Math.round((now - atMs) / 60_000))
  if (mins < 1) return t('row.poolAgoNow')
  if (mins < 60) return t('row.poolAgoMin', { n: mins })
  const hours = Math.round(mins / 60)
  if (hours < 24) return t('row.poolAgoHour', { n: hours })
  const days = Math.round(hours / 24)
  return t('row.poolAgoDay', { n: days })
}

/** A human label for every value of {@link TraeWebPoolOutcome}. */
function outcomeLabel(outcome: TraeWebPoolOutcome, t: T): string {
  switch (outcome) {
    case 'ok': return t('row.poolProbeOk')
    case 'rate-limited': return t('row.poolProbeRateLimited')
    case 'model-busy': return t('row.poolProbeModelBusy')
    case 'out-of-credit': return t('row.poolProbeOutOfCredit')
    case 'credential-rejected': return t('row.poolProbeCredentialRejected')
    case 'policy-rejected': return t('row.poolProbePolicyRejected')
    case 'plan-gated': return t('row.poolProbePlanGated')
    case 'unavailable': return t('row.poolProbeUnavailable')
    case 'not-found': return t('row.poolProbeNotFound')
    case 'failed': return t('row.poolProbeFailed')
  }
}

/** A human label for every value of {@link TraeWebPoolExclusion}. */
function exclusionLabel(exclusion: TraeWebPoolExclusion, t: T): string {
  switch (exclusion) {
    case 'unusable': return t('row.poolExcludedUnusable')
    case 'rate-limited': return t('row.poolExcludedRateLimited')
    case 'model-busy': return t('row.poolExcludedModelBusy')
    case 'out-of-credit': return t('row.poolExcludedOutOfCredit')
    case 'credential-rejected': return t('row.poolExcludedCredentialRejected')
    case 'policy-rejected': return t('row.poolExcludedPolicyRejected')
    case 'plan-gated': return t('row.poolExcludedPlanGated')
    case 'not-found': return t('row.poolExcludedNotFound')
    case 'unavailable': return t('row.poolExcludedUnavailable')
    case 'failed': return t('row.poolExcludedFailed')
  }
}

function probeSourceLabel(source: 'test-batch' | 'live-request' | undefined, t: T): string {
  switch (source) {
    case 'test-batch': return t('row.poolProbeSourceTest')
    case 'live-request': return t('row.poolProbeSourceLive')
    case undefined: return t('row.poolProbeSourceUnknown')
  }
}

/** The tone to log a test row result under. */
function outcomeTone(outcome: TraeWebPoolOutcome): LogEntry['tone'] {
  return outcome === 'ok' ? 'ok' : 'warn'
}

/** The serving account (Host's answer), for the header badge. */
function servingAccount(pool: TraeWebPool): TraeWebPoolAccount | undefined {
  return pool.accounts.find(account => account.current === true)
}

/**
 * Render a route refusal into a card-safe string. The error statuses the Host
 * can answer with are listed in the card doc; every one here must render as
 * TEXT (never crash). `origin-not-trusted`/`pool-unavailable` carry no body, so
 * they get a dedicated copy line keyed off the status.
 */
function renderRouteError(t: T, status: number, body: { reason?: unknown } | undefined): string {
  if (status === 403 && body?.reason === 'origin-not-trusted') return t('row.poolErrOrigin')
  if (status === 503) return t('row.poolErrUnavailable')
  if (status === 405) return t('row.poolErrMethod')
  if (status === 400) return t('row.poolErrBadRequest')
  if (status === 409) {
    switch (body?.reason) {
      case 'no-members': return t('row.poolErrNoMembers')
      case 'no-live-members': return t('row.poolErrNoLiveMembers')
      case 'checkin-unsupported': return t('row.poolErrCheckinUnsupported')
      case 'target-model-stale': return t('row.poolErrTargetStale')
      case 'no-free-model': return t('row.poolErrNoFreeModel')
      default: return t('row.poolErrConflict')
    }
  }
  return t('row.poolErrGeneric', { status: String(status) })
}

/** Whether one row is a saved member (dictates the in-pool tag / ghost badge). */
function isSavedMember(memberAccountIds: readonly string[] | undefined, accountId: string): boolean {
  return (memberAccountIds ?? []).includes(accountId)
}

interface TestMediaLine {
  row?: TraePoolTestRowView
  rows?: TraePoolTestRowView[]
  reason?: string
  error?: string
}

/**
 * Consume a `test` NDJSON answer line-by-line so rows render while the batch
 * runs. A non-JSON line is skipped; a `{reason:'pool-failed'}` line reports the
 * failure and counts as "saw something". Returns whether any usable line was
 * seen (a body with nothing parseable is a route bug the caller should surface).
 */
function consumeTestNdjson(
  text: string,
  t: T,
  onRow: (row: TraePoolTestRowView) => void,
  onFailure: (message: string) => void,
): boolean {
  let sawAny = false
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '') continue
    let parsed: TestMediaLine
    try { parsed = JSON.parse(line) } catch { continue }
    if (parsed.row !== undefined) {
      sawAny = true
      onRow(parsed.row)
    } else if (parsed.rows !== undefined) {
      sawAny = true
      for (const r of parsed.rows) onRow(r)
    } else if (parsed.reason === 'pool-failed') {
      sawAny = true
      onFailure(parsed.error ?? t('row.poolLogGeneric'))
    }
  }
  return sawAny
}

export function AccountPool({ panel, pool, models, t, settingsScope, onChanged, onRefresh }: AccountPoolProps): ReactElement | null {
  // Re-read saved preferences whenever the settings scope changes (a save here,
  // or a save elsewhere / a profile import). Without this the `saved` memo is
  // keyed on `settingsScope`/`pool` field PRIMITIVES, so a write that only
  // mutates the scope (no pool identity change) would leave the draft comparing
  // against a stale snapshot and the "unsaved changes" badge stuck on.
  const [settingsTick, setSettingsTick] = useState(0)

  // Saved preferences — the SOURCE OF TRUTH for what the pool actually does.
  // NON-NEGOTIABLE: `targetModelId` must read as the saved/pool value, NOT `''`,
  // while the Host still holds the old id. Reading `''` makes a controlled
  // select show "automatic" and the NEXT save erases the user's choice.
  const saved = useMemo(() => {
    const base = regionPoolOf(settingsScope?.getSnapshot().value, panel)
    return {
      enabled: base.enabled === true,
      targetModelId: base.targetModelId ?? pool.targetModelId ?? pool.staleTargetModelId ?? '',
      memberAccountIds: [...(base.memberAccountIds ?? [])],
    }
  }, [settingsTick, settingsScope, panel, pool.targetModelId, pool.staleTargetModelId])

  // The draft the user edits. The membership checkbox binds HERE (NON-NEGOTIABLE
  // #4), never to `account.member`.
  const [enabled, setEnabled] = useState(saved.enabled)
  const [targetModelId, setTargetModelId] = useState(saved.targetModelId ?? '')
  const [selected, setSelected] = useState(() => new Set(saved.memberAccountIds ?? []))
  const [busy, setBusy] = useState<'checkin' | 'test' | 'remove' | 'save' | undefined>(undefined)
  const [saveError, setSaveError] = useState<string | undefined>(undefined)
  const [testing, setTesting] = useState<{ done: number } | undefined>(undefined)
  const [rows, setRows] = useState<Readonly<Record<string, TraePoolTestRowView>>>({})
  const [removed, setRemoved] = useState<Readonly<Record<string, boolean>>>({})
  const [log, setLog] = useState<LogEntry[]>([])
  const [now, setNow] = useState(Date.now())
  const logId = useRef(0)
  const mountRef = useRef(true)

  useEffect(() => { mountRef.current = true; return () => { mountRef.current = false } }, [])

  useEffect(() => settingsScope?.subscribe(() => { setSettingsTick(tick => tick + 1) }), [settingsScope])

  const pushLog = (tone: LogEntry['tone'], text: string) => {
    if (!mountRef.current) return
    logId.current += 1
    setLog(prev => [...prev.slice(-49), { id: logId.current, tone, text }])
  }

  // Ghost members: saved but resolving to no local sign-in. They MUST still
  // render (as checked rows) so the user can see and remove them (#5).
  const knownIds = useMemo(() => new Set(pool.accounts.map(account => account.accountId)), [pool])
  const ghosts = useMemo(() => {
    const names = pool.memberNames ?? {}
    const result: { accountId: string; accountName: string }[] = []
    for (const id of saved.memberAccountIds ?? []) {
      if (!knownIds.has(id)) result.push({ accountId: id, accountName: names[id] ?? id })
    }
    return result
  }, [saved, pool, knownIds])

  // Dirty compares enabled / targetModelId / membership ids ORDER-INSENSITIVELY (#3).
  const dirty = enabled !== saved.enabled
    || (targetModelId ?? '') !== (saved.targetModelId ?? '')
    || !sameIds([...selected], saved.memberAccountIds)

  const writable = settingsScope?.getSnapshot().writable === true

  // Reset the draft when the saved preferences change identity (after a save or
  // a settings re-read elsewhere).
  const savedKey = useMemo(() => `${panel}:${saved.enabled}:${saved.targetModelId ?? ''}:${[...(saved.memberAccountIds ?? [])].sort().join('\u0000')}`, [panel, saved])
  useEffect(() => {
    setEnabled(saved.enabled)
    setTargetModelId(saved.targetModelId ?? '')
    setSelected(new Set(saved.memberAccountIds ?? []))
    setSaveError(undefined)
  }, [savedKey]) // eslint-disable-line react-hooks/exhaustive-deps

  const toggleMember = (accountId: string) => {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(accountId)) next.delete(accountId)
      else next.add(accountId)
      return next
    })
  }

  const selectAll = () => {
    setSelected(new Set([...pool.accounts.map(a => a.accountId), ...(saved.memberAccountIds ?? [])]))
  }
  const selectNone = () => setSelected(new Set())

  const discard = () => {
    setEnabled(saved.enabled)
    setTargetModelId(saved.targetModelId ?? '')
    setSelected(new Set(saved.memberAccountIds ?? []))
    setSaveError(undefined)
    pushLog('info', t('row.poolLogDiscarded'))
    setNow(Date.now())
  }

  const save = async (): Promise<void> => {
    if (!writable || busy !== undefined) return
    setBusy('save')
    setSaveError(undefined)
    try {
      const next: TraePoolPreferences = {
        enabled,
        ...(targetModelId === '' ? {} : { targetModelId }),
        memberAccountIds: [...selected],
      }
      await writeSettingsField(
        settingsScope,
        'regions',
        nextRegionPool(settingsScope.getSnapshot().value, panel, next),
        readBack => {
          const readPool = regionPoolOf(readBack, panel)
          return readPool.enabled === (next.enabled ?? false)
            && sameIds(readPool.memberAccountIds, next.memberAccountIds)
            && (readPool.targetModelId ?? '') === (next.targetModelId ?? '')
        },
      )
      pushLog('ok', t('row.poolLogSaved'))
      onChanged?.()
      onRefresh?.()
      setNow(Date.now())
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      setSaveError(t('row.poolSaveFailed', { message }))
      pushLog('error', t('row.poolLogSaveFailed'))
    } finally {
      if (mountRef.current) setBusy(undefined)
    }
  }

  const runCheckin = async (): Promise<void> => {
    if (busy !== undefined) return
    const members = [...selected]
    if (members.length === 0) { pushLog('warn', t('row.poolLogNoMembers')); return }
    setBusy('checkin')
    setNow(Date.now())
    pushLog('info', t('row.poolLogCheckinStart', { count: members.length }))
    try {
      const response = await fetch(withTraePoolAction(panel, 'checkin'), { method: 'POST' })
      const body = await response.json() as { rows?: TraePoolCheckinRowView[]; reason?: string } | undefined
      if (!response.ok) throw new Error(renderRouteError(t, response.status, body))
      for (const row of body?.rows ?? []) {
        switch (row.status) {
          case 'claimed': pushLog('ok', t('row.poolLogCheckinClaimed', { accountName: row.accountName })); break
          case 'already':
          case 'device-already': pushLog('info', t('row.poolLogCheckinAlready', { accountName: row.accountName })); break
          case 'failed':
          case 'disabled': pushLog('error', t('row.poolLogCheckinFailed', { accountName: row.accountName, message: row.message ?? '' })); break
        }
      }
      pushLog( members.length > 0 && body?.rows ? 'ok' : 'info', t('row.poolLogCheckinDone'))
      onRefresh?.()
      setNow(Date.now())
    } catch (error: unknown) {
      pushLog('error', t('row.poolLogBatchFailed', { message: error instanceof Error ? error.message : String(error) }))
    } finally {
      if (mountRef.current) setBusy(undefined)
    }
  }

  const runTest = async (): Promise<void> => {
    if (busy !== undefined) return
    const members = [...selected]
    if (members.length === 0) { pushLog('warn', t('row.poolLogNoMembers')); return }
    setBusy('test')
    setRows({})
    setTesting({ done: 0 })
    setNow(Date.now())
    const targetLabel = targetModelId === '' ? t('row.poolTargetAutoOption') : (models.find(m => m.id === targetModelId)?.name ?? targetModelId)
    pushLog('info', t('row.poolLogTestStart', { count: members.length, model: targetLabel }))
    try {
      const response = await fetch(withTraePoolAction(panel, 'test'), { method: 'POST' })
      const text = await response.text()
      const seen = new Set<string>()
      const ok = consumeTestNdjson(text, t, r => {
        setRows(prev => ({ ...prev, [r.accountId]: r }))
        seen.add(r.accountId)
        if (mountRef.current) setTesting({ done: seen.size })
        pushLog(outcomeTone(r.outcome), t('row.poolLogTestRow', { accountName: r.accountName, outcome: outcomeLabel(r.outcome, t) }))
      }, errorText => {
        pushLog('error', t('row.poolLogBatchFailed', { message: errorText }))
      })
      if (!ok) throw new Error(t('row.poolLogGeneric'))
      pushLog('ok', t('row.poolLogTestDone'))
      onRefresh?.()
      setNow(Date.now())
    } catch (error: unknown) {
      pushLog('error', t('row.poolLogBatchFailed', { message: error instanceof Error ? error.message : String(error) }))
    } finally {
      if (mountRef.current) { setBusy(undefined); setTesting(undefined) }
    }
  }

  const runSingleTest = async (account: TraeWebPoolAccount): Promise<void> => {
    if (busy !== undefined) return
    setBusy('test')
    setNow(Date.now())
    const targetLabel = targetModelId === '' ? t('row.poolTargetAutoOption') : (models.find(m => m.id === targetModelId)?.name ?? targetModelId)
    pushLog('info', t('row.poolLogRowTesting', { accountName: account.accountName }))
    try {
      const response = await fetch(withTraePoolAccount(panel, 'test', account.accountId), { method: 'POST' })
      const text = await response.text()
      const ok = consumeTestNdjson(text, t, r => {
        setRows(prev => ({ ...prev, [r.accountId]: r }))
        pushLog(outcomeTone(r.outcome), t('row.poolLogTestRow', { accountName: r.accountName, outcome: outcomeLabel(r.outcome, t), model: targetLabel }))
      }, errorText => {
        pushLog('error', t('row.poolLogBatchFailed', { message: errorText }))
      })
      if (!ok) throw new Error(t('row.poolLogGeneric'))
      onRefresh?.()
      setNow(Date.now())
    } catch (error: unknown) {
      pushLog('error', t('row.poolLogBatchFailed', { message: error instanceof Error ? error.message : String(error) }))
    } finally {
      if (mountRef.current) setBusy(undefined)
    }
  }

  const removeAccount = async (account: { accountId: string; accountName: string }): Promise<void> => {
    if (busy !== undefined) return
    setBusy('remove')
    setRemoved(prev => ({ ...prev, [account.accountId]: false }))
    try {
      const response = await fetch(withTraePoolAccount(panel, 'remove', account.accountId), { method: 'POST' })
      const body = await response.json() as (TraeWebPoolRemoveAnswer & { reason?: string }) | undefined
      if (!response.ok) throw new Error(renderRouteError(t, response.status, body))
      if (body?.removed !== true) throw new Error(t('row.poolRowRemoveFailed'))
      if (mountRef.current) setRemoved(prev => ({ ...prev, [account.accountId]: true }))
      pushLog('ok', t('row.poolRowRemoved', { accountName: account.accountName }))
      // If it was a ghost not in the rendered list, drop it from the draft too.
      setSelected(prev => { const next = new Set(prev); next.delete(account.accountId); return next })
      onRefresh?.()
      setNow(Date.now())
    } catch (error: unknown) {
      pushLog('error', t('row.poolRowRemoveError', { message: error instanceof Error ? error.message : String(error) }))
    } finally {
      if (mountRef.current) setBusy(undefined)
    }
  }

  const noCandidate = pool.noCandidate
  const showNoCandidate = pool.enabled && noCandidate !== undefined
  const serving = servingAccount(pool)

  return (
    <section className="dsm-trae-pool" aria-label={t('row.poolTitle')}>
      <header className="dsm-trae-pool-head">
        <div>
          <h3 className="dsm-trae-pool-title">{t('row.poolTitle')}</h3>
          <p className="dsm-trae-pool-region-note">{t('row.poolRegionNote')}</p>
        </div>
        {serving !== undefined
          ? <span className="dsm-trae-pool-current">{t('row.poolCurrentHeader', { account: serving.accountName })}</span>
          : null}
      </header>

      {/* Action row: check in all + test all + a busy line. */}
      <div className="dsm-trae-pool-actions">
        {pool.checkinSupported === true
          ? <button
              type="button"
              className="dsm-btn dsm-btn-outline dsm-trae-pool-action-checkin"
              disabled={busy !== undefined || !writable || selected.size === 0}
              onClick={() => { void runCheckin() }}
            >
              {busy === 'checkin' ? t('row.poolCheckingIn') : t('row.poolCheckinAll')}
            </button>
          : null}
        <button
          type="button"
          className="dsm-btn dsm-btn-outline dsm-trae-pool-action-test"
          disabled={busy !== undefined || selected.size === 0 || pool.targetModelSource === 'none'}
          title={pool.targetModelSource === 'none' ? t('row.poolTargetNoneHint') : undefined}
          onClick={() => { void runTest() }}
        >
          {busy === 'test' ? t('row.poolTesting') : t('row.poolTestAll')}
        </button>
        {(busy === 'checkin' || busy === 'test' || testing !== undefined)
          ? <span className="dsm-trae-pool-busy" role="status">{t('row.poolBusyHint')}</span>
          : null}
      </div>

      {showNoCandidate ? <NoCandidateNotice noCandidate={noCandidate} t={t} /> : null}

      {/* Membership table. Ghost members keep rendering as checked rows. */}
      <div className="dsm-trae-pool-members">
        <div className="dsm-trae-pool-members-head">
          <div>
            <h4 className="dsm-trae-pool-subtitle">{t('row.poolMembersTitle')}</h4>
            <p className="dsm-trae-pool-subnote">{t('row.poolSelectedCount', { count: selected.size, total: pool.accounts.length + ghosts.length })}</p>
          </div>
          <div className="dsm-trae-pool-select-actions">
            <button type="button" className="dsm-btn dsm-btn-outline" disabled={busy !== undefined} onClick={selectAll}>{t('row.poolSelectAll')}</button>
            <button type="button" className="dsm-btn dsm-btn-outline" disabled={busy !== undefined} onClick={selectNone}>{t('row.poolSelectNone')}</button>
          </div>
        </div>
        <div className="dsm-trae-pool-table" role="table" aria-label={t('row.poolMembersTitle')}>
          <MemberRowHeader t={t} checkinSupported={pool.checkinSupported} />
          {pool.accounts.map(account => (
            <MemberRow
              key={account.accountId}
              account={account}
              models={models}
              rows={rows}
              checked={selected.has(account.accountId)}
              savedMember={isSavedMember(pool.memberAccountIds ?? saved.memberAccountIds, account.accountId)}
              onToggle={() => { toggleMember(account.accountId) }}
              onTest={() => { void runSingleTest(account) }}
              t={t}
              disabled={busy !== undefined || !writable}
              removing={removed[account.accountId] === true}
              onRemove={() => { void removeAccount(account) }}
              formatNumber={formatNumber}
              relativeAt={relativeAt}
            />
          ))}
          {ghosts.map(ghost => (
            <MemberGhostRow
              key={`ghost:${ghost.accountId}`}
              ghost={ghost}
              checked={selected.has(ghost.accountId)}
              onToggle={() => { toggleMember(ghost.accountId) }}
              t={t}
              disabled={busy !== undefined || !writable}
              removing={removed[ghost.accountId] === true}
              onRemove={() => { void removeAccount(ghost) }}
            />
          ))}
        </div>
        {ghosts.length > 0
          ? <p className="dsm-trae-pool-ghost-note" role="status">
              {t('row.poolGhostMembers', { count: ghosts.length, names: ghosts.map(g => g.accountName).join('、') })}
            </p>
          : null}
        {dirty ? <p className="dsm-trae-pool-unsaved" role="status">{t('row.poolUnsavedMembers')}</p> : null}
      </div>

      {/* Settings block. */}
      <div className="dsm-trae-pool-settings">
        <div className="dsm-trae-pool-settings-head">
          <h4 className="dsm-trae-pool-subtitle">{t('row.poolSettingsTitle')}</h4>
          <p className="dsm-trae-pool-subnote">{t('row.poolSettingsHint')}</p>
        </div>

        <label className="dsm-trae-switch">
          <input
            type="checkbox"
            checked={enabled}
            disabled={busy !== undefined || !writable}
            onChange={(e) => { setEnabled(e.target.checked) }}
          />
          <span>{t('row.poolEnabled')}</span>
        </label>
        {saved.enabled === true && enabled === false
          ? <p className="dsm-trae-pool-off-notice" role="status">{t('row.poolOffNotice')}</p>
          : null}

        <label className="dsm-trae-pool-target">
          <span className="dsm-trae-pool-target-label">{t('row.poolTargetLabel')}</span>
          <select
            className="dsm-trae-select"
            value={targetModelId}
            disabled={busy !== undefined || !writable}
            onChange={(e) => { setTargetModelId(e.target.value) }}
          >
            <option value="">{t('row.poolTargetAutoOption')}</option>
            {models.map(model => <option key={model.id} value={model.id}>{model.name}</option>)}
            {pool.targetModelSource === 'stale' && pool.staleTargetModelId !== undefined
              ? <option value={pool.staleTargetModelId}>{t('row.poolTargetStaleOption', { model: pool.staleTargetModelId })}</option>
              : null}
          </select>
          {pool.targetModelSource === 'stale'
            ? <div className="dsm-trae-pool-target-stale" role="status">
                <span>{t('row.poolTargetStale', { model: pool.staleTargetModelId ?? '' })}</span>
                <button
                  type="button"
                  className="dsm-btn dsm-btn-outline"
                  disabled={busy !== undefined}
                  onClick={() => { setTargetModelId(''); pushLog('info', t('row.poolLogTargetCleared')) }}
                >
                  {t('row.poolTargetStaleClear')}
                </button>
              </div>
            : null}
          {pool.targetModelSource === 'none'
            ? <p className="dsm-trae-pool-target-none" role="status">{t('row.poolTargetNone')} — {t('row.poolTargetNoneHint')}</p>
            : null}
        </label>

        {saveError === undefined ? null : <p className="dsm-trae-pool-save-error" role="alert">{saveError}</p>}
        <div className="dsm-trae-pool-settings-save">
          <button type="button" className="dsm-btn dsm-btn-outline" disabled={!dirty || busy !== undefined} onClick={discard}>{t('row.poolDiscard')}</button>
          <button type="button" className="dsm-btn dsm-btn-primary" disabled={!dirty || busy !== undefined} onClick={() => { void save() }}>
            {busy === 'save' ? t('row.poolSaving') : t('row.poolSaved')}
          </button>
          {dirty ? <span className="dsm-trae-pool-dirty" role="status">{t('row.poolDirty')}</span> : null}
        </div>
      </div>

      {/* Activity log. */}
      <ActivityLog log={log} t={t} now={now} relativeAt={relativeAt} onClear={() => setLog([])} />
    </section>
  )
}

/* ------------------------------------------------------------------ *
 * Small presentational helpers, kept in this file so the component is *
 * unit-testable without pulling in the whole card.                    *
 * ------------------------------------------------------------------ */

function NoCandidateNotice({ noCandidate, t }: { noCandidate: TraeWebPoolExclusion | 'empty'; t: T }): ReactElement {
  if (noCandidate === 'empty') {
    return (
      <div className="dsm-trae-pool-warning dsm-trae-pool-warning-empty" role="status">
        <span className="dsm-trae-pool-warning-title">{t('row.poolNoCandidateEmpty')}</span>
        <span className="dsm-trae-pool-warning-hint">{t('row.poolNoCandidateEmptyHint')}</span>
      </div>
    )
  }
  return (
    <div className="dsm-trae-pool-warning dsm-trae-pool-warning-unusable" role="status">
      <span className="dsm-trae-pool-warning-title">{t('row.poolNoCandidateUnusable')}</span>
      <span className="dsm-trae-pool-warning-hint">
        {t('row.poolNoCandidateHint')} {exclusionLabel(noCandidate, t)}
      </span>
    </div>
  )
}

function MemberRowHeader({ t, checkinSupported }: { t: T; checkinSupported: boolean }): ReactElement {
  return (
    <div className="dsm-trae-pool-row dsm-trae-pool-row-head" role="row">
      <span>{t('row.poolColumnAccount')}</span>
      <span>{t('row.poolColumnCredits')}</span>
      <span>{t('row.poolColumnProbe')}</span>
      {checkinSupported ? <span>{t('row.poolColumnCheckin')}</span> : null}
      <span />
    </div>
  )
}

interface MemberRowProps {
  account: TraeWebPoolAccount
  models: readonly TraeWebModel[]
  rows: Readonly<Record<string, TraePoolTestRowView>>
  checked: boolean
  savedMember: boolean
  onToggle: () => void
  onTest: () => void
  t: T
  disabled: boolean
  removing: boolean
  onRemove: () => void
  formatNumber: (value: number) => string
  relativeAt: (at: number, now: number, t: T) => string
}

function MemberRow({ account, models, rows, checked, savedMember, onToggle, onTest, t, disabled, removing, onRemove, formatNumber, relativeAt }: MemberRowProps): ReactElement {
  const isCurrent = account.current === true
  // NON-NEGOTIABLE #7: show General as the number (what chat spends); never
  // rank/display `available` (the wider sum) as "credits".
  const credit = account.generalAvailable
  const excluded = account.excludedBy
  const checkin = account.checkedInToday
  const device = account.deviceCheckedIn
  const testRow = rows[account.accountId]

  return (
    <div className={`dsm-trae-pool-row${isCurrent ? ' dsm-trae-pool-row-current' : ''}`} role="row" data-account-id={account.accountId}>
      {/* Account: draft checkbox + status dot + current badge + in-pool tag + exclusion. */}
      <div className="dsm-trae-pool-account">
        <label className="dsm-trae-pool-check">
          <input
            type="checkbox"
            checked={checked}
            disabled={disabled}
            onChange={onToggle}
            aria-label={t('row.poolSelectAria', { accountName: account.accountName })}
          />
          <span className="dsm-trae-pool-account-name">
            <span className={`dsm-trae-pool-dot dsm-trae-pool-dot-${excluded ? 'excluded' : 'ok'}`} aria-hidden="true" />
            {account.accountName}
          </span>
        </label>
        <span className="dsm-trae-pool-account-tags">
          {isCurrent ? <span className="dsm-trae-pool-tag dsm-trae-pool-tag-current">{t('row.poolCurrentBadge')}</span> : null}
          {savedMember ? <span className="dsm-trae-pool-tag dsm-trae-pool-tag-member">{t('row.poolMember')}</span> : null}
          {excluded ? <span className="dsm-trae-pool-tag dsm-trae-pool-tag-excluded">{exclusionLabel(excluded, t)}</span> : null}
        </span>
      </div>

      {/* Credit: the General bucket. Work is only a hint (never shown as the number). */}
      <div className="dsm-trae-pool-credit" title={t('row.poolWorkHint')}>
        <span className="dsm-trae-pool-credit-num">{credit === undefined ? t('row.poolCreditNone') : formatNumber(credit)}</span>
        <span className="dsm-trae-pool-credit-label">{t('row.poolGeneralLabel')}</span>
      </div>

      {/* Probe result. */}
      <div className="dsm-trae-pool-probe">
        {testRow !== undefined
          ? <ProbeResult outcome={testRow.outcome} modelId={testRow.modelId} atMs={undefined} source={undefined} t={t} relativeAt={relativeAt} now={Date.now()} detail={testRow.detail} />
          : account.probe !== undefined
            ? <ProbeResult outcome={account.probe.outcome} modelId={account.probe.modelId} atMs={account.probe.atMs} source={account.probe.source} t={t} relativeAt={relativeAt} now={Date.now()} detail={account.probe.message} />
            : <span className="dsm-trae-pool-probe-none">{t('row.poolNeverTested')}</span>}
      </div>

      {/* Check-in column (only when the panel supports it). */}
      <div className="dsm-trae-pool-checkin">
        <span className={`dsm-trae-pool-checkin-state dsm-trae-pool-checkin-${checkin === undefined ? 'unknown' : checkin ? 'ok' : device === true ? 'device' : 'no'}`}>
          {checkin === undefined
            ? t('row.poolCheckinUnknown')
            : checkin ? t('row.poolCheckedIn')
              : device === true ? t('row.poolDeviceUsed') : t('row.poolNotCheckedIn')}
        </span>
      </div>

      {/* Row actions: Test / Remove. */}
      <div className="dsm-trae-pool-row-actions">
        <button type="button" className="dsm-btn dsm-btn-outline" disabled={disabled} onClick={onTest}>{t('row.poolRowTest')}</button>
        <button
          type="button"
          className="dsm-btn dsm-btn-outline dsm-trae-pool-remove"
          disabled={disabled || removing}
          aria-label={t('row.poolRowRemoveAria', { accountName: account.accountName })}
          onClick={onRemove}
        >
          {removing ? t('row.poolRowRemoving') : t('row.poolRowRemove')}
        </button>
      </div>
    </div>
  )
}

interface MemberGhostRowProps {
  ghost: { accountId: string; accountName: string }
  checked: boolean
  onToggle: () => void
  t: T
  disabled: boolean
  removing: boolean
  onRemove: () => void
}

function MemberGhostRow({ ghost, checked, onToggle, t, disabled, removing, onRemove }: MemberGhostRowProps): ReactElement {
  return (
    <div className="dsm-trae-pool-row dsm-trae-pool-row-ghost" role="row" data-account-id={ghost.accountId}>
      <div className="dsm-trae-pool-account">
        <label className="dsm-trae-pool-check">
          <input
            type="checkbox"
            checked={checked}
            disabled={disabled}
            onChange={onToggle}
            aria-label={t('row.poolSelectAria', { accountName: ghost.accountName })}
          />
          <span className="dsm-trae-pool-account-name">
            <span className="dsm-trae-pool-dot dsm-trae-pool-dot-ghost" aria-hidden="true" />
            {ghost.accountName}
          </span>
        </label>
        <span className="dsm-trae-pool-account-tags">
          <span className="dsm-trae-pool-tag dsm-trae-pool-tag-ghost">{t('row.poolExcludedUnusable')}</span>
        </span>
      </div>
      {/* A ghost has no live credit / probe — the removal is the point. */}
      <div className="dsm-trae-pool-credit"><span className="dsm-trae-pool-credit-num">{t('row.poolCreditNone')}</span></div>
      <div className="dsm-trae-pool-probe"><span className="dsm-trae-pool-probe-none">{t('row.poolNeverTested')}</span></div>
      <div className="dsm-trae-pool-checkin"><span className="dsm-trae-pool-checkin-state dsm-trae-pool-checkin-unknown">{t('row.poolCheckinUnknown')}</span></div>
      <div className="dsm-trae-pool-row-actions">
        <button
          type="button"
          className="dsm-btn dsm-btn-outline dsm-trae-pool-remove"
          disabled={disabled || removing}
          aria-label={t('row.poolGhostRemoveAria', { accountName: ghost.accountName })}
          onClick={onRemove}
        >
          {removing ? t('row.poolRowRemoving') : t('row.poolGhostRemove')}
        </button>
      </div>
    </div>
  )
}

interface ProbeResultProps {
  outcome: TraeWebPoolOutcome
  modelId?: string | undefined
  atMs?: number | undefined
  source?: 'test-batch' | 'live-request' | undefined
  detail?: string | undefined
  t: T
  relativeAt: (at: number, now: number, t: T) => string
  now: number
}

function ProbeResult({ outcome, modelId, atMs, source, detail, t, relativeAt, now }: ProbeResultProps): ReactElement {
  const tone = outcome === 'ok' ? 'ok' : 'warn'
  return (
    <div className="dsm-trae-pool-probe-cell">
      <span className={`dsm-trae-pool-probe-outcome dsm-trae-pool-probe-${tone}`}>
        <span className="dsm-trae-pool-dot dsm-trae-pool-dot-ok" aria-hidden="true" />
        {outcomeLabel(outcome, t)}
      </span>
      <span className="dsm-trae-pool-probe-meta">
        {modelId !== undefined ? t('row.poolProbeModel', { model: modelId }) : t('row.poolProbeModelUnknown')}
        {atMs !== undefined ? ` · ${relativeAt(atMs, now, t)}` : ''}
        {' · '}{probeSourceLabel(source, t)}
      </span>
      {detail !== undefined && detail !== '' ? <span className="dsm-trae-pool-probe-detail">{detail}</span> : null}
    </div>
  )
}

interface ActivityLogProps {
  log: LogEntry[]
  t: T
  now: number
  relativeAt: (at: number, now: number, t: T) => string
  onClear: () => void
}

function ActivityLog({ log, t, now, relativeAt, onClear }: ActivityLogProps): ReactElement {
  return (
    <div className="dsm-trae-pool-log">
      <div className="dsm-trae-pool-log-head">
        <h4 className="dsm-trae-pool-subtitle">{t('row.poolLogTitle')}</h4>
        {log.length > 0 ? <button type="button" className="dsm-btn dsm-btn-outline" onClick={onClear}>{t('row.poolLogClear')}</button> : null}
      </div>
      {log.length === 0
        ? <p className="dsm-trae-pool-log-empty">{t('row.poolLogEmpty')}</p>
        : <ol className="dsm-trae-pool-log-list">
            {log.map(entry => (
              <li key={entry.id} className={`dsm-trae-pool-log-item dsm-trae-pool-log-${entry.tone}`}>
                <span className="dsm-trae-pool-log-text">{entry.text}</span>
              </li>
            ))}
          </ol>}
    </div>
  )
}