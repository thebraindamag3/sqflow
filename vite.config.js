import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
export default defineConfig({
  plugins: [react()],
  base: '/sqflow/',     // ← ESTO ES LO QUE FALTABA para GitHub Pages
  build: {
    outDir: 'dist'
  }
})
