import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({ command }) => ({
  base: command === 'build' ? '/SubDivMakerV2/' : '/',
  define: {
    __LOGIS_GIS_BASE_URL__: JSON.stringify(command === 'serve' ? '/api/loudoun' : 'https://logis.loudoun.gov'),
    __LOUDOUN_GIS_BASE_URL__: JSON.stringify(command === 'serve' ? '/api/loudoun-gis' : 'https://gis.loudoun.gov'),
  },
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
