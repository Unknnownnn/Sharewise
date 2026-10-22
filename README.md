# SmartSplit

SmartSplit uses Google's multimodal Gemma model through OpenRouter to read grocery bill screenshots.

## Add the API key

1. Copy `.env.example` to `.env`.
2. Open `.env` and replace `sk-or-v1-your-key-here` with your OpenRouter key from https://openrouter.ai/settings/keys.
3. Set `OPENROUTER_MODEL` to the OpenRouter model slug you want to use. The default is `google/gemma-4-26b-a4b-it:free`.
4. Never put this key in `src/` or commit `.env`.

The key is read only by `api.mjs`. The browser calls the local `/api/ocr` endpoint, and the Vite development proxy forwards it to the API server.

## Run locally

```bash
npm install
npm run dev:all
```

Open http://localhost:5173, upload a PNG/JPG/WebP bill screenshot, and wait for the status to say `items extracted by Gemma`.

The API listens on `API_PORT` from `.env` (default `8787`), and the Vite dev proxy reads the same variable, so the two cannot drift apart. If you change the port, restart both processes.

The OCR model is read from `OPENROUTER_MODEL`. Free model endpoints can be rate-limited or temporarily unavailable; the UI displays the actual API error instead of silently pretending OCR succeeded.

## Test OpenRouter directly

This bypasses the browser and local API to prove whether OpenRouter accepts the image request:

```bash
node scripts/test-openrouter.mjs "path/to/your/image.jpg"
```

The script prints the image MIME type, base64 size, selected model, HTTP status, and model response. It never prints the API key.

## Send splits to Splitwise

SmartSplit can push a finished split to a real Splitwise group. The bridge runs inside `api.mjs`, so `npm run dev:all` is still the only command you need.

No Splitwise Pro plan and no API key are involved: the bridge reuses the web session of an account you are already signed into.

### How it works

1. A persistent Chromium profile in `data/splitwise-profile` holds the Splitwise cookies.
2. API calls run inside the Splitwise page with same-origin `fetch()`, so the cookies attach automatically.
3. The CSRF token is read from the live `<meta name="csrf-token">` tag on every call, so it can never go stale.
4. The server pings the session every 30 minutes to keep it alive.

The CSRF token is deliberately not part of the seed. It is a per-page Rails value tied to the server-side session, and it can rotate. Storing one would work until the first rotation and then start failing with HTTP 422. Seeding only transplants the cookies, which is the one thing the server cannot derive on its own; loading the page afterwards renders a valid token, and the client sends it as `X-CSRF-Token` on each request.

Splitwise protects its login form with Cloudflare Turnstile, which cannot be solved unattended, so the bridge never tries to log in. You seed the session once by pasting a cookie header.

### One-time setup

```bash
npm install
npm run splitwise:setup
```

`splitwise:setup` installs the Playwright package (including optional dependencies) and downloads the Chromium build it drives. The browser download and the npm package are separate: running `npx playwright install chromium` on its own only fills `~/.cache/ms-playwright` and leaves `node_modules/playwright` missing. Playwright is an optional dependency, so if it is missing, OCR and cloud sync keep working and only the Splitwise routes report an error.

Copy the cookie header:

1. Sign in to https://secure.splitwise.com in your normal browser.
2. Open DevTools, go to the Network tab, and reload the page.
3. Select any request to `secure.splitwise.com` (the document request is fine).
4. Copy the whole `Cookie:` request header value.

Add it to `.env` on a single line, then seed the profile:

```dotenv
SPLITWISE_COOKIE=swdid=...; _splitwise_session=...; ...
```

```bash
npm run splitwise:seed
```

The seed script prints the Splitwise account it resolved. Delete `SPLITWISE_COOKIE` from `.env` afterwards; the cookies now live in the profile.

### Person mapping

SmartSplit names rarely match Splitwise names (a group may list `Aa`, `R`, `Ad` while Splitwise has `A`, `B`, `C`), so the bridge never guesses silently.

1. Open **Account & Groups**, then click **Splitwise mapping** under the member list.
2. Pick the Splitwise group once, then set each person to a member, **Auto (match by name)**, or **Skip (exclude)**.
3. The mapping is saved per SmartSplit group and syncs with the account, so it follows you to another device.

Auto resolution tries, in order: exact full name, exact first name, a unique prefix of three or more characters, then a unique single initial. Ambiguous names are not guessed. Anyone who still cannot be resolved is skipped, listed in the send modal, and left out of the expense total.

### Sending a split

1. Scan a bill and assign items as usual.
2. Confirm the split so it is saved to History.
3. Expand the split and click **Send to Splitwise**.
4. Pick the Splitwise group and who actually paid the bill.
5. Review the per-person preview, then send.

The selected group and payer are remembered per SmartSplit group, so repeat sends are two clicks.

The expense is created as the signed-in Splitwise account. There is no `paid_by` field in the Splitwise API: the payer is expressed by giving that member the full `paid_share` while everyone else gets `0.00`. The expense is dated with the saved split date.

### Amounts and rounding

- Shares are converted to integer paise and the rounding remainder is distributed, so `paid_share` and `owed_share` always add up to the cost to the paise.
- The expense cost is the included shares, not the OCR receipt total. If the receipt total and the shares disagree, the modal says so and sends the sum of the shares.
- A mismatch larger than one rupee is rejected instead of being silently absorbed.
- People who owe nothing are not added. The payer is added with a zero owed share if their items were excluded.
- People who cannot be matched (and everyone set to **Skip**) are excluded: the modal lists them and the cost becomes the sum of the included shares.

### Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `SPLITWISE_ENABLED` | `1` | Set to `0` to skip the browser warm-up and keep-alive. |
| `SPLITWISE_PROFILE` | `./data/splitwise-profile` | Persistent Chromium profile directory. |
| `SPLITWISE_HEADLESS` | `1` | Set to `0` to watch the browser window. |
| `SPLITWISE_KEEPALIVE_MINUTES` | `30` | How often the session is pinged. |
| `SPLITWISE_ALLOW_LOCAL` | `1` | Allow loopback callers without a login. Set to `0` on a shared machine. |
| `SPLITWISE_COOKIE` | unset | Only used by `npm run splitwise:seed`. |

The routes below require a SmartSplit login **or** a loopback connection, because they create real expenses:

- `GET /api/splitwise/health`
- `GET /api/splitwise/groups`
- `POST /api/splitwise/preview`
- `POST /api/splitwise/send`

### Troubleshooting

| Symptom | Fix |
| --- | --- |
| `Playwright is not installed` / `Playwright package is missing` | The browser download alone is not enough. Run `npm install --include=optional`, or `npm run splitwise:setup`. |
| `EACCES: permission denied, mkdir .../data/splitwise-profile` | The repo was started as root at some point. Fix ownership with `sudo chown -R "$USER":"$USER" ~/Smartsplit`, and run pm2 as your own user, not with sudo. |
| Seeded successfully, but the UI still says the session is not signed in | Health is a snapshot taken at boot. Stop the API (`pm2 stop smartsplit`) before seeding, then start it again. Seeding while the API holds the profile also fights over the Chromium profile lock. |
| `Splitwise returned HTML instead of JSON` | The session expired. Copy a fresh cookie and run `npm run splitwise:seed`. |
| `Splitwise rejected the CSRF token (HTTP 422)` | Same as above; the page needs a fresh load, which seeding performs. |
| `"Name" is not in Splitwise group "Group"` | Set the person's mapping under **Splitwise mapping**, or add them to the Splitwise group. |
| `matches multiple Splitwise members` | Two members share a name. Set an explicit mapping instead. |
| `both map to <member>` | Two SmartSplit people point at the same Splitwise member. Fix the mapping. |
| Expense does not appear | Check the group on splitwise.com; the modal shows an error if Splitwise returned `errors`. |

# React + TypeScript + Vite

This template provides a minimal setup to get React working in Vite with HMR and some Oxlint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Oxc](https://oxc.rs)
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/)

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the Oxlint configuration

If you are developing a production application, we recommend enabling type-aware lint rules by installing `oxlint-tsgolint` and editing `.oxlintrc.json`:

```json
{
  "$schema": "./node_modules/oxlint/configuration_schema.json",
  "plugins": ["react", "typescript", "oxc"],
  "options": {
    "typeAware": true
  },
  "rules": {
    "react/rules-of-hooks": "error",
    "react/only-export-components": ["warn", { "allowConstantExport": true }]
  }
}
```

See the [Oxlint rules documentation](https://oxc.rs/docs/guide/usage/linter/rules) for the full list of rules and categories.
