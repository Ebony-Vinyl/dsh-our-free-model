import path from 'node:path'
import { fileURLToPath } from 'node:url'
import tailwind from '@tailwindcss/vite'
import { standaloneSharedUi } from '../../scripts/lib/standalone-shared-ui.mjs'

const root = fileURLToPath(new URL('./frontend', import.meta.url))
export default {
  root, base: '/assets/',
  plugins: [tailwind(), standaloneSharedUi()],
  build: {
    outDir: fileURLToPath(new URL('./web', import.meta.url)),
    emptyOutDir: false, write: false, assetsDir: '', target: 'es2022',
    cssCodeSplit: false,
    rollupOptions: {
      output: {
        entryFileNames: 'app.js',
        chunkFileNames: '[name]-[hash].js',
        assetFileNames: asset => asset.names?.some(name => path.extname(name) === '.css') ? 'app.css' : '[name]-[hash][extname]',
      },
    },
  },
}
