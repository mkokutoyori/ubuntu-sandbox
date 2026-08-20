/**
 * The client stops asking once the server has hung up.
 *
 * `PRD-SSH-Unification` §6.2 left this open after measuring it: with
 * `MaxAuthTries 1` on the target, the terminal still offered a second
 * password prompt although the server had closed the connection on the
 * first failure. The transcript read `password:` / `Permission denied,
 * please try again.` / `password:` — an invitation to type into a socket
 * nobody is listening on.
 *
 * The cause is that the wire answer was reduced to a boolean.
 * `SshSession.requestServerAuth` resolves `{ ok: false }` BOTH for a
 * plain rejection and for `conn.onClose` firing, so the two are
 * indistinguishable by the time `PasswordAuthMethod` sees them. And that
 * method reads `ctx.getAttemptsRemaining()` exactly once, before its
 * loop, so even a context that knew would not have been consulted again.
 *
 * Both halves are needed: telling the two apart is useless if nobody
 * asks again, and asking again is useless if the answer cannot tell them
 * apart.
 *
 * This is the wire path EVERY interactive client shares — the terminal's
 * own first hop, `startNestedHop`, and `sshLauncher`'s wire leg — so the
 * fix lands once for all three.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { SshSession, SSH_PASSWORD_PROMPTS } from '@/network/protocols/ssh/session/SshSession';
import { SshConnectOptionsBuilder } from '@/network/protocols/ssh/SshConnectOptions';
import {
  SilentSshInteractionHandler, type HostKeyResponse,
} from '@/network/protocols/ssh/session/ISshInteractionHandler';
import type { TcpConnector } from '@/network/tcp/types';

beforeEach(() => {
  resetCounters();
  MACAddress.resetCounter();
  resetDeviceCounters();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

class CountingHandler extends SilentSshInteractionHandler {
  prompts = 0;
  failuresShown = 0;

  constructor(private readonly answer: string) { super(answer); }

  async promptHostKeyConfirmation(): Promise<HostKeyResponse> {
    return super.promptHostKeyConfirmation();
  }

  async promptPassword(): Promise<string> {
    this.prompts += 1;
    return this.answer;
  }

  showAuthFailure(): void { this.failuresShown += 1; }
}

async function buildPair(maxAuthTries?: number) {
  const pc = new LinuxPC('linux-pc', 'pc', 0, 0);
  const srv = new LinuxServer('linux-server', 'srv', 0, 0);
  new Cable('c').connect(pc.getPorts()[0], srv.getPorts()[0]);
  pc.getPorts()[0].configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
  srv.getPorts()[0].configureIP(new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));
  const userMgr = (srv as unknown as { executor: { userMgr: {
    useradd(u: string, o?: object): void;
    setPassword(u: string, p: string): void;
  } } }).executor.userMgr;
  userMgr.useradd('alice', { createHome: true });
  userMgr.setPassword('alice', 'good');
  if (maxAuthTries !== undefined) {
    await srv.executeCommand(`sh -c 'echo "MaxAuthTries ${maxAuthTries}" >> /etc/ssh/sshd_config'`);
    await srv.executeCommand('systemctl restart ssh');
  }
  return { pc, srv };
}

async function connectWith(pc: LinuxPC, handler: CountingHandler) {
  const session = new SshSession({
    tcpConnector: ((h, p) => (pc as unknown as {
      tcpConnect: (h: string, p: number) => Promise<unknown>;
    }).tcpConnect(h, p)) as TcpConnector,
    vfs: (pc as unknown as { executor: { vfs: unknown } }).executor.vfs as never,
    localUser: 'root', localUid: 0, localGid: 0,
    knownHostsPath: '/root/.ssh/known_hosts',
    interactionHandler: handler,
  });
  const result = await session.connect(
    SshConnectOptionsBuilder.create()
      .host('10.0.0.2').user('alice').port(22)
      .strictHostKeyChecking('accept-new').build(),
  );
  session.disconnect();
  return result;
}

describe('a hung-up server ends the prompting', () => {
  it('MaxAuthTries 1 gives exactly ONE prompt, not three', async () => {
    const { pc } = await buildPair(1);
    const handler = new CountingHandler('wrong');

    const result = await connectWith(pc, handler);

    expect(result.ok).toBe(false);
    expect(handler.prompts).toBe(1);
  });

  it('and no "please try again" is shown for a prompt that never comes', async () => {
    const { pc } = await buildPair(1);
    const handler = new CountingHandler('wrong');

    await connectWith(pc, handler);

    expect(handler.failuresShown).toBe(0);
  });

  it('MaxAuthTries 2 gives exactly two', async () => {
    const { pc } = await buildPair(2);
    const handler = new CountingHandler('wrong');

    await connectWith(pc, handler);

    expect(handler.prompts).toBe(2);
  });
});

describe('the reference: nothing else changes', () => {
  it('the server default leaves the client its three prompts', async () => {
    const { pc } = await buildPair();
    const handler = new CountingHandler('wrong');

    const result = await connectWith(pc, handler);

    expect(result.ok).toBe(false);
    expect(handler.prompts).toBe(SSH_PASSWORD_PROMPTS);
  });

  it('and the right password still connects on the first prompt', async () => {
    // Without this, a lab that simply cannot connect and a correct cut
    // would be indistinguishable: both end in a refusal.
    const { pc } = await buildPair(1);
    const handler = new CountingHandler('good');

    const result = await connectWith(pc, handler);

    expect(result.ok).toBe(true);
    expect(handler.prompts).toBe(1);
  });
});
