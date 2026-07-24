/**
 * SSH server (real wire) — StrictModes enforcement on public-key auth.
 *
 * `ssh-strict-modes.test.ts` already covers this behaviour through the
 * client-side `ssh` command simulation (`LinuxSshClient.ts`). This suite
 * drives the same scenario through a real `SshSession.connect()` — the
 * path `LinuxTerminalSession.connectAndEnterSsh()` already uses for
 * interactive sessions — to prove `LinuxSshServerContext.checkPublicKey`
 * enforces StrictModes on the wire, not just in the client simulation.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, MACAddress } from '@/network/core/types';
import { Logger } from '@/network/core/Logger';
import { Equipment } from '@/network';
import { isOk } from '@/network/protocols/ssh/Result';
import { SshSession } from '@/network/protocols/ssh/session/SshSession';
import { SshConnectOptionsBuilder } from '@/network/protocols/ssh/SshConnectOptions';
import { SilentSshInteractionHandler } from '@/network/protocols/ssh/session/ISshInteractionHandler';
import { buildLan, assignIps, PC2_IP, type SshLan } from './ssh-lan-fixtures';
import type { LinuxPC } from '@/network/devices/LinuxPC';

function pcInternals(pc: LinuxPC) {
  return (pc as unknown as {
    executor: {
      vfs: {
        mkdirp(p: string, m: number, u: number, g: number): void;
        writeFile(p: string, c: string, u: number, g: number, m: number): void;
      };
      userMgr: { getUser(name: string): { uid?: number; gid?: number } | undefined };
    };
    tcpConnect: (h: string, p: number) => Promise<unknown>;
  }).executor;
}

async function connectWithKeyOnly(lan: SshLan, targetIp: string, user: string) {
  const pc1 = lan.pc1 as unknown as { executor: { vfs: unknown }; tcpConnect: (h: string, p: number) => Promise<unknown> };
  const session = new SshSession({
    tcpConnector: (host, port) => pc1.tcpConnect(host, port) as Promise<never>,
    vfs: pc1.executor.vfs as never,
    localUser: 'root',
    localUid: 0,
    localGid: 0,
    knownHostsPath: '/root/.ssh/known_hosts',
    // Deliberately wrong: if StrictModes fails to block the key, the
    // password fallback would never even be tried and this would not
    // matter — if StrictModes correctly blocks it, this guarantees the
    // whole auth chain (not just publickey) fails, isolating the check.
    interactionHandler: new SilentSshInteractionHandler('definitely-not-the-password'),
  });
  const result = await session.connect(
    SshConnectOptionsBuilder.create()
      .host(targetIp)
      .user(user)
      .port(22)
      .addIdentityFile('/root/.ssh/id_rsa')
      .strictHostKeyChecking('accept-new')
      .build(),
  );
  return { session, result };
}

describe('SSH server (real wire) — StrictModes on public-key auth', () => {
  let lan: SshLan;

  beforeEach(async () => {
    resetCounters();
    MACAddress.resetCounter();
    Logger.reset();
    Equipment.clearRegistry();
    lan = buildLan();
    await assignIps(lan);
  });

  it('accepts the key over the real wire when ~/.ssh and authorized_keys are safely permissioned', async () => {
    await lan.pc1.executeCommand("ssh-keygen -t rsa -N '' -f /root/.ssh/id_rsa");
    const pub = (await lan.pc1.executeCommand('cat /root/.ssh/id_rsa.pub')).trim();

    const srv = pcInternals(lan.pc2);
    const uid = srv.userMgr.getUser('user')?.uid ?? 1000;
    const gid = srv.userMgr.getUser('user')?.gid ?? uid;
    srv.vfs.mkdirp('/home/user/.ssh', 0o700, uid, gid);
    // writeFile's last param is a umask (base mode 0o666), not an absolute
    // mode — 0o066 clears group/other rw, leaving the file at 0o600.
    srv.vfs.writeFile('/home/user/.ssh/authorized_keys', `${pub}\n`, uid, gid, 0o066);

    const { session, result } = await connectWithKeyOnly(lan, PC2_IP, 'user');
    expect(isOk(result)).toBe(true);
    session.disconnect();
  });

  it('refuses the same key over the real wire when authorized_keys is group/world writable', async () => {
    await lan.pc1.executeCommand("ssh-keygen -t rsa -N '' -f /root/.ssh/id_rsa");
    const pub = (await lan.pc1.executeCommand('cat /root/.ssh/id_rsa.pub')).trim();

    const srv = pcInternals(lan.pc2);
    const uid = srv.userMgr.getUser('user')?.uid ?? 1000;
    const gid = srv.userMgr.getUser('user')?.gid ?? uid;
    srv.vfs.mkdirp('/home/user/.ssh', 0o700, uid, gid);
    // Group/world-writable authorized_keys (umask 0 → base mode 0o666) — a
    // real sshd with StrictModes yes (the default) must refuse this key.
    srv.vfs.writeFile('/home/user/.ssh/authorized_keys', `${pub}\n`, uid, gid, 0);

    const { session, result } = await connectWithKeyOnly(lan, PC2_IP, 'user');
    expect(isOk(result)).toBe(false);
    session.disconnect();
  });
});
