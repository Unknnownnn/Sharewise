// Splitwise payload building for SmartSplit.
//
// SmartSplit computes per-person shares as floating point rupee amounts
// (item amount / number of people sharing it, plus evenly split charges).
// Splitwise requires paid_share and owed_share to add up to the cost to
// the paise, so everything is converted to integer paise and the rounding
// remainder is distributed before the payload is built.

export function normalizeName(value) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

export function fullName(user) {
  const name = [user.first_name, user.last_name].filter(Boolean).join(' ').trim()
  return name || String(user.id)
}

/**
 * Converts rupee amounts to integer paise so that they sum exactly to
 * totalPaise. The leftover paise go to the largest fractional remainders.
 */
export function allocatePaise(shares, totalPaise) {
  const rows = shares.map((share) => {
    const exact = Number(share.amount) * 100
    const floor = Math.floor(exact)
    return { name: share.name, paise: floor, remainder: exact - floor }
  })

  if (!rows.length) {
    return []
  }

  let difference = totalPaise - rows.reduce((sum, row) => sum + row.paise, 0)

  const byRemainder = rows
    .map((row, index) => ({ index, remainder: row.remainder }))
    .sort((a, b) => b.remainder - a.remainder)
    .map((entry) => entry.index)

  let cursor = 0

  while (difference > 0) {
    rows[byRemainder[cursor % byRemainder.length]].paise += 1
    difference -= 1
    cursor += 1
  }

  const bySize = rows
    .map((row, index) => ({ index, paise: row.paise }))
    .sort((a, b) => b.paise - a.paise)
    .map((entry) => entry.index)

  let guard = 0

  while (difference < 0 && guard < 10_000) {
    const target = rows[bySize[guard % bySize.length]]

    if (target.paise > 0) {
      target.paise -= 1
      difference += 1
    }

    guard += 1
  }

  return rows.map((row) => ({ name: row.name, paise: row.paise }))
}

export function matchMemberByName(group, name) {
  const needle = normalizeName(name)

  const matches = group.members.filter(
    (user) =>
      normalizeName(fullName(user)) === needle ||
      normalizeName(user.first_name) === needle,
  )

  if (matches.length > 1) {
    throw new Error(`"${name}" matches multiple Splitwise members. Use full names.`)
  }

  if (!matches.length) {
    throw new Error(`"${name}" is not in Splitwise group "${group.name}".`)
  }

  return matches[0]
}

/**
 * Resolves a SmartSplit name to a Splitwise member without guessing wildly.
 *
 * Order: exact full name, exact first name, unique prefix (three or more
 * characters), unique single initial. Ambiguous or unknown names return
 * null so the caller can skip them instead of attributing someone else's
 * money. An explicit mapping from the group settings always wins.
 */
export function resolveMember(group, name) {
  const needle = normalizeName(name)

  if (!needle) {
    return null
  }

  const exact = group.members.filter((user) => normalizeName(fullName(user)) === needle)

  if (exact.length === 1) return exact[0]
  if (exact.length > 1) return null

  const byFirst = group.members.filter((user) => normalizeName(user.first_name) === needle)

  if (byFirst.length === 1) return byFirst[0]
  if (byFirst.length > 1) return null

  if (needle.length >= 3) {
    const prefixed = group.members.filter((user) => {
      const full = normalizeName(fullName(user))
      const first = normalizeName(user.first_name)
      return full.startsWith(needle) || first.startsWith(needle)
    })

    if (prefixed.length === 1) return prefixed[0]
  }

  if (needle.length === 1) {
    const initial = group.members.filter((user) =>
      normalizeName(user.first_name).startsWith(needle),
    )

    if (initial.length === 1) return initial[0]
  }

  return null
}

export function findGroupByName(groups, groupName) {
  const needle = normalizeName(groupName).replace(/\s+/g, '')

  let target = groups.find((group) => normalizeName(group.name).replace(/\s+/g, '') === needle)

  if (!target) {
    const matches = groups.filter((group) =>
      normalizeName(group.name).replace(/\s+/g, '').includes(needle),
    )

    if (matches.length > 1) {
      throw new Error(`Splitwise group "${groupName}" is ambiguous. Use the exact name.`)
    }

    target = matches[0]
  }

  if (!target) {
    throw new Error(`Splitwise group "${groupName}" was not found.`)
  }

  return target
}

/**
 * Builds the flattened users__N__* body for POST /create_expense.
 *
 * `shares` are rupee amounts. Each share may carry an explicit `user_id`
 * (from the saved mapping) or `skip`. Without an id the member is resolved
 * by name; people who cannot be resolved are skipped and reported, and the
 * expense cost becomes the sum of the people who were actually included.
 *
 * `total` is the amount owed in aggregate; any difference beyond normal
 * floating point drift is rejected instead of being silently absorbed.
 */
export function buildExpenseData({
  group,
  total,
  description,
  currency = 'INR',
  shares,
  payer = null,
  payerId = null,
  date = null,
  currentUserId,
}) {
  if (!Array.isArray(group?.members) || !group.members.length) {
    throw new Error('The selected Splitwise group has no members.')
  }

  const totalPaise = Math.round(Number(total) * 100)

  if (!Number.isFinite(totalPaise) || totalPaise <= 0) {
    throw new Error('The split total must be greater than zero.')
  }

  if (!description || !String(description).trim()) {
    throw new Error('A description is required.')
  }

  const incoming = (shares || []).filter((share) => Number(share.amount) > 0)

  if (!incoming.length) {
    throw new Error('Nobody owes anything in this split.')
  }

  const rawPaise = incoming.reduce(
    (sum, share) => sum + Math.round(Number(share.amount) * 100),
    0,
  )

  // Share totals can drift by a few paise because of division. Anything
  // larger means the bill and the shares disagree, so refuse to guess.
  if (Math.abs(rawPaise - totalPaise) > 100) {
    throw new Error(
      `Shares add up to ${(rawPaise / 100).toFixed(2)} but the total is ` +
        `${(totalPaise / 100).toFixed(2)}. Fix the bill before sending.`,
    )
  }

  const matched = []
  const skipped = []
  let skippedPaise = 0

  for (const share of incoming) {
    if (share.skip) {
      skippedPaise += Math.round(Number(share.amount) * 100)
      skipped.push({
        name: share.name,
        amount: (Math.round(Number(share.amount) * 100) / 100).toFixed(2),
      })
      continue
    }

    const mapped = share.user_id
      ? group.members.find((user) => String(user.id) === String(share.user_id))
      : null

    const member = mapped || resolveMember(group, share.name)

    if (!member) {
      skippedPaise += Math.round(Number(share.amount) * 100)
      skipped.push({
        name: share.name,
        amount: (Math.round(Number(share.amount) * 100) / 100).toFixed(2),
      })
      continue
    }

    matched.push({ name: share.name, amount: Number(share.amount), user: member })
  }

  if (!matched.length) {
    throw new Error(
      'None of the people in this split match the Splitwise group. ' +
        'Set the mapping in the group settings, then try again.',
    )
  }

  const seen = new Map()

  for (const row of matched) {
    const id = String(row.user.id)

    if (seen.has(id)) {
      throw new Error(
        `"${seen.get(id)}" and "${row.name}" both map to ${fullName(row.user)}. ` +
          'Fix the Splitwise mapping in the group settings.',
      )
    }

    seen.set(id, row.name)
  }

  const keptPaise = matched.reduce((sum, row) => sum + Math.round(row.amount * 100), 0)
  const allocated = allocatePaise(
    matched.map(({ name, amount }) => ({ name, amount })),
    keptPaise,
  )

  const rows = matched.map((row, index) => ({
    user: row.user,
    owedPaise: allocated[index].paise,
  }))

  const payerUser = payerId
    ? group.members.find((user) => String(user.id) === String(payerId))
    : payer
      ? matchMemberByName(group, payer)
      : group.members.find((user) => String(user.id) === String(currentUserId))

  if (!payerUser) {
    throw new Error('Could not resolve who paid this bill in the Splitwise group.')
  }

  const payerUserId = String(payerUser.id)
  const payerRow = rows.find((row) => String(row.user.id) === payerUserId)

  if (payerRow) {
    payerRow.paidPaise = keptPaise
  } else {
    // The payer can legitimately owe nothing (for example when their
    // items were excluded), so add them with a zero owed share.
    rows.push({
      user: payerUser,
      owedPaise: 0,
      paidPaise: keptPaise,
    })
  }

  for (const row of rows) {
    if (row.paidPaise === undefined) {
      row.paidPaise = 0
    }
  }

  const data = {
    cost: (keptPaise / 100).toFixed(2),
    description: String(description).trim(),
    currency_code: currency || 'INR',
    group_id: String(group.id),
  }

  // Splitwise accepts a plain YYYY-MM-DD date; anything else is left to default.
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) {
    data.date = String(date)
  }

  rows.forEach((row, index) => {
    data[`users__${index}__user_id`] = String(row.user.id)
    data[`users__${index}__paid_share`] = (row.paidPaise / 100).toFixed(2)
    data[`users__${index}__owed_share`] = (row.owedPaise / 100).toFixed(2)
  })

  return {
    data,
    rows: rows.map((row) => ({
      user_id: String(row.user.id),
      name: fullName(row.user),
      paid: (row.paidPaise / 100).toFixed(2),
      owed: (row.owedPaise / 100).toFixed(2),
    })),
    payer: { id: payerUserId, name: fullName(payerUser) },
    skipped,
    totals: {
      requested: (totalPaise / 100).toFixed(2),
      included: (keptPaise / 100).toFixed(2),
      skipped: (skippedPaise / 100).toFixed(2),
    },
  }
}
