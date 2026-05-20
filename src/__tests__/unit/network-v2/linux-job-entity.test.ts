/**
 * Unit tests — the rich LinuxJob entity (separate from job-control
 * builtins). Exercises the behaviour the table doesn't see: state
 * transitions, foreground/background flip, nohup/disown semantics,
 * completion bookkeeping, snapshot.
 */

import { describe, it, expect } from 'vitest';
import { LinuxJob } from '@/network/devices/linux/jobs/LinuxJob';

describe('LinuxJob entity', () => {
  const make = () => new LinuxJob({ id: 1, pid: 42, command: 'sleep 60 &' });

  it('defaults are sane', () => {
    const j = make();
    expect(j.state).toBe('Running');
    expect(j.mode).toBe('background');
    expect(j.pgid).toBe(42);
    expect(j.controllingTty).toBe('pts/0');
    expect(j.nohup).toBe(false);
    expect(j.disowned).toBe(false);
    expect(j.isRunning()).toBe(true);
    expect(j.isFinished()).toBe(false);
  });

  it('suspend / resume flip state and capture the signal', () => {
    const j = make();
    j.suspend('SIGTSTP');
    expect(j.state).toBe('Stopped');
    expect(j.signal).toBe('SIGTSTP');
    expect(j.isStopped()).toBe(true);
    j.resume();
    expect(j.state).toBe('Continued');
    expect(j.signal).toBeUndefined();
  });

  it('toForeground / toBackground flip mode without touching state', () => {
    const j = make();
    j.toForeground();
    expect(j.mode).toBe('foreground');
    expect(j.state).toBe('Running');
    j.toBackground();
    expect(j.mode).toBe('background');
  });

  it('complete with exitCode=0 → Done', () => {
    const j = make();
    j.complete({ exitCode: 0 });
    expect(j.state).toBe('Done');
    expect(j.exitCode).toBe(0);
    expect(j.endTime).toBeInstanceOf(Date);
    expect(j.isFinished()).toBe(true);
  });

  it('complete with non-zero exitCode → Exit, with signal → Killed', () => {
    const a = make(); a.complete({ exitCode: 2 });
    expect(a.state).toBe('Exit');
    expect(a.exitCode).toBe(2);
    const b = make(); b.complete({ signal: 'SIGTERM' });
    expect(b.state).toBe('Killed');
    expect(b.signal).toBe('SIGTERM');
  });

  it('disown sets the detach flags; -h keeps nohup on', () => {
    const j = make();
    j.disown(true);
    expect(j.disowned).toBe(true);
    expect(j.nohup).toBe(true);
  });

  it('snapshot returns enumerable fields only — no methods', () => {
    const j = make();
    const snap = j.snapshot();
    expect(snap.id).toBe(1);
    expect(snap.pid).toBe(42);
    expect(typeof (snap as { isRunning?: unknown }).isRunning).toBe('undefined');
  });

  it('describe formats like `jobs` output', () => {
    expect(make().describe()).toBe('[1] Running               sleep 60 &');
  });
});
