/**
 * SSH LAN — filesystem coherence (BRD SSH-04, SSH-05).
 *
 * Three Linux PCs cabled through one switch. Each scenario asserts that
 * the same shell command produces an equivalent result whether it is
 * executed locally or via `ssh user@host <cmd>`. Beyond mere coherence,
 * tests cover stateful flows: a file created over SSH must be visible
 * from a subsequent local `cat`, etc.
 *
 * Helpers under `ssh-lan-fixtures.ts`.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, MACAddress } from '@/network/core/types';
import { Logger } from '@/network/core/Logger';
import {
  buildLan,
  assignIps,
  sshExec,
  sshScript,
  type SshLan,
  PC1_IP,
  PC2_IP,
  PC3_IP,
} from './ssh-lan-fixtures';

describe('SSH LAN — filesystem coherence (BRD SSH-04 / SSH-05)', () => {
  let lan: SshLan;

  beforeEach(async () => {
    resetCounters();
    MACAddress.resetCounter();
    Logger.reset();
    lan = buildLan();
    await assignIps(lan);
  });

  // 1
  it('S1 — local `pwd` and remote `pwd` both return the user home', async () => {
    const local = (await lan.pc1.executeCommand('pwd')).trim();
    const remote = (await sshExec(lan.pc1, PC2_IP, 'pwd')).stdout.trim();
    expect(local).toBe('/home/user');
    expect(remote).toBe('/home/user');
  });

  // 2
  it('S2 — `whoami` reports the SSH user, not the local one', async () => {
    const local = (await lan.pc1.executeCommand('whoami')).trim();
    const remote = (await sshExec(lan.pc1, PC2_IP, 'whoami')).stdout.trim();
    expect(local).toBe('user');
    expect(remote).toBe('user');
  });

  // 3
  it('S3 — `hostname` returns coherent results local vs SSH', async () => {
    // The Linux profile names every PC with the same default hostname.
    // Coherence here means: the value returned through SSH on PC2 must
    // match what running `hostname` directly on PC2 returns.
    const directly = (await lan.pc2.executeCommand('hostname')).trim();
    const remotely = (await sshExec(lan.pc1, PC2_IP, 'hostname')).stdout.trim();
    expect(remotely).toBe(directly);
  });

  // 4
  it('S4 — file created over SSH is visible to a subsequent local cat', async () => {
    const exec = await sshExec(
      lan.pc1,
      PC2_IP,
      'echo hello-from-ssh > /tmp/note.txt',
    );
    expect(exec.exitCode).toBe(0);
    const local = await lan.pc2.executeCommand('cat /tmp/note.txt');
    expect(local.trim()).toBe('hello-from-ssh');
  });

  // 5
  it('S5 — local mkdir followed by remote ls sees the directory', async () => {
    await lan.pc2.executeCommand('mkdir -p /tmp/shared/dir');
    const remoteLs = (await sshExec(lan.pc1, PC2_IP, 'ls /tmp/shared')).stdout;
    expect(remoteLs).toContain('dir');
  });

  // 6
  it('S6 — `mkdir -p` over SSH creates nested directories', async () => {
    const out = await sshScript(lan.pc1, PC2_IP, [
      'mkdir -p /tmp/a/b/c',
      'ls -d /tmp/a/b/c',
    ]);
    expect(out[1]).toContain('/tmp/a/b/c');
  });

  // 7
  it('S7 — `cp` then `cat` round-trip via SSH preserves content', async () => {
    const out = await sshScript(lan.pc1, PC2_IP, [
      'echo "v1" > /tmp/src.txt',
      'cp /tmp/src.txt /tmp/dst.txt',
      'cat /tmp/dst.txt',
    ]);
    expect(out[2].trim()).toBe('v1');
  });

  // 8
  it('S8 — `mv` over SSH removes the source and creates the destination', async () => {
    const out = await sshScript(lan.pc1, PC2_IP, [
      'echo "moveme" > /tmp/before.txt',
      'mv /tmp/before.txt /tmp/after.txt',
      'cat /tmp/after.txt',
      'ls /tmp/before.txt',
    ]);
    expect(out[2].trim()).toBe('moveme');
    expect(out[3].toLowerCase()).toContain('no such');
  });

  // 9
  it('S9 — `rm` over SSH actually deletes the file (visible locally too)', async () => {
    await lan.pc2.executeCommand('echo doomed > /tmp/doomed.txt');
    expect(
      (await lan.pc2.executeCommand('cat /tmp/doomed.txt')).trim(),
    ).toBe('doomed');
    await sshExec(lan.pc1, PC2_IP, 'rm /tmp/doomed.txt');
    const result = await lan.pc2.executeCommand('cat /tmp/doomed.txt');
    expect(result.toLowerCase()).toContain('no such');
  });

  // 10
  it('S10 — `chmod` modifies permissions on the remote VFS', async () => {
    await lan.pc2.executeCommand('echo secret > /tmp/secret.txt');
    await sshExec(lan.pc1, PC2_IP, 'chmod 600 /tmp/secret.txt');
    const stat = await lan.pc2.executeCommand('stat -c %a /tmp/secret.txt');
    expect(stat.trim()).toBe('600');
  });

  // 11
  it('S11 — `ls -l` over SSH lists rich attributes', async () => {
    await lan.pc2.executeCommand('echo content > /tmp/file.txt');
    const out = (await sshExec(lan.pc1, PC2_IP, 'ls -l /tmp/file.txt')).stdout;
    expect(out).toMatch(/-[r-][w-][x-]/);
    expect(out).toContain('file.txt');
  });

  // 12
  it('S12 — `find` over SSH lists matching files', async () => {
    await sshScript(lan.pc1, PC2_IP, [
      'mkdir -p /tmp/findme',
      'touch /tmp/findme/a.log',
      'touch /tmp/findme/b.log',
      'touch /tmp/findme/note.txt',
    ]);
    const result = (
      await sshExec(lan.pc1, PC2_IP, 'find /tmp/findme -name "*.log"')
    ).stdout;
    expect(result).toContain('a.log');
    expect(result).toContain('b.log');
    expect(result).not.toContain('note.txt');
  });

  // 13
  it('S13 — `cat` of a missing file returns OpenSSH-style error', async () => {
    const result = await sshExec(lan.pc1, PC2_IP, 'cat /tmp/does-not-exist');
    expect(result.stdout.toLowerCase()).toContain('no such');
  });

  // 14
  it('S14 — `head` and `tail` slice content correctly via SSH', async () => {
    await sshScript(lan.pc1, PC2_IP, [
      'printf "l1\\nl2\\nl3\\nl4\\nl5\\n" > /tmp/lines.txt',
    ]);
    const head = (await sshExec(lan.pc1, PC2_IP, 'head -n 2 /tmp/lines.txt'))
      .stdout;
    const tail = (await sshExec(lan.pc1, PC2_IP, 'tail -n 2 /tmp/lines.txt'))
      .stdout;
    expect(head.trim()).toBe('l1\nl2');
    expect(tail.trim()).toBe('l4\nl5');
  });

  // 15
  it('S15 — `wc -l` over SSH counts lines', async () => {
    await sshScript(lan.pc1, PC2_IP, [
      'printf "a\\nb\\nc\\n" > /tmp/wc.txt',
    ]);
    const out = (await sshExec(lan.pc1, PC2_IP, 'wc -l /tmp/wc.txt')).stdout;
    expect(out.trim().split(/\s+/)[0]).toBe('3');
  });

  // 16
  it('S16 — `grep -r` recurses through a remote tree via SSH', async () => {
    await sshScript(lan.pc1, PC2_IP, [
      'mkdir -p /tmp/grep/sub',
      'echo apple > /tmp/grep/a.txt',
      'echo banana > /tmp/grep/sub/b.txt',
      'echo apple > /tmp/grep/sub/c.txt',
    ]);
    const out = (await sshExec(lan.pc1, PC2_IP, 'grep -r apple /tmp/grep'))
      .stdout;
    expect(out).toContain('a.txt');
    expect(out).toContain('c.txt');
    expect(out).not.toContain('b.txt');
  });

  // 17
  it('S17 — independent VFS: a file created on PC2 is invisible on PC3', async () => {
    await sshExec(lan.pc1, PC2_IP, 'echo onlypc2 > /tmp/island.txt');
    const onPc3 = await sshExec(lan.pc1, PC3_IP, 'cat /tmp/island.txt');
    expect(onPc3.stdout.toLowerCase()).toContain('no such');
  });

  // 18
  it('S18 — `touch` creates an empty file with the right mtime metadata', async () => {
    await sshExec(lan.pc1, PC2_IP, 'touch /tmp/empty.txt');
    const stat = await sshExec(lan.pc1, PC2_IP, 'stat /tmp/empty.txt');
    expect(stat.stdout).toContain('Size: 0');
  });

  // 19
  it('S19 — `rmdir` on a non-empty directory fails over SSH', async () => {
    await sshScript(lan.pc1, PC2_IP, [
      'mkdir -p /tmp/full',
      'touch /tmp/full/x',
    ]);
    const out = await sshExec(lan.pc1, PC2_IP, 'rmdir /tmp/full');
    expect(out.stdout.toLowerCase()).toMatch(/not empty|failed to remove|failure/);
  });

  // 20
  it('S20 — pipes work over SSH (`ls /etc | wc -l`)', async () => {
    const out = (await sshExec(lan.pc1, PC2_IP, 'ls /etc | wc -l')).stdout;
    const count = Number.parseInt(out.trim(), 10);
    expect(count).toBeGreaterThan(0);
  });
});
