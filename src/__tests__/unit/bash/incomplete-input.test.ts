/**
 * Interactive line-continuation detection for bash.
 *
 * A real interactive bash keeps reading (PS2 `>`) when the line so far
 * cannot yet be a complete command: an open quote, a trailing backslash,
 * a dangling pipe/`&&`/`||`, an unfinished compound (if/for/while/case),
 * or an unterminated here-document. The simulator used to error or
 * silently truncate these — this detector is what lets the terminal
 * accumulate lines until the command is whole.
 */

import { describe, it, expect } from 'vitest';
import { analyzeBashInput } from '@/bash/incompleteInput';

const incomplete = (s: string) => analyzeBashInput(s).complete === false;
const complete = (s: string) => analyzeBashInput(s).complete === true;

describe('analyzeBashInput — complete commands', () => {
  for (const cmd of [
    'echo hello',
    "echo 'quoted string'",
    'echo "double quoted"',
    'ls -la | grep foo',
    'if true; then echo x; fi',
    'for i in 1 2 3; do echo $i; done',
    'cat <<EOF\nline1\nline2\nEOF',
    'echo a && echo b',
    'echo "with escaped \\" quote"',
    'x=1',
  ]) {
    it(`complete: ${JSON.stringify(cmd)}`, () => {
      expect(complete(cmd)).toBe(true);
    });
  }
});

describe('analyzeBashInput — incomplete commands', () => {
  it('unterminated single quote', () => {
    expect(incomplete("echo 'abc")).toBe(true);
  });
  it('unterminated double quote', () => {
    expect(incomplete('echo "abc')).toBe(true);
  });
  it('trailing backslash (line continuation)', () => {
    expect(incomplete('echo abc \\')).toBe(true);
  });
  it('dangling pipe', () => {
    expect(incomplete('echo a |')).toBe(true);
  });
  it('dangling &&', () => {
    expect(incomplete('echo a &&')).toBe(true);
  });
  it('dangling ||', () => {
    expect(incomplete('echo a ||')).toBe(true);
  });
  it('open if without fi', () => {
    expect(incomplete('if true; then')).toBe(true);
  });
  it('open for without done', () => {
    expect(incomplete('for i in 1 2 3; do')).toBe(true);
  });
  it('open while without done', () => {
    expect(incomplete('while true; do echo x')).toBe(true);
  });
  it('unterminated heredoc reports the delimiter', () => {
    const r = analyzeBashInput('cat <<EOF\nfoo');
    expect(r.complete).toBe(false);
    expect(r.heredocDelimiter).toBe('EOF');
  });
  it('heredoc closed by its delimiter line is complete', () => {
    expect(complete('cat <<EOF\nfoo\nEOF')).toBe(true);
  });
  it('quoted heredoc delimiter (<<"END") still detected', () => {
    const r = analyzeBashInput('cat <<"END"\nfoo');
    expect(r.complete).toBe(false);
    expect(r.heredocDelimiter).toBe('END');
  });
});

describe('analyzeBashInput — a comment or pipe inside quotes is not a continuation trap', () => {
  it('a pipe character inside quotes does not count as dangling', () => {
    expect(complete('echo "a | b"')).toBe(true);
  });
  it('a bare # comment line is complete', () => {
    expect(complete('# just a comment')).toBe(true);
  });
});

describe('analyzeBashInput — << inside arithmetic is a shift, not a heredoc', () => {
  it('$((8 << 2)) is a complete command', () => {
    expect(complete('echo $((8 << 2))')).toBe(true);
  });
  it('assignment from a shift expression is complete', () => {
    expect(complete('x=$((1<<4)); echo $x')).toBe(true);
  });
  it('arithmetic command (( x <<= 2 )) is complete', () => {
    expect(complete('(( x <<= 2 ))')).toBe(true);
  });
  it('nested parens inside arithmetic stay balanced', () => {
    expect(complete('echo $(( (1 << 2) + 3 ))')).toBe(true);
  });
  it('an arithmetic expansion left open continues on PS2 without a heredoc delimiter', () => {
    const r = analyzeBashInput('echo $((8 <<');
    expect(r.complete).toBe(false);
    expect(r.heredocDelimiter).toBeUndefined();
  });
  it('a real heredoc after a closed arithmetic expansion is still detected', () => {
    const r = analyzeBashInput('echo $((1 << 3)) && cat << EOF');
    expect(r.complete).toBe(false);
    expect(r.heredocDelimiter).toBe('EOF');
  });
});
