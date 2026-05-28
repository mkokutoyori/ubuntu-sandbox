/// <reference types="vitest" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";
import { componentTagger } from "lovable-tagger";

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => ({
  server: {
    host: '127.0.0.1',
    port: 8080,
  },
  plugins: [react(), mode === "development" && componentTagger()].filter(Boolean),
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  // Provide Node.js Buffer polyfill for the browser.
  // Domain network entities (EthernetFrame, IPv4Packet, ICMPPacket, ARPService)
  // use Buffer for binary data manipulation.
  define: {
    global: 'globalThis',
  },
  // Preserve class/function names through minification. The simulator
  // dispatches on `instance.constructor.name === 'WindowsPC'` (and a
  // few siblings) to pick the vendor-specific SSH push path — under
  // default esbuild minification those names become `W4`, `Jd`, … and
  // the dispatch silently falls back to a generic shell, producing a
  // Linux-format prompt on Windows hosts in production builds.
  esbuild: {
    keepNames: true,
  },
  build: {
    // Same guard for the rollup/esbuild minifier used by `vite build`.
    minify: 'esbuild',
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      reportsDirectory: './coverage',
      include: ['src/network/protocols/ssh/**/*.ts'],
      exclude: ['**/*.d.ts', '**/__tests__/**'],
      thresholds: {
        // Analysis doc P7: keep the SSH core honest as new features land.
        lines: 85,
        functions: 85,
        statements: 85,
        branches: 75,
      },
    },
  },
}));
