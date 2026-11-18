import { defineConfig } from 'vite';

export default defineConfig({
  resolve: {
    alias: {
      stream: 'readable-stream',
      buffer: 'buffer',
    },
  },
  define: {
    global: 'globalThis',
    'process.env': {},
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});

