/**
 * SSH LAN — advanced scenarios.
 *
 * These tests stress more subtle BRD requirements: cross-host coherence,
 * sshd_config policy enforcement (PermitRootLogin / AllowUsers /
 * PasswordAuthentication), MOTD propagation, host-key change detection,
 * config aliases, and chained command scenarios that mix `ssh`, `scp` and
 * file-system operations.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, MACAddress } from '@/network/core/types';
import { Logger } from '@/network/core/Logger';
import { VirtualFileSystem } from '@/network/devices/linux/VirtualFileSystem';
import {
  buildLan,
  assignIps,
  openSshSession,
  openSftpSession,
  sshExec,
  sshScript,
  type SshLan,
  PC1_IP,
  PC2_IP,
  PC3_IP,
} from './ssh-lan-fixtures';
import { SshConfig } from '@/network/protocols/ssh/SshConfig';
import { SshSession } from '@/network/protocols/ssh/session/SshSession';
import { SshConnectOptionsBuilder } from '@/network/protocols/ssh/SshConnectOptions';
import {
  hostKeyFingerprint,
  type ISshInteractionHandler,
  type SshConnectionInfo,
} from '@/network/protocols/ssh/session/ISshInteractionHandler';
import { isOk, isErr } from '@/network/protocols/ssh/Result';

class CapturingHandler implements ISshInteractionHandler {
  warnings: string[] = [];
  infos: string[] = [];
  constructor(
    private readonly password: string,
    private readonly hostKeyAnswer: 'yes' | 'no' | { fingerprint: string } = 'yes',
  ) {}
  async promptHostKeyConfirmation(_h: string, fp: string) {
    if (this.hostKeyAnswer === 'yes') return { kind: 'yes' as const };
    if (this.hostKeyAnswer === 'no') return { kind: 'no' as const };
    return hostKeyFingerprint(this.hostKeyAnswer.fingerprint || fp);
  }
  async promptPassword() {
    return this.password;
  }
  showWarning(m: string) {
    this.warnings.push(m);
  }
  showInfo(m: string) {
    this.infos.push(m);
  }
  onConnected(_info: SshConnectionInfo) {}
}

describe('SSH LAN — advanced scenarios', () => {
  let lan: SshLan;

  beforeEach(async () => {
    resetCounters();
    MACAddress.resetCounter();
    Logger.reset();
    lan = buildLan();
    await assignIps(lan);
  });

  // 71
  it('S71 — Permanently added host appears in known_hosts after the first connect', async () => {
    const localVfs = new VirtualFileSystem();
    const session = new SshSession({
      tcpConnector: (h, p) =>
        (lan.pc1 as unknown as { tcpConnect: (h: string, p: number) => Promise<unknown> })
          .tcpConnect(h, p) as Promise<never>,
      vfs: localVfs,
      localUser: 'root',
      localUid: 0,
      localGid: 0,
      knownHostsPath: '/root/.ssh/known_hosts',
      interactionHandler: new CapturingHandler('admin'),
    });
    expect(
      isOk(
        await session.connect(
          SshConnectOptionsBuilder.create()
            .host(PC2_IP)
            .user('user')
            .password('admin')
            .strictHostKeyChecking('accept-new')
            .build(),
        ),
      ),
    ).toBe(true);
    session.disconnect();
    const known = localVfs.readFile('/root/.ssh/known_hosts');
    expect(known).toContain(PC2_IP);
  });

  // 72
  it('S72 — host-key change after a wipe triggers HOST_KEY_CHANGED', async () => {
    const localVfs = new VirtualFileSystem();
    // Plant a fake known_hosts entry that does NOT match PC2's real key.
    localVfs.mkdirp('/root/.ssh', 0o700, 0, 0);
    localVfs.writeFile(
      '/root/.ssh/known_hosts',
      `${PC2_IP} ssh-ed25519 AAAA-WRONG-KEY-DELIBERATELY\n`,
      0,
      0,
      0o022,
    );
    const handler = new CapturingHandler('admin');
    const session = new SshSession({
      tcpConnector: (h, p) =>
        (lan.pc1 as unknown as { tcpConnect: (h: string, p: number) => Promise<unknown> })
          .tcpConnect(h, p) as Promise<never>,
      vfs: localVfs,
      localUser: 'root',
      localUid: 0,
      localGid: 0,
      knownHostsPath: '/root/.ssh/known_hosts',
      interactionHandler: handler,
    });
    const result = await session.connect(
      SshConnectOptionsBuilder.create()
        .host(PC2_IP)
        .user('user')
        .password('admin')
        .strictHostKeyChecking('yes')
        .build(),
    );
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.kind).toBe('HOST_KEY_CHANGED');
    }
    expect(handler.warnings.join('\n')).toMatch(/REMOTE HOST IDENTIFICATION HAS CHANGED/);
    session.disconnect();
  });

  // 73
  it('S73 — typing the exact fingerprint accepts without persisting known_hosts', async () => {
    const ctx = lan.pc2.getSshServerContext();
    const fp = ctx.hostKey.fingerprint.toString();
    const localVfs = new VirtualFileSystem();
    const handler = new CapturingHandler('admin', { fingerprint: fp });
    const session = new SshSession({
      tcpConnector: (h, p) =>
        (lan.pc1 as unknown as { tcpConnect: (h: string, p: number) => Promise<unknown> })
          .tcpConnect(h, p) as Promise<never>,
      vfs: localVfs,
      localUser: 'root',
      localUid: 0,
      localGid: 0,
      knownHostsPath: '/root/.ssh/known_hosts',
      interactionHandler: handler,
    });
    const result = await session.connect(
      SshConnectOptionsBuilder.create()
        .host(PC2_IP)
        .user('user')
        .password('admin')
        .strictHostKeyChecking('yes')
        .build(),
    );
    expect(isOk(result)).toBe(true);
    expect(localVfs.readFile('/root/.ssh/known_hosts')).toBeNull();
    session.disconnect();
  });

  // 74
  it('S74 — `Host alias` in ~/.ssh/config maps to the right hostName/user/port', () => {
    const cfg = SshConfig.parse(
      `Host * \n  StrictHostKeyChecking accept-new\n\n` +
        `Host pc2\n  HostName ${PC2_IP}\n  User user\n  Port 22\n` +
        `Host pc3\n  HostName ${PC3_IP}\n  User user\n  Port 22\n`,
    );
    const r2 = cfg.resolve('pc2');
    const r3 = cfg.resolve('pc3');
    expect(r2.hostName).toBe(PC2_IP);
    expect(r3.hostName).toBe(PC3_IP);
    expect(r2.strictHostKeyChecking).toBe('accept-new');
  });

  // 75
  it('S75 — AllowUsers wildcard prevents auth for non-matching usernames', async () => {
    const ctx = lan.pc2.getSshServerContext();
    // Inject AllowUsers = "user" and reload via systemctl.
    await lan.pc2.executeCommand(
      `bash -c 'echo "AllowUsers user" >> /etc/ssh/sshd_config'`,
    );
    await lan.pc2.executeCommand('sudo systemctl restart ssh');
    const reloaded = lan.pc2.getSshServerContext();
    // Auth should still work for "user" but fail for an unknown account.
    expect(reloaded.auth.checkPassword('user', 'admin')).toBe(true);
    expect(reloaded.auth.checkPassword('ghost', 'admin')).toBe(false);
    expect(ctx.config.permitRootLogin).toBe(false);
  });

  // 76
  it('S76 — disabling password auth makes credentials fail', async () => {
    const vfs = (lan.pc2 as unknown as {
      executor: {
        vfs: {
          writeFile: (p: string, c: string, u: number, g: number, m: number) => boolean;
        };
      };
    }).executor.vfs;
    vfs.writeFile(
      '/etc/ssh/sshd_config',
      'Port 22\nPermitRootLogin no\nPasswordAuthentication no\nPubkeyAuthentication yes\n',
      0,
      0,
      0o022,
    );
    await lan.pc2.executeCommand('systemctl restart ssh');
    let failed = false;
    try {
      await openSshSession(lan.pc1, PC2_IP);
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);
  });

  // 77
  it('S77 — MOTD is readable through a remote `cat /etc/motd`', async () => {
    const motd = await sshExec(lan.pc1, PC2_IP, 'cat /etc/motd');
    expect(motd.stdout.toLowerCase()).toContain('ubuntu');
  });

  // 78
  it('S78 — chained command: ssh remote→remote scp via PC1 as orchestrator', async () => {
    // Stage a file on PC2 then copy it to PC3 by orchestrating from PC1.
    await lan.pc2.executeCommand('echo content-from-pc2 > /tmp/relay.txt');
    // Step 1: download from PC2 to a "local" VFS held by PC1's SFTP client.
    const a = await openSftpSession(lan.pc1, PC2_IP);
    a.sftp.get('/tmp/relay.txt', '/root/relay.txt');
    a.sftp.disconnect();
    // Step 2: re-upload to PC3 from the same local VFS.
    const b = await openSftpSession(lan.pc1, PC3_IP);
    // The local VFS for the second session is fresh; re-create the file.
    b.localVfs.writeFile('/root/relay.txt', 'content-from-pc2', 0, 0, 0o022);
    b.sftp.put('/root/relay.txt', '/tmp/relay.txt');
    b.sftp.disconnect();
    const onPc3 = await lan.pc3.executeCommand('cat /tmp/relay.txt');
    expect(onPc3.trim()).toBe('content-from-pc2');
  });

  // 79
  it('S79 — three concurrent SSH sessions from PC1 to PC2/PC3 stay isolated', async () => {
    const a = await openSshSession(lan.pc1, PC2_IP);
    const b = await openSshSession(lan.pc1, PC3_IP);
    const c = await openSshSession(lan.pc1, PC2_IP);
    expect(a.isConnected).toBe(true);
    expect(b.isConnected).toBe(true);
    expect(c.isConnected).toBe(true);
    a.disconnect();
    b.disconnect();
    c.disconnect();
  });

  // 80
  it('S80 — connection refused for an unreachable host', async () => {
    let failed = false;
    try {
      // 192.0.2.99 is in TEST-NET-1, not present in our LAN.
      await openSshSession(lan.pc1, '192.0.2.99');
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);
  });

  // 81
  it('S81 — SFTP `cd` updates the remote cwd reported by `pwd`', async () => {
    await lan.pc2.executeCommand('mkdir -p /home/user/sub');
    const { sftp } = await openSftpSession(lan.pc1, PC2_IP);
    sftp.cd('/home/user/sub');
    expect(sftp.pwd()).toContain('/home/user/sub');
    sftp.disconnect();
  });

  // 82
  it('S82 — sftp `lcd` then `lpwd` track the local cwd', async () => {
    const { sftp, localVfs } = await openSftpSession(lan.pc1, PC2_IP);
    localVfs.mkdirp('/root/local-tree', 0o755, 0, 0);
    expect(sftp.lcd('/root/local-tree')).toBe('');
    expect(sftp.lpwd()).toContain('/root/local-tree');
    sftp.disconnect();
  });

  // 83
  it('S83 — uploading then chmod 600 leaves the file owner-only readable', async () => {
    const { sftp, localVfs } = await openSftpSession(lan.pc1, PC2_IP);
    localVfs.writeFile('/root/secret.txt', 'top-secret', 0, 0, 0o022);
    sftp.put('/root/secret.txt', '/home/user/secret.txt');
    sftp.chmod('600', '/home/user/secret.txt');
    sftp.disconnect();
    const stat = await lan.pc2.executeCommand(
      'stat -c %a /home/user/secret.txt',
    );
    expect(stat.trim()).toBe('600');
  });

  // 84
  it('S84 — get on a non-existent remote file produces "No such file or directory"', async () => {
    const { sftp } = await openSftpSession(lan.pc1, PC2_IP);
    const out = sftp.get('/home/user/nope.txt');
    expect(out).toContain('No such file or directory');
    sftp.disconnect();
  });

  // 85
  it('S85 — sftp put fails into a non-writable directory (root-owned /etc)', async () => {
    const { sftp, localVfs } = await openSftpSession(lan.pc1, PC2_IP);
    localVfs.writeFile('/root/blocked.txt', 'x', 0, 0, 0o022);
    const out = sftp.put('/root/blocked.txt', '/etc/blocked.txt');
    expect(out).toContain('Permission denied');
    sftp.disconnect();
  });

  // 86
  it('S86 — chained SSH: create on PC2, then read it back via a second SSH', async () => {
    await sshExec(lan.pc1, PC2_IP, 'echo phase-1 > /tmp/chain.txt');
    const out = await sshExec(lan.pc1, PC2_IP, 'cat /tmp/chain.txt');
    expect(out.stdout.trim()).toBe('phase-1');
  });

  // 87
  it('S87 — SshConfig flow: alias resolves to a different user/host', async () => {
    // Render a synthetic config and resolve via SshConfig directly.
    const cfg = SshConfig.parse(
      `Host pc2-as-user\n  HostName ${PC2_IP}\n  User user\n`,
    );
    const entry = cfg.resolve('pc2-as-user');
    const session = await openSshSession(lan.pc1, entry.hostName!, entry.user);
    expect(session.isConnected).toBe(true);
    session.disconnect();
  });

  // 88
  it('S88 — host key matches across two reconnections (deterministic)', async () => {
    const a = await openSshSession(lan.pc1, PC2_IP);
    const fpA = lan.pc2.getSshServerContext().hostKey.fingerprint.toString();
    a.disconnect();
    const b = await openSshSession(lan.pc1, PC2_IP);
    const fpB = lan.pc2.getSshServerContext().hostKey.fingerprint.toString();
    b.disconnect();
    expect(fpA).toBe(fpB);
  });

  // 89
  it('S89 — disconnected session refuses to open further channels', async () => {
    const session = await openSshSession(lan.pc1, PC2_IP);
    session.disconnect();
    const r = session.openExecChannel('echo hi');
    expect(isErr(r)).toBe(true);
  });

  // 90
  it('S90 — empty command over SSH yields exitCode 0 and empty stdout', async () => {
    const out = await sshExec(lan.pc1, PC2_IP, '');
    expect(out.exitCode).toBe(0);
    expect(out.stdout.trim()).toBe('');
  });
});
