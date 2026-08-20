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
  build: {
    minify: 'esbuild',
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
    // Automatic reset of shared singletons before every test (rapport 08,
    // item #51) — see the file for what this deliberately does and doesn't
    // cover. Additive: existing per-file manual resets are untouched and
    // remain harmless no-ops when this backstop already did the work.
    setupFiles: ['./src/__tests__/setupGlobalState.ts'],
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
        // Le moteur ACL est le composant de securite central du
        // simulateur et n'etait sous AUCUN seuil : dix-neuf constats
        // d'audit y ont vecu sous 83 tests verts (AUDIT-ACL-CISCO.md).
        //
        // Releve via `vitest run --coverage` sur les suites qui exercent
        // reellement ces fichiers (acl|nat|ipsec|vty|security|firewall|
        // ipv6|scenario + src/__tests__/audit/), 298 fichiers :
        //   ACLEngine.ts      76.97 / 68.75 / 93.65 / 81.86
        //   Ipv6AclEngine.ts  71.73 / 63.04 / 80.00 / 81.81
        //   (stmts / branches / funcs / lines)
        // Les seuils sont poses SOUS ces nombres : la suite complete
        // exerce strictement plus de chemins, elle les passe donc.
        //
        // Ce sont des planchers anti-regression, pas un satisfecit :
        // 68 % de branches sur un moteur de filtrage reste faible, et
        // c'est precisement dans les branches non couvertes que vivaient
        // les sept defauts d'ouverture. A remonter.
        'src/network/devices/router/ACLEngine.ts': {
          lines: 78,
          functions: 88,
          statements: 72,
          branches: 64,
        },
        'src/network/devices/router/Ipv6AclEngine.ts': {
          lines: 78,
          functions: 75,
          statements: 68,
          branches: 58,
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
