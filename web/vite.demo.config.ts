import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/** Clickable preview build (npm run demo:build): relative paths, a router that needs no server, recorded answers instead of an API. */
export default defineConfig({
  root: __dirname,
  base: './',
  plugins: [react()],
  define: { 'import.meta.env.VITE_DEMO': JSON.stringify('1') },
  publicDir: false,
  build: { target: 'es2022', cssCodeSplit: false, outDir: 'dist-demo', emptyOutDir: true, sourcemap: false, chunkSizeWarningLimit: 4000 },
});
