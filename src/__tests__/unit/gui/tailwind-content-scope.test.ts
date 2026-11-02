/**
 * Tailwind scans the files named by `content` for class names. It used to
 * name every `.ts` and `.tsx` file under `src` — 8 369 files, 335 MB, the whole simulator and
 * every test — and a cold `vite` dev server spent 26 of its 29 seconds
 * compiling `index.css`. The scan is now limited to the files that can carry
 * a class: `.tsx` and the `.ts` helpers under `src/components`.
 *
 * Measured with the Tailwind CLI on the same tree: the narrowed scope emits
 * the same stylesheet minus the rules that only matched ordinary words of the
 * simulator's own code (`.collapse`, `.sticky`, `.isolate`, `.!block`,
 * `.[core:emerg]`…) in 1.1 s instead of 28 s.
 *
 * Four cases against the old glob: three fall (the scope holds ~8 000 files,
 * it contains `src/network` and the tests, `index.html` is not in it) and one
 * passes either way — the witness that narrowing hid no class: no file left
 * out of the scan declares a JSX `className=`.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import fg from 'fast-glob';
import { describe, expect, it } from 'vitest';
import tailwindConfig from '../../../../tailwind.config';

const ROOT = resolve(__dirname, '../../../..');

const patterns = (tailwindConfig.content as string[]);
const included = patterns.filter((pattern) => !pattern.startsWith('!'));
const excluded = patterns.filter((pattern) => pattern.startsWith('!')).map((pattern) => pattern.slice(1));

const scanned = fg.sync(included, { cwd: ROOT, ignore: excluded, dot: false });

describe('tailwind content scope', () => {
  it('scans fewer than 300 files', () => {
    expect(scanned.length).toBeGreaterThan(80);
    expect(scanned.length).toBeLessThan(300);
  });

  it('scans no simulation, database, shell or test directory', () => {
    const outside = scanned.filter((file) =>
      /^(?:\.\/)?src\/(?:network|database|bash|powershell|cli|shell|crypto|adapters|labs)\//.test(file)
      || file.includes('__tests__'),
    );
    expect(outside).toEqual([]);
  });

  it('scans the files that carry the interface', () => {
    const normalised = scanned.map((file) => file.replace(/^\.\//, ''));
    expect(normalised).toContain('index.html');
    expect(normalised).toContain('src/pages/Index.tsx');
    expect(normalised).toContain('src/components/network/DevicePalette.tsx');
    expect(normalised).toContain('src/components/network/device-visuals.ts');
  });

  it('leaves out no file that declares a JSX className', () => {
    const scannedSet = new Set(scanned.map((file) => file.replace(/^\.\//, '')));
    const candidates = fg.sync(['src/**/*.{ts,tsx}'], { cwd: ROOT, ignore: ['src/**/__tests__/**'] });
    const leftOut = candidates
      .filter((file) => !scannedSet.has(file))
      .filter((file) => /\bclassName=/.test(readFileSync(resolve(ROOT, file), 'utf8')));
    expect(leftOut).toEqual([]);
  });
});
