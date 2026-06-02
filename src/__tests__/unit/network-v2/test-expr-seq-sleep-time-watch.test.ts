/**
 * test / [ , expr, seq, sleep, time, watch — exhaustive behaviour spec.
 *
 * Drives each command through the real Linux executor so the parsers,
 * VFS-bound predicates, regex translator, format renderer, and
 * dispatch wiring are all exercised end-to-end.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxCommandExecutor } from '@/network/devices/linux/LinuxCommandExecutor';

let exec: LinuxCommandExecutor;
beforeEach(() => { exec = new LinuxCommandExecutor(false); });

function write(path: string, content: string, mode = 0o644): void {
  exec.vfs.writeFile(path, content, 0, 0, 0o022);
  const inode = exec.vfs.resolveInode(path);
  if (inode) inode.permissions = mode;
}
function run(cmd: string): string { return exec.execute(cmd); }

// ─── test / [ ──────────────────────────────────────────────────────────
describe('test / [ … ]', () => {
  it('T1 -e succeeds on an existing file', () => {
    write('/tmp/a', 'x');
    expect(run('test -e /tmp/a && echo Y')).toBe('Y');
  });
  it('T2 -e fails on a missing path (exit 1)', () => {
    expect(run('test -e /tmp/nope || echo MISS')).toBe('MISS');
  });
  it('T3 -f distinguishes a regular file from a directory', () => {
    write('/tmp/file', 'x');
    exec.vfs.mkdirp('/tmp/dir', 0o755, 0, 0);
    expect(run('test -f /tmp/file && echo YES')).toBe('YES');
    expect(run('test -f /tmp/dir || echo NO')).toBe('NO');
  });
  it('T4 -d recognises a directory', () => {
    exec.vfs.mkdirp('/var/log', 0o755, 0, 0);
    expect(run('test -d /var/log && echo OK')).toBe('OK');
  });
  it('T5 -s is true only for non-empty files', () => {
    write('/tmp/empty', '');
    write('/tmp/full',  'hi');
    expect(run('test -s /tmp/empty || echo NO')).toBe('NO');
    expect(run('test -s /tmp/full && echo YES')).toBe('YES');
  });
  it('T6 -z / -n classify empty vs non-empty strings', () => {
    expect(run('test -z "" && echo Z')).toBe('Z');
    expect(run('test -n abc && echo N')).toBe('N');
  });
  it('T7 string equality with = and !=', () => {
    expect(run('test foo = foo && echo EQ')).toBe('EQ');
    expect(run('test foo != bar && echo NEQ')).toBe('NEQ');
  });
  it('T8 integer comparison operators', () => {
    expect(run('test 3 -lt 4 && echo LT')).toBe('LT');
    expect(run('test 4 -ge 4 && echo GE')).toBe('GE');
    expect(run('test 5 -eq 5 && echo EQ')).toBe('EQ');
  });
  it('T9 `!` negates the inner expression', () => {
    expect(run('test ! -e /tmp/none && echo NEG')).toBe('NEG');
  });
  it('T10 -a / -o combine sub-expressions', () => {
    write('/tmp/ab', 'x');
    expect(run('test -e /tmp/ab -a -f /tmp/ab && echo BOTH')).toBe('BOTH');
    expect(run('test -e /tmp/nope -o -e /tmp/ab && echo EITHER')).toBe('EITHER');
  });
  it('T11 `[ … ]` accepts the trailing `]`', () => {
    expect(run('[ 1 -eq 1 ] && echo OK')).toBe('OK');
  });
  it('T12 `[` reports a syntax error when `]` is missing', () => {
    const out = run('[ 1 -eq 1 || echo FALLBACK');
    expect(out).toContain('FALLBACK');
  });
  it('T13 -nt / -ot compare mtimes', () => {
    write('/tmp/old', 'x'); const oldI = exec.vfs.resolveInode('/tmp/old')!;
    write('/tmp/new', 'x'); const newI = exec.vfs.resolveInode('/tmp/new')!;
    oldI.mtime = 1000; newI.mtime = 2000;
    expect(run('test /tmp/new -nt /tmp/old && echo NEWER')).toBe('NEWER');
    expect(run('test /tmp/old -ot /tmp/new && echo OLDER')).toBe('OLDER');
  });
  it('T14 -ef true when both names resolve to the same inode', () => {
    write('/tmp/x', 'x');
    expect(run('test /tmp/x -ef /tmp/x && echo SAME')).toBe('SAME');
  });
  it('T15 invalid integer in -eq surfaces exit 2', () => {
    expect(run('test foo -eq 1 || echo BAD')).toContain('BAD');
  });
});

// ─── expr ──────────────────────────────────────────────────────────────
describe('expr', () => {
  it('E1 simple arithmetic +/-/*/%', () => {
    expect(run('expr 2 + 3')).toBe('5');
    expect(run('expr 10 - 4')).toBe('6');
    expect(run('expr 6 \\* 7')).toBe('42');
    expect(run('expr 7 % 3')).toBe('1');
  });
  it('E2 integer division truncates toward zero', () => {
    expect(run('expr 7 / 2')).toBe('3');
  });
  it('E3 honours precedence: 2 + 3 * 4 = 14', () => {
    expect(run('expr 2 + 3 \\* 4')).toBe('14');
  });
  it('E4 parenthesised sub-expression', () => {
    expect(run('expr \\( 2 + 3 \\) \\* 4')).toBe('20');
  });
  it('E5 comparison emits 1 / 0', () => {
    expect(run('expr 4 \\> 3')).toBe('1');
    expect(run('expr 4 \\< 3')).toBe('0');
    expect(run('expr abc = abc')).toBe('1');
  });
  it('E6 `|` returns the first non-zero/non-empty operand', () => {
    expect(run('expr "" \\| fallback')).toBe('fallback');
    expect(run('expr first \\| second')).toBe('first');
  });
  it('E7 `&` zeroes out when either side is empty/zero', () => {
    expect(run('expr 0 \\& 5')).toBe('0');
    expect(run('expr 5 \\& 3')).toBe('5');
  });
  it('E8 length / substr / index string functions', () => {
    expect(run('expr length hello')).toBe('5');
    expect(run('expr substr hello 2 3')).toBe('ell');
    expect(run('expr index abcdef cf')).toBe('3');
  });
  it('E9 match / `:` regex returns match length or capture', () => {
    expect(run('expr match abcdef "abc"')).toBe('3');
    expect(run('expr "abc123" : "[a-z]*\\([0-9]*\\)"')).toBe('123');
  });
  it('E10 exit 1 when the result is zero or empty', () => {
    expect(run('expr 0 || echo FALSEY')).toContain('FALSEY');
    expect(run('expr "" || echo EMPTY')).toContain('EMPTY');
  });
  it('E11 division by zero exits 3 with an error', () => {
    const out = run('expr 5 / 0');
    expect(out).toContain('division by zero');
  });
});

// ─── seq ───────────────────────────────────────────────────────────────
describe('seq', () => {
  it('S1 single operand: 1..N', () => {
    expect(run('seq 5').split('\n')).toEqual(['1','2','3','4','5']);
  });
  it('S2 FIRST LAST', () => {
    expect(run('seq 3 6').split('\n')).toEqual(['3','4','5','6']);
  });
  it('S3 FIRST INCR LAST counts upward by INCR', () => {
    expect(run('seq 0 2 10').split('\n')).toEqual(['0','2','4','6','8','10']);
  });
  it('S4 omitted step never auto-descends (matches GNU seq)', () => {
    expect(run('seq 5 1')).toBe('');
  });
  it('S5 explicit negative increment', () => {
    expect(run('seq 10 -3 1').split('\n')).toEqual(['10','7','4','1']);
  });
  it('S6 -s changes the separator', () => {
    expect(run('seq -s , 1 4')).toBe('1,2,3,4');
  });
  it('S7 -w zero-pads to equal width', () => {
    expect(run('seq -w 8 11').split('\n')).toEqual(['08','09','10','11']);
  });
  it('S8 floating-point increments preserve precision', () => {
    expect(run('seq 1.0 0.5 2.5').split('\n')).toEqual(['1.0','1.5','2.0','2.5']);
  });
  it('S9 -f printf-style formatting', () => {
    expect(run('seq -f "%03d" 1 3').split('\n')).toEqual(['001','002','003']);
  });
  it('S10 empty when ascending bounds are crossed', () => {
    expect(run('seq 5 3')).toBe('');
  });
  it('S11 zero increment is rejected', () => {
    expect(run('seq 1 0 5')).toContain('Zero increment');
  });
  it('S12 invalid operand is rejected', () => {
    expect(run('seq foo 5')).toContain('invalid floating point');
  });
});

// ─── sleep ─────────────────────────────────────────────────────────────
describe('sleep', () => {
  it('Z1 returns immediately with exit 0', () => {
    expect(run('sleep 1 && echo DONE')).toBe('DONE');
  });
  it('Z2 multiple operands are accepted', () => {
    expect(run('sleep 1 2 && echo K')).toBe('K');
  });
  it('Z3 suffixes s/m/h/d are valid', () => {
    expect(run('sleep 1s && echo S')).toBe('S');
    expect(run('sleep 2m && echo M')).toBe('M');
    expect(run('sleep 1h && echo H')).toBe('H');
    expect(run('sleep 1d && echo D')).toBe('D');
  });
  it('Z4 missing operand → exit 1', () => {
    expect(run('sleep || echo BAD')).toContain('BAD');
  });
  it('Z5 invalid interval → exit 1 with util-linux phrasing', () => {
    expect(run('sleep abc')).toContain("invalid time interval 'abc'");
  });
  it('Z6 fractional seconds are accepted', () => {
    expect(run('sleep 0.5 && echo F')).toBe('F');
  });
});

// ─── time ──────────────────────────────────────────────────────────────
describe('time', () => {
  it('M1 emits real/user/sys lines after the inner command', () => {
    const out = run('time echo hi');
    expect(out).toMatch(/^hi/);
    expect(out).toMatch(/\nreal\t\dm\d/);
    expect(out).toMatch(/\nuser\t\dm\d/);
    expect(out).toMatch(/\nsys\t\dm\d/);
  });
  it('M2 propagates the inner exit code', () => {
    expect(run('time false || echo FAILED')).toContain('FAILED');
  });
  it('M3 with no command, emits a zero-time block', () => {
    const out = run('time');
    expect(out).toContain('real\t0m');
    expect(out).toContain('user\t0m');
    expect(out).toContain('sys\t0m');
  });
});

// ─── watch ─────────────────────────────────────────────────────────────
describe('watch', () => {
  it('W1 renders the canonical header and the command output', () => {
    const out = run('watch echo hello');
    expect(out).toMatch(/^Every 2s: echo hello/);
    expect(out).toMatch(/\d\d:\d\d:\d\d/);
    expect(out).toContain('hello');
  });
  it('W2 -t suppresses the header', () => {
    const out = run('watch -t echo bare');
    expect(out).not.toContain('Every');
    expect(out).toContain('bare');
  });
  it('W3 -n changes the displayed interval', () => {
    expect(run('watch -n 5 echo X')).toMatch(/^Every 5s:/);
  });
  it('W4 no command → exit 1 with usage message', () => {
    expect(run('watch')).toContain('no command given');
  });
  it('W5 invalid -n value is rejected', () => {
    expect(run('watch -n abc echo Y')).toContain('invalid interval');
  });
  it('W6 propagates the inner exit code', () => {
    expect(run('watch -t false || echo PROP')).toContain('PROP');
  });
});
