/**
 * terminal_gap.md §6.3 — per-drive current directory on Windows.
 *
 * Real cmd.exe remembers, per drive letter, the last working directory
 * visited on that drive. Typing `D:` after `cd D:\work` switches to
 * `D:\work`, not `D:\`. Switching back to `C:` returns to the previous
 * `C:\` cwd. The simulator now tracks this via WindowsShellSession.driveCwd.
 *
 * Bare `D:` at the prompt is *not* an external command — cmd.exe handles
 * it before the program-search step. The simulator's executeCmdCommand
 * intercepts it and routes through switchActiveDrive(), which also
 * preserves the previous drive's cwd in the session's driveCwd map.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { EventBus, __setDefaultEventBus } from '@/events/EventBus';

describe('Windows per-drive cwd (driveCwd)', () => {
  let bus: EventBus;
  let pc: WindowsPC;

  beforeEach(() => {
    EquipmentRegistry.resetInstance();
    bus = new EventBus();
    __setDefaultEventBus(bus);
    EquipmentRegistry.getInstance().setEventBus(bus);
    pc = new WindowsPC('PC1', 0, 0);
    pc.setEventBus(bus);
    // Provision a second drive on the simulated FS so `D:` is a valid
    // root. Without this `D:` would return "system cannot find the drive".
    const fs = pc.getFileSystem();
    fs.mkdirp('D:\\');
    fs.mkdirp('D:\\work');
    fs.mkdirp('D:\\work\\src');
  });

  it('typing `D:` switches to drive D and remembers the previous C: cwd', async () => {
    const shell = pc.openShellSession();

    // Move on C: first so the previous-cwd is non-default.
    await pc.executeCommandInSession('cd C:\\Windows', shell);
    expect(shell.cwd).toBe('C:\\Windows');

    // Switch to drive D.
    const out = await pc.executeCommandInSession('D:', shell);
    expect(out).toBe('');
    expect(shell.cwd).toMatch(/^D:/);
    // The session's driveCwd map has remembered the C: cwd.
    expect(shell.driveCwd.get('C')).toBe('C:\\Windows');
  });

  it('typing `D:` again returns to D\'s last-visited cwd', async () => {
    const shell = pc.openShellSession();

    // Visit a sub-directory on D:.
    await pc.executeCommandInSession('D:', shell);
    await pc.executeCommandInSession('cd D:\\work', shell);
    expect(shell.cwd).toBe('D:\\work');
    expect(shell.driveCwd.get('D')).toBe('D:\\work');

    // Bounce back to C: then back to D: — must restore D:\work, not D:\.
    await pc.executeCommandInSession('C:', shell);
    expect(shell.cwd).toMatch(/^C:/);

    await pc.executeCommandInSession('D:', shell);
    expect(shell.cwd).toBe('D:\\work');
  });

  it('`D:\\path` switches drive AND chdir in one step', async () => {
    const shell = pc.openShellSession();
    const out = await pc.executeCommandInSession('D:\\work\\src', shell);
    expect(out).toBe('');
    expect(shell.cwd).toBe('D:\\work\\src');
    expect(shell.driveCwd.get('D')).toBe('D:\\work\\src');
  });

  it('`D:\\nonexistent` fails with cmd.exe-style error', async () => {
    const shell = pc.openShellSession();
    const before = shell.cwd;
    const out = await pc.executeCommandInSession('D:\\nope', shell);
    expect(out).toMatch(/cannot find the path/i);
    expect(shell.cwd).toBe(before);
  });

  it('switching to a missing drive returns "cannot find the drive"', async () => {
    const shell = pc.openShellSession();
    const before = shell.cwd;
    const out = await pc.executeCommandInSession('Z:', shell);
    expect(out).toMatch(/cannot find the drive/i);
    expect(shell.cwd).toBe(before);
  });

  it('per-drive cwd is local to each session', async () => {
    const a = pc.openShellSession();
    const b = pc.openShellSession();

    await pc.executeCommandInSession('D:', a);
    await pc.executeCommandInSession('cd D:\\work', a);

    // Terminal B has never touched D: — its map must not learn from A.
    expect(b.driveCwd.has('D')).toBe(false);
    expect(b.cwd).toBe('C:\\Users\\User');
  });

  it('`cd /d D:\\work` also updates driveCwd', async () => {
    const shell = pc.openShellSession();
    await pc.executeCommandInSession('cd /d D:\\work', shell);
    expect(shell.cwd).toBe('D:\\work');
    expect(shell.driveCwd.get('D')).toBe('D:\\work');
    // And the previous drive's cwd is remembered too.
    expect(shell.driveCwd.get('C')).toBe('C:\\Users\\User');
  });

  it('bare `c:` (lowercase) is treated equivalently', async () => {
    const shell = pc.openShellSession();
    await pc.executeCommandInSession('D:', shell);
    expect(shell.cwd).toMatch(/^D:/);

    // Mixed-case bare drive should still hand off to switchActiveDrive.
    const out = await pc.executeCommandInSession('c:', shell);
    expect(out).toBe('');
    expect(shell.cwd).toMatch(/^C:/);
  });
});
