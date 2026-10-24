/*
 * Probe - the journal's disk budget, rotation, vacuum, retention and rate limit are real on a simulated host, and the same files are
 * what ls, df and journalctl show.  The byte model itself is pinned against the real daemon by journald-space-oracle.test.ts; here
 * the properties are the ones a learner sees: a rotation grows what df counts by the allocation of the new file, SystemMaxFileSize=
 * and SystemMaxFiles= in a drop-in decide how many files of what size stay on disk, MaxRetentionSec= deletes an archived file when
 * the simulated clock passes it (the timer of journald.c), SyncIntervalSec= turns the active file OFFLINE only after its interval
 * (an event of priority crit or worse syncs at once), SplitMode= decides which user gets a file of their own, and LogRateLimitBurst= in
 * a unit file limits what that unit writes.
 * Measured before the port (git stash push -- src/network): 7 of the 11 cases fall - nothing rotated by size, vacuumed or expired, no user
 * journal files, journald never synced and the unit directives were not read.  The 4 that pass either way are WITNESSES: a default host
 * holds one 8 MiB file, a rotation already added an 8 MiB file (non-regression of what df counts), SplitMode=none keeps one file, and
 * without MaxRetentionSec the archived file survives the same clock advance.
 */
import { describe, it, expect } from 'vitest';
import { LinuxCommandExecutor } from '@/network/devices/linux/LinuxCommandExecutor';
import { LinuxServer } from '@/network/devices/LinuxServer';

interface Lab {
  server: LinuxServer;
  exec: LinuxCommandExecutor;
}

function lab(): Lab {
  const server = new LinuxServer('linux-server', 'journald-space');
  return { server, exec: (server as unknown as { executor: LinuxCommandExecutor }).executor };
}

async function configure(lab: Lab, body: string): Promise<void> {
  lab.exec.execute('mkdir -p /etc/systemd/journald.conf.d');
  lab.exec.vfs.writeFile('/etc/systemd/journald.conf.d/zz-probe.conf', `[Journal]\n${body}\n`, 0, 0, 0o022);
  await lab.server.executeCommand('systemctl restart systemd-journald');
  lab.exec.execute('journalctl --rotate');
}

function journalFiles(exec: LinuxCommandExecutor): Array<{ name: string; size: number }> {
  const directory = exec.logMgr.journald.directory;
  return (exec.vfs.listDirectory(directory) ?? [])
    .filter((entry) => entry.name.endsWith('.journal'))
    .map((entry) => ({ name: entry.name, size: exec.vfs.lstat(`${directory}/${entry.name}`)?.size ?? 0 }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function flood(exec: LinuxCommandExecutor, count: number): void {
  const journald = exec.logMgr.journald;
  const shared = Array.from({ length: 100 }, (_, k) => `F${String(k).padStart(3, '0')}=shared value number ${k}\n`).join('');
  for (let i = 0; i < count; i++) journald.deliverNative(Uint8Array.from(Buffer.from(`MESSAGE=fat entry ${i}\nPRIORITY=6\n${shared}`)), null);
}

describe('the journal files on a host', () => {
  it('witness: a default host holds one allocated 8 MiB file', () => {
    const { exec } = lab();
    expect(journalFiles(exec).map((file) => file.size)).toEqual([8 * 1024 * 1024]);
  });

  it('a rotation adds an allocated file to what ls, du and df count', () => {
    const { exec } = lab();
    const used = exec.vfs.usedBytes();
    exec.execute('journalctl --rotate');
    expect(journalFiles(exec).map((file) => file.size)).toEqual([8 * 1024 * 1024, 8 * 1024 * 1024]);
    const grown = exec.vfs.usedBytes() - used;
    expect(grown).toBeGreaterThanOrEqual(8 * 1024 * 1024);
    expect(grown).toBeLessThan(8 * 1024 * 1024 + 64 * 1024);
    expect(exec.execute('journalctl --disk-usage')).toContain('16.0M');
  });

  it('SystemMaxFileSize= and SystemMaxFiles= decide how many files of what size stay on disk', async () => {
    const l = lab();
    const { exec } = l;
    await configure(l, 'SystemMaxFileSize=1M\nSystemMaxUse=100M\nSystemKeepFree=0\nSystemMaxFiles=2');
    flood(exec, 2000);
    const files = journalFiles(exec);
    expect(files).toHaveLength(2);
    expect(files.every((file) => file.size === 1024 * 1024)).toBe(true);
    expect(exec.execute('journalctl --disk-usage')).toContain('2.0M');
  });

  it('SystemMaxUse= vacuums the oldest archived files to fit under it', async () => {
    const l = lab();
    const { exec } = l;
    await configure(l, 'SystemMaxFileSize=1M\nSystemMaxUse=2500K\nSystemKeepFree=0');
    flood(exec, 2500);
    const total = journalFiles(exec).reduce((sum, file) => sum + file.size, 0);
    expect(total).toBeLessThanOrEqual(2500 * 1024);
    expect(total).toBeGreaterThan(0);
  });
});

describe('SplitMode=', () => {
  it('a message from a login user goes to that user\'s journal file, root and system accounts stay in system.journal', () => {
    const { exec } = lab();
    exec.execute('useradd -m -u 1000 alice');
    exec.execute("su alice -c 'logger -t split fromalice'");
    exec.execute('logger -t split fromroot');
    const names = journalFiles(exec).map((file) => file.name);
    expect(names).toContain('user-1000.journal');
    expect(names).toContain('system.journal');
    expect(exec.execute('journalctl --no-pager -t split')).toContain('fromalice');
    expect(exec.execute('journalctl --no-pager -t split')).toContain('fromroot');
  });

  it('SplitMode=none keeps everything in system.journal', async () => {
    const l = lab();
    await configure(l, 'SplitMode=none');
    l.exec.execute('useradd -m -u 1000 alice');
    l.exec.execute("su alice -c 'logger -t split fromalice'");
    expect(journalFiles(l.exec).map((file) => file.name)).not.toContain('user-1000.journal');
    expect(l.exec.execute('journalctl --no-pager -t split')).toContain('fromalice');
  });
});

describe('Compress=', () => {
  const flags = (exec: LinuxCommandExecutor): string => [...exec.execute('journalctl --header').matchAll(/Incompatible flags: (.*)/g)].pop()?.[1] ?? '';

  it('a file created under Compress=no does not carry the compression flag', async () => {
    const l = lab();
    expect(flags(l.exec)).toContain('COMPRESSED-ZSTD');
    await configure(l, 'Compress=no');
    expect(flags(l.exec)).toBe('KEYED-HASH COMPACT');
  });

  it('big compressible payloads fill files more slowly when they are compressed', async () => {
    const rotations = async (compress: string): Promise<number> => {
      const l = lab();
      await configure(l, `SystemMaxFileSize=512K\nSystemMaxUse=100M\nSystemKeepFree=0\nCompress=${compress}`);
      const journald = l.exec.logMgr.journald;
      for (let i = 0; i < 400; i++) journald.deliverNative(Uint8Array.from(Buffer.from(`MESSAGE=${`line ${i} `.repeat(150)}\nPRIORITY=6\n`)), null);
      return journald.fileInfos().filter((info) => info.state === 'ARCHIVED').length;
    };
    expect(await rotations('yes')).toBeLessThan(await rotations('no'));
  });
});

describe('time on the simulated clock', () => {
  it('MaxRetentionSec= deletes an archived file once the clock has passed it', async () => {
    const l = lab();
    const { server, exec } = l;
    await configure(l, 'MaxRetentionSec=5min');
    exec.execute('logger -t probe before');
    exec.execute('journalctl --rotate');
    const archived = (): number => journalFiles(exec).filter((file) => file.name.startsWith('system@')).length;
    expect(archived()).toBe(2);
    server.advanceTime(10 * 60 * 1000);
    expect(archived()).toBe(0);
    expect(exec.execute('journalctl --no-pager -t probe')).not.toContain('before');
  });

  it('witness: without MaxRetentionSec the archived file survives the same clock advance', () => {
    const { server, exec } = lab();
    exec.execute('logger -t probe before');
    exec.execute('journalctl --rotate');
    server.advanceTime(10 * 60 * 1000);
    expect(journalFiles(exec).filter((file) => file.name.startsWith('system@'))).toHaveLength(1);
    expect(exec.execute('journalctl --no-pager -t probe')).toContain('before');
  });

  it('SyncIntervalSec= turns the active file OFFLINE only after its interval', async () => {
    const l = lab();
    const { server, exec } = l;
    await configure(l, 'SyncIntervalSec=60s');
    exec.execute('logger -t probe dirty');
    const state = (): string => [...exec.execute('journalctl --header').matchAll(/State: (\w+)/g)].pop()?.[1] ?? '';
    expect(state()).toBe('ONLINE');
    server.advanceTime(30_000);
    expect(state()).toBe('ONLINE');
    server.advanceTime(40_000);
    expect(state()).toBe('OFFLINE');
  });

  it('an event of priority crit syncs the file at once', async () => {
    const l = lab();
    const { exec } = l;
    await configure(l, 'SyncIntervalSec=3600s');
    const state = (): string => [...exec.execute('journalctl --header').matchAll(/State: (\w+)/g)].pop()?.[1] ?? '';
    exec.execute('logger -t probe -p user.info calm');
    expect(state()).toBe('ONLINE');
    exec.execute('logger -t probe -p user.crit loud');
    expect(state()).toBe('OFFLINE');
  });
});

describe('rate limit of a unit', () => {
  it('LogRateLimitBurst= in the unit file limits what the unit writes (modulated by the space left, burst 1 on 4 GiB lets 3 through), and the next interval reports it', () => {
    const { server, exec } = lab();
    exec.vfs.writeFile('/etc/systemd/system/noisy.service', '[Unit]\nDescription=Noisy\n[Service]\nExecStart=/bin/sleep infinity\nLogRateLimitIntervalSec=10s\nLogRateLimitBurst=1\n', 0, 0, 0o022);
    exec.execute('systemctl daemon-reload');
    exec.execute('systemctl start noisy');
    const pid = exec.serviceMgr.status('noisy')?.mainPid ?? 0;
    expect(pid).toBeGreaterThan(0);
    const send = (text: string): void => exec.logMgr.journald.deliverNative(Uint8Array.from(Buffer.from(`MESSAGE=${text}\nPRIORITY=6\nSYSLOG_IDENTIFIER=noisy\n`)), { pid, uid: 0, gid: 0 });
    for (let i = 0; i < 10; i++) send(`line ${i}`);
    const stored = (): number => exec.execute('journalctl --no-pager -t noisy').split('\n').filter((line) => /line \d/.test(line)).length;
    expect(stored()).toBe(3);
    server.advanceTime(11_000);
    send('after the interval');
    expect(exec.execute('journalctl --no-pager -t systemd-journald')).toContain('Suppressed 7 messages from noisy.service');
  });
});
