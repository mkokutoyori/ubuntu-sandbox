/**
 * Word classes recorded from a real vim 9.1 (scripts/oracle/record_vim_wordclass.py, `vim -u NONE -N -es`).  For 13
 * 'iskeyword' values, `\k` says which characters from U+0001 up to U+00FF are keyword characters, and for the default value
 * it says it for every code point up to U+10FFFF (surrogates apart); then, for the pairs of 304 representatives (one per
 * interval of utf_class_buf's table, Latin-1 included, composing characters left out), `w` on `<a><b> x` lands on `<b>` when
 * the two have different classes and on `x` when they share one.  The table of intervals comes from vim's own source
 * (src/mbyte.c, scripts/oracle/gen_vim_charclass.py) and is searched the same way, overlapping entries included.
 *
 * Measured with `git stash push -- src/network`: the module does not exist on the previous tree, so the file cannot import
 * (every case fails before, 0 after).  The corpus-size case would pass on any tree that could load the fixture (witness
 * that it loads).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { parseIsKeyword, wordClasses } from '@/network/devices/linux/editors/vim/VimCharClass';

interface Recorded {
  readonly vim: string;
  readonly specs: readonly string[];
  readonly keyword: Readonly<Record<string, readonly (readonly [number, number])[]>>;
  readonly representatives: readonly number[];
  readonly different: readonly string[];
}

const recorded = JSON.parse(readFileSync('src/__tests__/support/oracle/vim-wordclass/vim-9.1-wordclass.json', 'utf8')) as Recorded;

function recordedKeyword(spec: string, code: number): boolean {
  return recorded.keyword[spec].some(([low, high]) => code >= low && code <= high);
}

describe('vim word classes recorded from a real vim', () => {
  it('has the recorded corpus', () => {
    expect(recorded.vim).toMatch(/^VIM - Vi IMproved 9\.1/);
    expect(recorded.specs.length).toBeGreaterThan(10);
    expect(recorded.representatives.length).toBeGreaterThan(250);
  });

  for (const spec of Object.keys(recorded.keyword)) {
    it(`\\k agrees on iskeyword=${spec} below U+0100`, () => {
      const classes = wordClasses(spec)!;
      const body = new RegExp(`[${classes.keywordBody(false)}]`, 'u');
      const mismatches: string[] = [];
      for (let code = 1; code < 0x100; code++) {
        if (body.test(String.fromCodePoint(code)) !== recordedKeyword(spec, code)) mismatches.push(code.toString(16));
      }
      expect(mismatches).toEqual([]);
    });
  }

  it('\\k agrees above U+00FF for every code point', () => {
    const spec = recorded.specs[0];
    const body = new RegExp(`[${wordClasses(spec)!.keywordBody(false)}]`, 'u');
    const ranges = recorded.keyword[spec];
    let at = 0;
    const mismatches: string[] = [];
    for (let code = 0x100; code <= 0x10ffff; code++) {
      if (code >= 0xd800 && code <= 0xdfff) continue;
      while (at < ranges.length && ranges[at][1] < code) at++;
      const expected = at < ranges.length && ranges[at][0] <= code;
      if (body.test(String.fromCodePoint(code)) !== expected && mismatches.length < 10) mismatches.push(code.toString(16));
    }
    expect(mismatches).toEqual([]);
  });

  it('isKeyword and classOf agree with the recorded keyword set', () => {
    const classes = wordClasses(recorded.specs[0])!;
    const mismatches: string[] = [];
    for (let code = 0x100; code <= 0x10ffff; code += 7) {
      if (code >= 0xd800 && code <= 0xdfff) continue;
      if (classes.isKeyword(String.fromCodePoint(code)) !== recordedKeyword(recorded.specs[0], code) && mismatches.length < 10) mismatches.push(code.toString(16));
    }
    expect(mismatches).toEqual([]);
  });

  it('two characters share a class exactly when `w` treats them as one word', () => {
    const classes = wordClasses(recorded.specs[0])!;
    const mismatches: string[] = [];
    recorded.representatives.forEach((a, row) => {
      recorded.representatives.forEach((b, column) => {
        const first = classes.classOf(String.fromCodePoint(a));
        const second = classes.classOf(String.fromCodePoint(b));
        if (first === 0 || second === 0) return;
        const different = first !== second;
        if (different !== (recorded.different[row][column] === '1') && mismatches.length < 10) mismatches.push(`${a.toString(16)} ${b.toString(16)}`);
      });
    });
    expect(mismatches).toEqual([]);
  });

  it('refuses a value vim refuses', () => {
    for (const bad of ['300', '0', 'b-a', 'a-', 'abc', 'a,,b-', '1-300']) expect(parseIsKeyword(bad)).toBeNull();
  });
});
