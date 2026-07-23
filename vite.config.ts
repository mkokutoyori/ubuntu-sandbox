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
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        '**/*.d.ts',
        '**/__tests__/**',
        'src/bash/grammar/**',
        'src/**/index.ts',
      ],
      thresholds: {
        'src/network/protocols/ssh/**': {
          lines: 85,
          functions: 85,
          statements: 85,
          branches: 75,
        },
        // Measured via `vitest run --coverage src/__tests__/unit/database/
        // src/__tests__/unit/terminal/subshells/rman/` (Oracle's own unit
        // suites, excluding the debug/*.debug.test.ts transcript dumps):
        // database/oracle ~86.6/69.05/93.66/89.67 (stmts/branches/funcs/lines),
        // database/engine's weakest subdir (catalog) ~73.38/61.16/80.39/79.04.
        // Thresholds are set with margin below those numbers so the full CI
        // suite (which exercises strictly more code paths than this subset)
        // clears them comfortably.
        'src/database/oracle/**': {
          lines: 85,
          functions: 85,
          statements: 80,
          branches: 65,
        },
        'src/database/engine/**': {
          lines: 75,
          functions: 75,
          statements: 70,
          branches: 55,
        },
      },
    },
  },
}));
