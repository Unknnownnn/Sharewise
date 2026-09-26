import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { config } from 'dotenv'

config()

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const distDir = path.join(__dirname, 'dist')
const dataDir = path.join(__dirname, 'data')
const dbFile = path.join(dataDir, 'smartsplit_db.json')

// Ensure data directory exists
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true })
}

function loadDb() {
  try {
    if (fs.existsSync(dbFile)) {
      const parsed = JSON.parse(fs.readFileSync(dbFile, 'utf8'))
      if (parsed && typeof parsed === 'object') {
        return {
          users: parsed.users || {},
          sessions: parsed.sessions || {},
        }
      }
    }
  } catch (e) {
    console.error('Failed to read smartsplit_db.json, initializing fresh db:', e)
  }
  return { users: {}, sessions: {} }
}

const db = loadDb()

function saveDb() {
  try {
    fs.writeFileSync(dbFile, JSON.stringify(db, null, 2), 'utf8')
  } catch (e) {
    console.error('Failed to save smartsplit_db.json:', e)
  }
}

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex')
}

function getAuthenticatedUser(request) {
  const authHeader = request.headers.authorization || ''
  const token = authHeader.replace(/^Bearer\s+/i, '').trim()
  if (!token || !db.sessions[token]) return null

  const session = db.sessions[token]
  if (Date.now() > session.expiresAt) {
    delete db.sessions[token]
    saveDb()
    return null
  }

  const user = db.users[session.usernameLower]
  if (!user) return null
  return { token, user }
}

async function readJsonBody(request) {
  let raw = ''
  for await (const chunk of request) raw += chunk
  if (!raw.trim()) return {}
  return JSON.parse(raw)
}

const port = Number(process.env.PORT || process.env.API_PORT || 80)
const host = process.env.HOST || '0.0.0.0'
const model = process.env.OPENROUTER_MODEL || 'openrouter/free'

const extractionPromptSingle = `Look at this grocery/delivery bill screenshot carefully. Return JSON only. First inspect the complete final bill summary section, usually near the bottom, and read the exact visible values for tax/GST, delivery or delivery fee, handling/convenience/platform/rain/surge/peak charges, discounts/coupons/offers/savings, subtotal, and final bill total. A visible FREE delivery means delivery is 0; an unreadable or absent value must be null, never 0. Do not guess or calculate a charge from the total. Extract every purchased product and its final line amount. Put every fee other than tax, delivery, and discount into other, and list its visible components in other_breakdown. If there is any discount, coupon, offer discount, or savings shown, put the absolute (positive) value into discount. Return exactly: {"items":[{"name":string,"quantity":string|null,"unit":string|null,"amount":number|null,"confidence":number}],"charges":{"tax":number|null,"delivery":number|null,"discount":number|null,"other":number|null,"other_breakdown":[{"label":string,"amount":number}],"subtotal":number|null,"total":number|null}}. Amounts must be numbers without currency symbols. Discount must be a positive number (even if shown as negative on the bill).`

const extractionPromptMulti = `You are analyzing a sequence of multiple continuous screenshots of the SAME single order/receipt bill, captured in scroll order from top to bottom.

CRITICAL CONTINUITY & DEDUPLICATION RULES:
1. Continuous Scroll Overlap: The user took multiple screenshots while scrolling down through a long bill. Consecutive screenshots frequently overlap vertically.
2. Deduplicate Overlapping Items: If a purchased item is visible in more than one screenshot (e.g. cut off or shown near the bottom of screenshot N and visible again at the top of screenshot N+1), you MUST DEDUPLICATE IT. DO NOT list the same purchased item twice! Include each unique purchased product/item exactly once in the "items" list.
3. Natural Order: List the items in their natural chronological order from the top of the first screenshot down through the final screenshot.
4. Summary & Extras: Extract the full bill breakdown (subtotal, tax/GST, delivery fees, handling/platform/surge/rain/packaging fees, discounts/coupons/offer discounts/savings, and final grand total). These summary charges are located near the bottom of the final screenshot(s). A visible FREE delivery means delivery is 0; an unreadable or absent value must be null, never 0. Do not guess or calculate charges from the total. Put every fee other than tax, delivery, and discount into other, and list its visible components in other_breakdown. If there is any discount, coupon, offer discount, or savings shown, put the absolute (positive) value into discount.

Return JSON only in this exact format:
{"items":[{"name":string,"quantity":string|null,"unit":string|null,"amount":number|null,"confidence":number}],"charges":{"tax":number|null,"delivery":number|null,"discount":number|null,"other":number|null,"other_breakdown":[{"label":string,"amount":number}],"subtotal":number|null,"total":number|null}}
Amounts must be numbers without currency symbols. Discount must be a positive number (even if shown as negative/green on the bill).`

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
}

function sendJson(response, status, body, requestOrigin = '*') {
  response.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': requestOrigin || '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  })
  response.end(JSON.stringify(body))
}

function serveStaticFile(request, response) {
  const urlPath = new URL(request.url, `http://${request.headers.host || 'localhost'}`).pathname
  let filePath = path.join(distDir, urlPath === '/' ? 'index.html' : urlPath)

  if (!filePath.startsWith(distDir)) {
    response.writeHead(403)
    return response.end('Forbidden')
  }

  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    filePath = path.join(distDir, 'index.html')
  }

  if (!fs.existsSync(filePath)) {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    return response.end(`
      <!doctype html>
      <html>
        <head><title>SmartSplit Server</title></head>
        <body style="font-family: system-ui, -apple-system, sans-serif; padding: 40px; text-align: center; background: #faf7f0; color: #25242b;">
          <h2>SmartSplit Server is Running!</h2>
          <p>Frontend build not detected in <code>dist/</code>.</p>
          <p>Please run <code>npm run build</code> to compile the client application.</p>
        </body>
      </html>
    `)
  }

  const ext = path.extname(filePath).toLowerCase()
  const contentType = MIME_TYPES[ext] || 'application/octet-stream'
  const stream = fs.createReadStream(filePath)
  response.writeHead(200, {
    'Content-Type': contentType,
    'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable',
  })
  stream.pipe(response)
}

function parseModelJson(content) {
  const text = typeof content === 'string' ? content : Array.isArray(content) ? content.map((part) => part.text || '').join('') : ''
  const cleaned = text.replace(/^```json\s*/i, '').replace(/\s*```$/i, '').trim()
  if (!cleaned) throw new Error('The model returned an empty response')
  try { return JSON.parse(cleaned) }
  catch {
    const start = cleaned.indexOf('{')
    const end = cleaned.lastIndexOf('}')
    if (start >= 0 && end > start) return JSON.parse(cleaned.slice(start, end + 1))
    throw new Error('The model returned incomplete JSON')
  }
}

function parseAmount(val) {
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
          if (entry && typeof entry === 'object' && 'amount' in entry) return parseAmount(entry.amount)
          return parseAmount(entry)
        })
        .filter((n) => n !== null && Number.isFinite(n))
      return nums.length > 0 ? nums.reduce((a, b) => a + b, 0) : null
    }
    const nums = Object.values(val)
      .map(parseAmount)
      .filter((n) => n !== null && Number.isFinite(n))
    return nums.length > 0 ? nums.reduce((a, b) => a + b, 0) : null
  }
  return null
}

function normalizeCharges(payload) {
  const source = payload?.charges && typeof payload.charges === 'object' ? payload.charges : payload || {}

  let tax = null
  const taxAliases = [
    'tax', 'taxes', 'gst', 'gst_amount', 'tax_amount',
    'taxes_and_charges', 'tax_and_charges', 'taxes_charges',
    'total_tax', 'govt_taxes', 'govt_tax', 'vat',
  ]
  for (const alias of taxAliases) {
    if (source[alias] !== undefined && source[alias] !== null) {
      const parsed = parseAmount(source[alias])
      if (parsed !== null) { tax = parsed; break }
    }
  }

  const cgst = parseAmount(source.cgst ?? source.cgst_amount)
  const sgst = parseAmount(source.sgst ?? source.sgst_amount)
  const igst = parseAmount(source.igst ?? source.igst_amount)
  if (cgst !== null || sgst !== null || igst !== null) {
    tax = (tax || 0) + (cgst || 0) + (sgst || 0) + (igst || 0)
  }

  let delivery = null
  const deliveryAliases = ['delivery', 'delivery_charges', 'delivery_charge', 'delivery_fee', 'shipping', 'shipping_fee']
  for (const alias of deliveryAliases) {
    if (source[alias] !== undefined && source[alias] !== null) {
      const parsed = parseAmount(source[alias])
      if (parsed !== null) { delivery = parsed; break }
    }
  }

  let other = null
  const otherAliases = ['other', 'other_charges', 'other_charge', 'other_fee', 'others']
  for (const alias of otherAliases) {
    if (source[alias] !== undefined && source[alias] !== null) {
      const parsed = parseAmount(source[alias])
      if (parsed !== null) { other = parsed; break }
    }
  }

  const detailedKeys = [
    'handling', 'handling_charge', 'handling_fee',
    'surge', 'surge_charge',
    'rain_fee', 'rain_charge',
    'peak_fee', 'weather_charge',
    'platform', 'platform_fee',
    'service_fee', 'convenience_fee',
    // NOTE: discount keys excluded — handled by discountAliases block below
  ]
  const detailedOther = detailedKeys
    .map((k) => parseAmount(source[k]))
    .filter((n) => n !== null)
    .reduce((sum, n) => sum + n, 0)

  if (detailedOther > 0) {
    other = (other || 0) + detailedOther
  }

  let other_breakdown = Array.isArray(source.other_breakdown) ? source.other_breakdown : []
  if (tax === null && other_breakdown.length > 0) {
    const taxEntry = other_breakdown.find((entry) => entry && typeof entry.label === 'string' && /tax|gst|vat/i.test(entry.label))
    if (taxEntry && taxEntry.amount != null) {
      tax = parseAmount(taxEntry.amount)
      other_breakdown = other_breakdown.filter((entry) => entry !== taxEntry)
    }
  }

  let subtotal = null
  for (const k of ['subtotal', 'item_total', 'items_total']) {
    if (source[k] !== undefined && source[k] !== null) {
      const parsed = parseAmount(source[k])
      if (parsed !== null) { subtotal = parsed; break }
    }
  }

  let total = null
  for (const k of ['total', 'bill_total', 'grand_total', 'order_total', 'final_total']) {
    if (source[k] !== undefined && source[k] !== null) {
      const parsed = parseAmount(source[k])
      if (parsed !== null) { total = parsed; break }
    }
  }

  // Extract discount separately (offer discount, coupon, savings etc.)
  let discount = null
  const discountAliases = [
    'discount', 'discount_amount', 'product_discount', 'item_discount',
    'total_discount', 'coupon_discount', 'coupon', 'promo_discount',
    'offer_discount', 'savings', 'total_savings',
  ]
  for (const alias of discountAliases) {
    if (source[alias] !== undefined && source[alias] !== null) {
      const parsed = parseAmount(source[alias])
      // Discounts may be stored as negative numbers — normalise to positive
      if (parsed !== null) { discount = Math.abs(parsed); break }
    }
  }
  // Also check other_breakdown for discount-like line items
  if (discount === null && other_breakdown.length > 0) {
    const discountEntry = other_breakdown.find(
      (entry) => entry && typeof entry.label === 'string' && /discount|coupon|promo|saving|offer/i.test(entry.label)
    )
    if (discountEntry && discountEntry.amount != null) {
      discount = Math.abs(parseAmount(discountEntry.amount) ?? 0) || null
      // Remove from other_breakdown since it now has its own field
      other_breakdown = other_breakdown.filter((entry) => entry !== discountEntry)
    }
  }

  return {
    ...payload,
    charges: {
      tax,
      delivery,
      discount,
      other,
      other_breakdown,
      subtotal,
      total,
    },
  }
}

function deduplicateItems(items) {
  if (!Array.isArray(items) || items.length <= 1) return items
  const result = []
  for (let i = 0; i < items.length; i++) {
    const curr = items[i]
    if (!curr || !curr.name) continue

    const normCurrName = String(curr.name).trim().toLowerCase().replace(/[^a-z0-9]/g, '')
    const currAmount = parseAmount(curr.amount ?? curr.price)

    // Check if duplicate of an item seen within the last 6 items (overlap window)
    const isDuplicate = result.slice(-6).some((prev) => {
      const normPrevName = String(prev.name).trim().toLowerCase().replace(/[^a-z0-9]/g, '')
      const prevAmount = parseAmount(prev.amount ?? prev.price)
      if (normCurrName && normCurrName === normPrevName) {
        if (currAmount !== null && prevAmount !== null) {
          return Math.abs(currAmount - prevAmount) < 0.01
        }
        return true
      }
      return false
    })

    if (!isDuplicate) {
      result.push(curr)
    } else {
      console.log(`Deduplicated overlapping item from screenshots: "${curr.name}" (${currAmount})`)
    }
  }
  return result
}

async function requestModel(imageList) {
  const isMulti = imageList.length > 1
  const promptText = isMulti ? extractionPromptMulti : extractionPromptSingle

  const userContent = [
    { type: 'text', text: promptText },
    ...imageList.map((img) => ({
      type: 'image_url',
      image_url: { url: `data:${img.mimeType};base64,${img.image}` },
    })),
  ]

  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://github.com/Unknnownnn/Smartsplit',
      'X-Title': 'SmartSplit OCR',
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      max_tokens: 8192,
      messages: [
        {
          role: 'user',
          content: userContent,
        },
      ],
    }),
  })

  const payload = await response.json()
  if (!response.ok) {
    const message = payload?.error?.message || `OpenRouter returned ${response.status}`
    const error = new Error(message)
    error.status = response.status
    throw error
  }

  const choice = payload.choices?.[0]
  const message = choice?.message
  let content = message?.content
  if (!content && message?.reasoning) {
    content = message.reasoning
  }
  if (!content) {
    if (choice?.finish_reason === 'length') {
      throw new Error(`OpenRouter model ran out of tokens before completing the response (finish_reason=length). Try another image or model.`)
    }
    throw new Error(`OpenRouter returned no message content (finish_reason=${choice?.finish_reason || 'unknown'}, has_reasoning=${Boolean(message?.reasoning)})`)
  }
  return content
}

const server = http.createServer(async (request, response) => {
  const origin = request.headers.origin || '*'

  if (request.method === 'OPTIONS') {
    response.writeHead(204, {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    })
    return response.end()
  }

  // Health check endpoint
  if (request.url === '/api/health') {
    return sendJson(response, 200, { status: 'ok', time: new Date().toISOString() }, origin)
  }

  // Auth: Register
  if (request.url === '/api/auth/register') {
    if (request.method !== 'POST') return sendJson(response, 405, { error: 'Method not allowed' }, origin)
    try {
      const { username, password, rememberMe, initialData } = await readJsonBody(request)
      if (!username || typeof username !== 'string' || username.trim().length < 3) {
        return sendJson(response, 400, { error: 'Username must be at least 3 characters' }, origin)
      }
      if (!password || typeof password !== 'string' || password.length < 4) {
        return sendJson(response, 400, { error: 'Password must be at least 4 characters' }, origin)
      }

      const usernameLower = username.trim().toLowerCase()
      if (db.users[usernameLower]) {
        return sendJson(response, 409, { error: 'An account with this username already exists' }, origin)
      }

      const salt = crypto.randomBytes(16).toString('hex')
      const passwordHash = hashPassword(password, salt)
      const token = crypto.randomBytes(32).toString('hex')
      // 90 days if rememberMe, 24 hours if not
      const expiresAt = Date.now() + (rememberMe ? 90 * 24 * 60 * 60 * 1000 : 24 * 60 * 60 * 1000)

      db.users[usernameLower] = {
        id: 'usr_' + Date.now(),
        username: username.trim(),
        passwordHash,
        salt,
        createdAt: new Date().toISOString(),
        data: initialData && typeof initialData === 'object' ? initialData : null,
      }

      db.sessions[token] = {
        usernameLower,
        expiresAt,
      }
      saveDb()

      return sendJson(response, 200, {
        user: { id: db.users[usernameLower].id, username: db.users[usernameLower].username },
        token,
        data: db.users[usernameLower].data,
      }, origin)
    } catch (e) {
      return sendJson(response, 500, { error: e instanceof Error ? e.message : 'Registration failed' }, origin)
    }
  }

  // Auth: Login
  if (request.url === '/api/auth/login') {
    if (request.method !== 'POST') return sendJson(response, 405, { error: 'Method not allowed' }, origin)
    try {
      const { username, password, rememberMe } = await readJsonBody(request)
      if (!username || !password) {
        return sendJson(response, 400, { error: 'Username and password are required' }, origin)
      }

      const usernameLower = username.trim().toLowerCase()
      const user = db.users[usernameLower]
      if (!user) {
        return sendJson(response, 401, { error: 'Invalid username or password' }, origin)
      }

      const testHash = hashPassword(password, user.salt)
      if (testHash !== user.passwordHash) {
        return sendJson(response, 401, { error: 'Invalid username or password' }, origin)
      }

      const token = crypto.randomBytes(32).toString('hex')
      const expiresAt = Date.now() + (rememberMe ? 90 * 24 * 60 * 60 * 1000 : 24 * 60 * 60 * 1000)
      db.sessions[token] = {
        usernameLower,
        expiresAt,
      }
      saveDb()

      return sendJson(response, 200, {
        user: { id: user.id, username: user.username },
        token,
        data: user.data,
      }, origin)
    } catch (e) {
      return sendJson(response, 500, { error: e instanceof Error ? e.message : 'Login failed' }, origin)
    }
  }

  // Auth: Get Current User Profile (/api/auth/me)
  if (request.url === '/api/auth/me') {
    const auth = getAuthenticatedUser(request)
    if (!auth) return sendJson(response, 401, { error: 'Unauthorized' }, origin)
    return sendJson(response, 200, {
      user: { id: auth.user.id, username: auth.user.username },
      data: auth.user.data,
    }, origin)
  }

  // Auth: Logout
  if (request.url === '/api/auth/logout') {
    const authHeader = request.headers.authorization || ''
    const token = authHeader.replace(/^Bearer\s+/i, '').trim()
    if (token && db.sessions[token]) {
      delete db.sessions[token]
      saveDb()
    }
    return sendJson(response, 200, { success: true }, origin)
  }

  // Cloud Sync: Get or update user data across devices
  if (request.url === '/api/user/sync') {
    const auth = getAuthenticatedUser(request)
    if (!auth) return sendJson(response, 401, { error: 'Unauthorized' }, origin)

    if (request.method === 'GET') {
      return sendJson(response, 200, { data: auth.user.data }, origin)
    }

    if (request.method === 'POST') {
      try {
        const payload = await readJsonBody(request)
        if (payload && typeof payload === 'object') {
          auth.user.data = payload
          saveDb()
          return sendJson(response, 200, { success: true, savedAt: new Date().toISOString() }, origin)
        }
        return sendJson(response, 400, { error: 'Invalid sync payload' }, origin)
      } catch (e) {
        return sendJson(response, 500, { error: e instanceof Error ? e.message : 'Sync failed' }, origin)
      }
    }
    return sendJson(response, 405, { error: 'Method not allowed' }, origin)
  }

  // OCR API endpoint (supports single screenshot or multiple continuous screenshots)
  if (request.url === '/api/ocr') {
    if (request.method !== 'POST') return sendJson(response, 405, { error: 'Method not allowed' }, origin)
    if (!process.env.OPENROUTER_API_KEY) return sendJson(response, 500, { error: 'OPENROUTER_API_KEY is missing. Add it to .env and restart the API.' }, origin)

    try {
      const input = await readJsonBody(request)
      let imageList = []
      if (Array.isArray(input.images) && input.images.length > 0) {
        imageList = input.images.filter((img) => img && img.image && img.mimeType)
      } else if (input.image && input.mimeType) {
        imageList = [{ image: input.image, mimeType: input.mimeType }]
      }

      if (imageList.length === 0) {
        return sendJson(response, 400, { error: 'At least one screenshot is required' }, origin)
      }

      const totalChars = imageList.reduce((sum, img) => sum + (img.image ? img.image.length : 0), 0)
      if (totalChars > 25_000_000) {
        return sendJson(response, 413, { error: 'Total screenshot payload too large. Please use fewer or smaller images.' }, origin)
      }

      console.log(`OCR request: model=${model}, screenshotsCount=${imageList.length}, totalBase64Chars=${totalChars}`)
      const content = await requestModel(imageList)
      const parsed = parseModelJson(content)
      const result = normalizeCharges(parsed)
      if (Array.isArray(result.items)) {
        const deduplicated = deduplicateItems(result.items)
        result.items = deduplicated.map((item) => ({ ...item, amount: parseAmount(item.amount ?? item.price) }))
      }
      return sendJson(response, 200, { model, result, screenshotsCount: imageList.length }, origin)
    } catch (error) {
      const status = error && typeof error === 'object' && 'status' in error && typeof error.status === 'number' ? error.status : 500
      return sendJson(response, status, { error: error instanceof Error ? error.message : 'OCR request failed', model, sentImage: true }, origin)
    }
  }

  // Any other API path
  if (request.url.startsWith('/api/')) {
    return sendJson(response, 404, { error: 'API route not found' }, origin)
  }

  // Frontend static files & SPA handling
  return serveStaticFile(request, response)
})

server.listen(port, host, () => {
  console.log(`SmartSplit listening on http://${host}:${port}`)
})
