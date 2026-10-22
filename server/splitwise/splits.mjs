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
 * `shares` are rupee amounts keyed by the SmartSplit person name. `total`
 * is the amount actually owed in aggregate; any difference beyond normal
 * floating point drift is rejected instead of being silently absorbed.
 */
export function buildExpenseData({
  group,
  total,
  description,
  currency = 'INR',
  shares,
  payer = null,
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

  const allocated = allocatePaise(incoming, totalPaise)
  const rows = allocated.map((entry) => ({
    user: matchMemberByName(group, entry.name),
    owedPaise: entry.paise,
  }))

  const payerUser = payer
    ? matchMemberByName(group, payer)
    : group.members.find((user) => String(user.id) === String(currentUserId))

  if (!payerUser) {
    throw new Error('Could not resolve who paid this bill in the Splitwise group.')
  }

  const payerId = String(payerUser.id)
  const seen = new Set()

  const uniqueRows = []

  for (const row of rows) {
    const id = String(row.user.id)

    if (seen.has(id)) {
      throw new Error(`"${fullName(row.user)}" appears twice in this split.`)
    }

    seen.add(id)
    uniqueRows.push(row)
  }

  const payerRow = uniqueRows.find((row) => String(row.user.id) === payerId)

  if (payerRow) {
    payerRow.paidPaise = totalPaise
  } else {
    // The payer can legitimately owe nothing (for example when their
    // items were excluded), so add them with a zero owed share.
    uniqueRows.push({
      user: payerUser,
      owedPaise: 0,
      paidPaise: totalPaise,
    })
  }

  for (const row of uniqueRows) {
    if (row.paidPaise === undefined) {
      row.paidPaise = 0
    }
  }

  const data = {
    cost: (totalPaise / 100).toFixed(2),
    description: String(description).trim(),
    currency_code: currency || 'INR',
    group_id: String(group.id),
  }

  // Splitwise accepts a plain YYYY-MM-DD date; anything else is left to default.
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) {
    data.date = String(date)
  }

  uniqueRows.forEach((row, index) => {
    data[`users__${index}__user_id`] = String(row.user.id)
    data[`users__${index}__paid_share`] = (row.paidPaise / 100).toFixed(2)
    data[`users__${index}__owed_share`] = (row.owedPaise / 100).toFixed(2)
  })

  return {
    data,
    rows: uniqueRows.map((row) => ({
      user_id: String(row.user.id),
      name: fullName(row.user),
      paid: (row.paidPaise / 100).toFixed(2),
      owed: (row.owedPaise / 100).toFixed(2),
    })),
    payer: { id: payerId, name: fullName(payerUser) },
  }
}
