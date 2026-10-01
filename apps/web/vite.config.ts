import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// `pnpm dev` talks to a running `code-atlas serve` on this port. Without one,
// the app falls back to the bundled fixture.
const server = process.env.CODE_ATLAS_SERVER ?? 'http://localhost:4400';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5273,
    proxy: {
      '/api': { target: server, changeOrigin: true },
      '/ws': { target: server, ws: true },
    },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
