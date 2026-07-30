import { fileURLToPath } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
// vitest's defineConfig, not vite's — it is the one that knows about `test`.
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '#': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 4340,
    strictPort: true,
  },
  build: {
    // The webview is always current, so there is no reason to ship transpiled
    // output for browsers that will never load this bundle.
    target: 'esnext',
    sourcemap: true,
  },
  test: {
    environment: 'jsdom',
  },
})
