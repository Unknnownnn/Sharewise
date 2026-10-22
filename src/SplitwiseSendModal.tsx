import { useEffect, useMemo, useState } from 'react'

export type SplitwiseShare = {
  personId: number
  name: string
  color: string
  amount: number
}

type SplitwiseGroup = {
  id: string
  name: string
  members: Array<{ id: string; name: string }>
}

type SplitwiseHealth = {
  ok: boolean
  authenticated: boolean
  user: string | null
  last_error: string | null
}

type PreviewRow = { user_id: string; name: string; paid: string; owed: string }

type SplitwisePreview = {
  group: { id: string; name: string }
  rows: PreviewRow[]
  payer: { id: string; name: string }
  payload: Record<string, string>
  skipped: Array<{ name: string; amount: string }>
  totals: { requested: string; included: string; skipped: string }
}

export type SplitwiseSent = {
  expense: {
    id: number | string
    cost: string
    description: string
    currency_code: string
    group_id: number | string
    expense_url: string | null
    created_at: string | null
  }
  group: { id: string; name: string }
  rows: PreviewRow[]
  payer: { id: string; name: string }
}

type Props = {
  open: boolean
  token: string | null
  title: string
  date: string
  groupId: string
  groupName: string
  total: number
  shares: SplitwiseShare[]
  mapping: Record<number, string>
  preferredGroup: string
  onClose: () => void
  onSent?: (result: SplitwiseSent) => void
}

const PAYER_KEY = 'smartsplit:splitwise-payer'

const groupKey = (sharewiseGroupId: string) => `smartsplit:splitwise-group:${sharewiseGroupId}`

const normalize = (value: string) => value.replace(/\s+/g, ' ').trim().toLowerCase()

async function callApi<T>(path: string, token: string | null, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init?.headers || {}),
    },
  })

  const text = await response.text()
  let body: unknown = null

  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = null
  }

  if (!response.ok) {
    const message =
      body && typeof body === 'object' && 'error' in body
        ? String((body as { error: unknown }).error)
        : response.status === 502 || response.status === 503 || response.status === 504
          ? 'The SmartSplit API server is not reachable. Start it with "npm run dev:all" and try again.'
          : `Request failed (${response.status})`

    throw new Error(message)
  }

  return body as T
}

const expenseAmount = (value: string) => `₹${Number(value).toFixed(2)}`

export default function SplitwiseSendModal({
  open,
  token,
  title,
  date,
  groupId,
  groupName,
  total,
  shares,
  mapping,
  preferredGroup,
  onClose,
  onSent,
}: Props) {
  const [health, setHealth] = useState<SplitwiseHealth | null>(null)
  const [groups, setGroups] = useState<SplitwiseGroup[]>([])
  const [currentUser, setCurrentUser] = useState<{ id: string; name: string } | null>(null)
  const [selectedGroup, setSelectedGroup] = useState('')
  const [payer, setPayer] = useState('')
  const [preview, setPreview] = useState<SplitwisePreview | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const [sent, setSent] = useState<SplitwiseSent | null>(null)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const activeShares = useMemo(() => shares.filter((share) => share.amount > 0), [shares])
  const shareSum = useMemo(
    () => activeShares.reduce((sum, share) => sum + share.amount, 0),
    [activeShares],
  )

  const expenseDate = useMemo(() => {
    const parsed = new Date(date)
    return Number.isNaN(parsed.getTime()) ? '' : parsed.toISOString().slice(0, 10)
  }, [date])

  // Explicit mappings win; 'skip' excludes a person; an empty entry leaves
  // resolution to the server's name matching.
  const sharePayload = useMemo(
    () =>
      activeShares.map((share) => {
        const mapped = mapping[share.personId]

        if (mapped === 'skip') {
          return { name: share.name, amount: share.amount, skip: true }
        }

        return mapped
          ? { name: share.name, amount: share.amount, user_id: mapped }
          : { name: share.name, amount: share.amount }
      }),
    [activeShares, mapping],
  )

  useEffect(() => {
    if (!open) return

    let cancelled = false

    const load = async () => {
      try {
        const state = await callApi<SplitwiseHealth>('/api/splitwise/health', token)

        if (cancelled) return

        setHealth(state)

        if (!state.authenticated) {
          setStatus('error')
          setError(
            state.last_error ||
              'The saved Splitwise session is not signed in. Re-seed it with a fresh cookie.',
          )
          return
        }

        const data = await callApi<{
          groups: SplitwiseGroup[]
          current_user: { id: string; name: string } | null
        }>('/api/splitwise/groups', token)

        if (cancelled) return

        setGroups(data.groups)
        setCurrentUser(data.current_user)

        const savedName = localStorage.getItem(groupKey(groupId))
        const initial =
          data.groups.find((group) => group.name === preferredGroup) ??
          data.groups.find((group) => group.name === savedName) ??
          data.groups.find((group) => normalize(group.name) === normalize(groupName)) ??
          data.groups[0]

        setSelectedGroup(initial ? initial.name : '')

        // Payer preferences are stored as Splitwise user ids, because names
        // can change and can collide.
        const savedPayerId = localStorage.getItem(PAYER_KEY)
        const memberIds = initial ? initial.members.map((member) => member.id) : []
        const preferredPayerId =
          savedPayerId && memberIds.includes(savedPayerId)
            ? savedPayerId
            : data.current_user && memberIds.includes(data.current_user.id)
              ? data.current_user.id
              : memberIds[0] || ''

        setPayer(preferredPayerId)
        setStatus('ready')
      } catch (loadError) {
        if (cancelled) return

        setStatus('error')
        setError(loadError instanceof Error ? loadError.message : 'Could not reach Splitwise.')
      }
    }

    void load()

    return () => {
      cancelled = true
    }
  }, [open, token, groupId, groupName, preferredGroup])

  useEffect(() => {
    if (!open || status !== 'ready' || !selectedGroup || !payer || !activeShares.length) {
      return
    }

    let cancelled = false

    const timer = setTimeout(() => {
      if (cancelled) return

      setPreviewing(true)
      setPreviewError(null)

      callApi<SplitwisePreview>('/api/splitwise/preview', token, {
        method: 'POST',
        body: JSON.stringify({
          group_name: selectedGroup,
          total: shareSum,
          description: title,
          date: expenseDate,
          currency: 'INR',
          payer_id: payer,
          shares: sharePayload,
        }),
      })
        .then((result) => {
          if (cancelled) return
          setPreview(result)
        })
        .catch((previewFailure) => {
          if (cancelled) return
          setPreview(null)
          setPreviewError(
            previewFailure instanceof Error ? previewFailure.message : 'Could not preview this split.',
          )
        })
        .finally(() => {
          if (cancelled) return
          setPreviewing(false)
        })
    }, 250)

    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [open, status, selectedGroup, payer, title, expenseDate, shareSum, activeShares.length, sharePayload, token])

  const activeGroup = groups.find((group) => group.name === selectedGroup) || null

  const handleSend = async () => {
    if (!selectedGroup || !payer) return

    setBusy(true)
    setError(null)

    try {
      const result = await callApi<SplitwiseSent>('/api/splitwise/send', token, {
        method: 'POST',
        body: JSON.stringify({
          group_name: selectedGroup,
          total: shareSum,
          description: title,
          date: expenseDate,
          currency: 'INR',
          payer_id: payer,
          shares: sharePayload,
        }),
      })

      localStorage.setItem(groupKey(groupId), selectedGroup)
      localStorage.setItem(PAYER_KEY, payer)
      setSent(result)
      onSent?.(result)
    } catch (sendError) {
      setError(sendError instanceof Error ? sendError.message : 'Could not send to Splitwise.')
    } finally {
      setBusy(false)
    }
  }

  if (!open) return null

  const difference = Math.abs(shareSum - total)

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <section className="splitwise-modal" onClick={(event) => event.stopPropagation()}>
        <div className="modal-heading">
          <div>
            <p className="eyebrow">SPLITWISE</p>
            <h2>Send to Splitwise</h2>
          </div>
          <button className="close-button" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        {status === 'loading' && <p className="splitwise-muted">Checking the Splitwise session...</p>}

        {status === 'error' && (
          <div className="splitwise-error">
            <strong>Splitwise is not ready.</strong>
            <p>{error}</p>
            <ol>
              <li>Copy the whole Cookie header from a signed-in splitwise.com request.</li>
              <li>
                Put it on a single <code>SPLITWISE_COOKIE=</code> line in <code>.env</code>.
              </li>
              <li>
                Run <code>npm run splitwise:seed</code>, then reload this page.
              </li>
            </ol>
            {health?.user && <p className="splitwise-muted">Last known user: {health.user}</p>}
          </div>
        )}

        {status === 'ready' && (
          <>
            <div className="splitwise-controls">
              <label className="field-label">
                <span>Splitwise group</span>
                <select value={selectedGroup} onChange={(event) => setSelectedGroup(event.target.value)}>
                  {groups.map((group) => (
                    <option key={group.id} value={group.name}>
                      {group.name}
                    </option>
                  ))}
                </select>
              </label>

              <label className="field-label">
                <span>Who paid the bill</span>
                <select value={payer} onChange={(event) => setPayer(event.target.value)}>
                  {(activeGroup?.members || []).map((member) => (
                    <option key={member.id} value={member.id}>
                      {member.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <p className="splitwise-muted">
              Sending as {currentUser ? currentUser.name : 'the saved account'} · {title}
            </p>

            {difference > 0.01 && (
              <p className="splitwise-note">
                The receipt total is ₹{total.toFixed(2)} but the shares add up to ₹
                {shareSum.toFixed(2)}. Splitwise receives the sum of the shares.
              </p>
            )}

            {preview && preview.skipped.length > 0 && (
              <p className="splitwise-note">
                {preview.skipped.length} left out of the expense: {preview.skipped.map((entry) => `${entry.name} (₹${entry.amount})`).join(', ')}.
                {' '}Included total: ₹{preview.totals.included}.
              </p>
            )}

            <div className="splitwise-rows">
              {previewing && !preview && <p className="splitwise-muted">Building the split...</p>}

              {preview?.rows.map((row) => (
                <div className="splitwise-row" key={row.user_id}>
                  <span className="splitwise-row-name">{row.name}</span>
                  <span className="splitwise-row-paid">
                    {Number(row.paid) > 0 ? `paid ${expenseAmount(row.paid)}` : ''}
                  </span>
                  <strong>{expenseAmount(row.owed)}</strong>
                </div>
              ))}

              {!previewing && !preview && !previewError && (
                <p className="splitwise-muted">Pick a group and a payer to preview the split.</p>
              )}
            </div>

            {previewError && <div className="splitwise-error">{previewError}</div>}
            {error && <div className="splitwise-error">{error}</div>}

            {sent ? (
              <div className="splitwise-success">
                <strong>Expense created.</strong>
                <p>
                  {expenseAmount(sent.expense.cost)} · {sent.expense.description} · {sent.group.name}
                </p>
                {sent.expense.expense_url && (
                  <a href={sent.expense.expense_url} target="_blank" rel="noreferrer">
                    Open in Splitwise
                  </a>
                )}
              </div>
            ) : (
              <div className="splitwise-actions">
                <button type="button" className="cancel-btn-sm" onClick={onClose}>
                  Cancel
                </button>
                <button
                  type="button"
                  className="primary-button"
                  onClick={handleSend}
                  disabled={busy || previewing || !preview || !selectedGroup || !payer}
                >
                  {busy ? 'Sending...' : `Send ₹${preview?.totals.included ?? shareSum.toFixed(2)}`}
                </button>
              </div>
            )}
          </>
        )}
      </section>
    </div>
  )
}
