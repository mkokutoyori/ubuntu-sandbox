/**
 * `ssh user@host command` runs on the REMOTE, as that user.
 *
 * Point 2 of `PRD-SSH-Unification` §6, and the measurement is blunt.
 * `runSshExec` called `auth.target.executeCommand(command)` — the remote
 * equipment's own method, in memory. So the login crossed the cable for
 * real (19 frames, measured) and then the command crossed nothing:
 *
 *   ssh alice@10.0.0.2 whoami  ->  root
 *   ssh alice@10.0.0.2 pwd     ->  /root
 *
 * The simulator authenticated you as alice and ran your command as root.
 * That is not a fidelity nicety; it is the privilege model saying one
 * thing and doing another, on the most ordinary invocation there is.
 *
 * Everything needed was already built and already used elsewhere:
 * `openWireSshConnection` (whose own header explains why exec mode must
 * NOT open a shell channel — a login session the user never ended would
 * be narrated in syslog) and `session.openExecChannel(cmd).execute()`,
 * which the port forwarders already drive. The server end runs each exec
 * through `ctx.getShell(userCtx, cwd)`, so the user and the home
 * directory come from the authenticated session rather than from the
 * device's default shell.
 *
 * The frame counter is what separates "the right answer" from "the right
 * answer obtained by cheating": a command answered without a single
 * frame on the cable did not run on the remote, however plausible its
 * output.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, MACAddress, resetCounters } from '@/network/core/types';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import {
  tryInterpretSshLaunch, finalisePendingAuth,
  type SshLaunchOptions, type PendingSshAuth, type FinaliseAuthOutcome,
} from '@/shell/sshLauncher';
import { reinstallDefaultShells } from '@/shell/registerDefaults';

reinstallDefaultShells();

const CLIENT_IP = '10.0.0.1';
const SERVER_IP = '10.0.0.2';

beforeEach(() => {
  resetCounters();
  MACAddress.resetCounter();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

interface Lab { client: LinuxPC; server: LinuxServer; cable: Cable; opts: SshLaunchOptions }

function lab(): Lab {
  const client = new LinuxPC('linux-pc', 'CLIENT', 0, 0);
  const server = new LinuxServer('linux-server', 'SERVER', 0, 0);
  const cable = new Cable('c1');
  cable.connect(client.getPorts()[0], server.getPorts()[0]);
  const mask = new SubnetMask('255.255.255.0');
  client.getPorts()[0].configureIP(new IPAddress(CLIENT_IP), mask);
  server.getPorts()[0].configureIP(new IPAddress(SERVER_IP), mask);
  const userMgr = (server as unknown as {
    executor: { userMgr: {
      useradd: (u: string, o?: object) => void;
      setPassword: (u: string, p: string) => void;
    } };
  }).executor.userMgr;
  userMgr.useradd('alice', { createHome: true });
  userMgr.setPassword('alice', 'good');
  return {
    client, server, cable,
    opts: {
      defaultUser: 'root', sourceIp: CLIENT_IP, sourceDevice: client,
      wireProbe: (h, p) => client.tcpConnectOutcome(new IPAddress(h), p),
    },
  };
}

async function sshExec(l: Lab, line: string, password = 'good'): Promise<FinaliseAuthOutcome> {
  const attempt = await tryInterpretSshLaunch(line, l.opts);
  expect((attempt as { kind?: string } | null)?.kind).toBe('pending');
  const auth = (attempt as { pendingAuth: PendingSshAuth }).pendingAuth;
  return finalisePendingAuth(auth, password);
}

function execLines(out: FinaliseAuthOutcome): readonly string[] {
  expect(out.kind).toBe('exec');
  return (out as { kind: 'exec'; lines: readonly string[] }).lines;
}

describe('the command runs as the user who logged in', () => {
  it('whoami answers the ssh user, not the device\'s default root', async () => {
    const l = lab();
    expect(execLines(await sshExec(l, `ssh alice@${SERVER_IP} whoami`))).toEqual(['alice']);
  });

  it('and the working directory is that user\'s home', async () => {
    const l = lab();
    expect(execLines(await sshExec(l, `ssh alice@${SERVER_IP} pwd`))).toEqual(['/home/alice']);
  });

  it('a second account gets its own answer, not a constant', async () => {
    // The reference for the two cases above. A client that simply echoed
    // the name it was given would pass them both while proving nothing
    // about where the answer comes from; two different accounts on the
    // same server, each answering itself, is what distinguishes a real
    // remote execution from a plausible echo.
    //
    // Root is deliberately NOT the second account: `PermitRootLogin` is
    // `prohibit-password` by default, so a password login as root is
    // refused by the server — measured, and correct.
    const l = lab();
    const userMgr = (l.server as unknown as {
      executor: { userMgr: {
        useradd: (u: string, o?: object) => void;
        setPassword: (u: string, p: string) => void;
      } };
    }).executor.userMgr;
    userMgr.useradd('bob', { createHome: true });
    userMgr.setPassword('bob', 'bobpw');

    expect(execLines(await sshExec(l, `ssh bob@${SERVER_IP} whoami`, 'bobpw'))).toEqual(['bob']);
    expect(execLines(await sshExec(l, `ssh bob@${SERVER_IP} pwd`, 'bobpw'))).toEqual(['/home/bob']);
  });
});

describe('the command really crosses the cable', () => {
  async function framesFor(line: string): Promise<number> {
    const l = lab();
    const attempt = await tryInterpretSshLaunch(line, l.opts);
    const auth = (attempt as { pendingAuth: PendingSshAuth }).pendingAuth;
    const before = l.cable.getStats().framesTransmitted;
    await finalisePendingAuth(auth, 'good');
    return l.cable.getStats().framesTransmitted - before;
  }

  it('the command costs frames of its OWN, beyond the login\'s', async () => {
    // Counting the whole exchange proves nothing: the login already
    // crossed the cable before this fix, so a total above zero was
    // already true while the command ran in memory. What discriminates
    // is the DIFFERENCE between the same login with and without a
    // command — that difference is the command's own traffic, and it was
    // exactly zero.
    const withCommand = await framesFor(`ssh alice@${SERVER_IP} whoami`);
    const loginOnly = await framesFor(`ssh alice@${SERVER_IP}`);

    expect(withCommand).toBeGreaterThan(loginOnly);
  });

  it('the remote\'s own error text comes back for an unknown command', async () => {
    const l = lab();
    const lines = execLines(await sshExec(l, `ssh alice@${SERVER_IP} definitely-not-a-command`));
    expect(lines.join('\n')).toMatch(/not found|No such file/i);
  });

  it('a multi-word command keeps its arguments', async () => {
    const l = lab();
    expect(execLines(await sshExec(l, `ssh alice@${SERVER_IP} echo hello world`)))
      .toEqual(['hello world']);
  });
});

describe('the references: nothing else moves', () => {
  it('a bare ssh with no command is still an interactive session', async () => {
    const l = lab();
    const out = await sshExec(l, `ssh alice@${SERVER_IP}`);
    expect(out.kind).toBe('success');
  });

  it('a wrong password is refused before any command runs', async () => {
    const l = lab();
    const out = await sshExec(l, `ssh alice@${SERVER_IP} whoami`, 'wrong');
    expect(out.kind).toBe('bad-password');
  });
});
