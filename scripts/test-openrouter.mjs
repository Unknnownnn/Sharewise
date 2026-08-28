import fs from 'node:fs/promises'
import path from 'node:path'
import { config } from 'dotenv'

config()

const imagePath = process.argv[2]
const model = process.env.OPENROUTER_MODEL || 'google/gemma-4-26b-a4b-it:free'
const apiKey = process.env.OPENROUTER_API_KEY

if (!imagePath) {
  console.error('Usage: node scripts/test-openrouter.mjs "path/to/your/image.jpg"')
  process.exit(1)
}
if (!apiKey) {
  console.error('OPENROUTER_API_KEY is missing from .env')
  process.exit(1)
}

const mimeTypes = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' }
const mimeType = mimeTypes[path.extname(imagePath).toLowerCase()]
if (!mimeType) {
  console.error('Supported image types: .jpg, .jpeg, .png, .webp')
  process.exit(1)
}

const image = (await fs.readFile(imagePath)).toString('base64')
const dataUrl = `data:${mimeType};base64,${image}`
const prompt = `Look at this grocery bill screenshot and the items ordered along with thier price and qty in seperate lines and finally the tax and other charges`

console.log(`Sending ${path.basename(imagePath)} as ${mimeType}`)
console.log(`Model: ${model}`)
console.log(`Base64 characters: ${image.length}`)

const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    'X-Title': 'SmartSplit API test',
  },
  body: JSON.stringify({
    model,
    temperature: 0,
    max_tokens: 2500,
    reasoning: { effort: 'minimal', exclude: true },
    response_format: { type: 'json_object' },
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: prompt },
        { type: 'image_url', image_url: { url: dataUrl, detail: 'high' } },
      ],
    }],
  }),
})

const body = await response.json()
console.log(`HTTP status: ${response.status}`)
if (!response.ok) {
  console.error(JSON.stringify(body, null, 2))
  process.exit(1)
}

const message = body.choices?.[0]?.message
console.log('Response message received:', Boolean(message))
console.log(JSON.stringify(message, null, 2))
