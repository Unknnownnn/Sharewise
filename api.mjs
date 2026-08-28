import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { config } from 'dotenv'

config()

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const distDir = path.join(__dirname, 'dist')

const port = Number(process.env.PORT || process.env.API_PORT || 80)
const host = process.env.HOST || '0.0.0.0'
const model = process.env.OPENROUTER_MODEL || 'openrouter/free'
const extractionPrompt = `Look at this grocery bill screenshot carefully. Return JSON only. First inspect the complete final bill summary section, usually near the bottom, and read the exact visible values for tax/GST, delivery or delivery fee, handling/convenience/platform/rain/surge/peak charges, discounts, subtotal, and final bill total. A visible FREE delivery means delivery is 0; an unreadable or absent value must be null, never 0. Do not guess or calculate a charge from the total. Extract every purchased product and its final line amount. Put every fee other than tax and delivery into other, and list its visible components in other_breakdown. Return exactly: {"items":[{"name":string,"quantity":string|null,"unit":string|null,"amount":number|null,"confidence":number}],"charges":{"tax":number|null,"delivery":number|null,"other":number|null,"other_breakdown":[{"label":string,"amount":number}],"subtotal":number|null,"total":number|null}}. Amounts must be numbers without currency symbols. `

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
    'Access-Control-Allow-Headers': 'Content-Type',
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
    'discount', 'product_discount', 'discount_amount',
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

  return {
    ...payload,
    charges: {
      tax,
      delivery,
      other,
      other_breakdown,
      subtotal,
      total,
    },
  }
}

async function requestModel(image, mimeType) {
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
          content: [
            { type: 'text', text: extractionPrompt },
            { type: 'image_url', image_url: { url: `data:${mimeType};base64,${image}` } },
          ],
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
      'Access-Control-Allow-Headers': 'Content-Type',
    })
    return response.end()
  }

  // Health check endpoint
  if (request.url === '/api/health') {
    return sendJson(response, 200, { status: 'ok', time: new Date().toISOString() }, origin)
  }

  // OCR API endpoint
  if (request.url === '/api/ocr') {
    if (request.method !== 'POST') return sendJson(response, 405, { error: 'Method not allowed' }, origin)
    if (!process.env.OPENROUTER_API_KEY) return sendJson(response, 500, { error: 'OPENROUTER_API_KEY is missing. Add it to .env and restart the API.' }, origin)

    try {
      let raw = ''
      for await (const chunk of request) raw += chunk
      const input = JSON.parse(raw)
      if (!input.image || !input.mimeType) return sendJson(response, 400, { error: 'image and mimeType are required' }, origin)
      if (input.image.length > 12_000_000) return sendJson(response, 413, { error: 'Image is too large. Use an image under 9 MB.' }, origin)

      console.log(`OCR request: model=${model}, mimeType=${input.mimeType}, base64Chars=${input.image.length}`)
      const content = await requestModel(input.image, input.mimeType)
      const result = normalizeCharges(parseModelJson(content))
      if (Array.isArray(result.items)) {
        result.items = result.items.map((item) => ({ ...item, amount: parseAmount(item.amount ?? item.price) }))
      }
      return sendJson(response, 200, { model, result }, origin)
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
