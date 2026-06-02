/**
 * Cross-shell drive switching and SSH home-directory coherence.
 *
 * Covers three regressions that surfaced together:
 *   1. The simulated FS only seeded the C: drive, so `D:` (or any other
 *      letter) bare drive-switches reported "system cannot find the
 *      drive specified" even though real Windows ships with at least
 *      one secondary volume.
 *   2. PowerShell's `Set-Location D:` delegated to cmd's `cd D:` which
 *      — per cmd.exe semantics — does NOT switch drives, so the shell
 *      silently stayed on C:.
 *   3. Built-in accounts such as `Administrator` had no profile on
 *      disk, so an SSH login landed in `C:\Users\Administrator` and
 *      every subsequent `dir`/`mkdir` failed with "path not found".
 *
 * Together they meant a user could SSH in as `Administrator`, type
 * `D:`, get the wrong error, fall back to PowerShell, type
 * `Set-Location D:`, and still be on C: — with no diagnostic.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { PowerShellExecutor } from '@/network/devices/windows/PowerShellExecutor';
import { MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

// ─── Drive existence ─────────────────────────────────────────────────

describe('Windows secondary drives are seeded with real content', () => {
  it('D: drive root exists as a directory', () => {
    const pc = new WindowsPC('windows-pc', 'PC1', 0, 0);
    expect(pc.getFileSystem().isDirectory('D:\\')).toBe(true);
  });

  it('D: drive carries the standard data folders', () => {
    const pc = new WindowsPC('windows-pc', 'PC1', 0, 0);
    const fs = pc.getFileSystem();
    for (const dir of ['D:\\Data', 'D:\\Backup', 'D:\\Projects', 'D:\\Shared']) {
      expect(fs.isDirectory(dir)).toBe(true);
    }
  });

  it('`vol` reports D: as a real volume from cmd', async () => {
    const pc = new WindowsPC('windows-pc', 'PC1', 0, 0);
    const out = await pc.executeCommand('D:');
    // No error message — empty output means the drive switch succeeded.
    expect(out).not.toMatch(/cannot find the drive/i);
  });
});

// ─── Bare drive-letter switching from cmd ────────────────────────────

describe('cmd: bare drive letter switches drive and remembers cwd', () => {
  it('typing `D:` switches the session to D:\\', async () => {
    const pc = new WindowsPC('windows-pc', 'PC1', 0, 0);
    const session = pc.openShellSession();
    await pc.executeCommandInSession('D:', session);
    const cwd = await pc.executeCommandInSession('cd', session);
    expect(cwd.trim()).toBe('D:\\');
  });

  it('returning to C: restores the previously-visited cwd', async () => {
    const pc = new WindowsPC('windows-pc', 'PC1', 0, 0);
    const session = pc.openShellSession();
    // C: starts at the user profile, hop to D:, dive in, hop back.
    await pc.executeCommandInSession('D:', session);
    await pc.executeCommandInSession('cd \\Projects', session);
    await pc.executeCommandInSession('C:', session);
    expect((await pc.executeCommandInSession('cd', session)).trim())
      .toBe('C:\\Users\\User');
    // Now hop back to D: — it should land in the remembered Projects dir.
    await pc.executeCommandInSession('D:', session);
    expect((await pc.executeCommandInSession('cd', session)).trim())
      .toBe('D:\\Projects');
  });

  it('refuses to switch to a drive that does not exist', async () => {
    const pc = new WindowsPC('windows-pc', 'PC1', 0, 0);
    const session = pc.openShellSession();
    const out = await pc.executeCommandInSession('Z:', session);
    expect(out).toMatch(/cannot find the drive/i);
  });
});

// ─── PowerShell drive switching, and round-tripping with cmd ─────────

describe('PowerShell drive switching mirrors cmd semantics', () => {
  it('Set-Location D: switches drives (was a silent no-op pre-fix)', async () => {
    const pc = new WindowsPC('windows-pc', 'PC1', 0, 0);
    const ps = new PowerShellExecutor(pc as any);
    await ps.execute('Set-Location D:');
    const loc = await ps.execute('Get-Location');
    // Get-Location formats as a Path table — match the path field.
    expect(loc).toMatch(/D:\\?\s*$/m);
  });

  it('PS `cd D:\\Data` lands in D:\\Data, cmd `cd` confirms the same', async () => {
    const pc = new WindowsPC('windows-pc', 'PC1', 0, 0);
    const ps = new PowerShellExecutor(pc as any);
    await ps.execute('cd D:\\Data');
    // Device cwd is shared with cmd — confirm via the cmd surface.
    const cmdOut = await pc.executeCommand('cd');
    expect(cmdOut.trim()).toBe('D:\\Data');
  });

  it('PS → cmd → PS round-trip keeps the active drive in sync', async () => {
    const pc = new WindowsPC('windows-pc', 'PC1', 0, 0);
    const ps = new PowerShellExecutor(pc as any);
    // 1. PS hops to D:.
    await ps.execute('Set-Location D:\\Projects');
    // 2. cmd reports the same cwd (state is device-wide, not shell-local).
    expect((await pc.executeCommand('cd')).trim()).toBe('D:\\Projects');
    // 3. cmd creates a file there.
    await pc.executeCommand('mkdir alpha');
    expect(pc.getFileSystem().isDirectory('D:\\Projects\\alpha')).toBe(true);
    // 4. PS sees it via Get-ChildItem.
    const ls = await ps.execute('Get-ChildItem');
    expect(ls).toMatch(/alpha/);
    // 5. PS hops back to C: by bare drive — restoring C:'s remembered cwd.
    await ps.execute('Set-Location C:');
    expect((await pc.executeCommand('cd')).trim()).toMatch(/^C:\\/);
  });

  it('Set-Location to a non-existent drive surfaces an error', async () => {
    const pc = new WindowsPC('windows-pc', 'PC1', 0, 0);
    const ps = new PowerShellExecutor(pc as any);
    const out = await ps.execute('Set-Location Q:');
    expect(out).toMatch(/cannot find the drive/i);
  });
});

// ─── SSH-as-Administrator home directory ─────────────────────────────

describe('SSH login as Administrator lands in a directory that exists', () => {
  it('Administrator profile is seeded by the filesystem', () => {
    const pc = new WindowsPC('windows-pc', 'PC1', 0, 0);
    const fs = pc.getFileSystem();
    expect(fs.isDirectory('C:\\Users\\Administrator')).toBe(true);
    expect(fs.isDirectory('C:\\Users\\Administrator\\Documents')).toBe(true);
  });

  it('SSH user context for Administrator points at the real profile', async () => {
    const pc = new WindowsPC('windows-pc', 'PC1', 0, 0);
    // The CrossVendorSshHost lazily builds a WindowsSshServerContext;
    // ssh-listener boots that as a side effect of construction. Drive
    // it directly through the context's buildUserContext helper.
    const { WindowsSshServerContext } = await import(
      '@/network/protocols/ssh/server/WindowsSshServerContext');
    const ctx = new WindowsSshServerContext(
      pc.getFileSystem(),
      (pc as any).userMgr,
      pc.hostname,
    );
    const userCtx = ctx.buildUserContext('Administrator');
    expect(userCtx).not.toBeNull();
    expect(userCtx!.homeDirectory).toBe('C:\\Users\\Administrator');
    expect(pc.getFileSystem().isDirectory(userCtx!.homeDirectory)).toBe(true);
  });

  it('home directory is materialised lazily for a freshly-created user', async () => {
    const pc = new WindowsPC('windows-pc', 'PC1', 0, 0);
    // Add a brand-new user — its profile is not seeded at init time.
    // createUser() requires the caller to already be an admin.
    const mgr = (pc as any).userMgr;
    mgr.setCurrentUser('Administrator');
    const r = mgr.createUser('zoe', 'Zoe-Pass-123!', { fullName: 'Zoe Q.' });
    expect(r).toBe('');
    expect(pc.getFileSystem().isDirectory('C:\\Users\\zoe')).toBe(false);
    const { WindowsSshServerContext } = await import(
      '@/network/protocols/ssh/server/WindowsSshServerContext');
    const ctx = new WindowsSshServerContext(
      pc.getFileSystem(), mgr, pc.hostname,
    );
    const userCtx = ctx.buildUserContext('zoe');
    expect(userCtx!.homeDirectory).toBe('C:\\Users\\zoe');
    expect(pc.getFileSystem().isDirectory('C:\\Users\\zoe')).toBe(true);
  });
});

// ─── Linux sanity check — `cd` semantics are unchanged ───────────────

describe('LinuxPC cd / pwd remain coherent after the Windows fixes', () => {
  it('`pwd` after `cd /tmp` returns /tmp', async () => {
    const pc = new LinuxPC('linux-pc', 'lpc1', 0, 0);
    const session = pc.openShellSession();
    await pc.executeCommandInSession('cd /tmp', session);
    const out = await pc.executeCommandInSession('pwd', session);
    expect(out.trim()).toBe('/tmp');
  });

  it('two independent sessions track their own cwd', async () => {
    const pc = new LinuxPC('linux-pc', 'lpc1', 0, 0);
    const a = pc.openShellSession();
    const b = pc.openShellSession();
    await pc.executeCommandInSession('cd /etc', a);
    await pc.executeCommandInSession('cd /var', b);
    expect((await pc.executeCommandInSession('pwd', a)).trim()).toBe('/etc');
    expect((await pc.executeCommandInSession('pwd', b)).trim()).toBe('/var');
  });
});
