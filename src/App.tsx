import { useEffect, useMemo, useRef, useState } from 'react'
import type { ChangeEvent } from 'react'
import './App.css'

type Person = { id: number; name: string; color: string; initials?: string }
type Group = { id: string; name: string; isDefault?: boolean; people: Person[] }
type Item = { id: number; name: string; detail: string; amount: number }
type Charges = {
  tax: number | null
  delivery: number | null
  other: number | null
  other_breakdown?: Array<{ label: string; amount: number }>
  subtotal: number | null
  total: number | null
}
type OcrItem = {
  name: string
  quantity?: string | number | null
  unit?: string | null
  amount?: number | null
  price?: number | null
}

type FinalizedSplit = {
  id: string
  title: string
  date: string
  displayDate: string
  groupId: string
  groupName: string
  fileName?: string
  total: number
  itemsCount: number
  items: Array<{
    id: number
    name: string
    detail: string
    amount: number
  }>
  charges: {
    tax: number | null
    delivery: number | null
    other: number | null
    subtotal: number | null
    total: number | null
  }
  shares: Array<{
    personId: number
    name: string
    initials: string
    color: string
    amount: number
  }>
}

type User = {
  id: string
  username: string
}

type ScreenshotItem = {
  id: string
  name: string
  preview: string
  base64: string
  mimeType: string
}

const colors = ['#ef765c', '#4967b0', '#d6a43a', '#6c9d73', '#9b6db0', '#3f9b9d', '#c66b91']
const blankCharges: Charges = { tax: null, delivery: null, other: null, subtotal: null, total: null, other_breakdown: [] }
const money = (value: number) => `₹${value.toFixed(2)}`

function cleanWord(w: string) {
  return w.replace(/[^a-zA-Z0-9]/g, '')
}

function computeGroupInitials(people: Person[]): Record<number, string> {
  const result: Record<number, string> = {}
  if (!people || people.length === 0) return result

  const candidates: Record<number, string> = {}
  people.forEach((p) => {
    const words = p.name.trim().split(/\s+/).map(cleanWord).filter(Boolean)
    if (words.length === 0) {
      candidates[p.id] = '?'
    } else if (words.length > 1) {
      candidates[p.id] = (words[0][0] + words[words.length - 1][0]).toUpperCase()
    } else {
      candidates[p.id] = words[0][0].toUpperCase()
    }
  })

  const countByCand: Record<string, number> = {}
  Object.values(candidates).forEach((c) => {
    countByCand[c] = (countByCand[c] || 0) + 1
  })

  const collidingCandMap: Record<string, Person[]> = {}
  people.forEach((p) => {
    const cand = candidates[p.id]
    if (countByCand[cand] > 1) {
      if (!collidingCandMap[cand]) collidingCandMap[cand] = []
      collidingCandMap[cand].push(p)
    } else {
      result[p.id] = cand
    }
  })

  Object.values(collidingCandMap).forEach((group) => {
    const level1: Record<number, string> = {}
    group.forEach((p) => {
      const words = p.name.trim().split(/\s+/).map(cleanWord).filter(Boolean)
      if (words.length > 1) {
        const firstTwo = words[0].slice(0, 2).toUpperCase()
        const lastInitial = words[words.length - 1][0].toUpperCase()
        level1[p.id] = `${firstTwo}${lastInitial}`
      } else if (words.length === 1) {
        const firstTwo = words[0].slice(0, 2).toUpperCase()
        level1[p.id] = firstTwo.length > 1 ? firstTwo : `${firstTwo}1`
      } else {
        level1[p.id] = '?'
      }
    })

    const countLevel1: Record<string, number> = {}
    Object.values(level1).forEach((c) => {
      countLevel1[c] = (countLevel1[c] || 0) + 1
    })

    const remaining = group.filter((p) => countLevel1[level1[p.id]] > 1)
    if (remaining.length === 0) {
      group.forEach((p) => {
        result[p.id] = level1[p.id]
      })
    } else {
      const used = new Set<string>()
      group.forEach((p, idx) => {
        let val = level1[p.id]
        if (countLevel1[val] > 1) {
          const words = p.name.trim().split(/\s+/).map(cleanWord).filter(Boolean)
          if (words.length > 0 && words[0].length >= 3) {
            val = words[0].slice(0, 3).toUpperCase()
          }
          if (used.has(val) || countLevel1[val] > 1) {
            val = val.slice(0, 2) + (idx + 1)
          }
        }
        used.add(val)
        result[p.id] = val
      })
    }
  })

  return result
}

const toBase64 = (buffer: ArrayBuffer) => {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192))
  }
  return btoa(binary)
}

function parseAmount(val: unknown): number | null {
  if (val === null || val === undefined) return null
  if (typeof val === 'number') return Number.isFinite(val) ? val : null
  if (typeof val === 'string') {
    if (/free/i.test(val)) return 0
    const cleaned = val.replace(/[^0-9.-]/g, '').trim()
    if (cleaned === '' || cleaned === '-') return null
    const num = Number(cleaned)
    return Number.isFinite(num) ? num : null
  }
  if (typeof val === 'object') {
    if (Array.isArray(val)) {
      const nums = val
        .map((entry) => {
          if (typeof entry === 'number') return entry
          if (entry && typeof entry === 'object' && 'amount' in entry) return parseAmount((entry as { amount: unknown }).amount)
          return parseAmount(entry)
        })
        .filter((n): n is number => n !== null && Number.isFinite(n))
      return nums.length > 0 ? nums.reduce((a, b) => a + b, 0) : null
    }
    const nums = Object.values(val as Record<string, unknown>)
      .map(parseAmount)
      .filter((n): n is number => n !== null && Number.isFinite(n))
    return nums.length > 0 ? nums.reduce((a, b) => a + b, 0) : null
  }
  return null
}

function extractTax(source: Record<string, unknown>): number | null {
  const taxKeys = [
    'tax', 'taxes', 'gst', 'gst_amount', 'tax_amount',
    'taxes_and_charges', 'tax_and_charges', 'taxes_charges',
    'total_tax', 'govt_taxes', 'govt_tax', 'vat',
  ]
  for (const key of taxKeys) {
    if (source[key] !== undefined && source[key] !== null) {
      const parsed = parseAmount(source[key])
      if (parsed !== null) return parsed
    }
  }
  const cgst = parseAmount(source.cgst ?? source.cgst_amount)
  const sgst = parseAmount(source.sgst ?? source.sgst_amount)
  const igst = parseAmount(source.igst ?? source.igst_amount)
  if (cgst !== null || sgst !== null || igst !== null) {
    return (cgst || 0) + (sgst || 0) + (igst || 0)
  }
  if (Array.isArray(source.other_breakdown)) {
    const taxEntry = source.other_breakdown.find(
      (entry) => entry && typeof entry === 'object' && typeof entry.label === 'string' && /tax|gst|vat/i.test(entry.label),
    )
    if (taxEntry && (taxEntry as { amount?: unknown }).amount != null) {
      return parseAmount((taxEntry as { amount: unknown }).amount)
    }
  }
  return null
}

function extractDelivery(source: Record<string, unknown>): number | null {
  const deliveryKeys = ['delivery', 'delivery_charges', 'delivery_charge', 'delivery_fee', 'shipping', 'shipping_fee']
  for (const key of deliveryKeys) {
    if (source[key] !== undefined && source[key] !== null) {
      const parsed = parseAmount(source[key])
      if (parsed !== null) return parsed
    }
  }
  return null
}

function extractOther(source: Record<string, unknown>): number | null {
  const otherKeys = ['other', 'other_charges', 'other_charge', 'other_fee', 'others']
  for (const key of otherKeys) {
    if (source[key] !== undefined && source[key] !== null) {
      const parsed = parseAmount(source[key])
      if (parsed !== null) return parsed
    }
  }
  const detailedKeys = [
    'handling', 'handling_charge', 'handling_fee',
    'surge', 'surge_charge',
    'rain_fee', 'rain_charge',
    'peak_fee', 'weather_charge',
    'platform', 'platform_fee',
    'service_fee', 'convenience_fee',
    'discount', 'product_discount', 'discount_amount',
  ]
  const detailedOther = detailedKeys
    .map((k) => parseAmount(source[k]))
    .filter((n): n is number => n !== null)
    .reduce((sum, n) => sum + n, 0)
  if (detailedOther > 0) return detailedOther
  return null
}

function extractSubtotal(source: Record<string, unknown>): number | null {
  const subtotalKeys = ['subtotal', 'item_total', 'items_total']
  for (const key of subtotalKeys) {
    if (source[key] !== undefined && source[key] !== null) {
      const parsed = parseAmount(source[key])
      if (parsed !== null) return parsed
    }
  }
  return null
}

function extractTotal(source: Record<string, unknown>): number | null {
  const totalKeys = ['total', 'bill_total', 'grand_total', 'order_total', 'final_total']
  for (const key of totalKeys) {
    if (source[key] !== undefined && source[key] !== null) {
      const parsed = parseAmount(source[key])
      if (parsed !== null) return parsed
    }
  }
  return null
}

const initialGroups = (): Group[] => {
  const saved = localStorage.getItem('smartsplit-groups')
  if (saved) {
    try {
      const parsed = JSON.parse(saved) as Group[]
      if (Array.isArray(parsed) && parsed.length > 0) {
        if (!parsed.some((g) => g.isDefault)) {
          parsed[0].isDefault = true
        }
        return parsed
      }
    } catch {
      // fallback
    }
  }

  const legacyPeopleStr = localStorage.getItem('smartsplit-people')
  const legacyPeople = legacyPeopleStr
    ? (JSON.parse(legacyPeopleStr) as Person[])
    : [
      { id: 1, name: 'John Doe', color: colors[0] },
      { id: 2, name: 'Jane Doe', color: colors[1] },
    ]
  const legacyGroupName = localStorage.getItem('smartsplit-group') || 'Housemates'

  return [
    {
      id: 'default',
      name: legacyGroupName,
      isDefault: true,
      people: legacyPeople,
    },
  ]
}

function App() {
  // User Authentication & Cloud Sync
  const [user, setUser] = useState<User | null>(() => {
    const saved = localStorage.getItem('smartsplit-user')
    if (saved) {
      try {
        return JSON.parse(saved) as User
      } catch {
        // ignore
      }
    }
    return null
  })

  const [token, setToken] = useState<string | null>(() => {
    return localStorage.getItem('smartsplit-token') || sessionStorage.getItem('smartsplit-token')
  })

  const [syncStatus, setSyncStatus] = useState<'idle' | 'syncing' | 'synced' | 'error'>('idle')
  const [authModalOpen, setAuthModalOpen] = useState(false)
  const [authMode, setAuthMode] = useState<'login' | 'register'>('login')
  const [authUsername, setAuthUsername] = useState('')
  const [authPassword, setAuthPassword] = useState('')
  const [rememberMe, setRememberMe] = useState(true)
  const [authError, setAuthError] = useState<string | null>(null)
  const [authLoading, setAuthLoading] = useState(false)

  // Groups and Settings
  const [groups, setGroups] = useState<Group[]>(initialGroups)
  const [activeGroupId, setActiveGroupId] = useState<string>(() => {
    const savedActive = localStorage.getItem('smartsplit-active-group-id')
    const all = initialGroups()
    if (savedActive && all.some((g) => g.id === savedActive)) {
      return savedActive
    }
    const def = all.find((g) => g.isDefault) || all[0]
    return def.id
  })

  const [newGroupName, setNewGroupName] = useState('')
  const [showNewGroupInput, setShowNewGroupInput] = useState(false)

  const activeGroup = useMemo(() => {
    return groups.find((g) => g.id === activeGroupId) || groups[0]
  }, [groups, activeGroupId])

  const people = activeGroup.people
  const groupName = activeGroup.name

  const initialsMap = useMemo(() => computeGroupInitials(people), [people])
  const getInitials = (id: number) => initialsMap[id] || '?'

  const [items, setItems] = useState<Item[]>([])
  const [included, setIncluded] = useState<Record<number, number[]>>({})
  const [charges, setCharges] = useState<Charges>(blankCharges)
  const [editedCharges, setEditedCharges] = useState<Record<'tax' | 'delivery' | 'other', string>>({
    tax: '',
    delivery: '',
    other: '',
  })
  const [fileName, setFileName] = useState('No bill scanned yet')
  const [status, setStatus] = useState('Upload bill screenshot(s) to begin')
  const [screenshots, setScreenshots] = useState<ScreenshotItem[]>([])
  const [isScanning, setIsScanning] = useState(false)
  const [accountOpen, setAccountOpen] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
  const appendFileInput = useRef<HTMLInputElement>(null)

  // Navigation & History states
  const [viewMode, setViewMode] = useState<'split' | 'history'>('split')
  const [history, setHistory] = useState<FinalizedSplit[]>(() => {
    const saved = localStorage.getItem('smartsplit-history')
    if (saved) {
      try {
        const parsed = JSON.parse(saved)
        if (Array.isArray(parsed)) return parsed as FinalizedSplit[]
      } catch {
        // ignore
      }
    }
    return []
  })
  const [historyFilterGroup, setHistoryFilterGroup] = useState<string>('all')
  const [historySearch, setHistorySearch] = useState('')
  const [expandedSplitId, setExpandedSplitId] = useState<string | null>(null)
  const [copiedSplitId, setCopiedSplitId] = useState<string | null>(null)
  const [finalizeModalOpen, setFinalizeModalOpen] = useState(false)
  const [splitTitleInput, setSplitTitleInput] = useState('')

  // Check auth session on startup
  useEffect(() => {
    if (!token) return
    fetch('/api/auth/me', {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((res) => (res.ok ? res.json() : Promise.reject(res)))
      .then(
        (payload: {
          user: User
          data?: { groups?: Group[]; activeGroupId?: string; history?: FinalizedSplit[] }
        }) => {
          setUser(payload.user)
          localStorage.setItem('smartsplit-user', JSON.stringify(payload.user))
          if (payload.data) {
            if (Array.isArray(payload.data.groups) && payload.data.groups.length > 0) {
              setGroups(payload.data.groups)
              localStorage.setItem('smartsplit-groups', JSON.stringify(payload.data.groups))
            }
            if (payload.data.activeGroupId) {
              setActiveGroupId(payload.data.activeGroupId)
              localStorage.setItem('smartsplit-active-group-id', payload.data.activeGroupId)
            }
            if (Array.isArray(payload.data.history)) {
              setHistory(payload.data.history)
              localStorage.setItem('smartsplit-history', JSON.stringify(payload.data.history))
            }
          }
          setSyncStatus('synced')
        },
      )
      .catch(() => {
        setToken(null)
        setUser(null)
        localStorage.removeItem('smartsplit-token')
        localStorage.removeItem('smartsplit-user')
        sessionStorage.removeItem('smartsplit-token')
      })
  }, [token])

  // Save to local storage
  useEffect(() => {
    localStorage.setItem('smartsplit-groups', JSON.stringify(groups))
  }, [groups])

  useEffect(() => {
    localStorage.setItem('smartsplit-active-group-id', activeGroupId)
  }, [activeGroupId])

  useEffect(() => {
    localStorage.setItem('smartsplit-history', JSON.stringify(history))
  }, [history])

  // Cloud sync debounced save across devices
  const syncTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (!token || !user) return
    if (syncTimeoutRef.current) clearTimeout(syncTimeoutRef.current)

    syncTimeoutRef.current = setTimeout(() => {
      setSyncStatus('syncing')
      fetch('/api/user/sync', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          groups,
          activeGroupId,
          history,
        }),
      })
        .then((res) => {
          if (res.ok) setSyncStatus('synced')
          else setSyncStatus('error')
        })
        .catch(() => setSyncStatus('error'))
    }, 1200)

    return () => {
      if (syncTimeoutRef.current) clearTimeout(syncTimeoutRef.current)
    }
  }, [groups, activeGroupId, history, token, user])

  const values = {
    tax: editedCharges.tax === '' ? null : Number(editedCharges.tax),
    delivery: editedCharges.delivery === '' ? null : Number(editedCharges.delivery),
    other: editedCharges.other === '' ? null : Number(editedCharges.other),
  }

  const itemTotal = items.reduce((sum, item) => sum + item.amount, 0)
  const calculatedTotal = itemTotal + (values.tax || 0) + (values.delivery || 0) + (values.other || 0)
  const currentTotal = items.length ? (charges.total ?? calculatedTotal) : calculatedTotal
  const discrepancy = charges.total !== null && Math.abs(charges.total - calculatedTotal) > 0.01

  const shares = useMemo(() => {
    const totals = Object.fromEntries(people.map((person) => [person.id, 0])) as Record<number, number>
    items.forEach((item) => {
      const ids = included[item.id] || []
      ids.forEach((id) => {
        totals[id] += item.amount / (ids.length || 1)
      })
    })
    const selected = people.filter((person) => Object.values(included).some((ids) => ids.includes(person.id)))
    const targetPeople = selected.length > 0 ? selected : people
    const extras = ((values.tax || 0) + (values.delivery || 0) + (values.other || 0)) / (targetPeople.length || 1)
    targetPeople.forEach((person) => {
      totals[person.id] += extras
    })
    return totals
  }, [included, items, people, values.delivery, values.other, values.tax])

  const addItem = () => {
    const id = Date.now()
    setItems((current) => [...current, { id, name: 'New item', detail: '', amount: 0 }])
    setIncluded((current) => ({ ...current, [id]: people.map((person) => person.id) }))
  }

  const toggle = (itemId: number, personId: number) => {
    setIncluded((current) => {
      const selected = current[itemId] || []
      return {
        ...current,
        [itemId]: selected.includes(personId) ? selected.filter((id) => id !== personId) : [...selected, personId],
      }
    })
  }

  const fileToScreenshotItem = async (file: File): Promise<ScreenshotItem> => {
    const buffer = await file.arrayBuffer()
    return {
      id: `${file.name}_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      name: file.name,
      preview: URL.createObjectURL(file),
      base64: toBase64(buffer),
      mimeType: file.type || 'image/png',
    }
  }

  const resetCurrentBill = () => {
    screenshots.forEach((s) => URL.revokeObjectURL(s.preview))
    setScreenshots([])
    setItems([])
    setCharges(blankCharges)
    setEditedCharges({ tax: '', delivery: '', other: '' })
    setFileName('No bill scanned yet')
    setStatus('Upload bill screenshot(s) to begin')
    setIncluded({})
    setViewMode('split')
  }

  const runOcrOnScreenshots = async (itemsList: ScreenshotItem[]) => {
    if (itemsList.length === 0) return
    setIsScanning(true)
    setItems([])
    setCharges(blankCharges)
    setEditedCharges({ tax: '', delivery: '', other: '' })
    setStatus(
      itemsList.length > 1
        ? `Analyzing ${itemsList.length} continuous screenshots & merging duplicates...`
        : 'Reading screenshot and extracting charges...',
    )

    try {
      const response = await fetch('/api/ocr', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          images: itemsList.map((s) => ({ image: s.base64, mimeType: s.mimeType })),
        }),
      })
      const payload = (await response.json()) as Record<string, unknown>
      if (!response.ok) {
        throw new Error(typeof payload.error === 'string' ? payload.error : `OCR request failed (${response.status})`)
      }

      const result = (payload.result && typeof payload.result === 'object' ? payload.result : payload) as Record<string, unknown>
      const rawItems = Array.isArray(result.items) ? (result.items as OcrItem[]) : []
      const parsed = rawItems
        .filter((item) => item && item.name && (item.amount != null || item.price != null))
        .map((item, index) => ({
          id: index + 1,
          name: String(item.name),
          detail: `${item.quantity ?? ''}${item.unit ? ` ${item.unit}` : ''}`.trim(),
          amount: parseAmount(item.amount ?? item.price) || 0,
        }))

      const rawCharges = (
        result.charges && typeof result.charges === 'object'
          ? { ...result, ...(result.charges as Record<string, unknown>) }
          : result
      ) as Record<string, unknown>

      const taxVal = extractTax(rawCharges)
      const deliveryVal = extractDelivery(rawCharges)
      const otherVal = extractOther(rawCharges)
      const subtotalVal = extractSubtotal(rawCharges)
      const totalVal = extractTotal(rawCharges)

      const nextCharges: Charges = {
        tax: taxVal,
        delivery: deliveryVal,
        other: otherVal,
        other_breakdown: Array.isArray(rawCharges.other_breakdown)
          ? (rawCharges.other_breakdown as Array<{ label: string; amount: number }>)
          : [],
        subtotal: subtotalVal,
        total: totalVal,
      }

      setItems(parsed)
      setCharges(nextCharges)
      setEditedCharges({
        tax: nextCharges.tax !== null ? String(nextCharges.tax) : '',
        delivery: nextCharges.delivery !== null ? String(nextCharges.delivery) : '',
        other: nextCharges.other !== null ? String(nextCharges.other) : '',
      })
      setIncluded(Object.fromEntries(parsed.map((item) => [item.id, people.map((person) => person.id)])))
      setStatus(
        itemsList.length > 1
          ? `${parsed.length} unique items extracted across ${itemsList.length} screenshots · duplicates merged`
          : `${parsed.length} items and charges extracted · review before splitting`,
      )
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'OCR request failed')
    } finally {
      setIsScanning(false)
    }
  }

  const handleInitialUpload = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files
    if (!files || files.length === 0) return
    const fileArray = Array.from(files)
    const loaded = await Promise.all(fileArray.map(fileToScreenshotItem))
    setScreenshots(loaded)
    setFileName(loaded.length === 1 ? loaded[0].name : `${loaded.length} continuous screenshots`)
    void runOcrOnScreenshots(loaded)
    event.target.value = ''
  }

  const handleAppendScreenshots = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files
    if (!files || files.length === 0) return
    const fileArray = Array.from(files)
    const loaded = await Promise.all(fileArray.map(fileToScreenshotItem))
    const updated = [...screenshots, ...loaded]
    setScreenshots(updated)
    setFileName(`${updated.length} continuous screenshots`)
    void runOcrOnScreenshots(updated)
    event.target.value = ''
  }

  const moveScreenshot = (index: number, direction: -1 | 1) => {
    const target = index + direction
    if (target < 0 || target >= screenshots.length) return
    const next = [...screenshots]
    const temp = next[index]
    next[index] = next[target]
    next[target] = temp
    setScreenshots(next)
  }

  const removeScreenshot = (id: string) => {
    const target = screenshots.find((s) => s.id === id)
    if (target) URL.revokeObjectURL(target.preview)
    const next = screenshots.filter((s) => s.id !== id)
    setScreenshots(next)
    if (next.length === 0) {
      resetCurrentBill()
    } else {
      setFileName(next.length === 1 ? next[0].name : `${next.length} continuous screenshots`)
      void runOcrOnScreenshots(next)
    }
  }

  const updateGroupName = (name: string) => {
    setGroups((current) => current.map((g) => (g.id === activeGroup.id ? { ...g, name } : g)))
  }

  const setDefaultGroup = (id: string) => {
    setGroups((current) => current.map((g) => ({ ...g, isDefault: g.id === id })))
  }

  const switchGroup = (id: string) => {
    setActiveGroupId(id)
    const target = groups.find((g) => g.id === id)
    if (target) {
      setIncluded((current) => {
        const next: Record<number, number[]> = {}
        Object.keys(current).forEach((itemIdStr) => {
          next[Number(itemIdStr)] = target.people.map((p) => p.id)
        })
        return next
      })
    }
  }

  const handleCreateGroup = () => {
    const trimmed = newGroupName.trim()
    if (!trimmed) return
    const newId = 'grp_' + Date.now()
    const created: Group = {
      id: newId,
      name: trimmed,
      isDefault: false,
      people: [
        { id: 1, name: 'John Doe', color: colors[0] },
        { id: 2, name: 'Jane Doe', color: colors[1] },
      ],
    }
    setGroups((current) => [...current, created])
    setActiveGroupId(newId)
    setNewGroupName('')
    setShowNewGroupInput(false)
    setIncluded((current) => {
      const next: Record<number, number[]> = {}
      Object.keys(current).forEach((itemIdStr) => {
        next[Number(itemIdStr)] = created.people.map((p) => p.id)
      })
      return next
    })
  }

  const handleDeleteGroup = (id: string) => {
    if (groups.length < 2) return
    const target = groups.find((g) => g.id === id)
    const remaining = groups.filter((g) => g.id !== id)
    if (target?.isDefault && remaining.length > 0) {
      remaining[0].isDefault = true
    }
    setGroups(remaining)
    if (activeGroupId === id) {
      const nextActive = remaining.find((g) => g.isDefault) || remaining[0]
      switchGroup(nextActive.id)
    }
  }

  const updatePersonName = (id: number, name: string) => {
    setGroups((current) =>
      current.map((g) =>
        g.id === activeGroup.id
          ? {
            ...g,
            people: g.people.map((p) => (p.id === id ? { ...p, name } : p)),
          }
          : g,
      ),
    )
  }

  const removePerson = (id: number) => {
    if (people.length < 2) return
    setGroups((current) =>
      current.map((g) =>
        g.id === activeGroup.id
          ? { ...g, people: g.people.filter((p) => p.id !== id) }
          : g,
      ),
    )
    setIncluded((current) =>
      Object.fromEntries(Object.entries(current).map(([key, ids]) => [key, ids.filter((personId) => personId !== id)])),
    )
  }

  const addPerson = () => {
    const newMember: Person = {
      id: Date.now(),
      name: 'New member',
      color: colors[people.length % colors.length],
    }
    setGroups((current) =>
      current.map((g) =>
        g.id === activeGroup.id
          ? { ...g, people: [...g.people, newMember] }
          : g,
      ),
    )
    setIncluded((current) =>
      Object.fromEntries(Object.entries(current).map(([key, ids]) => [key, [...ids, newMember.id]])),
    )
  }

  // Finalize Split functions
  const openFinalizeModal = () => {
    const defaultTitle =
      fileName && fileName !== 'No bill scanned yet'
        ? fileName.replace(/\.[^/.]+$/, '')
        : `${groupName} Bill - ${new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}`
    setSplitTitleInput(defaultTitle)
    setFinalizeModalOpen(true)
  }

  const confirmFinalizeSplit = () => {
    const activeShares = people.map((person) => ({
      personId: person.id,
      name: person.name,
      initials: getInitials(person.id),
      color: person.color,
      amount: shares[person.id] || 0,
    }))

    const newSplit: FinalizedSplit = {
      id: 'split_' + Date.now(),
      title: splitTitleInput.trim() || `${groupName} Split`,
      date: new Date().toISOString(),
      displayDate: new Date().toLocaleString('en-IN', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      }),
      groupId: activeGroup.id,
      groupName: activeGroup.name,
      fileName: fileName !== 'No bill scanned yet' ? fileName : undefined,
      total: currentTotal,
      itemsCount: items.length,
      items: items.map((it) => ({
        id: it.id,
        name: it.name,
        detail: it.detail,
        amount: it.amount,
      })),
      charges: {
        tax: values.tax,
        delivery: values.delivery,
        other: values.other,
        subtotal: charges.subtotal,
        total: charges.total,
      },
      shares: activeShares,
    }

    setHistory((current) => [newSplit, ...current])
    setFinalizeModalOpen(false)
    setExpandedSplitId(newSplit.id)
    setViewMode('history')
  }

  const copySplitSummary = (split: FinalizedSplit) => {
    const shareLines = split.shares
      .filter((s) => s.amount > 0)
      .map((s) => `• ${s.name}: ${money(s.amount)}`)
      .join('\n')

    const text = `🧾 SmartSplit: ${split.title} (${split.displayDate})\nGroup: ${split.groupName}\nTotal: ${money(split.total)}\n\nWho owes what:\n${shareLines}`

    void navigator.clipboard.writeText(text).then(() => {
      setCopiedSplitId(split.id)
      setTimeout(() => setCopiedSplitId(null), 2500)
    })
  }

  const deleteSplit = (id: string) => {
    setHistory((current) => current.filter((s) => s.id !== id))
  }

  // Authentication Handlers
  const handleAuthSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setAuthError(null)
    setAuthLoading(true)

    const endpoint = authMode === 'login' ? '/api/auth/login' : '/api/auth/register'
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: authUsername.trim(),
          password: authPassword,
          rememberMe,
          initialData: { groups, activeGroupId, history },
        }),
      })

      const data = (await res.json()) as {
        user?: User
        token?: string
        error?: string
        data?: { groups?: Group[]; activeGroupId?: string; history?: FinalizedSplit[] }
      }

      if (!res.ok) {
        throw new Error(data.error || 'Authentication failed')
      }

      if (data.user && data.token) {
        if (rememberMe) {
          localStorage.setItem('smartsplit-token', data.token)
          localStorage.setItem('smartsplit-user', JSON.stringify(data.user))
        } else {
          sessionStorage.setItem('smartsplit-token', data.token)
          localStorage.removeItem('smartsplit-token')
          localStorage.setItem('smartsplit-user', JSON.stringify(data.user))
        }

        setToken(data.token)
        setUser(data.user)

        if (data.data) {
          if (Array.isArray(data.data.groups) && data.data.groups.length > 0) {
            setGroups(data.data.groups)
          }
          if (data.data.activeGroupId) {
            setActiveGroupId(data.data.activeGroupId)
          }
          if (Array.isArray(data.data.history)) {
            setHistory(data.data.history)
          }
        }

        setSyncStatus('synced')
        setAuthModalOpen(false)
        setAuthUsername('')
        setAuthPassword('')
      }
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : 'Authentication failed')
    } finally {
      setAuthLoading(false)
    }
  }

  const handleLogout = () => {
    if (token) {
      fetch('/api/auth/logout', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      }).catch(() => { })
    }
    setToken(null)
    setUser(null)
    setSyncStatus('idle')
    localStorage.removeItem('smartsplit-token')
    localStorage.removeItem('smartsplit-user')
    sessionStorage.removeItem('smartsplit-token')

    // Wipe private splits and groups from browser so they don't show when logged out
    localStorage.removeItem('smartsplit-history')
    localStorage.removeItem('smartsplit-groups')
    localStorage.removeItem('smartsplit-active-group-id')
    setHistory([])
    const freshGroups: Group[] = [
      {
        id: 'default',
        name: 'Housemates',
        isDefault: true,
        people: [
          { id: 1, name: 'John Doe', color: colors[0] },
          { id: 2, name: 'Jane Doe', color: colors[1] },
        ],
      },
    ]
    setGroups(freshGroups)
    setActiveGroupId('default')
    resetCurrentBill()
  }

  const filteredHistory = useMemo(() => {
    return history.filter((split) => {
      const matchesGroup = historyFilterGroup === 'all' || split.groupId === historyFilterGroup
      const matchesSearch =
        historySearch.trim() === '' ||
        split.title.toLowerCase().includes(historySearch.toLowerCase()) ||
        split.groupName.toLowerCase().includes(historySearch.toLowerCase()) ||
        split.shares.some((s) => s.name.toLowerCase().includes(historySearch.toLowerCase()))
      return matchesGroup && matchesSearch
    })
  }, [history, historyFilterGroup, historySearch])

  const chargeKeys = ['tax', 'delivery', 'other'] as const

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">S</span>
          <span>smartsplit</span>
        </div>
        <nav>
          <button
            className={`nav-link ${viewMode === 'split' ? 'active' : ''}`}
            onClick={() => setViewMode('split')}
          >
            New split
          </button>
          <button
            className={`nav-link ${viewMode === 'history' ? 'active' : ''}`}
            onClick={() => setViewMode('history')}
          >
            My splits {history.length > 0 && <span className="nav-badge">{history.length}</span>}
          </button>
          <button className="nav-link nav-group-btn" onClick={() => setAccountOpen(true)}>
            Group: <strong>{groupName}</strong> ▾
          </button>
        </nav>

        <div className="topbar-right">
          {user ? (
            <button
              className="auth-btn-pill"
              onClick={() => setAccountOpen(true)}
              title="Cloud sync is active for this account"
            >
              <span className="sync-status-badge">
                {syncStatus === 'syncing' ? '☁ Syncing...' : '● Synced'}
              </span>
              <span>{user.username}</span>
            </button>
          ) : (
            <button className="auth-btn-pill" onClick={() => setAuthModalOpen(true)}>
              <span className="cloud-icon-spin">☁</span>
              <span>Sign In / Sync</span>
            </button>
          )}

          <button className="profile" onClick={() => setAccountOpen(true)}>
            <span className="avatar" style={{ backgroundColor: people[0]?.color }}>
              {getInitials(people[0]?.id || 0)}
            </span>
            <span>{people[0]?.name}</span>⌄
          </button>
        </div>
      </header>

      <div className="content">
        {viewMode === 'split' ? (
          <>
            <div className="page-heading">
              <div>
                <p className="eyebrow">{groupName.toUpperCase()} / NEW BILL</p>
                <h1>
                  New split <span className="status">● Editing</span>
                </h1>
                <p className="muted">Upload a bill, then decide who shares each line.</p>
              </div>
            </div>

            <section className={`upload-strip ${screenshots.length > 0 ? 'has-screenshots' : ''}`}>
              <div className="upload-strip-header">
                <div className="scan-icon">⌁</div>
                <div>
                  <strong>
                    {screenshots.length === 0
                      ? 'Scan a new bill'
                      : screenshots.length === 1
                      ? '1 Bill Screenshot'
                      : `${screenshots.length} Continuous Screenshots`}
                    {screenshots.length > 1 && (
                      <span className="continuity-tag">Scroll Continuity Active</span>
                    )}
                  </strong>
                  <p>
                    {fileName} <span className="dot">•</span> {status}
                  </p>
                </div>

                <div className="upload-strip-actions">
                  {screenshots.length === 0 ? (
                    <button
                      type="button"
                      className="upload-button"
                      onClick={() => fileInput.current?.click()}
                    >
                      ↑ Upload screenshot(s)
                    </button>
                  ) : (
                    <>
                      <button
                        type="button"
                        className="add-more-screenshots-btn"
                        onClick={() => appendFileInput.current?.click()}
                        title="Add the next screenshot in sequence"
                      >
                        ＋ Add screenshot
                      </button>
                      <button
                        type="button"
                        className="rescan-btn"
                        disabled={isScanning}
                        onClick={() => void runOcrOnScreenshots(screenshots)}
                      >
                        {isScanning ? 'Scanning...' : `⚡ Re-scan all (${screenshots.length})`}
                      </button>
                      <button
                        type="button"
                        className="clear-screenshots-btn"
                        onClick={resetCurrentBill}
                      >
                        Clear
                      </button>
                    </>
                  )}
                </div>
              </div>

              <input
                ref={fileInput}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                multiple
                hidden
                onChange={handleInitialUpload}
              />
              <input
                ref={appendFileInput}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                multiple
                hidden
                onChange={handleAppendScreenshots}
              />

              {screenshots.length > 0 && (
                <div className="screenshot-carousel">
                  {screenshots.map((item, idx) => (
                    <div className="screenshot-thumb-card" key={item.id}>
                      <img className="screenshot-thumb-img" src={item.preview} alt={`Screenshot ${idx + 1}`} />
                      <span className="screenshot-badge">
                        #{idx + 1} {idx === 0 && screenshots.length > 1 ? 'Top' : idx === screenshots.length - 1 && screenshots.length > 1 ? 'End' : ''}
                      </span>
                      <button
                        type="button"
                        className="screenshot-remove-btn"
                        onClick={() => removeScreenshot(item.id)}
                        title="Remove this screenshot"
                      >
                        ×
                      </button>
                      {screenshots.length > 1 && (
                        <div className="screenshot-nav-controls">
                          <button
                            type="button"
                            className="screenshot-nav-btn"
                            disabled={idx === 0}
                            onClick={() => moveScreenshot(idx, -1)}
                            title="Move earlier in sequence"
                          >
                            ◀
                          </button>
                          <button
                            type="button"
                            className="screenshot-nav-btn"
                            disabled={idx === screenshots.length - 1}
                            onClick={() => moveScreenshot(idx, 1)}
                            title="Move later in sequence"
                          >
                            ▶
                          </button>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </section>

            <div className="workspace">
              <section className={`items-panel ${items.length ? '' : 'empty-panel'}`}>
                <div className="section-head">
                  <div>
                    <h2>What’s on the bill?</h2>
                    <p className="muted">
                      {items.length ? `${items.length} items found · Tap names to adjust` : 'Items will appear here after scanning'}
                    </p>
                  </div>
                </div>

                {items.length === 0 ? (
                  <div className="empty-state">
                    <div className="empty-symbol">+</div>
                    <h3>No items yet</h3>
                    <p>Scan a grocery screenshot or add a line manually.</p>
                    <button className="primary-button empty-action" onClick={addItem}>
                      ＋ Add item manually <span>→</span>
                    </button>
                  </div>
                ) : (
                  <>
                    <div className="people-row">
                      <span className="label">SPLIT WITH</span>
                      {people.map((person) => (
                        <span className="person-chip" key={person.id}>
                          <span className="avatar" style={{ backgroundColor: person.color }}>
                            {getInitials(person.id)}
                          </span>
                          {person.name}
                        </span>
                      ))}
                    </div>

                    <div className="bill-table">
                      <div className="table-header">
                        <span>ITEM</span>
                        <span>WHO HAD THIS?</span>
                        <span>AMOUNT</span>
                      </div>

                      {items.map((item) => (
                        <div className="item-row" key={item.id}>
                          <div className="item-name">
                            <span className="item-icon">□</span>
                            <span>
                              <input
                                className="inline-item-name"
                                value={item.name}
                                onChange={(event) =>
                                  setItems((current) =>
                                    current.map((entry) => (entry.id === item.id ? { ...entry, name: event.target.value } : entry)),
                                  )
                                }
                              />
                              <input
                                className="inline-detail"
                                value={item.detail}
                                placeholder="quantity / unit"
                                onChange={(event) =>
                                  setItems((current) =>
                                    current.map((entry) => (entry.id === item.id ? { ...entry, detail: event.target.value } : entry)),
                                  )
                                }
                              />
                            </span>
                          </div>

                          <div className="selectors">
                            {people.map((person) => (
                              <button
                                key={person.id}
                                className={`mini-avatar ${(included[item.id] || []).includes(person.id) ? 'selected' : ''}`}
                                style={{ backgroundColor: person.color }}
                                onClick={() => toggle(item.id, person.id)}
                              >
                                {getInitials(person.id)}
                              </button>
                            ))}
                          </div>

                          <input
                            className="inline-amount amount"
                            type="number"
                            step="any"
                            value={item.amount}
                            onChange={(event) =>
                              setItems((current) =>
                                current.map((entry) =>
                                  entry.id === item.id ? { ...entry, amount: Number(event.target.value) || 0 } : entry,
                                ),
                              )
                            }
                          />
                        </div>
                      ))}
                    </div>

                    <button className="add-item-button" onClick={addItem}>
                      ＋ Add item manually
                    </button>
                  </>
                )}

                <div className="bill-options">
                  <div>
                    <h3>Bill extras</h3>
                    <p className="muted">Values detected from bill or entered manually. Edit any value if needed.</p>
                  </div>
                  {chargeKeys.map((key) => (
                    <label key={key}>
                      {key === 'other' ? 'Others' : key[0].toUpperCase() + key.slice(1)}
                      <input
                        type="number"
                        step="any"
                        placeholder="—"
                        value={editedCharges[key]}
                        onChange={(event) =>
                          setEditedCharges((current) => ({
                            ...current,
                            [key]: event.target.value,
                          }))
                        }
                      />
                    </label>
                  ))}
                </div>

                <div className="include-all">
                  <div>
                    <strong>Include everyone in this bill</strong>
                    <p className="muted">Turn off to remove everyone, then select people per item.</p>
                  </div>
                  <button
                    className={`toggle ${items.length > 0 && people.every((person) => Object.values(included).every((ids) => ids.includes(person.id)))
                        ? 'on'
                        : ''
                      }`}
                    onClick={() => {
                      const all = people.every((person) => Object.values(included).every((ids) => ids.includes(person.id)))
                      setIncluded(Object.fromEntries(items.map((item) => [item.id, all ? [] : people.map((person) => person.id)])))
                    }}
                    aria-label="Toggle everyone"
                  >
                    <span />
                  </button>
                </div>
              </section>

              <aside className="summary">
                <div className="summary-top">
                  <span className="label">BILL SUMMARY</span>
                  <span className="receipt">⌗</span>
                </div>
                <h2>{money(currentTotal)}</h2>
                <p className="muted">{items.length ? `${items.length} items + charges` : 'Scan a bill to calculate shares'}</p>
                {discrepancy && (
                  <p className="warning">
                    Receipt total {money(charges.total as number)} differs from calculated {money(calculatedTotal)}. Check extracted values.
                  </p>
                )}
                <div className="rule" />
                {people.map((person) => (
                  <div className="share-row" key={person.id}>
                    <span className="share-person">
                      <span className="avatar" style={{ backgroundColor: person.color }}>
                        {getInitials(person.id)}
                      </span>
                      {person.name}
                    </span>
                    <strong>{money(shares[person.id])}</strong>
                  </div>
                ))}

                <button
                  className="primary-button finalize-btn"
                  onClick={openFinalizeModal}
                  disabled={items.length === 0 && currentTotal === 0}
                  style={{ marginTop: '20px' }}
                >
                  <span>Finalize split</span> <span>→</span>
                </button>
              </aside>
            </div>
          </>
        ) : (
          <div className="history-container">
            <div className="page-heading">
              <div>
                <p className="eyebrow">{groupName.toUpperCase()} / HISTORY</p>
                <h1>
                  My splits <span className="status">● {history.length} finalized</span>
                </h1>
                <p className="muted">Review past finalized bills, breakdowns, and who owes what.</p>
              </div>
              <button className="upload-button" onClick={resetCurrentBill}>
                ＋ New split
              </button>
            </div>

            <div className="history-toolbar">
              <div className="history-filters">
                <button
                  type="button"
                  className={`filter-btn ${historyFilterGroup === 'all' ? 'active' : ''}`}
                  onClick={() => setHistoryFilterGroup('all')}
                >
                  All groups ({history.length})
                </button>
                <button
                  type="button"
                  className={`filter-btn ${historyFilterGroup === activeGroup.id ? 'active' : ''}`}
                  onClick={() => setHistoryFilterGroup(activeGroup.id)}
                >
                  {groupName} ({history.filter((s) => s.groupId === activeGroup.id).length})
                </button>
              </div>

              <input
                className="history-search-input"
                placeholder="Search splits by title or member..."
                value={historySearch}
                onChange={(e) => setHistorySearch(e.target.value)}
              />
            </div>

            {filteredHistory.length === 0 ? (
              <div className="empty-state" style={{ background: '#fffdf7' }}>
                <div className="empty-symbol">⌗</div>
                <h3>No finalized splits found</h3>
                <p>
                  {history.length === 0
                    ? 'Scan a receipt and click "Finalize split" to save it here.'
                    : 'No splits match your search/filter criteria.'}
                </p>
                <button className="primary-button empty-action" onClick={resetCurrentBill}>
                  ＋ Start a new split <span>→</span>
                </button>
              </div>
            ) : (
              <div className="history-list">
                {filteredHistory.map((split) => {
                  const isExpanded = expandedSplitId === split.id
                  return (
                    <div className="history-card" key={split.id}>
                      <div
                        className="history-card-header"
                        onClick={() => setExpandedSplitId(isExpanded ? null : split.id)}
                      >
                        <div className="history-title-group">
                          <div className="history-title-row">
                            <h3 className="history-title">{split.title}</h3>
                            <span className="history-group-tag">{split.groupName}</span>
                          </div>
                          <div className="history-meta">
                            <span>{split.displayDate}</span>
                            <span>•</span>
                            <span>{split.itemsCount} items</span>
                            <span>•</span>
                            <div className="history-participants">
                              {split.shares
                                .filter((s) => s.amount > 0)
                                .map((s) => (
                                  <span
                                    key={s.personId}
                                    className="mini-avatar"
                                    style={{ backgroundColor: s.color, opacity: 1 }}
                                    title={`${s.name}: ${money(s.amount)}`}
                                  >
                                    {s.initials}
                                  </span>
                                ))}
                            </div>
                          </div>
                        </div>

                        <div className="history-total-group">
                          <div className="history-amount">{money(split.total)}</div>
                          <span className={`history-expand-icon ${isExpanded ? 'expanded' : ''}`}>▼</span>
                        </div>
                      </div>

                      {isExpanded && (
                        <div className="history-card-body">
                          <div>
                            <div className="history-section-title">Items & Extras</div>
                            <div className="history-items-list">
                              {split.items.map((it) => (
                                <div className="history-item-row" key={it.id}>
                                  <div>
                                    <span className="history-item-name">{it.name}</span>
                                    {it.detail && <span className="history-item-detail">({it.detail})</span>}
                                  </div>
                                  <strong>{money(it.amount)}</strong>
                                </div>
                              ))}
                            </div>

                            <div className="history-extras-summary">
                              {split.charges.tax != null && split.charges.tax > 0 && (
                                <span>Tax: <strong>{money(split.charges.tax)}</strong></span>
                              )}
                              {split.charges.delivery != null && split.charges.delivery > 0 && (
                                <span>Delivery: <strong>{money(split.charges.delivery)}</strong></span>
                              )}
                              {split.charges.other != null && split.charges.other > 0 && (
                                <span>Others: <strong>{money(split.charges.other)}</strong></span>
                              )}
                            </div>
                          </div>

                          <div>
                            <div className="history-section-title">Who Owes What</div>
                            <div className="history-shares-grid">
                              {split.shares.map((share) => (
                                <div className="history-share-item" key={share.personId}>
                                  <div className="history-share-person">
                                    <span className="avatar" style={{ backgroundColor: share.color }}>
                                      {share.initials}
                                    </span>
                                    <span>{share.name}</span>
                                  </div>
                                  <span className="history-share-val">{money(share.amount)}</span>
                                </div>
                              ))}
                            </div>
                          </div>

                          <div className="history-card-footer">
                            <button
                              type="button"
                              className="copy-summary-btn"
                              onClick={() => copySplitSummary(split)}
                            >
                              📋 {copiedSplitId === split.id ? '✓ Copied to clipboard!' : 'Copy WhatsApp summary'}
                            </button>

                            <button
                              type="button"
                              className="delete-split-btn"
                              onClick={() => deleteSplit(split.id)}
                            >
                              Delete from history
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )}
      </div>

      {/* User Auth Modal (Register / Login) */}
      {authModalOpen && (
        <div className="modal-backdrop" onClick={() => setAuthModalOpen(false)}>
          <section className="account-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-heading">
              <div>
                <p className="eyebrow">SMARTSPLIT CLOUD</p>
                <h2>{authMode === 'login' ? 'Sign In' : 'Create Account'}</h2>
              </div>
              <button className="close-button" onClick={() => setAuthModalOpen(false)}>
                ×
              </button>
            </div>

            <div className="auth-modal-tabs">
              <button
                type="button"
                className={`auth-tab-btn ${authMode === 'login' ? 'active' : ''}`}
                onClick={() => {
                  setAuthMode('login')
                  setAuthError(null)
                }}
              >
                Sign In
              </button>
              <button
                type="button"
                className={`auth-tab-btn ${authMode === 'register' ? 'active' : ''}`}
                onClick={() => {
                  setAuthMode('register')
                  setAuthError(null)
                }}
              >
                Create Account
              </button>
            </div>

            {authError && <div className="auth-error-banner">{authError}</div>}

            <form className="auth-form" onSubmit={handleAuthSubmit}>
              <label className="field-label">
                <span>Username</span>
                <input
                  type="text"
                  required
                  value={authUsername}
                  onChange={(e) => setAuthUsername(e.target.value)}
                  placeholder=""
                  autoFocus
                />
              </label>

              <label className="field-label">
                <span>Password</span>
                <input
                  type="password"
                  required
                  value={authPassword}
                  onChange={(e) => setAuthPassword(e.target.value)}
                  placeholder=""
                />
              </label>

              <label className="remember-me-label">
                <input
                  type="checkbox"
                  checked={rememberMe}
                  onChange={(e) => setRememberMe(e.target.checked)}
                />
                <span>Remember me on this device (stays logged in for 90 days)</span>
              </label>

              <div className="auth-notice-box">
                ☁ Sync your splits across devices.
              </div>

              <button type="submit" className="primary-button" disabled={authLoading}>
                <span>
                  {authLoading
                    ? 'Connecting...'
                    : authMode === 'login'
                      ? 'Sign In & Sync'
                      : 'Create Account & Sync'}
                </span>
                <span>→</span>
              </button>

              <button
                type="button"
                className="auth-switch-link"
                onClick={() => {
                  setAuthMode(authMode === 'login' ? 'register' : 'login')
                  setAuthError(null)
                }}
              >
                {authMode === 'login'
                  ? "Don't have an account? Create one now"
                  : 'Already have an account? Sign in'}
              </button>
            </form>
          </section>
        </div>
      )}

      {/* Finalize Split Confirmation Modal */}
      {finalizeModalOpen && (
        <div className="modal-backdrop" onClick={() => setFinalizeModalOpen(false)}>
          <section className="account-modal" onClick={(event) => event.stopPropagation()}>
            <div className="modal-heading">
              <div>
                <p className="eyebrow">SAVE & FINALIZE</p>
                <h2>Finalize this split</h2>
              </div>
              <button className="close-button" onClick={() => setFinalizeModalOpen(false)}>
                ×
              </button>
            </div>

            <label className="field-label">
              <span>Split Title</span>
              <input
                value={splitTitleInput}
                onChange={(e) => setSplitTitleInput(e.target.value)}
                placeholder="Bill title..."
                autoFocus
              />
            </label>

            <div className="finalize-modal-preview">
              <div className="finalize-row">
                <span>Group:</span>
                <strong>{groupName}</strong>
              </div>
              <div className="finalize-row">
                <span>Items count:</span>
                <strong>{items.length} items</strong>
              </div>
              <div className="finalize-row">
                <span>Total amount:</span>
                <strong style={{ fontSize: '15px', color: '#ef765c' }}>{money(currentTotal)}</strong>
              </div>
            </div>

            <p className="label member-label">SHARES BREAKDOWN</p>
            <div className="member-list">
              {people.map((p) => (
                <div className="member-edit" key={p.id} style={{ justifyContent: 'space-between' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <span className="avatar" style={{ backgroundColor: p.color }}>
                      {getInitials(p.id)}
                    </span>
                    <span style={{ fontSize: '13px', fontWeight: 600 }}>{p.name}</span>
                  </div>
                  <strong style={{ fontSize: '13px' }}>{money(shares[p.id] || 0)}</strong>
                </div>
              ))}
            </div>

            <button className="primary-button" onClick={confirmFinalizeSplit} style={{ marginTop: '20px' }}>
              Confirm & Save to History <span>→</span>
            </button>
          </section>
        </div>
      )}

      {/* Account & Groups Modal */}
      {accountOpen && (
        <div className="modal-backdrop" onClick={() => setAccountOpen(false)}>
          <section className="account-modal" onClick={(event) => event.stopPropagation()}>
            <div className="modal-heading">
              <div>
                <p className="eyebrow">ACCOUNT & GROUPS</p>
                <h2>{activeGroup.name}</h2>
              </div>
              <button className="close-button" onClick={() => setAccountOpen(false)}>
                ×
              </button>
            </div>

            {/* Cloud User Banner */}
            {user ? (
              <div className="account-section-banner">
                <div className="account-section-user">
                  <span className="avatar" style={{ backgroundColor: '#25242b' }}>
                    {user.username.slice(0, 2).toUpperCase()}
                  </span>
                  <div>
                    <strong style={{ fontSize: '13px' }}>{user.username}</strong>
                    <p className="muted" style={{ fontSize: '10px', margin: 0 }}>
                      ☁ Cloud Sync Active · Syncing with your devices
                    </p>
                  </div>
                </div>
                <button type="button" className="account-logout-btn" onClick={handleLogout}>
                  Log out
                </button>
              </div>
            ) : (
              <div className="account-section-banner">
                <div>
                  <strong style={{ fontSize: '12px' }}>Local Storage Only</strong>
                  <p className="muted" style={{ fontSize: '10px', margin: 0 }}>
                    Sign in to sync your groups & history across phone and PC.
                  </p>
                </div>
                <button
                  type="button"
                  className="action-btn-sm"
                  onClick={() => {
                    setAccountOpen(false)
                    setAuthModalOpen(true)
                  }}
                >
                  Sign In / Sync
                </button>
              </div>
            )}

            <div className="group-selector-section">
              <p className="label">CHOOSE GROUP ({groups.length})</p>
              <div className="group-chips">
                {groups.map((group) => {
                  const isCurrent = group.id === activeGroup.id
                  return (
                    <button
                      key={group.id}
                      type="button"
                      className={`group-chip-btn ${isCurrent ? 'active' : ''}`}
                      onClick={() => switchGroup(group.id)}
                    >
                      <span>{group.name}</span>
                      {group.isDefault && <span className="default-tag">DEFAULT</span>}
                    </button>
                  )
                })}
                <button
                  type="button"
                  className="add-group-toggle-btn"
                  onClick={() => setShowNewGroupInput((v) => !v)}
                >
                  ＋ New group
                </button>
              </div>

              {showNewGroupInput && (
                <div className="create-group-box">
                  <input
                    placeholder="New group name (e.g. Goa Trip)..."
                    value={newGroupName}
                    onChange={(e) => setNewGroupName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleCreateGroup()
                    }}
                    autoFocus
                  />
                  <button type="button" className="action-btn-sm" onClick={handleCreateGroup}>
                    Create
                  </button>
                  <button
                    type="button"
                    className="cancel-btn-sm"
                    onClick={() => {
                      setShowNewGroupInput(false)
                      setNewGroupName('')
                    }}
                  >
                    Cancel
                  </button>
                </div>
              )}
            </div>

            <div className="active-group-details">
              <label className="field-label">
                <span>Group name</span>
                <input
                  value={activeGroup.name}
                  onChange={(event) => updateGroupName(event.target.value)}
                />
              </label>

              <div className="group-toolbar">
                {activeGroup.isDefault ? (
                  <span className="is-default-badge">★ Default Group</span>
                ) : (
                  <button
                    type="button"
                    className="set-default-btn"
                    onClick={() => setDefaultGroup(activeGroup.id)}
                  >
                    ★ Set as default group
                  </button>
                )}

                {groups.length > 1 && (
                  <button
                    type="button"
                    className="delete-group-btn"
                    onClick={() => handleDeleteGroup(activeGroup.id)}
                  >
                    Delete group
                  </button>
                )}
              </div>

              <p className="label member-label">MEMBERS · {people.length}</p>
              <div className="member-list">
                {people.map((person) => (
                  <div className="member-edit" key={person.id}>
                    <span className="avatar" style={{ backgroundColor: person.color }}>
                      {getInitials(person.id)}
                    </span>
                    <input
                      value={person.name}
                      onChange={(event) => updatePersonName(person.id, event.target.value)}
                    />
                    <button
                      className="remove-member"
                      onClick={() => removePerson(person.id)}
                      disabled={people.length < 2}
                      aria-label={`Remove ${person.name}`}
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>

              <button className="add-member-button" onClick={addPerson}>
                ＋ Add member
              </button>
            </div>

            <button className="primary-button" onClick={() => setAccountOpen(false)}>
              Done <span>→</span>
            </button>
          </section>
        </div>
      )}
    </main>
  )
}

export default App
