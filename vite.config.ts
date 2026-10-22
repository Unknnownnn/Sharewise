import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  // Read API_PORT from .env so the dev proxy and api.mjs can never disagree.
  // Shell variables win over .env, matching how dotenv behaves in api.mjs.
  const env = loadEnv(mode, process.cwd(), '')
  const apiPort = Number(process.env.API_PORT || env.API_PORT || process.env.PORT || env.PORT || 8787)
  const webPort = Number(process.env.VITE_PORT || env.VITE_PORT || 5173)

  return {
    plugins: [react()],
    server: {
      host: '0.0.0.0',
      port: webPort,
      proxy: {
        '/api': `http://localhost:${apiPort}`,
      },
    },
  }
})
