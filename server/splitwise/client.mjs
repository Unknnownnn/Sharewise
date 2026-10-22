// Splitwise client for SmartSplit.
//
// Runs Splitwise API calls from inside an authenticated browser page:
//  - a persistent Chromium profile holds the session cookies, so no login
//    is needed on every boot (Splitwise gates login with Cloudflare
//    Turnstile, which blocks unattended sign-in),
//  - fetch() runs same-origin so the browser attaches cookies,
//  - X-CSRF-Token is read from the live <meta> tag on every call, so a
//    rotated token can never be stale.
//
// Playwright is imported lazily so the rest of the API (OCR, auth, sync)
// keeps working when it is not installed.

import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { buildExpenseData, findGroupByName, fullName } from './splits.mjs'

const require = createRequire(import.meta.url)

function playwrightVersion() {
  try {
    return require('playwright/package.json').version
  } catch {
    return null
  }
}

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const DEFAULT_PROFILE = path.join(PROJECT_ROOT, 'data', 'splitwise-profile')

const BASE_URL = 'https://secure.splitwise.com'
const API_PREFIX = '/api/v3.0'
const GROUP_CACHE_MS = 30 * 60 * 1000
const PAGE_RELOAD_MS = 6 * 60 * 60 * 1000

export class AuthError extends Error {
  constructor(message) {
    super(message)
    this.name = 'AuthError'
    this.reauthRequired = true
  }
}

export class SplitwiseClient {
  constructor(options = {}) {
    this.profileDir = path.resolve(
      options.profileDir ||
        process.env.SPLITWISE_PROFILE ||
        DEFAULT_PROFILE,
    )
    this.headless = String(process.env.SPLITWISE_HEADLESS ?? '1') !== '0'
    this.channel = process.env.SPLITWISE_BROWSER_CHANNEL || undefined
    this.locale = process.env.SPLITWISE_LOCALE || 'en-IN'
    this.timezoneId = process.env.SPLITWISE_TZ || 'Asia/Kolkata'

    this.context = null
    this._playwright = null
    this._starting = null
    this._page = null
    this._groups = null
    this._groupsAt = 0
    this._loadedAt = 0

    this.user = null
    this.authenticated = false
    this.lastError = null
    this.lastCheckAt = 0
    this.available = false
  }

  async ensureStarted() {
    if (this.context) {
      return
    }

    // Concurrent callers (warm-up plus an early request) must not launch
    // two browsers against the same profile.
    if (!this._starting) {
      this._starting = this.start().finally(() => {
        this._starting = null
      })
    }

    await this._starting
  }

  async start() {
    if (!this._playwright) {
      try {
        const imported = await import('playwright')
        // Playwright ships as CommonJS in some releases. Node then exposes
        // the real module on `default` instead of as named exports, so
        // `imported.chromium` is undefined even though the package is there.
        this._playwright = imported.chromium ? imported : imported.default
      } catch (error) {
        const missing = error && error.code === 'ERR_MODULE_NOT_FOUND'
        this.lastError = missing
          ? 'The Playwright package is missing (the browser download alone is not enough). ' +
            'Run "npm install --include=optional" in the SmartSplit project, then try again.'
          : `Playwright could not be loaded: ${error instanceof Error ? error.message : error}`
        throw new Error(this.lastError)
      }
    }

    if (!this._playwright?.chromium) {
      this.lastError =
        'Playwright loaded but exposes no chromium export. Run "npm install --include=optional" ' +
        'to install a matching version, then try again.'
      throw new Error(this.lastError)
    }

    try {
      this.context = await this._playwright.chromium.launchPersistentContext(this.profileDir, {
        headless: this.headless,
        channel: this.channel,
        locale: this.locale,
        timezoneId: this.timezoneId,
        viewport: { width: 1280, height: 900 },
        ignoreDefaultArgs: ['--enable-automation'],
        args: [
          '--window-position=-3000,-3000',
          '--disable-blink-features=AutomationControlled',
          '--no-first-run',
          '--no-default-browser-check',
        ],
      })

      this.context.setDefaultTimeout(30_000)
      this.context.on('close', () => {
        this.context = null
        this._page = null
        this.authenticated = false
      })

      this.available = true
      this.lastError = null
    } catch (error) {
      this.lastError = `Could not launch Chromium: ${error.message}`
      throw new Error(this.lastError)
    }
  }

  async ensurePage() {
    await this.ensureStarted()

    if (!this._page || this._page.isClosed()) {
      const [existing] = this.context.pages()
      this._page = existing || (await this.context.newPage())
    }

    if (!this._page.url().startsWith(BASE_URL)) {
      await this._page.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded' })
      this._loadedAt = Date.now()
    }

    return this._page
  }

  async api(path, { method = 'GET', data = null } = {}) {
    const page = await this.ensurePage()

    const result = await page.evaluate(
      async ({ apiPath, method, data }) => {
        const token = document.querySelector('meta[name="csrf-token"]')?.content || ''

        const headers = {
          Accept: 'application/json, text/javascript, */*; q=0.01',
          'X-Requested-With': 'XMLHttpRequest',
        }

        if (token) {
          headers['X-CSRF-Token'] = token
        }

        let body

        if (data) {
          headers['Content-Type'] = 'application/x-www-form-urlencoded'
          body = new URLSearchParams(
            Object.entries(data).map(([key, value]) => [
              key,
              value === null || value === undefined ? '' : String(value),
            ]),
          ).toString()
        }

        const response = await fetch(apiPath, {
          method,
          headers,
          body,
          credentials: 'same-origin',
          redirect: 'manual',
        })

        return {
          status: response.status,
          type: response.type,
          text: await response.text(),
        }
      },
      { apiPath: `${API_PREFIX}${path}`, method, data },
    )

    if (result.type === 'opaqueredirect' || result.status === 0) {
      throw new AuthError('Splitwise redirected the request. The session has expired.')
    }

    if (result.status >= 300 && result.status < 400) {
      throw new AuthError(
        `Splitwise redirected (HTTP ${result.status}). The session has expired.`,
      )
    }

    if (result.status === 422) {
      throw new AuthError(
        'Splitwise rejected the CSRF token (HTTP 422). Reload the profile page and retry.',
      )
    }

    if (result.status === 401 || result.status === 403) {
      throw new AuthError(
        'The Splitwise session is not signed in. Copy a fresh cookie and run "npm run splitwise:seed".',
      )
    }

    if (!result.text.trimStart().startsWith('{')) {
      throw new AuthError(
        'Splitwise returned HTML instead of JSON. The saved session is not authenticated.',
      )
    }

    let payload

    try {
      payload = JSON.parse(result.text)
    } catch {
      throw new Error(`Splitwise returned invalid JSON (HTTP ${result.status}).`)
    }

    if (result.status >= 400) {
      throw new Error(
        `Splitwise request failed (HTTP ${result.status}): ${result.text.slice(0, 300)}`,
      )
    }

    return payload
  }

  async getCurrentUser() {
    try {
      const payload = await this.api('/get_current_user')

      if (!payload.user?.id) {
        throw new AuthError('Splitwise did not return a user. The session is not authenticated.')
      }

      this.user = payload.user
      this.authenticated = true
      this.lastError = null
      this.lastCheckAt = Date.now()

      return payload.user
    } catch (error) {
      this.authenticated = false
      this.lastCheckAt = Date.now()
      this.lastError = error.message
      throw error
    }
  }

  async getGroups({ refresh = false } = {}) {
    const fresh = this._groups && Date.now() - this._groupsAt < GROUP_CACHE_MS

    if (fresh && !refresh) {
      return this._groups
    }

    const payload = await this.api('/get_groups')

    if (!Array.isArray(payload.groups)) {
      throw new Error('Unexpected response while fetching Splitwise groups.')
    }

    this._groups = payload.groups.filter(
      (group) =>
        Number(group.id) !== 0 &&
        Array.isArray(group.members) &&
        group.members.length > 0,
    )
    this._groupsAt = Date.now()

    return this._groups
  }

  async findGroup(groupName) {
    const groups = await this.getGroups()

    try {
      return findGroupByName(groups, groupName)
    } catch {
      const refreshed = await this.getGroups({ refresh: true })
      return findGroupByName(refreshed, groupName)
    }
  }

  /**
   * Validates a split and returns the payload without creating anything.
   */
  async preview({ groupName, total, description, currency, shares, payer, payerId, date }) {
    const user = await this.getCurrentUser()
    const group = await this.findGroup(groupName)

    const built = buildExpenseData({
      group,
      total,
      description,
      currency,
      shares,
      payer,
      payerId,
      date,
      currentUserId: String(user.id),
    })

    return {
      group: { id: String(group.id), name: group.name },
      rows: built.rows,
      payer: built.payer,
      payload: built.data,
      skipped: built.skipped,
      totals: built.totals,
    }
  }

  async createExpense({ groupName, total, description, currency, shares, payer, payerId, date }) {
    const preview = await this.preview({
      groupName,
      total,
      description,
      currency,
      shares,
      payer,
      payerId,
      date,
    })

    const response = await this.api('/create_expense', {
      method: 'POST',
      data: preview.payload,
    })

    const errors = response?.errors
    const hasErrors = Array.isArray(errors)
      ? errors.length > 0
      : Boolean(errors && Object.keys(errors).length)

    if (hasErrors) {
      const message = Array.isArray(errors)
        ? errors.map((entry) => entry?.message ?? String(entry)).join(', ')
        : JSON.stringify(errors)

      throw new Error(`Splitwise rejected the expense: ${message}`)
    }

    const created = response.expenses?.[0]

    if (!created || created.deleted_at) {
      throw new Error('Splitwise did not confirm expense creation.')
    }

    return {
      expense: {
        id: created.id,
        cost: created.cost,
        description: created.description,
        currency_code: created.currency_code,
        group_id: created.group_id,
        expense_url: created.expense_url || null,
        created_at: created.created_at || null,
      },
      group: preview.group,
      rows: preview.rows,
      payer: preview.payer,
      skipped: preview.skipped,
      totals: preview.totals,
    }
  }

  async keepAlive() {
    if (this.context && Date.now() - this._loadedAt > PAGE_RELOAD_MS) {
      const page = await this.ensurePage()
      await page.reload({ waitUntil: 'domcontentloaded' })
      this._loadedAt = Date.now()
    }

    return this.getCurrentUser()
  }

  describe() {
    return {
      available: this.available,
      authenticated: this.authenticated,
      user: this.user ? fullName(this.user) : null,
      user_id: this.user ? String(this.user.id) : null,
      profile: this.profileDir,
      playwright: this._playwright ? playwrightVersion() || 'loaded' : null,
      headless: this.headless,
      last_check: this.lastCheckAt ? new Date(this.lastCheckAt).toISOString() : null,
      last_error: this.lastError,
      groups_cached: this._groups ? this._groups.length : 0,
    }
  }

  async close() {
    if (this.context) {
      await this.context.close().catch(() => {})
    }

    this.context = null
    this._page = null
    this.authenticated = false
  }
}

let singleton = null

export function getClient() {
  if (!singleton) {
    singleton = new SplitwiseClient()
  }

  return singleton
}
