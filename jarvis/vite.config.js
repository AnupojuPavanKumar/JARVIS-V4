import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  root: resolve(__dirname, 'renderer'),
  base: './', // Use relative paths for Electron
  build: {
    outDir: resolve(__dirname, 'dist-renderer'),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'renderer/index.html')
      }
    }
  },
  server: {
    port: 5173,
    strictPort: true
  }
});
