# SmartSplit Handoff

## Product goal
SmartSplit is a grocery-bill splitting web app for Blinkit, BigBasket, Zepto, and similar screenshots. A user belongs to a group, uploads a bill image, reviews extracted products and charges, chooses participants per item, and sees each person's share.

## Current stack
- React 19 + TypeScript + Vite
- Small Node HTTP API in `api.mjs`
- OpenRouter multimodal model configured with `OPENROUTER_MODEL`
- Vite proxies `/api/*` to `http://localhost:8787`
- `.env` is local and ignored. Do not edit it unless explicitly requested. `.env.example` is safe to update.

## OCR flow
1. `src/App.tsx` reads the uploaded image in the browser.
2. It converts the bytes to base64 and posts `{ image, mimeType }` to `/api/ocr`.
3. `api.mjs` sends an OpenRouter chat completion with an `image_url` data URL: `data:<mimeType>;base64,<image>`.
4. The model is instructed to return items plus `tax`, `delivery`, `handling`, `surge`, `platform`, `discount`, `subtotal`, and `total`.
5. The API normalizes `price` to `amount` and the UI maps alternate charge labels such as `bill_total`, `handling_charge`, and `surge_charge`.

The standalone direct test is `scripts/test-openrouter.mjs`. Run it with `npm run test:openrouter -- "path/to/image.jpeg"`. It proved the image encoding and OpenRouter request work. The `dots-studio/dots-3-note-preview:free` model returned agent-style/truncated output, while Gemini returned usable bill JSON. The user may intentionally use `openrouter/free`; do not change `.env` automatically.

## Current UI behavior
- New bill starts empty; no dummy items.
- Uploading a screenshot is the only automatic way to add OCR items.
- Manual item creation is available and item name/details/amount are editable.
- Charge fields are editable and blank when OCR did not return a value.
- Receipt total is displayed separately from calculated total and a discrepancy warning appears when they differ.
- Per-item person buttons control inclusion. The bill-wide toggle can include everyone or remove everyone.
- Account/group modal persists group name and members in localStorage and supports adding/removing members.
- Member badges should use initials and avoid collisions; account UI is intentionally lightweight local persistence, not authentication.

## Recent fix
`src/App.css` now uses a responsive grid for `.bill-options` so six extras fields do not overflow. Build and lint should be run after changes:

```bash
npm run build
npm run lint
```

## Important security note
A real OpenRouter key was previously exposed in conversation/workspace context. It should be revoked and replaced. Never print or commit API keys.
