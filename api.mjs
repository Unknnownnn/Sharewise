import http from 'node:http'
import { config } from 'dotenv'

config()

const port = Number(process.env.API_PORT || 8787)
const model = process.env.OPENROUTER_MODEL || 'openrouter/free'
const extractionPrompt = `Look at this grocery bill screenshot carefully. Return JSON only. First inspect the complete final bill summary section, usually near the bottom, and read the exact visible values for tax/GST, delivery or delivery fee, handling/convenience/platform/rain/surge/peak charges, discounts, subtotal, and final bill total. A visible FREE delivery means delivery is 0; an unreadable or absent value must be null, never 0. Do not guess or calculate a charge from the total. Extract every purchased product and its final line amount. Put every fee other than tax and delivery into other, and list its visible components in other_breakdown. Return exactly: {"items":[{"name":string,"quantity":string|null,"unit":string|null,"amount":number|null,"confidence":number}],"charges":{"tax":number|null,"delivery":number|null,"other":number|null,"other_breakdown":[{"label":string,"amount":number}],"subtotal":number|null,"total":number|null}}. Amounts must be numbers without currency symbols. `

function sendJson(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': 'http://localhost:5173' })
  response.end(JSON.stringify(body))
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
    const nums = Object.values(val).map(parseAmount).filter((n) => n !== null && Number.isFinite(n))
    return nums.length > 0 ? nums.reduce((a, b) => a + b, 0) : null
  }
  return null
}

function normalizeCharges(result) {
  if (!result || typeof result !== 'object') result = {}
  const rawCharges = result.charges || result.bill_details || result.summary || result.bill || {}
  const source = typeof rawCharges === 'object' && rawCharges !== null ? { ...result, ...rawCharges } : { ...result }

  const findValue = (...keys) => {
    for (const key of keys) {
      if (source[key] !== undefined && source[key] !== null) {
        const parsed = parseAmount(source[key])
        if (parsed !== null) return parsed
      }
    }
    return null
  }

  // 1. Tax extraction
  let tax = findValue(
    'tax', 'taxes', 'gst', 'gst_amount', 'tax_amount',
    'taxes_and_charges', 'tax_and_charges', 'taxes_charges',
    'total_tax', 'govt_taxes', 'govt_tax', 'vat'
  )
  if (tax === null) {
    const cgst = parseAmount(source.cgst ?? source.cgst_amount)
    const sgst = parseAmount(source.sgst ?? source.sgst_amount)
    const igst = parseAmount(source.igst ?? source.igst_amount)
    if (cgst !== null || sgst !== null || igst !== null) {
      tax = (cgst || 0) + (sgst || 0) + (igst || 0)
    }
  }
  if (tax === null && Array.isArray(source.other_breakdown)) {
    const taxEntry = source.other_breakdown.find((entry) => entry && typeof entry.label === 'string' && /tax|gst|vat/i.test(entry.label))
    if (taxEntry && taxEntry.amount != null) {
      tax = parseAmount(taxEntry.amount)
    }
  }

  // 2. Delivery extraction
  const delivery = findValue('delivery', 'delivery_charges', 'delivery_charge', 'delivery_fee', 'shipping', 'shipping_fee')

  // 3. Other extraction
  let other = findValue('other', 'other_charges', 'other_charge', 'other_fee', 'others')
  const detailedKeys = ['handling', 'handling_charge', 'handling_fee', 'surge', 'surge_charge', 'rain_fee', 'rain_charge', 'peak_fee', 'weather_charge', 'platform', 'platform_fee', 'service_fee', 'convenience_fee', 'discount', 'product_discount', 'discount_amount']
  const detailedOther = detailedKeys.map((k) => parseAmount(source[k])).filter((n) => n !== null).reduce((sum, n) => sum + n, 0)
  if (other === null && detailedOther > 0) {
    other = detailedOther
  }

  const breakdown = Array.isArray(source.other_breakdown)
    ? source.other_breakdown.filter((entry) => entry && entry.amount !== null).map((entry) => ({ label: String(entry.label || 'Other charge'), amount: parseAmount(entry.amount) || 0 }))
    : []

  // 4. Subtotal & Total
  const subtotal = findValue('subtotal', 'item_total', 'items_total')
  const total = findValue('total', 'bill_total', 'grand_total', 'order_total', 'final_total')

  result.charges = {
    tax,
    delivery,
    other,
    other_breakdown: breakdown,
    subtotal,
    total,
  }
  return result
}

async function requestModel(image, mimeType) {
  const openRouterResponse = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, 'Content-Type': 'application/json', 'X-Title': 'SmartSplit' },
    body: JSON.stringify({
      model,
      temperature: 0,
      max_tokens: 8192,
      response_format: { type: 'json_object' },
      messages: [{ role: 'user', content: [{ type: 'text', text: extractionPrompt }, { type: 'image_url', image_url: { url: `data:${mimeType};base64,${image}`, detail: 'high' } }] }],
    }),
  })
  const providerBody = await openRouterResponse.json()
  if (!openRouterResponse.ok) {
    const providerError = providerBody?.error
    const error = new Error(`OpenRouter ${openRouterResponse.status}: ${providerError?.message || 'provider rejected the request'}${providerError?.code ? ` (code ${providerError.code})` : ''}`)
    error.status = openRouterResponse.status
    throw error
  }
  const choice = providerBody.choices?.[0]
  if (!choice) throw new Error(`OpenRouter ${model} returned no choices`)
  if (choice.error) throw new Error(`Model error: ${choice.error.message || 'unknown model error'}`)
  const message = choice.message
  let content = message?.content
  if (!content && message?.reasoning) {
    content = message.reasoning
  }
  if (!content) {
    if (choice.finish_reason === 'length') {
      throw new Error(`OpenRouter model ran out of tokens before completing the response (finish_reason=length). Try another image or model.`)
    }
    throw new Error(`OpenRouter returned no message content (finish_reason=${choice.finish_reason || 'unknown'}, has_reasoning=${Boolean(message?.reasoning)})`)
  }
  return content
}

const server = http.createServer(async (request, response) => {
  if (request.method === 'OPTIONS') return sendJson(response, 204, {})
  if (request.method !== 'POST' || request.url !== '/api/ocr') return sendJson(response, 404, { error: 'Not found' })
  if (!process.env.OPENROUTER_API_KEY) return sendJson(response, 500, { error: 'OPENROUTER_API_KEY is missing. Add it to .env and restart the API.' })

  try {
    let raw = ''
    for await (const chunk of request) raw += chunk
    const input = JSON.parse(raw)
    if (!input.image || !input.mimeType) return sendJson(response, 400, { error: 'image and mimeType are required' })
    if (input.image.length > 12_000_000) return sendJson(response, 413, { error: 'Image is too large. Use an image under 9 MB.' })

    console.log(`OCR request: model=${model}, mimeType=${input.mimeType}, base64Chars=${input.image.length}`)
    const content = await requestModel(input.image, input.mimeType)
    const result = normalizeCharges(parseModelJson(content))
    if (Array.isArray(result.items)) {
      result.items = result.items.map((item) => ({ ...item, amount: parseAmount(item.amount ?? item.price) }))
    }
    return sendJson(response, 200, { model, result })
  } catch (error) {
    const status = error && typeof error === 'object' && 'status' in error && typeof error.status === 'number' ? error.status : 500
    return sendJson(response, status, { error: error instanceof Error ? error.message : 'OCR request failed', model, sentImage: true })
  }
})

server.listen(port, () => console.log(`SmartSplit OCR API listening on http://localhost:${port}`))
