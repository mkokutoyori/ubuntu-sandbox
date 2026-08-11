import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = 'src/network/devices/shells';
const RENDERER = join(ROOT, 'cli/CliDiagnostic.ts');
const TRIE = join(ROOT, 'CommandTrie.ts');
const ERRORS_TABLE = join(ROOT, 'cli-utils.ts');

const ALLOWED = new Set([RENDERER, TRIE, ERRORS_TABLE].map(p => p.replace(/\\/g, '/')));

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sources(full));
    else if (full.endsWith('.ts')) out.push(full.replace(/\\/g, '/'));
  }
  return out;
}

const CARET_MESSAGE = "% Invalid input detected at '^' marker.";

describe('the diagnostic renderer is the only place that words an error', () => {
  it('no shell file spells the ambiguous-command message itself', () => {
    const offenders = sources(ROOT)
      .filter(f => !ALLOWED.has(f))
      .filter(f => readFileSync(f, 'utf8').includes('% Ambiguous command'));
    expect(offenders).toEqual([]);
  });

  it('the caret and its message are produced together, never apart', () => {
    const rendered = readFileSync(RENDERER, 'utf8');
    expect(rendered).toContain('formatInvalidInput');
    expect(rendered).toContain(CARET_MESSAGE);
  });

  it('the handler-side signal exists so a handler need not word anything', () => {
    expect(readFileSync(RENDERER, 'utf8')).toContain('export class CliInvalidInput');
  });
});

describe('the count of hand-written error literals only goes down', () => {
  const countIn = (needle: string): number =>
    sources(ROOT)
      .filter(f => !ALLOWED.has(f))
      .reduce((n, f) => n + readFileSync(f, 'utf8').split(needle).length - 1, 0);

  it('% Invalid input is written in at most the sites left to migrate', () => {
    expect(countIn(CARET_MESSAGE)).toBeLessThanOrEqual(56);
  });

  it('% Incomplete command. is written in at most the sites left to migrate', () => {
    expect(countIn('% Incomplete command.')).toBeLessThanOrEqual(257);
  });
});
