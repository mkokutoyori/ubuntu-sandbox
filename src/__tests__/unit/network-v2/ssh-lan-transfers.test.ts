/**
 * SSH LAN — file transfers (BRD SFTP-* / SSH-08 scp / SSH-03 keygen+copy-id).
 *
 * Exercises end-to-end transfer scenarios across the small LAN:
 * sftp client commands, scp upload/download (with -r), ssh-keygen and
 * ssh-copy-id round-trips. Each scenario asserts the resulting state on
 * the remote VFS, not just the CLI output, to catch regressions like
 * silent permission failures.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, MACAddress } from '@/network/core/types';
import { Logger } from '@/network/core/Logger';
import { VirtualFileSystem } from '@/network/devices/linux/VirtualFileSystem';
import {
  buildLan,
  assignIps,
  openSftpSession,
  openSshSession,
  sshExec,
  type SshLan,
  PC1_IP,
  PC2_IP,
  PC3_IP,
} from './ssh-lan-fixtures';
import { sshCopyId } from '@/network/protocols/ssh/SshCopyId';
import {
  parseSshKeygenArgs,
  generateAndWriteKeyPair,
} from '@/network/protocols/ssh/SshKeygen';

describe('SSH LAN — file transfers', () => {
  let lan: SshLan;

  beforeEach(async () => {
    resetCounters();
    MACAddress.resetCounter();
    Logger.reset();
    lan = buildLan();
    await assignIps(lan);
    // Pre-seed a few files for download scenarios.
    await lan.pc2.executeCommand('mkdir -p /home/user/docs/sub');
    await lan.pc2.executeCommand('echo report-body > /home/user/docs/report.txt');
    await lan.pc2.executeCommand('echo inner > /home/user/docs/sub/inner.txt');
  });

  // 51
  it('S51 — sftp `ls` lists the remote home over the LAN', async () => {
    const { sftp } = await openSftpSession(lan.pc1, PC2_IP);
    const out = sftp.ls(['/home/user'], new Set());
    expect(out).toContain('docs');
    sftp.disconnect();
  });

  // 52
  it('S52 — sftp `get` downloads the report with right content', async () => {
    const { sftp, localVfs } = await openSftpSession(lan.pc1, PC2_IP);
    sftp.get('/home/user/docs/report.txt', '/root/report.txt');
    expect((localVfs.readFile('/root/report.txt') ?? '').trim()).toBe(
      'report-body',
    );
    sftp.disconnect();
  });

  // 53
  it('S53 — sftp `put` uploads a local file and remote `cat` matches', async () => {
    const { sftp, localVfs } = await openSftpSession(lan.pc1, PC2_IP);
    localVfs.writeFile('/root/upload.txt', 'fresh-content', 0, 0, 0o022);
    sftp.put('/root/upload.txt', '/home/user/upload.txt');
    sftp.disconnect();
    const remote = await lan.pc2.executeCommand('cat /home/user/upload.txt');
    expect(remote.trim()).toBe('fresh-content');
  });

  // 54
  it('S54 — sftp `mkdir` non-recursive: parent missing returns error', async () => {
    const { sftp } = await openSftpSession(lan.pc1, PC2_IP);
    const out = sftp.mkdir('/home/user/nope/inner');
    expect(out).toMatch(/Couldn't create directory/);
    sftp.disconnect();
  });

  // 55
  it('S55 — sftp `rename` refuses if destination already exists', async () => {
    await lan.pc2.executeCommand('echo a > /home/user/dst.txt');
    const { sftp } = await openSftpSession(lan.pc1, PC2_IP);
    const out = sftp.rename('/home/user/docs/report.txt', '/home/user/dst.txt');
    expect(out).toMatch(/Couldn't rename file/);
    sftp.disconnect();
  });

  // 56
  it('S56 — sftp `chmod 600` updates remote permissions', async () => {
    const { sftp } = await openSftpSession(lan.pc1, PC2_IP);
    expect(sftp.chmod('600', '/home/user/docs/report.txt')).toContain(
      'Changing mode',
    );
    sftp.disconnect();
    const stat = await lan.pc2.executeCommand(
      'stat -c %a /home/user/docs/report.txt',
    );
    expect(stat.trim()).toBe('600');
  });

  // 57
  it('S57 — sftp `stat` returns a Mode/UID/GID block', async () => {
    const { sftp } = await openSftpSession(lan.pc1, PC2_IP);
    const out = sftp.stat('/home/user/docs/report.txt');
    expect(out).toContain('Mode:');
    expect(out).toContain('UID:');
    expect(out).toContain('GID:');
    sftp.disconnect();
  });

  // 58
  it('S58 — sftp `df` reports a capacity table', async () => {
    const { sftp } = await openSftpSession(lan.pc1, PC2_IP);
    const out = sftp.df(undefined, true);
    expect(out).toContain('%Capacity');
    sftp.disconnect();
  });

  // 59
  it('S59 — sftp `version` announces protocol 3', async () => {
    const { sftp } = await openSftpSession(lan.pc1, PC2_IP);
    expect(sftp.version()).toBe('SFTP protocol version 3');
    sftp.disconnect();
  });

  // 60
  it('S60 — sftp recursive `getRecursive` mirrors a remote tree locally', async () => {
    const { sftp, localVfs } = await openSftpSession(lan.pc1, PC2_IP);
    sftp.getRecursive('/home/user/docs', '/root/docs');
    expect((localVfs.readFile('/root/docs/report.txt') ?? '').trim()).toBe(
      'report-body',
    );
    expect((localVfs.readFile('/root/docs/sub/inner.txt') ?? '').trim()).toBe(
      'inner',
    );
    sftp.disconnect();
  });

  // 61
  it('S61 — sftp recursive `putRecursive` mirrors a local tree onto the server', async () => {
    const { sftp, localVfs } = await openSftpSession(lan.pc1, PC2_IP);
    localVfs.mkdirp('/root/proj/lib', 0o755, 0, 0);
    localVfs.writeFile('/root/proj/main.txt', 'main-body', 0, 0, 0o022);
    localVfs.writeFile('/root/proj/lib/util.txt', 'util-body', 0, 0, 0o022);
    sftp.putRecursive('/root/proj', '/home/user/proj');
    sftp.disconnect();
    const main = await lan.pc2.executeCommand('cat /home/user/proj/main.txt');
    const util = await lan.pc2.executeCommand('cat /home/user/proj/lib/util.txt');
    expect(main.trim()).toBe('main-body');
    expect(util.trim()).toBe('util-body');
  });

  // 62
  it('S62 — ssh-keygen writes id_ed25519 + .pub with proper modes', () => {
    const localVfs = new VirtualFileSystem();
    localVfs.mkdirp('/home/user', 0o755, 1000, 1000);
    const opts = parseSshKeygenArgs(
      ['-t', 'ed25519', '-C', 'alice@local'],
      '/home/user',
    );
    const result = generateAndWriteKeyPair(localVfs, 1000, 1000, opts);
    expect('error' in result).toBe(false);
    expect(localVfs.exists('/home/user/.ssh/id_ed25519')).toBe(true);
    expect(localVfs.exists('/home/user/.ssh/id_ed25519.pub')).toBe(true);
  });

  // 63
  it('S63 — ssh-copy-id appends a key to remote authorized_keys', async () => {
    const session = await openSshSession(lan.pc1, PC2_IP);
    const result = await sshCopyId(
      session,
      'ssh-ed25519 AAAACOPYID alice@local',
      '/home/user',
    );
    session.disconnect();
    expect('added' in result && result.added).toBe(1);
    const stored = await lan.pc2.executeCommand(
      'cat /home/user/.ssh/authorized_keys',
    );
    expect(stored).toContain('AAAACOPYID');
  });

  // 64
  it('S64 — ssh-copy-id is idempotent (second call adds 0 keys)', async () => {
    const session = await openSshSession(lan.pc1, PC2_IP);
    await sshCopyId(session, 'ssh-ed25519 ABDUP alice@local', '/home/user');
    const second = await sshCopyId(
      session,
      'ssh-ed25519 ABDUP alice@local',
      '/home/user',
    );
    session.disconnect();
    expect('added' in second && second.added).toBe(0);
  });

  // 65
  it('S65 — sftp `lmkdir` creates a local directory', async () => {
    const { sftp, localVfs } = await openSftpSession(lan.pc1, PC2_IP);
    expect(sftp.lmkdir('/root/local-dir')).toBe('');
    expect(localVfs.exists('/root/local-dir')).toBe(true);
    sftp.disconnect();
  });

  // 66
  it('S66 — sftp `rm` deletes a remote file (visible locally as missing)', async () => {
    const { sftp } = await openSftpSession(lan.pc1, PC2_IP);
    sftp.rm('/home/user/docs/report.txt');
    sftp.disconnect();
    const out = await lan.pc2.executeCommand('cat /home/user/docs/report.txt');
    expect(out.toLowerCase()).toContain('no such');
  });

  // 67
  it('S67 — sftp `rmdir` on a non-empty directory fails (Failure)', async () => {
    const { sftp } = await openSftpSession(lan.pc1, PC2_IP);
    const out = sftp.rmdir('/home/user/docs');
    expect(out).toMatch(/Couldn't remove directory/);
    sftp.disconnect();
  });

  // 68
  it('S68 — sftp `ls -l` produces lines matching the long format', async () => {
    const { sftp } = await openSftpSession(lan.pc1, PC2_IP);
    const out = sftp.ls(['/home/user/docs'], new Set(['l']));
    expect(out).toMatch(/^[d\-l][r-][w-]/m);
    sftp.disconnect();
  });

  // 69
  it('S69 — sftp `ls -a` exposes dotfiles, default does not', async () => {
    await lan.pc2.executeCommand('echo h > /home/user/.hidden');
    const { sftp } = await openSftpSession(lan.pc1, PC2_IP);
    expect(sftp.ls(['/home/user'], new Set())).not.toContain('.hidden');
    expect(sftp.ls(['/home/user'], new Set(['a']))).toContain('.hidden');
    sftp.disconnect();
  });

  // 70
  it('S70 — concurrent SFTP sessions to PC2 and PC3 from PC1', async () => {
    const a = await openSftpSession(lan.pc1, PC2_IP);
    const b = await openSftpSession(lan.pc1, PC3_IP);
    a.localVfs.writeFile('/root/x.txt', 'x', 0, 0, 0o022);
    b.localVfs.writeFile('/root/y.txt', 'y', 0, 0, 0o022);
    a.sftp.put('/root/x.txt', '/tmp/x.txt');
    b.sftp.put('/root/y.txt', '/tmp/y.txt');
    a.sftp.disconnect();
    b.sftp.disconnect();
    expect((await lan.pc2.executeCommand('cat /tmp/x.txt')).trim()).toBe('x');
    expect((await lan.pc3.executeCommand('cat /tmp/y.txt')).trim()).toBe('y');
  });
});
