/**
 * `MaxAuthTries` belongs to the server, and the interactive `ssh` path
 * never consulted it.
 *
 * What the measurement corrected first, before any code was written.
 * `PRD-SSH-Unification` §6.1 recorded "six refusals, no blocking" for
 * this path. Run against the machine today, that is FALSE, and saying so
 * beats coding against a stale finding: the server's fail2ban-style
 * block does apply (the sixth attempt is refused at connect time,
 * `Connection refused`), and `AllowUsers` / `DenyUsers` /
 * `PermitRootLogin` / a locked account / an empty password are all
 * refused too — because the RIGHT password opens a real wire session,
 * which applies the server's policy.
 *
 * What was genuinely still wrong, and what these cases measure. The only
 * cap on attempts was the constant `3`, copied into `LinuxBashShell`,
 * `WindowsCmdShell`, `WindowsPowerShellShell`, `WindowsTerminalSession`
 * and `SshSession`. But `3` is the CLIENT's `NumberOfPasswordPrompts`, a
 * rule that has nothing to do with the SERVER's `MaxAuthTries`. Measured
 * with `MaxAuthTries 1`: two wrong passwords passed without consequence,
 * and the third attempt — the correct one — opened the session. A real
 * sshd had dropped the connection after the first failure.
 *
 * A wrong password never reaches the wire on this path (it is checked
 * locally), so the server's per-connection counter cannot see it: the
 * launcher now READS the server's rule instead of applying one of its
 * own.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, MACAddress, resetCounters } from '@/network/core/types';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import {
  tryInterpretSshLaunch, finalisePendingAuth, SSH_PASSWORD_PROMPTS,
  type SshLaunchOptions, type PendingSshAuth, type FinaliseAuthOutcome,
} from '@/shell/sshLauncher';
import { readMaxAuthTries } from '@/network/devices/linux/network/LinuxSshClient';
import { reinstallDefaultShells } from '@/shell/registerDefaults';
import { SshSession } from '@/network/protocols/ssh/session/SshSession';
import { SilentSshInteractionHandler } from '@/network/protocols/ssh/session/ISshInteractionHandler';
import { SshConnectOptionsBuilder } from '@/network/protocols/ssh/SshConnectOptions';
import type { TcpConnector } from '@/network/tcp/types';

reinstallDefaultShells();

const CLIENT_IP = '10.0.0.1';
const SERVER_IP = '10.0.0.2';

beforeEach(() => {
  resetCounters();
  MACAddress.resetCounter();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

interface Lab { client: LinuxPC; server: LinuxServer; opts: SshLaunchOptions }

function addAccount(server: LinuxServer, name: string, password: string): void {
  const userMgr = (server as unknown as {
    executor: { userMgr: {
      useradd: (u: string, o?: object) => void;
      setPassword: (u: string, p: string) => void;
    } };
  }).executor.userMgr;
  userMgr.useradd(name, { createHome: true });
  userMgr.setPassword(name, password);
}

function lab(): Lab {
  const client = new LinuxPC('linux-pc', 'CLIENT', 0, 0);
  const server = new LinuxServer('linux-server', 'SERVER', 0, 0);
  new Cable('c1').connect(client.getPorts()[0], server.getPorts()[0]);
  const mask = new SubnetMask('255.255.255.0');
  client.getPorts()[0].configureIP(new IPAddress(CLIENT_IP), mask);
  server.getPorts()[0].configureIP(new IPAddress(SERVER_IP), mask);
  addAccount(server, 'alice', 'goodpassword');
  return {
    client, server,
    opts: {
      defaultUser: 'root', sourceIp: CLIENT_IP, sourceDevice: client,
      wireProbe: (h, p) => client.tcpConnectOutcome(new IPAddress(h), p),
    },
  };
}

async function pendingAuth(opts: SshLaunchOptions, user = 'alice'): Promise<PendingSshAuth> {
  const attempt = await tryInterpretSshLaunch(`ssh ${user}@${SERVER_IP}`, opts);
  expect((attempt as { kind?: string } | null)?.kind).toBe('pending');
  return (attempt as { pendingAuth: PendingSshAuth }).pendingAuth;
}

async function setMaxAuthTries(server: LinuxServer, n: number): Promise<void> {
  await server.executeCommand(`sh -c 'echo "MaxAuthTries ${n}" >> /etc/ssh/sshd_config'`);
  await server.executeCommand('systemctl restart ssh');
}

function refusalMessage(out: FinaliseAuthOutcome): string {
  return out.kind === 'refused' ? out.message : '';
}

describe('MaxAuthTries 1 drops the connection on the first failure', () => {
  it('the FIRST failure is enough, in OpenSSH\'s own words', async () => {
    const { server, opts } = lab();
    await setMaxAuthTries(server, 1);
    const auth = await pendingAuth(opts);

    const first = await finalisePendingAuth(auth, 'wrong');
    expect(first.kind).toBe('refused');
    expect(refusalMessage(first))
      .toContain(`Received disconnect from ${SERVER_IP} port 22:2: Too many authentication failures`);
    expect(refusalMessage(first)).toContain(`Disconnected from ${SERVER_IP} port 22`);
  });

  it('and the RIGHT password no longer rescues anything afterwards', async () => {
    const { server, opts } = lab();
    await setMaxAuthTries(server, 1);
    const auth = await pendingAuth(opts);

    await finalisePendingAuth(auth, 'wrong');
    const good = await finalisePendingAuth(auth, 'goodpassword');

    expect(good.kind).toBe('refused');
    expect(good.kind === 'success').toBe(false);
  });
});

describe('the reference: the default configuration is unchanged', () => {
  it('the right password opens the session', async () => {
    const { opts } = lab();
    const out = await finalisePendingAuth(await pendingAuth(opts), 'goodpassword');
    expect(out.kind).toBe('success');
  });

  it('the server default of 6 leaves the client its 3 prompts', async () => {
    const { opts } = lab();
    const auth = await pendingAuth(opts);
    for (let i = 0; i < SSH_PASSWORD_PROMPTS; i++) {
      expect((await finalisePendingAuth(auth, `wrong${i}`)).kind).toBe('bad-password');
    }
    expect(auth.attempts).toBe(SSH_PASSWORD_PROMPTS);
  });

  it('MaxAuthTries 3 cuts on exactly the third failure', async () => {
    const { server, opts } = lab();
    await setMaxAuthTries(server, 3);
    const auth = await pendingAuth(opts);

    expect((await finalisePendingAuth(auth, 'wrong1')).kind).toBe('bad-password');
    expect((await finalisePendingAuth(auth, 'wrong2')).kind).toBe('bad-password');
    expect((await finalisePendingAuth(auth, 'wrong3')).kind).toBe('refused');
  });
});

describe('MaxAuthTries is read from the server, not the client', () => {
  it('a Match block can harden it for one user only', async () => {
    const { server, opts } = lab();
    addAccount(server, 'bob', 'bobpassword');
    await server.executeCommand(
      `sh -c 'printf "\\nMatch User alice\\n    MaxAuthTries 1\\n" >> /etc/ssh/sshd_config'`);
    await server.executeCommand('systemctl restart ssh');

    expect((await finalisePendingAuth(await pendingAuth(opts, 'alice'), 'wrong')).kind)
      .toBe('refused');

    const bobAuth = await pendingAuth(opts, 'bob');
    expect((await finalisePendingAuth(bobAuth, 'wrong')).kind).toBe('bad-password');
    expect((await finalisePendingAuth(bobAuth, 'wrong2')).kind).toBe('bad-password');
  });

  it('a target with no sshd_config gets no server-side cap at all', () => {
    expect(readMaxAuthTries({}, 'alice')).toBeNull();
    expect(readMaxAuthTries({ executor: {} }, 'alice')).toBeNull();
  });

  it('and a nonsense value in the file does not become a cap', async () => {
    const { server, opts } = lab();
    await setMaxAuthTries(server, 0);
    const auth = await pendingAuth(opts);
    expect((await finalisePendingAuth(auth, 'wrong')).kind).toBe('bad-password');
  });
});

describe('both paths say the same thing about the same server', () => {
  it('the wire path already refused, the interactive path refuses now', async () => {
    const { client, server, opts } = lab();
    await setMaxAuthTries(server, 1);

    const wire = new SshSession({
      tcpConnector: ((h, p) => (client as unknown as {
        tcpConnect: (h: string, p: number) => Promise<unknown>;
      }).tcpConnect(h, p)) as TcpConnector,
      vfs: (client as unknown as { executor: { vfs: unknown } }).executor.vfs as never,
      localUser: 'root', localUid: 0, localGid: 0,
      knownHostsPath: '/root/.ssh/known_hosts',
      interactionHandler: new SilentSshInteractionHandler('wrong'),
    });
    const overTheWire = await wire.connect(
      SshConnectOptionsBuilder.create()
        .host(SERVER_IP).user('alice').port(22)
        .strictHostKeyChecking('accept-new').password('wrong').build(),
    );
    wire.disconnect();
    expect(overTheWire.ok).toBe(false);

    const interactive = await finalisePendingAuth(await pendingAuth(opts), 'wrong');
    expect(interactive.kind).toBe('refused');
  });
});

describe('the client-side cap is a single fact', () => {
  it('the five copies of the constant 3 became one', () => {
    expect(SSH_PASSWORD_PROMPTS).toBe(3);
  });
});
