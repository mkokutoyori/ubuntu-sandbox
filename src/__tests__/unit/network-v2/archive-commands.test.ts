/**
 * TDD — real archive semantics (GAP §8.4: tar/gzip/zip were pure
 * no-ops — `tar -x` restored nothing and `gunzip` REPLACED the data
 * with a placeholder). The contract below is the GNU/Info-ZIP
 * behaviour a lab script depends on: lossless round-trips on the VFS,
 * real error texts and exit codes, option grammar including tar's old
 * bundled style, and a `file` that classifies from real content.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

function pc(): LinuxServer {
  return new LinuxServer('srv', 'host1');
}

describe('tar — create / list / extract round-trip', () => {
  it('tar czf + tar xzf restores the exact file contents elsewhere', async () => {
    const h = pc();
    await h.executeCommand('mkdir -p /root/src');
    await h.executeCommand('echo "hello archive" > /root/src/a.txt');
    await h.executeCommand('echo "second file" > /root/src/b.txt');
    // Old option style (no dash) — the form every admin types.
    expect(await h.executeCommand('cd /root && tar czf backup.tar.gz src'))
      .toBe('');
    // The archive is a real, non-empty VFS file.
    const ls = await h.executeCommand('ls -la /root/backup.tar.gz');
    expect(ls).toContain('backup.tar.gz');
    expect(ls).not.toMatch(/\s0\s+\w{3}/);   // size is not zero

    await h.executeCommand('mkdir -p /tmp/restore');
    await h.executeCommand('cd /tmp/restore && tar xzf /root/backup.tar.gz');
    expect(await h.executeCommand('cat /tmp/restore/src/a.txt'))
      .toBe('hello archive');
    expect(await h.executeCommand('cat /tmp/restore/src/b.txt'))
      .toBe('second file');
  });

  it('tar -tf lists the stored member names (dirs with trailing /)', async () => {
    const h = pc();
    await h.executeCommand('mkdir -p /root/conf');
    await h.executeCommand('echo x > /root/conf/app.cfg');
    await h.executeCommand('cd /root && tar cf conf.tar conf');
    const listing = await h.executeCommand('tar -tf /root/conf.tar');
    expect(listing).toContain('conf/');
    expect(listing).toContain('conf/app.cfg');
  });

  it('preserves file permissions through the round-trip', async () => {
    const h = pc();
    await h.executeCommand('echo "#!/bin/bash" > /root/run.sh');
    await h.executeCommand('chmod 755 /root/run.sh');
    await h.executeCommand('cd /root && tar cf s.tar run.sh');
    await h.executeCommand('rm /root/run.sh');
    await h.executeCommand('cd /root && tar xf s.tar');
    expect(await h.executeCommand('ls -l /root/run.sh'))
      .toContain('-rwxr-xr-x');
  });

  it('-C changes the extraction directory', async () => {
    const h = pc();
    await h.executeCommand('echo data > /root/d.txt');
    await h.executeCommand('cd /root && tar cf d.tar d.txt');
    await h.executeCommand('mkdir -p /opt/out');
    await h.executeCommand('tar -xf /root/d.tar -C /opt/out');
    expect(await h.executeCommand('cat /opt/out/d.txt')).toBe('data');
  });

  it('strips the leading / from member names with the GNU warning', async () => {
    const h = pc();
    await h.executeCommand('echo etc-data > /etc/lab.conf');
    const out = await h.executeCommand('cd /root && tar cf abs.tar /etc/lab.conf');
    expect(out).toContain("tar: Removing leading `/' from member names");
    expect(await h.executeCommand('tar -tf /root/abs.tar'))
      .toContain('etc/lab.conf');
  });

  it('a missing source yields Cannot stat + exit 2, but archives the rest', async () => {
    const h = pc();
    await h.executeCommand('echo ok > /root/ok.txt');
    const out = await h.executeCommand(
      'cd /root && tar cf part.tar ok.txt ghost.txt; echo "rc=$?"');
    expect(out).toContain('tar: ghost.txt: Cannot stat: No such file or directory');
    expect(out).toContain('tar: Exiting with failure status due to previous errors');
    expect(out).toContain('rc=2');
    expect(await h.executeCommand('tar -tf /root/part.tar')).toContain('ok.txt');
  });

  it('extracting a non-archive fails like real tar', async () => {
    const h = pc();
    await h.executeCommand('echo "just text" > /root/fake.tar');
    const out = await h.executeCommand('cd /root && tar xf fake.tar; echo "rc=$?"');
    expect(out).toContain('tar: This does not look like a tar archive');
    expect(out).toContain('rc=2');
  });

  it('missing archive and missing mode produce the canonical errors', async () => {
    const h = pc();
    expect(await h.executeCommand('tar xf /nope.tar'))
      .toContain('tar: /nope.tar: Cannot open: No such file or directory');
    expect(await h.executeCommand('tar /root'))
      .toContain("tar: You must specify one of the '-Acdtrux'");
    expect(await h.executeCommand('tar cf empty.tar'))
      .toContain('tar: Cowardly refusing to create an empty archive');
  });
});

describe('gzip / gunzip / zcat — lossless compression round-trip', () => {
  it('gzip replaces the file with .gz; gunzip restores the bytes', async () => {
    const h = pc();
    await h.executeCommand('printf "line1\\nline2\\n" > /root/log.txt');
    await h.executeCommand('cd /root && gzip log.txt');
    expect(await h.executeCommand('ls /root')).not.toContain('log.txt\n');
    expect(await h.executeCommand('ls /root')).toContain('log.txt.gz');
    await h.executeCommand('cd /root && gunzip log.txt.gz');
    expect(await h.executeCommand('cat /root/log.txt')).toBe('line1\nline2');
    expect(await h.executeCommand('ls /root')).not.toContain('log.txt.gz');
  });

  it('gzip -k keeps the original; zcat prints without touching files', async () => {
    const h = pc();
    await h.executeCommand('echo payload > /root/keep.txt');
    await h.executeCommand('cd /root && gzip -k keep.txt');
    expect(await h.executeCommand('cat /root/keep.txt')).toBe('payload');
    expect(await h.executeCommand('zcat /root/keep.txt.gz')).toBe('payload');
    expect(await h.executeCommand('ls /root')).toContain('keep.txt.gz');
  });

  it('error texts match real gzip', async () => {
    const h = pc();
    expect(await h.executeCommand('gzip /root/ghost.txt'))
      .toContain('gzip: /root/ghost.txt: No such file or directory');
    await h.executeCommand('echo x > /root/x.gz');
    expect(await h.executeCommand('cd /root && gzip x.gz'))
      .toContain('gzip: x.gz already has .gz suffix -- unchanged');
    await h.executeCommand('echo plain > /root/p.gz');
    expect(await h.executeCommand('cd /root && gunzip p.gz'))
      .toContain('gzip: p.gz: not in gzip format');
  });
});

describe('zip / unzip — archive with member listing', () => {
  it('zip prints adding: lines and unzip -d restores elsewhere', async () => {
    const h = pc();
    await h.executeCommand('echo alpha > /root/a.txt');
    await h.executeCommand('echo beta > /root/b.txt');
    const out = await h.executeCommand('cd /root && zip bundle a.txt b.txt');
    expect(out).toMatch(/adding: a\.txt \((deflated \d+%|stored 0%)\)/);
    expect(out).toMatch(/adding: b\.txt/);
    const unzipOut = await h.executeCommand(
      'cd /root && unzip bundle.zip -d /srv/www');
    expect(unzipOut).toContain('Archive:  bundle.zip');
    expect(unzipOut).toContain('inflating: a.txt');
    expect(await h.executeCommand('cat /srv/www/a.txt')).toBe('alpha');
    expect(await h.executeCommand('cat /srv/www/b.txt')).toBe('beta');
  });

  it('unzip -l lists members with sizes; missing member warns (exit 12)', async () => {
    const h = pc();
    await h.executeCommand('echo 12345 > /root/f.txt');
    await h.executeCommand('cd /root && zip data f.txt');
    const listing = await h.executeCommand('cd /root && unzip -l data.zip');
    expect(listing).toContain('Length');
    expect(listing).toContain('f.txt');
    expect(listing).toContain('1 files');
    const warn = await h.executeCommand('cd /root && zip oops nope.txt; echo "rc=$?"');
    expect(warn).toContain('zip warning: name not matched: nope.txt');
    expect(warn).toContain('rc=12');
  });

  it('unzip of a non-zip and of a missing archive fail like Info-ZIP', async () => {
    const h = pc();
    await h.executeCommand('echo not-a-zip > /root/t.zip');
    expect(await h.executeCommand('cd /root && unzip t.zip'))
      .toContain('End-of-central-directory signature not found');
    expect(await h.executeCommand('unzip absent'))
      .toContain('cannot find or open absent, absent.zip or absent.ZIP');
  });
});

describe('file — classification from real content', () => {
  it('recognises archives, directories, scripts, empty and missing files', async () => {
    const h = pc();
    await h.executeCommand('echo hello > /root/t.txt');
    await h.executeCommand('cd /root && gzip -k t.txt && tar cf t.tar t.txt && zip t.zip t.txt');
    expect(await h.executeCommand('file /root/t.txt'))
      .toBe('/root/t.txt: ASCII text');
    expect(await h.executeCommand('file /root/t.txt.gz'))
      .toContain('gzip compressed data, was "t.txt"');
    expect(await h.executeCommand('file /root/t.tar'))
      .toContain('POSIX tar archive');
    expect(await h.executeCommand('file /root/t.zip'))
      .toContain('Zip archive data');
    expect(await h.executeCommand('file /etc'))
      .toBe('/etc: directory');
    expect(await h.executeCommand('file /root/ghost'))
      .toContain("cannot open `/root/ghost' (No such file or directory)");
    await h.executeCommand('touch /root/empty');
    expect(await h.executeCommand('file /root/empty'))
      .toBe('/root/empty: empty');
    await h.executeCommand('printf "#!/bin/bash\\necho hi\\n" > /root/s.sh');
    expect(await h.executeCommand('file /root/s.sh'))
      .toContain('/bin/bash script');
  });
});

describe('end-to-end lab scenario — backup and restore script', () => {
  it('a bash backup/restore pipeline is coherent on the VFS', async () => {
    const h = pc();
    await h.executeCommand('mkdir -p /etc/app');
    await h.executeCommand('echo "port=8080" > /etc/app/app.conf');
    await h.executeCommand(
      'tar czf /tmp/app-backup.tar.gz -C /etc app && md5sum /etc/app/app.conf > /tmp/sum');
    // Simulate a config loss, then restore from the archive.
    await h.executeCommand('rm -rf /etc/app');
    expect(await h.executeCommand('cat /etc/app/app.conf'))
      .toContain('No such file');
    await h.executeCommand('tar xzf /tmp/app-backup.tar.gz -C /etc');
    expect(await h.executeCommand('cat /etc/app/app.conf')).toBe('port=8080');
    // The checksum matches: the restore was byte-identical.
    expect(await h.executeCommand('cd / && md5sum -c /tmp/sum'))
      .toContain('/etc/app/app.conf: OK');
  });
});
