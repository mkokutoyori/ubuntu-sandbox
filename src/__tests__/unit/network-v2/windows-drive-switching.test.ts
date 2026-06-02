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

// ─── Volume listings are FS-derived (single source of truth) ────────

describe('Get-Volume / Get-PSDrive / wmic logicaldisk derive from the FS', () => {
  it('Get-Volume lists exactly the FS-mounted drives, sorted', async () => {
    const pc = new WindowsPC('windows-pc', 'PC1', 0, 0);
    const ps = new PowerShellExecutor(pc as any);
    const out = await ps.execute('Get-Volume');
    // Both drives the FS seeds at init must appear.
    expect(out).toMatch(/^C\s/m);
    expect(out).toMatch(/^D\s/m);
  });

  it('seeding a new drive via mkdirp makes it visible in Get-Volume', async () => {
    const pc = new WindowsPC('windows-pc', 'PC1', 0, 0);
    pc.getFileSystem().mkdirp('E:\\Media');
    const ps = new PowerShellExecutor(pc as any);
    const out = await ps.execute('Get-Volume');
    expect(out).toMatch(/^E\s/m);
    // No phantom drive that the FS never created.
    expect(out).not.toMatch(/^Q\s/m);
  });

  it('Get-PSDrive FileSystem rows match Get-Volume rows', async () => {
    const pc = new WindowsPC('windows-pc', 'PC1', 0, 0);
    pc.getFileSystem().mkdirp('E:\\');
    const ps = new PowerShellExecutor(pc as any);
    const psd = await ps.execute('Get-PSDrive');
    const vol = await ps.execute('Get-Volume');
    for (const letter of ['C', 'D', 'E']) {
      // Volume table — letter as the first padded field on its own row.
      expect(vol).toMatch(new RegExp(`^${letter}\\s`, 'm'));
      // PSDrive — letter followed by the FileSystem provider + root.
      expect(psd).toMatch(new RegExp(`^${letter}\\b.*FileSystem\\s+${letter}:\\\\`, 'm'));
    }
  });

  it('wmic logicaldisk get name lists every mounted drive', async () => {
    const pc = new WindowsPC('windows-pc', 'PC1', 0, 0);
    pc.getFileSystem().mkdirp('Z:\\Archive');
    const out = await pc.executeCommand('wmic logicaldisk get name');
    for (const letter of ['C:', 'D:', 'Z:']) {
      expect(out).toContain(letter);
    }
  });

  it('listDrives() is the single source of truth (sorted A→Z)', () => {
    const pc = new WindowsPC('windows-pc', 'PC1', 0, 0);
    pc.getFileSystem().mkdirp('F:\\one');
    pc.getFileSystem().mkdirp('B:\\two');
    expect(pc.getFileSystem().listDrives()).toEqual(['B:', 'C:', 'D:', 'F:']);
  });
});

// ─── Storage figures are real (capacity − used = free) ─────────────

describe('Storage stats are FS-derived, not frozen constants', () => {
  it('getFreeDiskSpace shrinks as files are added', () => {
    const pc = new WindowsPC('windows-pc', 'PC1', 0, 0);
    const fs = pc.getFileSystem();
    const before = fs.getFreeDiskSpace('C');
    fs.createFile('C:\\big.bin', 'x'.repeat(10_000_000));
    const after = fs.getFreeDiskSpace('C');
    expect(before - after).toBe(10_000_000);
  });

  it('capacity − used = free for each drive', () => {
    const pc = new WindowsPC('windows-pc', 'PC1', 0, 0);
    const fs = pc.getFileSystem();
    fs.createFile('C:\\a.dat', 'x'.repeat(1_234_567));
    fs.createFile('D:\\b.dat', 'x'.repeat(7_654_321));
    for (const letter of ['C', 'D']) {
      expect(fs.getDriveCapacity(letter) - fs.getUsedSpace(letter))
        .toBe(fs.getFreeDiskSpace(letter));
    }
  });

  it('drives have differentiated capacities (C: 100 GB, D: 50 GB)', () => {
    const pc = new WindowsPC('windows-pc', 'PC1', 0, 0);
    const fs = pc.getFileSystem();
    expect(fs.getDriveCapacity('C')).toBe(107_374_182_400);
    expect(fs.getDriveCapacity('D')).toBe(53_687_091_200);
  });

  it('setDriveCapacity overrides the default', () => {
    const pc = new WindowsPC('windows-pc', 'PC1', 0, 0);
    const fs = pc.getFileSystem();
    fs.setDriveCapacity('D', 10_000_000_000);
    expect(fs.getDriveCapacity('D')).toBe(10_000_000_000);
    expect(fs.getFreeDiskSpace('D')).toBeLessThanOrEqual(10_000_000_000);
  });

  it('an unknown drive reports 0 used / 0 free, never the C: number', () => {
    const pc = new WindowsPC('windows-pc', 'PC1', 0, 0);
    expect(pc.getFileSystem().getUsedSpace('Q')).toBe(0);
    expect(pc.getFileSystem().getFreeDiskSpace('Q')).toBe(0);
  });

  it('dir D:\\ shows D:’s serial number, not C:’s', async () => {
    const pc = new WindowsPC('windows-pc', 'PC1', 0, 0);
    const fs = pc.getFileSystem();
    const dSerial = fs.getVolumeSerialNumber('D');
    const cSerial = fs.getVolumeSerialNumber('C');
    expect(dSerial).not.toBe(cSerial);
    const out = await pc.executeCommand('dir D:\\');
    expect(out).toContain(dSerial);
    expect(out).not.toContain(cSerial);
  });

  it('dir D:\\ shows D:’s free-byte count, not C:’s', async () => {
    const pc = new WindowsPC('windows-pc', 'PC1', 0, 0);
    const fs = pc.getFileSystem();
    // Make the drives' free-byte counts differ — different default
    // capacities AND a sizeable file on C: guarantee distinct numbers.
    fs.createFile('C:\\bulk.bin', 'x'.repeat(20_000_000));
    const out = await pc.executeCommand('dir D:\\');
    expect(out).toContain(fs.getFreeDiskSpace('D').toLocaleString('en-US'));
    expect(out).not.toContain(fs.getFreeDiskSpace('C').toLocaleString('en-US'));
  });

  it('Get-Volume Size + SizeRemaining reflect real FS state', async () => {
    const pc = new WindowsPC('windows-pc', 'PC1', 0, 0);
    pc.getFileSystem().setDriveCapacity('C', 200_000_000_000);
    const ps = new PowerShellExecutor(pc as any);
    const out = await ps.execute('Get-Volume -DriveLetter C');
    // 200 GB capacity → "186.26 GB" in the GiB display we use.
    expect(out).toMatch(/186\.\d{2} GB/);
  });

  it('Get-PSDrive Used/Free columns track FS usage', async () => {
    const pc = new WindowsPC('windows-pc', 'PC1', 0, 0);
    const fs = pc.getFileSystem();
    // Stamp the size directly to fake a 5 GB file without allocating the
    // bytes — keeps the test fast and side-steps V8's string ceiling.
    fs.createFile('C:\\hog.bin', '');
    const entry = (fs as any).resolve('C:\\hog.bin');
    entry.size = 5_368_709_120; // 5 GB
    const ps = new PowerShellExecutor(pc as any);
    const out = await ps.execute('Get-PSDrive');
    const cLine = out.split('\n').find(l => /^C\s/.test(l)) ?? '';
    // 5 GB hog dominates the system seeds — Used reads "5.xx".
    expect(cLine).toMatch(/\b5\.\d{2}\b/);
    // Free has shrunk from the ~100 GB capacity.
    expect(cLine).toMatch(/\b9[4-5]\.\d{2}\b/);
  });

  it('Get-Disk emits one row per FS-mounted drive', async () => {
    const pc = new WindowsPC('windows-pc', 'PC1', 0, 0);
    pc.getFileSystem().mkdirp('E:\\');
    const ps = new PowerShellExecutor(pc as any);
    const out = await ps.execute('Get-Disk');
    // Number column shows 0/1/2 for the three drives.
    const rows = out.split('\n').filter(l => /^\d\s+Virtual|^\d\s+Microsoft/.test(l));
    expect(rows.length).toBe(3);
  });

  it('Get-Disk for C: is the boot/system disk', async () => {
    const pc = new WindowsPC('windows-pc', 'PC1', 0, 0);
    const ps = new PowerShellExecutor(pc as any);
    const out = await ps.execute('Get-Disk -Number 0');
    expect(out).toMatch(/IsBoot\s+:\s+true/);
    expect(out).toMatch(/IsSystem\s+:\s+true/);
  });
});

// ─── su over SSH (regression lock) ────────────────────────────────────

describe('su over SSH prompts for password and switches user', () => {
  it('end-to-end: ssh user@host, then su admin → root', async () => {
    const { LinuxPC: LPC } = await import('@/network/devices/LinuxPC');
    const { GenericSwitch } = await import('@/network/devices/GenericSwitch');
    const { Cable } = await import('@/network/hardware/Cable');
    const { LinuxTerminalSession } = await import('@/terminal/sessions/LinuxTerminalSession');
    const { EquipmentRegistry } = await import('@/network/equipment/EquipmentRegistry');

    EquipmentRegistry.resetInstance();
    const a = new LPC('linux-pc', 'PC1', 0, 0);
    const b = new LPC('linux-pc', 'PC2', 100, 0);
    const sw = new GenericSwitch('switch-generic', 'SW1', 8, 50, 50);
    new Cable('c1').connect(a.getPort('eth0')!, sw.getPort('eth0')!);
    new Cable('c2').connect(b.getPort('eth0')!, sw.getPort('eth1')!);
    await a.executeCommand('ifconfig eth0 10.0.0.1 netmask 255.255.255.0');
    await b.executeCommand('ifconfig eth0 10.0.0.2 netmask 255.255.255.0');
    await a.executeCommand('ping -c 1 10.0.0.2');

    const term = new LinuxTerminalSession('t1', a);
    const k = (key: string) => ({ key, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false });
    const flush = async (n = 8) => { for (let i = 0; i < n; i++) { await Promise.resolve(); await new Promise(r => setTimeout(r, 0)); } };
    const waitFor = async (p: () => boolean, t = 2000) => {
      const start = Date.now();
      while (!p()) { if (Date.now() - start > t) throw new Error('timeout'); await new Promise(r => setTimeout(r, 5)); }
    };

    term.setInput('ssh user@10.0.0.2'); term.handleKey(k('Enter')); await flush();
    await waitFor(() => term.currentInputMode.type === 'password');
    term.setPasswordBuf('admin'); term.handleKey(k('Enter')); await flush();
    await waitFor(() => term.isInsideSshSession);

    // `su` must immediately enter password mode — the prompt is rendered
    // on the input row (broker path) so the regression check looks at
    // currentInputMode, not at scrollback.
    term.setInput('su'); term.handleKey(k('Enter')); await flush();
    await waitFor(() => term.currentInputMode.type === 'password');
    expect(term.currentInputMode.type).toBe('password');

    term.setPasswordBuf('admin'); term.handleKey(k('Enter')); await flush();
    await waitFor(() => term.currentInputMode.type === 'normal');

    term.setInput('whoami'); term.handleKey(k('Enter')); await flush(20);
    const last = term.lines.slice(-6).map(l => l.text);
    expect(last.some(l => /root/.test(l))).toBe(true);
  });

  it('end-to-end: wrong su password is rejected', async () => {
    const { LinuxPC: LPC } = await import('@/network/devices/LinuxPC');
    const { GenericSwitch } = await import('@/network/devices/GenericSwitch');
    const { Cable } = await import('@/network/hardware/Cable');
    const { LinuxTerminalSession } = await import('@/terminal/sessions/LinuxTerminalSession');
    const { EquipmentRegistry } = await import('@/network/equipment/EquipmentRegistry');

    EquipmentRegistry.resetInstance();
    const a = new LPC('linux-pc', 'PC1', 0, 0);
    const b = new LPC('linux-pc', 'PC2', 100, 0);
    const sw = new GenericSwitch('switch-generic', 'SW1', 8, 50, 50);
    new Cable('c1').connect(a.getPort('eth0')!, sw.getPort('eth0')!);
    new Cable('c2').connect(b.getPort('eth0')!, sw.getPort('eth1')!);
    await a.executeCommand('ifconfig eth0 10.0.0.1 netmask 255.255.255.0');
    await b.executeCommand('ifconfig eth0 10.0.0.2 netmask 255.255.255.0');
    await a.executeCommand('ping -c 1 10.0.0.2');

    const term = new LinuxTerminalSession('t1', a);
    const k = (key: string) => ({ key, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false });
    const flush = async (n = 8) => { for (let i = 0; i < n; i++) { await Promise.resolve(); await new Promise(r => setTimeout(r, 0)); } };
    const waitFor = async (p: () => boolean, t = 2000) => {
      const start = Date.now();
      while (!p()) { if (Date.now() - start > t) throw new Error('timeout'); await new Promise(r => setTimeout(r, 5)); }
    };

    term.setInput('ssh user@10.0.0.2'); term.handleKey(k('Enter')); await flush();
    await waitFor(() => term.currentInputMode.type === 'password');
    term.setPasswordBuf('admin'); term.handleKey(k('Enter')); await flush();
    await waitFor(() => term.isInsideSshSession);

    term.setInput('su'); term.handleKey(k('Enter')); await flush();
    await waitFor(() => term.currentInputMode.type === 'password');
    // Feed wrong password — the validation step re-prompts up to
    // MAX_SU_ATTEMPTS (3) times before giving up.
    for (let i = 0; i < 4; i++) {
      if (term.currentInputMode.type !== 'password') break;
      term.setPasswordBuf('definitely-wrong'); term.handleKey(k('Enter')); await flush();
    }
    await waitFor(() => term.currentInputMode.type === 'normal', 3000);

    term.setInput('whoami'); term.handleKey(k('Enter')); await flush(20);
    // Identity unchanged — still the SSH'd `user`, not root.
    const last = term.lines.slice(-6).map(l => l.text);
    expect(last.some(l => /^user$/.test(l))).toBe(true);
    expect(last.some(l => /^root$/.test(l))).toBe(false);
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
