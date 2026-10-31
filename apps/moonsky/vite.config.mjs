import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

const dir = import.meta.dirname
const MOONSKY_ORIGIN = 'http://127.0.0.1:3005'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  root: resolve(dir, 'client'),
  build: { outDir: resolve(dir, 'dist/client'), emptyOutDir: true },
  server: {
    host: '127.0.0.1', port: 3105, strictPort: true,
    proxy: {
      '/api': { target: MOONSKY_ORIGIN, changeOrigin: false },
      '/health': { target: MOONSKY_ORIGIN, changeOrigin: false },
      '/ws': { target: MOONSKY_ORIGIN, changeOrigin: false, ws: true },
    },
  },
})
