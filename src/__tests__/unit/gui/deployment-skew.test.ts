/*
 * The terminal of a page that was opened before a deployment: the main bundle asks for assets/TerminalManager-<old hash>.js, which the new deployment no longer holds, and the single-page rewrite of
 * vercel.json answers with index.html (text/html), so the browser refuses the module ("Failed to load module script ... MIME type of text/html", "Failed to fetch dynamically imported module"). A fresh
 * build of the same sources is consistent (359 chunk references, none missing, measured), so what breaks is the page, not the build. Probed here:
 * - which errors are a chunk that cannot be loaded (Chrome, Firefox, Safari wordings), and that an ordinary failure is not one;
 * - the guard: with nothing on the canvas the page reloads once (never twice within 30 s, so a deployment that really is broken cannot loop), with a topology on the canvas the page is NOT reloaded -
 *   the topology lives in memory - and the user is told instead;
 * - vercel.json: a missing /assets/ file is a 404 (never index.html served as a script), assets are immutable, the entry points are revalidated.
 * Measured before the change (git stash push -- src vercel.json; the new modules are untracked and stay in place): 2 of the 8 cases fall - the two on vercel.json, which rewrote every path including /assets/
 * and set no cache header. The other 6 pass either way: they exercise the new module (WITNESS), which the old code did not have.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { RELOAD_WINDOW_MS, deploymentSkewHandler, isChunkLoadFailure, type DeploymentSkewHost } from '@/deploymentSkew';

interface Trace {
  readonly calls: string[];
  readonly host: DeploymentSkewHost;
  clock: number;
}

function hostOf(options: { empty: boolean; last?: number | null }): Trace {
  let last = options.last ?? null;
  const trace: Trace = {
    calls: [],
    clock: 1_000_000,
    host: {
      nothingToLose: () => options.empty,
      lastReloadAt: () => last,
      rememberReloadAt: (at) => { last = at; trace.calls.push('remember'); },
      now: () => trace.clock,
      reload: () => trace.calls.push('reload'),
      announce: () => trace.calls.push('announce'),
    },
  };
  return trace;
}

describe('a page that outlived its deployment', () => {
  it('WITNESS: the three wordings of a module that cannot be fetched are recognised', () => {
    expect(isChunkLoadFailure(new TypeError('Failed to fetch dynamically imported module: https://x/assets/TerminalManager-B9x0auQN.js'))).toBe(true);
    expect(isChunkLoadFailure(new TypeError('error loading dynamically imported module: https://x/assets/a.js'))).toBe(true);
    expect(isChunkLoadFailure(new TypeError('Importing a module script failed.'))).toBe(true);
  });

  it('an ordinary failure is not a chunk failure', () => {
    expect(isChunkLoadFailure(new Error('Cannot read properties of undefined'))).toBe(false);
    expect(isChunkLoadFailure('boom')).toBe(false);
  });

  it('reloads once when nothing on the canvas would be lost', () => {
    const trace = hostOf({ empty: true });
    expect(deploymentSkewHandler(trace.host)()).toBe('reloaded');
    expect(trace.calls).toEqual(['remember', 'reload']);
  });

  it('does not reload a page that holds a topology: it says so', () => {
    const trace = hostOf({ empty: false });
    expect(deploymentSkewHandler(trace.host)()).toBe('announced');
    expect(trace.calls).toEqual(['announce']);
  });

  it('does not reload twice within the window, so a deployment that is really broken cannot loop', () => {
    const trace = hostOf({ empty: true, last: 1_000_000 - (RELOAD_WINDOW_MS - 1) });
    expect(deploymentSkewHandler(trace.host)()).toBe('announced');
    expect(trace.calls).toEqual(['announce']);
    const later = hostOf({ empty: true, last: 1_000_000 - RELOAD_WINDOW_MS - 1 });
    expect(deploymentSkewHandler(later.host)()).toBe('reloaded');
  });
});

describe('vercel.json', () => {
  const config = JSON.parse(readFileSync(new URL('../../../../vercel.json', import.meta.url), 'utf8')) as {
    rewrites: { source: string; destination: string }[];
    headers?: { source: string; headers: { key: string; value: string }[] }[];
  };
  const rewritten = (path: string): boolean => config.rewrites.some((rule) => new RegExp(`^${rule.source}$`).test(path.replace(/^\//, '/')));

  it('serves the application for an unknown route', () => {
    expect(rewritten('/some/route')).toBe(true);
    expect(rewritten('/')).toBe(true);
  });

  it('never answers a missing asset with index.html', () => {
    expect(rewritten('/assets/TerminalManager-B9x0auQN.js')).toBe(false);
  });

  it('keeps assets immutable and revalidates the entry points', () => {
    const rules = config.headers ?? [];
    expect(rules.some((rule) => rule.source === '/assets/(.*)' && rule.headers.some((header) => header.value.includes('immutable')))).toBe(true);
    expect(rules.some((rule) => rule.headers.some((header) => header.value === 'no-cache'))).toBe(true);
  });
});
