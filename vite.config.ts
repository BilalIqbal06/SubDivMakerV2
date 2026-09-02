import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({ command }) => ({
  base: command === 'build' ? '/SubDivMakerV2/' : '/',
  plugins: [react()],
  server: {
    port: 3004,
    strictPort: true,
    proxy: {
      '/api/loudoun': {
        target: 'https://logis.loudoun.gov',
        changeOrigin: true,
        secure: true,
        rewrite: (path) => path.replace(/^\/api\/loudoun/, ''),
      },
      '/api/loudoun-gis': {
        target: 'https://gis.loudoun.gov',
        changeOrigin: true,
        secure: true,
        rewrite: (path) => path.replace(/^\/api\/loudoun-gis/, ''),
      }
    }
  },
  build: {
    outDir: 'dist',
    sourcemap: true
  }
}))
