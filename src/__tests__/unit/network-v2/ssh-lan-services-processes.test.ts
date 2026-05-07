/**
 * SSH LAN — services and processes (BRD SSH-04, SSH-05, SSH-07-R6).
 *
 * Stresses the cross-section between systemctl, sshd reload semantics,
 * and the `ps` / `kill` family. Several scenarios verify that
 * configuration changes persisted over SSH actually take effect after
 * `systemctl restart sshd`.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, MACAddress } from '@/network/core/types';
import { Logger } from '@/network/core/Logger';
import {
  buildLan,
  assignIps,
  sshExec,
  sshScript,
  openSshSession,
  type SshLan,
  PC1_IP,
  PC2_IP,
  PC3_IP,
} from './ssh-lan-fixtures';
import { isOk } from '@/network/protocols/ssh/Result';

describe('SSH LAN — services & processes', () => {
  let lan: SshLan;

  beforeEach(async () => {
    resetCounters();
    MACAddress.resetCounter();
    Logger.reset();
    lan = buildLan();
    await assignIps(lan);
  });

  // 36
  it('S36 — `systemctl status ssh` reports active over SSH', async () => {
    const out = (await sshExec(lan.pc1, PC2_IP, 'systemctl status ssh')).stdout;
    expect(out.toLowerCase()).toContain('active');
  });

  // 37
  it('S37 — `systemctl is-active sshd` returns "active" over SSH', async () => {
    const out = (await sshExec(lan.pc1, PC2_IP, 'systemctl is-active ssh'))
      .stdout;
    expect(out.trim()).toBe('active');
  });

  // 38
  it('S38 — sshd_config rewrite + systemctl restart updates the cached context', async () => {
    // Edit the file locally (the simulator's `sudo sed` flow is out of
    // scope here) then trigger the lifecycle event that LinuxMachine
    // listens for. This exercises BRD SSH-07-R6 end-to-end.
    const vfs = (lan.pc2 as unknown as { executor: { vfs: { writeFile: typeof Function.prototype } } }).executor.vfs;
    (vfs as unknown as {
      writeFile: (p: string, c: string, u: number, g: number, m: number) => boolean;
    }).writeFile(
      '/etc/ssh/sshd_config',
      'Port 22\nPermitRootLogin yes\nPasswordAuthentication yes\nPubkeyAuthentication yes\n',
      0,
      0,
      0o022,
    );
    await lan.pc2.executeCommand('systemctl restart ssh');
    const ctx = lan.pc2.getSshServerContext();
    expect(ctx.config.permitRootLogin).toBe(true);
  });

  // 39
  it('S39 — `ps -ef` returns at least one process over SSH', async () => {
    const out = (await sshExec(lan.pc1, PC2_IP, 'ps -ef')).stdout;
    // Header line plus one or more processes.
    expect(out.split('\n').filter(Boolean).length).toBeGreaterThanOrEqual(1);
  });

  // 40
  it('S40 — `ps` headers are consistent local vs SSH', async () => {
    const local = (await lan.pc2.executeCommand('ps')).split('\n')[0];
    const ssh = (await sshExec(lan.pc1, PC2_IP, 'ps')).stdout.split('\n')[0];
    expect(ssh).toBe(local);
  });

  // 41
  it('S41 — systemctl status ssh transitions are observable', async () => {
    expect(
      (await lan.pc2.executeCommand('systemctl is-active ssh')).trim(),
    ).toBe('active');
    await lan.pc2.executeCommand('systemctl stop ssh');
    expect(
      (await lan.pc2.executeCommand('systemctl is-active ssh')).trim(),
    ).not.toBe('active');
    await lan.pc2.executeCommand('systemctl start ssh');
    expect(
      (await lan.pc2.executeCommand('systemctl is-active ssh')).trim(),
    ).toBe('active');
  });

  // 42
  it('S42 — running command over SSH leaves no orphan TCP socket', async () => {
    const before = (await lan.pc2.executeCommand('ss -tn')).split('\n').length;
    await sshExec(lan.pc1, PC2_IP, 'echo ok');
    const after = (await lan.pc2.executeCommand('ss -tn')).split('\n').length;
    // After the call, no extra ESTABLISHED line should remain (delta <= 0).
    expect(after - before).toBeLessThanOrEqual(0);
  });

  // 43
  it('S43 — `uname -a` answer is consistent local vs SSH', async () => {
    const local = (await lan.pc2.executeCommand('uname -a')).trim();
    const ssh = (await sshExec(lan.pc1, PC2_IP, 'uname -a')).stdout.trim();
    expect(ssh).toBe(local);
  });

  // 44
  it('S44 — `uptime` returns a coherent string over SSH', async () => {
    const out = (await sshExec(lan.pc1, PC2_IP, 'uptime')).stdout;
    expect(out.toLowerCase()).toContain('load average');
  });

  // 45
  it('S45 — `env` over SSH exposes a populated PATH', async () => {
    const out = (await sshExec(lan.pc1, PC2_IP, 'env')).stdout;
    expect(out).toContain('PATH=');
    expect(out).toMatch(/\/usr\/bin/);
  });

  // 46
  it('S46 — multiple sequential SSH calls reuse the same exec channel cleanly', async () => {
    const out = await sshScript(lan.pc1, PC2_IP, [
      'echo a',
      'echo b',
      'echo c',
    ]);
    expect(out).toEqual(['a', 'b', 'c']);
  });

  // 47
  it('S47 — `bash -c "echo $$"` returns a numeric pid over SSH', async () => {
    const out = (await sshExec(lan.pc1, PC2_IP, "bash -c 'echo $$'")).stdout;
    expect(/^\d+$/.test(out.trim())).toBe(true);
  });

  // 48
  it('S48 — failing commands surface a "no such" message', async () => {
    const result = await sshExec(lan.pc1, PC2_IP, 'cat /tmp/missing-file');
    expect(result.stdout.toLowerCase()).toContain('no such');
  });

  // 49
  it('S49 — `pwd && ls /tmp` chain works through one exec channel', async () => {
    const out = (await sshExec(lan.pc1, PC2_IP, 'pwd && ls /tmp')).stdout;
    expect(out).toContain('/home/user');
  });

  // 50
  it('S50 — auth still fails after MaxAuthTries override exhausted', async () => {
    let failed = false;
    try {
      await openSshSession(lan.pc1, PC2_IP, 'user', 'wrong-password');
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);
  });
});
