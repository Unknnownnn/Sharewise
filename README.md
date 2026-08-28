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

The OCR model is read from `OPENROUTER_MODEL`. Free model endpoints can be rate-limited or temporarily unavailable; the UI displays the actual API error instead of silently pretending OCR succeeded.

## Test OpenRouter directly

This bypasses the browser and local API to prove whether OpenRouter accepts the image request:

```bash
node scripts/test-openrouter.mjs "path/to/your/image.jpg"
```

The script prints the image MIME type, base64 size, selected model, HTTP status, and model response. It never prints the API key.

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
