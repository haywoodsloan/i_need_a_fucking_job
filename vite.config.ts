/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// `npm run local` passes the backend's address here. The sign-in cookie only travels to the page's own address, so
// the account pages call /api on that address and the dev server hands those calls to the backend. Search still
// calls the backend directly. The backend's admin channel (/api/admin) is deliberately not passed on.
const backend = process.env.VITE_API_URL;

// Relative base so the static build works from any GitHub Pages sub-path
// (https://<user>.github.io/<repo>/) without hard-coding the repo name.
export default defineConfig({
  base: './',
  plugins: [react()],
  server: backend ? { proxy: { '^/api/(auth|account|vault)(/|$)': { target: backend } } } : undefined,
  test: {
    environment: 'node',
    include: ['src/**/*.test.{ts,tsx}', 'test/**/*.test.{ts,tsx}'],
    // Starting the embedded database takes a second or two. The defaults (5 and 10 seconds) are too close to that
    // on a slow machine.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
