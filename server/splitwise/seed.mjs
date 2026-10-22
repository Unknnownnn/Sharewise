// Seeds the Splitwise session used by SmartSplit.
//
// Splitwise gates login with Cloudflare Turnstile, so an unattended login
// is not possible. Copy the Cookie header once from your own browser and
// inject it into the persistent profile below.
//
//   npm run splitwise:seed
//
// Reads SPLITWISE_COOKIE from .env (or the environment), or point
// SPLITWISE_COOKIE_FILE at a file containing the header.
//
// The CSRF token is not needed: it is read from the live page on every
// request, so it can never go stale.

import { readFile } from 'node:fs/promises'
import { config } from 'dotenv'
import { SplitwiseClient } from './client.mjs'

config()

function parseCookieHeader(header) {
  return String(header)
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((pair) => {
      const index = pair.indexOf('=')

      if (index === -1) {
        return null
      }

      return {
        name: pair.slice(0, index).trim(),
        value: pair.slice(index + 1).trim(),
      }
    })
    .filter((cookie) => cookie && cookie.name)
}

async function readCookieInput() {
  if (process.env.SPLITWISE_COOKIE) {
    return process.env.SPLITWISE_COOKIE
  }

  if (process.env.SPLITWISE_COOKIE_FILE) {
    return readFile(process.env.SPLITWISE_COOKIE_FILE, 'utf8')
  }

  throw new Error('Set SPLITWISE_COOKIE in .env (or SPLITWISE_COOKIE_FILE) before seeding.')
}

async function main() {
  const raw = (await readCookieInput()).trim()

  if (!raw) {
    throw new Error('SPLITWISE_COOKIE is empty.')
  }

  const cookies = parseCookieHeader(raw)

  if (!cookies.length) {
    throw new Error('Could not parse any cookies from the supplied header.')
  }

  if (!/user_credentials=/.test(raw)) {
    console.warn('Warning: no user_credentials cookie found. Copy the whole Cookie header.')
  }

  const client = new SplitwiseClient()

  console.log(`Profile: ${client.profileDir}`)
  console.log(`Cookies: ${cookies.map((cookie) => cookie.name).join(', ')}`)

  try {
    await client.ensureStarted()

    await client.context.addCookies(
      cookies.map((cookie) => ({
        name: cookie.name,
        value: cookie.value,
        domain: '.splitwise.com',
        path: '/',
        secure: true,
        httpOnly: true,
        sameSite: 'Lax',
        expires: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 300,
      })),
    )

    const page = await client.ensurePage()
    await page.reload({ waitUntil: 'domcontentloaded' })

    // The CSRF token is not seeded: it is per-page and tied to the session.
    // Loading the page with the injected cookies renders a fresh one, which
    // the client reads from <meta name="csrf-token"> on every call.
    const csrf = await page.evaluate(
      () => document.querySelector('meta[name="csrf-token"]')?.content || '',
    )
    console.log(`CSRF token: ${csrf ? `found (${csrf.length} chars)` : 'NOT FOUND'}`)

    if (!csrf) {
      console.warn('Warning: the page has no csrf-token meta tag. Writes will fail with 422.')
    }

    const user = await client.getCurrentUser()
    const name = [user.first_name, user.last_name].filter(Boolean).join(' ')

    console.log(`\nSeeded successfully. Authenticated as ${name} (id ${user.id}).`)
    console.log('Start the app with: npm run dev:all')
  } finally {
    await client.close()
  }
}

main().catch((error) => {
  console.error(`\nSeeding failed: ${error.message}`)
  console.error('Copy a fresh Cookie header from splitwise.com and try again.')
  process.exitCode = 1
})
