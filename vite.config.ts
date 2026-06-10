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
  // Preserve class/function names through minification. The vendor
  // dispatch that used to rely on `instance.constructor.name` has been
  // replaced by the polymorphic `Equipment.getOSType()` hook (see
  // src/shell/shellKind.ts), so this is now only a defensive guard for
  // debugging/log readability — kept until a minified production build
  // has been regression-checked without it.
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
