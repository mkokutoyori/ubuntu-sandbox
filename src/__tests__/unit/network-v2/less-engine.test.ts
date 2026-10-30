import { describe, it, expect } from 'vitest';
import { LessEngine, DEFAULT_LESS_OPTIONS } from '@/network/devices/linux/editors/LessEngine';
import { plainRowText } from '@/network/devices/linux/editors/screen/EditorScreen';
import { editorKey } from '@/network/devices/linux/editors/EditorKeyInput';

const numbered = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
const press = (e: LessEngine, keys: string) => { for (const k of keys) e.applyKey(editorKey(k)); };
const text = (e: LessEngine) => e.screen.rows.map(plainRowText);

describe('less engine', () => {
  it('shows the first page, the file name, then a colon', () => {
    const e = new LessEngine([{ title: 'big.txt', content: numbered(100) }], DEFAULT_LESS_OPTIONS, 10, 40);
    expect(text(e).slice(0, 9)).toEqual(Array.from({ length: 9 }, (_, i) => `line ${i + 1}`));
    expect(text(e)[9]).toBe('big.txt');
    press(e, 'j');
    expect(text(e)[0]).toBe('line 2');
    expect(text(e)[9]).toBe(':');
  });

  it('pages with space and b, jumps with G and g', () => {
    const e = new LessEngine([{ title: 'f', content: numbered(100) }], DEFAULT_LESS_OPTIONS, 10, 40);
    press(e, ' ');
    expect(text(e)[0]).toBe('line 9');
    press(e, 'b');
    expect(text(e)[0]).toBe('line 1');
    press(e, 'G');
    expect(text(e)[8]).toBe('line 100');
    expect(text(e)[9]).toBe('(END)');
    press(e, 'g');
    expect(text(e)[0]).toBe('line 1');
    press(e, '5g');
    expect(text(e)[0]).toBe('line 5');
  });

  it('pads a short file with tildes and shows END', () => {
    const e = new LessEngine([{ title: 'f', content: 'a\nb\n' }], DEFAULT_LESS_OPTIONS, 6, 20);
    expect(text(e)).toEqual(['a', 'b', '~', '~', '~', 'f (END)']);
  });

  it('searches forward and backward and repeats with n and N', () => {
    const e = new LessEngine([{ title: 'f', content: numbered(100) }], DEFAULT_LESS_OPTIONS, 10, 40);
    press(e, '/line 5');
    e.applyKey(editorKey('Enter'));
    expect(text(e)[0]).toBe('line 5');
    press(e, 'n');
    expect(text(e)[0]).toBe('line 50');
    press(e, 'N');
    expect(text(e)[0]).toBe('line 5');
    press(e, '/zzz');
    e.applyKey(editorKey('Enter'));
    expect(text(e)[9]).toBe('Pattern not found: zzz (press RETURN)');
  });

  it('highlights matches', () => {
    const e = new LessEngine([{ title: 'f', content: 'alpha beta\n' }], DEFAULT_LESS_OPTIONS, 4, 40);
    press(e, '/beta');
    e.applyKey(editorKey('Enter'));
    expect(e.screen.rows[0].spans).toEqual([{ from: 6, to: 10, style: 'reverse' }]);
  });

  it('toggles line numbers with -N and folds long lines', () => {
    const e = new LessEngine([{ title: 'f', content: 'x'.repeat(30) + '\n' }], DEFAULT_LESS_OPTIONS, 6, 10);
    expect(text(e).slice(0, 3)).toEqual(['x'.repeat(10), 'x'.repeat(10), 'x'.repeat(10)]);
    press(e, '-N');
    expect(text(e)[0]).toBe('      1 xx');
    expect(text(e)[5]).toBe('Use line numbers');
  });

  it('moves between files with :n and :p and announces the next one', () => {
    const e = new LessEngine([{ title: 'a.txt', content: 'one\n' }, { title: 'b.txt', content: 'two\n' }], DEFAULT_LESS_OPTIONS, 4, 40);
    expect(text(e)[3]).toBe('a.txt (file 1 of 2) (END) - Next: b.txt');
    press(e, ':n');
    expect(text(e)[0]).toBe('two');
    press(e, ':n');
    expect(text(e)[3]).toBe('No next file');
    press(e, ':p');
    expect(text(e)[0]).toBe('one');
  });

  it('marks a line and returns to it, and J scrolls past the end', () => {
    const e = new LessEngine([{ title: 'f', content: numbered(100) }], DEFAULT_LESS_OPTIONS, 10, 40);
    press(e, '10gma');
    expect(text(e)[0]).toBe('line 10');
    press(e, 'G');
    press(e, "'a");
    expect(text(e)[0]).toBe('line 10');
    press(e, 'G');
    press(e, 'J');
    expect(text(e)[0]).not.toBe('line 92');
    press(e, "'x");
    expect(text(e)[9]).toBe('Mark not set');
  });

  it('quits with q, :q and ZZ', () => {
    for (const keys of ['q', ':q', 'ZZ']) {
      const e = new LessEngine([{ title: 'f', content: 'a\n' }], DEFAULT_LESS_OPTIONS, 4, 20);
      press(e, keys);
      expect(e.exited).toBe(true);
    }
  });

  it('opens help and returns from it with q', () => {
    const e = new LessEngine([{ title: 'f', content: 'a\n' }], DEFAULT_LESS_OPTIONS, 6, 60);
    press(e, 'h');
    expect(text(e).join('\n')).toContain('SUMMARY OF LESS COMMANDS');
    press(e, 'q');
    expect(e.exited).toBe(false);
    expect(text(e)[0]).toBe('a');
  });

  it('starts on the help screen and leaves entirely with q when asked to', () => {
    const e = new LessEngine([{ title: '', content: '' }], DEFAULT_LESS_OPTIONS, 6, 60);
    e.showHelpFirst(true);
    expect(text(e).join('\n')).toContain('SUMMARY OF LESS COMMANDS');
    press(e, 'q');
    expect(e.exited).toBe(true);
  });

  it('expands tabs and shows control characters', () => {
    const e = new LessEngine([{ title: 'f', content: 'a\tb\u0001\n' }], DEFAULT_LESS_OPTIONS, 4, 40);
    expect(text(e)[0]).toBe('a       b^A');
  });
});
