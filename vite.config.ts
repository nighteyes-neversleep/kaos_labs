import { defineConfig } from 'vitest/config';

export default defineConfig({
  esbuild: { jsx: 'automatic' },
  server: {
    host: '0.0.0.0', port: 5173, strictPort: true,
    fs: { deny: ['.env', '.env.*', '*.{crt,pem}', '**/.git/**', '**/.omi-dev/**'] },
    proxy: { '/api/forum': { target: 'http://127.0.0.1:8080', changeOrigin: false } },
  },
  preview: { host: '0.0.0.0', port: 4173, strictPort: true },
  test: { include: ['src/**/*.test.ts', 'server/**/*.test.ts'], environment: 'node', maxWorkers: 2 },
});
