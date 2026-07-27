/**
 * The interactive `ssh` entry point (`sshLauncher.ts`, used by the real
 * terminal — `LinuxBashShell`/`WindowsCmdShell`/`WindowsPowerShellShell`)
 * used to be a thinner reimplementation than `LinuxSshClient.ts` (the
 * `executeCommand('ssh ...')` path exercised by scenario 8/9's tests):
 * it never checked ForceCommand or compared the presented host key
 * against `known_hosts`, so a user typing `ssh` directly into the
 * terminal bypassed both a ChrootDirectory/ForceCommand jail and MITM
 * host-key-change detection entirely. These tests drive the same
 * `tryInterpretSshLaunch`/`finalisePendingAuth` functions the real
 * terminal calls, not `executeCommand()`, to lock in the fix.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, MACAddress, resetCounters } from '@/network/core/types';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import {
  tryInterpretSshLaunch,
  finalisePendingAuth,
  type SshLaunchOptions,
  type PendingSshAuth,
} from '@/shell/sshLauncher';
import { reinstallDefaultShells } from '@/shell/registerDefaults';

reinstallDefaultShells();

const CLIENT_IP = '10.0.0.1';
const SERVER_IP = '10.0.0.2';

interface Lab { client: LinuxPC; server: LinuxServer }

async function buildLab(): Promise<Lab> {
  const client = new LinuxPC('linux-pc', 'CLIENT', 0, 0);
  const server = new LinuxServer('linux-server', 'SERVER', 0, 0);
  new Cable('c1').connect(client.getPorts()[0], server.getPorts()[0]);
  const mask = new SubnetMask('255.255.255.0');
  client.getPorts()[0].configureIP(new IPAddress(CLIENT_IP), mask);
  server.getPorts()[0].configureIP(new IPAddress(SERVER_IP), mask);
  return { client, server };
}

function launchOpts(client: LinuxPC): SshLaunchOptions {
  return {
    defaultUser: 'root',
    sourceIp: CLIENT_IP,
    sourceDevice: client,
    wireProbe: (host, port) => client.tcpConnectOutcome(new IPAddress(host), port),
  };
}

async function pendingAuthFor(line: string, client: LinuxPC): Promise<PendingSshAuth> {
  const attempt = await tryInterpretSshLaunch(line, launchOpts(client));
  expect(attempt?.kind).toBe('pending');
  return (attempt as { pendingAuth: PendingSshAuth }).pendingAuth;
}

beforeEach(() => {
  resetCounters();
  MACAddress.resetCounter();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

describe('ssh interactif (terminal réel) — chroot / ForceCommand', () => {
  async function provisionChroot(server: LinuxServer): Promise<void> {
    const um = (server as unknown as { executor: { userMgr: {
      useradd: (u: string, o?: object) => void; setPassword: (u: string, p: string) => void; getUser: (u: string) => unknown;
    } } }).executor.userMgr;
    if (!um.getUser('sftponly')) {
      um.useradd('sftponly', { m: true, s: '/sbin/nologin' });
      um.setPassword('sftponly', 'secret');
    }
    await server.executeCommand('mkdir -p /srv/sftp/sftponly/upload');
    await server.executeCommand('chown root:root /srv/sftp /srv/sftp/sftponly');
    await server.executeCommand('chmod 755 /srv/sftp /srv/sftp/sftponly');
    await server.executeCommand(
      `sh -c 'printf "Match User sftponly\\n  ChrootDirectory /srv/sftp/sftponly\\n  ForceCommand internal-sftp\\n" >> /etc/ssh/sshd_config'`,
    );
    await server.executeCommand('systemctl reload ssh');
  }

  it('un `ssh sftponly@host` interactif (sans commande) est refusé avant même la construction du shell', async () => {
    const { client, server } = await buildLab();
    await provisionChroot(server);
    const auth = await pendingAuthFor(`ssh sftponly@${SERVER_IP}`, client);
    const finalised = await finalisePendingAuth(auth, 'secret');
    expect(finalised.kind).toBe('refused');
    if (finalised.kind !== 'refused') throw new Error('unreachable');
    expect(finalised.message).toMatch(/sftp connections only/i);
  });

  it('un compte sans ForceCommand obtient bien un shell interactif (pas de régression)', async () => {
    // `alice` est preseedée sur tout LinuxServer fraîchement créé, mot de passe "alice".
    const { client } = await buildLab();
    const auth = await pendingAuthFor(`ssh alice@${SERVER_IP}`, client);
    const finalised = await finalisePendingAuth(auth, 'alice');
    expect(finalised.kind).toBe('success');
    if (finalised.kind !== 'success') throw new Error('unreachable');
    finalised.shell.dispose();
  });
});

describe('ssh interactif (terminal réel) — détection MITM par changement de clé d\'hôte', () => {
  function readPubKey(server: LinuxServer): string {
    const raw = (server as unknown as { executor: { vfs: { readFile: (p: string) => string | null } } })
      .executor.vfs.readFile('/etc/ssh/ssh_host_ed25519_key.pub') ?? '';
    return raw.trim().split(/\s+/)[1] ?? '';
  }

  it('première connexion interactive enregistre la clé serveur dans le known_hosts réel (VFS)', async () => {
    const { client, server } = await buildLab();
    const auth = await pendingAuthFor(`ssh alice@${SERVER_IP}`, client);
    const finalised = await finalisePendingAuth(auth, 'alice');
    expect(finalised.kind).toBe('success');
    if (finalised.kind !== 'success') throw new Error('unreachable');
    finalised.shell.dispose();

    const kh = await client.executeCommand('cat /root/.ssh/known_hosts');
    expect(kh).toContain(SERVER_IP);
    expect(kh).toContain(readPubKey(server));
  });

  it('reconnexion interactive après rotation de la clé serveur est refusée avec le WARNING MITM', async () => {
    const { client, server } = await buildLab();

    const first = await pendingAuthFor(`ssh alice@${SERVER_IP}`, client);
    const firstAuth = await finalisePendingAuth(first, 'alice');
    expect(firstAuth.kind).toBe('success');
    if (firstAuth.kind === 'success') firstAuth.shell.dispose();

    await server.executeCommand('rm -f /etc/ssh/ssh_host_ed25519_key /etc/ssh/ssh_host_ed25519_key.pub');
    await server.executeCommand('ssh-keygen -A');

    const second = await pendingAuthFor(`ssh alice@${SERVER_IP}`, client);
    const finalised = await finalisePendingAuth(second, 'alice');
    expect(finalised.kind).toBe('refused');
    if (finalised.kind !== 'refused') throw new Error('unreachable');
    expect(finalised.message).toMatch(/WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!/);
  });

  it('la connexion réussit à nouveau après ssh-keygen -R côté client', async () => {
    const { client, server } = await buildLab();

    const first = await pendingAuthFor(`ssh alice@${SERVER_IP}`, client);
    const firstAuth = await finalisePendingAuth(first, 'alice');
    if (firstAuth.kind === 'success') firstAuth.shell.dispose();

    await server.executeCommand('rm -f /etc/ssh/ssh_host_ed25519_key /etc/ssh/ssh_host_ed25519_key.pub');
    await server.executeCommand('ssh-keygen -A');

    const blockedAuth = await pendingAuthFor(`ssh alice@${SERVER_IP}`, client);
    expect((await finalisePendingAuth(blockedAuth, 'alice')).kind).toBe('refused');

    await client.executeCommand(`ssh-keygen -R ${SERVER_IP}`);

    const retryAuth = await pendingAuthFor(`ssh alice@${SERVER_IP}`, client);
    const retry = await finalisePendingAuth(retryAuth, 'alice');
    expect(retry.kind).toBe('success');
    if (retry.kind === 'success') retry.shell.dispose();
  });
});
