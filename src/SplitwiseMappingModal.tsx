import { useEffect, useRef, useState } from 'react'

type Person = { id: number; name: string; color: string }

type SplitwiseGroup = {
  id: string
  name: string
  members: Array<{ id: string; name: string }>
}

type Mapping = {
  groupName: string
  members: Record<number, string>
}

type Props = {
  open: boolean
  token: string | null
  groupId: string
  groupName: string
  people: Person[]
  value: Mapping
  onChange: (next: Mapping) => void
  onClose: () => void
}

const AUTO = ''

async function callApi<T>(path: string, token: string | null): Promise<T> {
  const response = await fetch(path, {
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
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

const normalize = (value: string) => value.replace(/\s+/g, ' ').trim().toLowerCase()

export default function SplitwiseMappingModal({
  open,
  token,
  groupId,
  groupName,
  people,
  value,
  onChange,
  onClose,
}: Props) {
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [error, setError] = useState<string | null>(null)
  const [groups, setGroups] = useState<SplitwiseGroup[]>([])
  const [selected, setSelected] = useState(value.groupName || '')
  const [account, setAccount] = useState<string | null>(null)

  // Captured once per mount. The parent remounts this panel with a new key
  // when the SmartSplit group changes, so this tracks the saved config for
  // that group without refetching on every mapping edit.
  const initialGroupName = useRef(value.groupName)

  useEffect(() => {
    if (!open) return

    let cancelled = false

    const load = async () => {
      try {
        const health = await callApi<{ authenticated: boolean; user: string | null }>(
          '/api/splitwise/health',
          token,
        )

        if (cancelled) return

        if (!health.authenticated) {
          setStatus('error')
          setError(
            'The Splitwise session is not signed in. Seed it with "npm run splitwise:seed", then reopen this panel.',
          )
          return
        }

        setAccount(health.user)

        const data = await callApi<{ groups: SplitwiseGroup[] }>('/api/splitwise/groups', token)

        if (cancelled) return

        setGroups(data.groups)

        if (!initialGroupName.current) {
          const match =
            data.groups.find((group) => normalize(group.name) === normalize(groupName)) ??
            data.groups[0]
          setSelected(match ? match.name : '')
        }

        setStatus('ready')
      } catch (loadError) {
        if (cancelled) return
        setStatus('error')
        setError(loadError instanceof Error ? loadError.message : 'Could not load Splitwise.')
      }
    }

    void load()

    return () => {
      cancelled = true
    }
    // Only seed the selector when nothing is configured yet; afterwards the
    // user drives it and edits must not refetch or reset it.
  }, [open, token, groupId, groupName])

  if (!open) return null

  const activeGroup = groups.find((group) => group.name === selected) || null
  const members = activeGroup?.members || []

  const setMember = (personId: number, memberId: string) => {
    const next = { ...value.members }

    if (memberId === AUTO) {
      delete next[personId]
    } else {
      next[personId] = memberId
    }

    onChange({ groupName: selected, members: next })
  }

  const handleGroupChange = (nextName: string) => {
    const nextGroup = groups.find((group) => group.name === nextName)
    const validIds = new Set((nextGroup?.members || []).map((member) => member.id))

    // Member ids are scoped to a Splitwise group, so drop ids that do not
    // exist in the newly selected group.
    const nextMembers = Object.fromEntries(
      Object.entries(value.members).filter(([, memberId]) => validIds.has(memberId)),
    ) as Record<number, string>

    setSelected(nextName)
    onChange({ groupName: nextName, members: nextMembers })
  }

  const mappedCount = people.filter((person) => {
    const memberId = value.members[person.id]
    return memberId && memberId !== 'skip'
  }).length
  const skippedCount = people.filter((person) => value.members[person.id] === 'skip').length

  return (
    <div className="modal-backdrop mapping-backdrop" onClick={onClose}>
      <section className="splitwise-modal mapping-modal" onClick={(event) => event.stopPropagation()}>
        <div className="modal-heading">
          <div>
            <p className="eyebrow">SPLITWISE / SETTINGS</p>
            <h2>Person mapping</h2>
          </div>
          <button className="close-button" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        <p className="splitwise-muted">
          Saved once for <strong>{groupName}</strong>. This decides which Splitwise member each
          person becomes on every send.
        </p>

        {status === 'loading' && <p className="splitwise-muted">Loading Splitwise groups...</p>}

        {status === 'error' && <div className="splitwise-error">{error}</div>}

        {status === 'ready' && (
          <>
            <label className="field-label">
              <span>Splitwise group</span>
              <select value={selected} onChange={(event) => handleGroupChange(event.target.value)}>
                {groups.map((group) => (
                  <option key={group.id} value={group.name}>
                    {group.name} ({group.members.length} members)
                  </option>
                ))}
              </select>
            </label>

            {value.groupName && !groups.some((group) => group.name === value.groupName) && (
              <p className="splitwise-note">
                The saved group "{value.groupName}" no longer exists. Pick another one above.
              </p>
            )}

            <div className="mapping-rows">
              {people.map((person) => {
                const stored = value.members[person.id] || AUTO
                const resolved = members.some((member) => member.id === stored) ? stored : AUTO

                return (
                  <div className="mapping-row" key={person.id}>
                    <span className="mapping-person">
                      <span className="avatar" style={{ backgroundColor: person.color }}>
                        {person.name.slice(0, 2).toUpperCase()}
                      </span>
                      {person.name}
                    </span>
                    <select
                      value={resolved}
                      onChange={(event) => setMember(person.id, event.target.value)}
                    >
                      <option value={AUTO}>Auto (match by name)</option>
                      {members.map((member) => (
                        <option key={member.id} value={member.id}>
                          {member.name}
                        </option>
                      ))}
                      <option value="skip">Skip (exclude)</option>
                    </select>
                  </div>
                )
              })}
            </div>

            <p className="splitwise-muted">
              {mappedCount} mapped, {skippedCount} skipped,{' '}
              {people.length - mappedCount - skippedCount} on auto. Auto tries the full name, then
              the first name, then a unique prefix. Anyone still unmatched is skipped and left out
              of the expense total.
            </p>

            <div className="splitwise-actions">
              <button type="button" className="primary-button" onClick={onClose}>
                Done
              </button>
            </div>
          </>
        )}

        {status === 'ready' && account && (
          <p className="splitwise-muted">Connected as {account}</p>
        )}
      </section>
    </div>
  )
}
