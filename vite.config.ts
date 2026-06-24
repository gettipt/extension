import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'

export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // Offscreen wallet runtime bundles the Spark SDK and is expected to be large.
    // Keep warnings focused on unexpected growth beyond this known baseline.
    chunkSizeWarningLimit: 7000,
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, 'index.html'),
        offscreen: path.resolve(__dirname, 'offscreen.html'),
        confirm: path.resolve(__dirname, 'confirm.html'),
        background: path.resolve(__dirname, 'src/background.ts'),
        content: path.resolve(__dirname, 'src/content.ts'),
      },
      output: {
        entryFileNames: (chunkInfo) => {
          if (
            chunkInfo.name === 'background' ||
            chunkInfo.name === 'content'
          ) {
            return '[name].js';
          }

          return 'assets/[name]-[hash].js';
        },
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
})
