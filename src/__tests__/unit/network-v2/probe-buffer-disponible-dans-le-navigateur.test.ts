/**
 * The browser entry installs a global `Buffer` before any simulator module runs.
 *
 * Measured before the fix, in Chromium: `sort` printed `sort: error` for every
 * input, and `tr`, `cut`, `cat -v` failed the same way, because the coreutils
 * ports call `Buffer.from` and the browser has no `Buffer` (the `buffer` package
 * was a dependency but nothing installed it). The executor swallows the
 * ReferenceError into `<command>: error`, so no unit test run under Node saw it.
 *
 * Discriminated by removing `src/bufferBoot.ts` (git stash push -u): the
 * first case fails to import the module. The second is the WITNESS: with the
 * global deleted, `sort` really fails in this lab, so the lab reproduces the
 * browser.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';

const original = (globalThis as { Buffer?: unknown }).Buffer;

afterEach(() => {
  (globalThis as { Buffer?: unknown }).Buffer = original;
  vi.resetModules();
});

describe('a browser without Buffer', () => {
  it('WITNESS: sort fails when the global is missing', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    pc.powerOn();
    await pc.executeCommand("printf 'b\\na\\n' > /tmp/f.txt");
    delete (globalThis as { Buffer?: unknown }).Buffer;
    expect(await pc.executeCommand('sort /tmp/f.txt')).toBe('sort: error');
  });

  it('bufferBoot installs it and sort works again', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    pc.powerOn();
    await pc.executeCommand("printf 'b\\na\\n' > /tmp/f.txt");
    delete (globalThis as { Buffer?: unknown }).Buffer;
    await import('@/bufferBoot');
    expect(typeof (globalThis as { Buffer?: unknown }).Buffer).toBe('function');
    expect(await pc.executeCommand('sort /tmp/f.txt')).toBe('a\nb');
  });
});
