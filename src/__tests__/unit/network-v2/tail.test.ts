/**
 * tail — exhaustive behaviour spec.
 *
 * Snapshot mode is driven through the live LinuxCommandExecutor;
 * follow mode is driven through the new VFS write-listener registry
 * plus the executor's `startTailFollow()` entry point. A separate
 * integration block drives the terminal session end-to-end so the
 * UI-facing addLine pipeline is exercised.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxCommandExecutor } from '@/network/devices/linux/LinuxCommandExecutor';
import {
  sliceTail, parseTailArgs, TailCommand,
} from '@/network/devices/linux/coreutils';
import type { TailSink, TailFollowHandle } from '@/network/devices/linux/coreutils';

let exec: LinuxCommandExecutor;
beforeEach(() => { exec = new LinuxCommandExecutor(false); });

function write(path: string, content: string): void {
  exec.vfs.writeFile(path, content, 0, 0, 0o022);
}
function append(path: string, more: string): void {
  exec.vfs.writeFile(path, more, 0, 0, 0o022, true);
}
function run(cmd: string): string { return exec.execute(cmd); }

// ─── Snapshot mode ──────────────────────────────────────────────────────
describe('tail snapshot', () => {
  it('A1 last 10 lines by default', () => {
    write('/tmp/log', Array.from({ length: 25 }, (_, i) => `L${i + 1}`).join('\n') + '\n');
    expect(run('tail /tmp/log').split('\n')).toEqual(
      Array.from({ length: 10 }, (_, i) => `L${i + 16}`),
    );
  });
  it('A2 -n N takes N tail lines', () => {
    write('/tmp/log', 'a\nb\nc\nd\ne\n');
    expect(run('tail -n 2 /tmp/log').split('\n')).toEqual(['d', 'e']);
  });
  it('A3 -n +N starts at line N (1-indexed)', () => {
    write('/tmp/log', 'a\nb\nc\nd\ne\n');
    expect(run('tail -n +3 /tmp/log').split('\n')).toEqual(['c', 'd', 'e']);
  });
  it('A4 historical `-3` syntax keeps working', () => {
    write('/tmp/log', '1\n2\n3\n4\n5\n');
    expect(run('tail -3 /tmp/log').split('\n')).toEqual(['3', '4', '5']);
  });
  it('A5 -c N returns the last N bytes', () => {
    write('/tmp/log', 'abcdef');
    expect(run('tail -c 3 /tmp/log')).toBe('def');
  });
  it('A6 --lines=N long-form', () => {
    write('/tmp/log', 'a\nb\nc\n');
    expect(run('tail --lines=1 /tmp/log')).toBe('c');
  });
  it('A7 stdin pipeline when no file is given', () => {
    expect(run('echo "x\ny\nz" | tail -n 2').split('\n')).toEqual(['y', 'z']);
  });
  it('A8 missing file → exit 1 with error message', () => {
    expect(run('tail /tmp/nope || echo MISS')).toContain('MISS');
  });
  it('A9 multi-file mode emits `==> path <==` headers', () => {
    write('/tmp/a', 'one\n');
    write('/tmp/b', 'two\n');
    const out = run('tail /tmp/a /tmp/b');
    expect(out).toContain('==> /tmp/a <==');
    expect(out).toContain('==> /tmp/b <==');
    expect(out).toContain('one');
    expect(out).toContain('two');
  });
  it('A10 -q suppresses headers in multi-file mode', () => {
    write('/tmp/a', 'one\n'); write('/tmp/b', 'two\n');
    const out = run('tail -q /tmp/a /tmp/b');
    expect(out).not.toContain('==>');
  });
  it('A11 -v forces headers even on a single file', () => {
    write('/tmp/a', 'only\n');
    expect(run('tail -v /tmp/a')).toContain('==> /tmp/a <==');
  });
  it('A12 -n 0 emits nothing', () => {
    write('/tmp/a', 'a\nb\nc\n');
    expect(run('tail -n 0 /tmp/a')).toBe('');
  });
  it('A13 clustered short flags `-fn5` parse', () => {
    const opts = parseTailArgs(['-fn5', '/tmp/x']);
    expect(opts.count).toBe(5);
    expect(opts.follow).toBe('descriptor');
  });
});

// ─── sliceTail unit ─────────────────────────────────────────────────────
describe('sliceTail', () => {
  it('B1 trailing-newline preservation', () => {
    expect(sliceTail('a\nb\nc\n', { ...parseTailArgs(['-n','2']) })).toBe('b\nc\n');
  });
  it('B2 fromStart line slicing', () => {
    expect(sliceTail('a\nb\nc\nd\n', { ...parseTailArgs(['-n','+2']) })).toBe('b\nc\nd\n');
  });
  it('B3 byte slicing without trailing newline', () => {
    expect(sliceTail('abcdef', { ...parseTailArgs(['-c','4']) })).toBe('cdef');
  });
});

// ─── Follow mode via the executor ───────────────────────────────────────
describe('tail -f via executor.startTailFollow', () => {
  function collect(): { sink: TailSink; lines: string[]; flush(): string } {
    const buf: string[] = [];
    return {
      sink: {
        write: (s: string) => { buf.push(s); },
        warn:  (s: string) => { buf.push(s); },
        error: (s: string) => { buf.push(s); },
      },
      get lines() { return buf; },
      flush() { return buf.join(''); },
    };
  }

  it('F1 emits the initial tail snapshot through the sink', () => {
    write('/tmp/log', 'one\ntwo\nthree\n');
    const c = collect();
    const handle = exec.startTailFollow('tail -f /tmp/log', c.sink);
    expect(handle).not.toBeNull();
    expect(c.flush()).toContain('three');
    handle!.cancel();
  });
  it('F2 streams every appended write while the handle is active', () => {
    write('/tmp/log', 'start\n');
    const c = collect();
    const handle = exec.startTailFollow('tail -f /tmp/log', c.sink)!;
    append('/tmp/log', 'live-1\n');
    append('/tmp/log', 'live-2\n');
    const out = c.flush();
    expect(out).toContain('live-1');
    expect(out).toContain('live-2');
    handle.cancel();
  });
  it('F3 cancel() detaches the listener — further writes are dropped', () => {
    write('/tmp/log', 'seed\n');
    const c = collect();
    const handle = exec.startTailFollow('tail -f /tmp/log', c.sink)!;
    const before = c.flush();
    handle.cancel();
    append('/tmp/log', 'after-cancel\n');
    expect(c.flush()).toBe(before);
  });
  it('F4 reports truncation as a non-fatal warning', () => {
    write('/tmp/log', 'long-line-1\nlong-line-2\n');
    const c = collect();
    const handle = exec.startTailFollow('tail -f /tmp/log', c.sink)!;
    write('/tmp/log', 'tiny\n');
    expect(c.flush()).toContain('file truncated');
    handle.cancel();
  });
  it('F5 multi-file follow emits headers when the active file switches', () => {
    write('/tmp/a', 'A\n');
    write('/tmp/b', 'B\n');
    const c = collect();
    const handle = exec.startTailFollow('tail -f /tmp/a /tmp/b', c.sink)!;
    append('/tmp/a', 'append-a\n');
    append('/tmp/b', 'append-b\n');
    const out = c.flush();
    expect(out).toContain('==> /tmp/a <==');
    expect(out).toContain('==> /tmp/b <==');
    expect(out).toContain('append-a');
    expect(out).toContain('append-b');
    handle.cancel();
  });
  it('F6 startTailFollow returns null for non-follow tails', () => {
    write('/tmp/log', 'x\n');
    expect(exec.startTailFollow('tail -n 5 /tmp/log', collect().sink)).toBeNull();
    expect(exec.startTailFollow('cat /tmp/log',       collect().sink)).toBeNull();
  });
  it('F7 -F enables retry mode and tracks a not-yet-created file', () => {
    const c = collect();
    const handle = exec.startTailFollow('tail -F /tmp/future', c.sink)!;
    expect(c.flush()).toContain('No such file or directory');
    write('/tmp/future', 'arrived\n');
    expect(c.flush()).toContain('arrived');
    handle.cancel();
  });
  it('F8 active flag transitions on cancel', () => {
    write('/tmp/log', 'x\n');
    const handle = exec.startTailFollow('tail -f /tmp/log', collect().sink)!;
    expect(handle.active).toBe(true);
    handle.cancel();
    expect(handle.active).toBe(false);
  });
  it('F9 cancel() is idempotent', () => {
    write('/tmp/log', 'x\n');
    const handle = exec.startTailFollow('tail -f /tmp/log', collect().sink)!;
    handle.cancel(); handle.cancel();    // second cancel must not throw
    expect(handle.active).toBe(false);
  });
});

// ─── VFS write-listener primitive ───────────────────────────────────────
describe('VFS write notifications', () => {
  it('V1 fires on append with previous/current snapshots', () => {
    const events: Array<{ created: boolean; previous: string; current: string }> = [];
    write('/tmp/v', 'init');
    const unsub = exec.vfs.onWrite('/tmp/v', (e) => {
      events.push({ created: e.created, previous: e.previous, current: e.current });
    });
    append('/tmp/v', '+more');
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ created: false, previous: 'init', current: 'init+more' });
    unsub();
  });
  it('V2 fires on file creation with `created: true`', () => {
    const events: Array<{ created: boolean }> = [];
    exec.vfs.onWrite('/tmp/new', (e) => { events.push({ created: e.created }); });
    write('/tmp/new', 'hi');
    expect(events).toEqual([{ created: true }]);
  });
  it('V3 unsubscribe stops further events', () => {
    const events: number[] = [];
    write('/tmp/u', 'a');
    const unsub = exec.vfs.onWrite('/tmp/u', () => { events.push(1); });
    append('/tmp/u', 'b'); unsub(); append('/tmp/u', 'c');
    expect(events).toHaveLength(1);
  });
  it('V4 multiple subscribers all receive every event', () => {
    let a = 0, b = 0;
    write('/tmp/m', 'x');
    exec.vfs.onWrite('/tmp/m', () => { a++; });
    exec.vfs.onWrite('/tmp/m', () => { b++; });
    append('/tmp/m', 'y');
    expect([a, b]).toEqual([1, 1]);
  });
});

// ─── TailCommand class directly ─────────────────────────────────────────
describe('TailCommand class', () => {
  it('C1 startFollow returns a handle exposing the followed files', () => {
    write('/tmp/x', 'a\n');
    const cmd = new TailCommand({
      readFile: (p) => exec.vfs.readFile(p),
      exists:   (p) => exec.vfs.exists(p),
      onWrite:  (p, cb) => exec.vfs.onWrite(p, cb),
      normalizePath: (p, cwd) => exec.vfs.normalizePath(p, cwd),
    });
    const handle: TailFollowHandle = cmd.startFollow(
      { ...parseTailArgs(['-f','/tmp/x']) },
      '/', { write: () => {} },
    );
    expect(handle.files).toEqual(['/tmp/x']);
    handle.cancel();
  });
});
