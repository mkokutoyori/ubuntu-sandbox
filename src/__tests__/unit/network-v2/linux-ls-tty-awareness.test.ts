/**
 * `ls` must behave like real coreutils: multi-column layout only when
 * stdout is an actual terminal. Piping (`ls | cat`) or redirecting
 * (`ls > file`) makes it fall back to one entry per line, exactly as
 * `-1` already does explicitly.
 *
 * Audit rapport 05, constat MAJEUR F1: `cmdLs` had no isatty notion at
 * all — multi-column layout applied unconditionally whenever `-1` wasn't
 * passed, regardless of pipe/redirect context.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

let pc: LinuxPC;

beforeEach(async () => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
  pc = new LinuxPC('linux-pc', 'Desktop1');
  await pc.executeCommand('mkdir /tmp/lstest');
  await pc.executeCommand('cd /tmp/lstest');
  for (let i = 0; i < 12; i++) await pc.executeCommand(`touch f${i}`);
});

describe('ls at an actual terminal (no pipe/redirect)', () => {
  it('wraps short names into a multi-column layout', async () => {
    const out = await pc.executeCommand('ls');
    const lines = out.split('\n').filter(l => l.length > 0);
    // 12 short names comfortably fit within one 80-column row.
    expect(lines.length).toBeLessThan(12);
    expect(out).toContain('f0');
    expect(out).toContain('f11');
  });
});

describe('ls | <pipe> — non-tty stdout forces one entry per line', () => {
  it('ls | cat prints one filename per line', async () => {
    const out = await pc.executeCommand('ls | cat');
    const lines = out.split('\n').filter(l => l.length > 0);
    expect(lines.length).toBe(12);
    expect(lines).toContain('f0');
    expect(lines).toContain('f11');
  });

  it('ls | wc -l counts exactly one line per entry', async () => {
    const out = await pc.executeCommand('ls | wc -l');
    expect(out.trim()).toBe('12');
  });

  it('ls as the first of three pipeline stages is still one-per-line', async () => {
    const out = await pc.executeCommand('ls | grep f1 | wc -l');
    // f1, f10, f11 all match the substring "f1".
    expect(out.trim()).toBe('3');
  });
});

describe('ls > file / ls >> file — redirected stdout forces one entry per line', () => {
  it('ls > out.txt writes one filename per line', async () => {
    await pc.executeCommand('ls > out.txt');
    const out = await pc.executeCommand('cat out.txt');
    const lines = out.split('\n').filter(l => l.length > 0);
    expect(lines.length).toBe(12);
  });

  it('a plain terminal ls right after is still multi-column (no lingering state)', async () => {
    await pc.executeCommand('ls > out.txt');
    const out = await pc.executeCommand('ls');
    const lines = out.split('\n').filter(l => l.length > 0);
    expect(lines.length).toBeLessThan(12);
  });

  it('ls 2> err.txt (stderr-only redirect) stays multi-column — stdout is still the terminal', async () => {
    const out = await pc.executeCommand('ls 2> err.txt');
    const lines = out.split('\n').filter(l => l.length > 0);
    expect(lines.length).toBeLessThan(12);
  });
});

describe('-1 still forces one-per-line explicitly, pipe or not', () => {
  it('ls -1 at a real terminal is one entry per line', async () => {
    const out = await pc.executeCommand('ls -1');
    const lines = out.split('\n').filter(l => l.length > 0);
    expect(lines.length).toBe(12);
  });
});
