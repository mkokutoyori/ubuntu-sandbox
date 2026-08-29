import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { LinuxTerminalSession } from '@/terminal/sessions/LinuxTerminalSession';
import { WindowsTerminalSession } from '@/terminal/sessions/WindowsTerminalSession';
import { CLITerminalSession } from '@/terminal/sessions/CLITerminalSession';
import { CiscoTerminalSession } from '@/terminal/sessions/CiscoTerminalSession';
import type { TerminalSession } from '@/terminal/sessions/TerminalSession';
import { installDefaultShells } from '@/shell/registerDefaults';

beforeEach(() => {
  installDefaultShells();
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
  EquipmentRegistry.getInstance().clear();
});

const MASK = new SubnetMask('255.255.255.0');
const key = (k: string) =>
  ({ key: k, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false }) as never;

const flush = async () => {
  for (let i = 0; i < 40; i++) { await Promise.resolve(); await new Promise<void>((r) => setTimeout(r, 0)); }
};

async function line(term: TerminalSession, text: string): Promise<void> {
  const fg = term.foreground as unknown as {
    setInput: (v: string) => void; setInputBuf: (v: string) => void; handleKey: (e: unknown) => void;
  };
  // At a root prompt the view writes the console buffer; the sub-shell
  // buffer is what it fills once a sub-shell owns the keyboard. Driving
  // both at the root would take a dispatch branch the user cannot reach.
  fg.setInput(text);
  fg.handleKey(key('Enter'));
  await flush();
}

async function answerPassword(term: TerminalSession, password: string): Promise<void> {
  for (let i = 0; i < 60 && term.foreground.currentInputMode.type !== 'password'; i++) await flush();
  const fg = term.foreground as unknown as { setPasswordBuf: (v: string) => void; handleKey: (e: unknown) => void };
  fg.setPasswordBuf(password);
  fg.handleKey(key('Enter'));
  await flush();
}

type ClientKind = 'linux' | 'windows' | 'cisco';

interface Lab {
  term: TerminalSession;
  server: LinuxServer;
}

async function labFor(clientKind: ClientKind): Promise<Lab> {
  const sw = new GenericSwitch('switch-generic', 'SW');
  const srv = new LinuxServer('linux-server', 'SRV1');
  srv.getPorts()[0].configureIP(new IPAddress('10.0.80.9'), MASK);
  new Cable('cs').connect(srv.getPorts()[0], sw.getPorts()[0]);

  let term: TerminalSession;
  if (clientKind === 'linux') {
    const pc = new LinuxPC('linux-pc', 'PC1');
    pc.getPorts()[0].configureIP(new IPAddress('10.0.80.1'), MASK);
    new Cable('cc').connect(pc.getPorts()[0], sw.getPorts()[1]);
    term = new LinuxTerminalSession('t1', pc);
  } else if (clientKind === 'windows') {
    const win = new WindowsPC('windows-pc', 'WIN1');
    win.getPorts()[0].configureIP(new IPAddress('10.0.80.2'), MASK);
    new Cable('cc').connect(win.getPorts()[0], sw.getPorts()[2]);
    term = new WindowsTerminalSession('t1', win);
  } else {
    const cisco = new CiscoRouter('router-cisco', 'R1');
    new Cable('cc').connect(cisco.getPorts()[0], sw.getPorts()[3]);
    for (const cmd of [
      'enable', 'configure terminal', 'hostname R1',
      `interface ${cisco.getPortNames()[0]}`, 'ip address 10.0.80.3 255.255.255.0', 'no shutdown', 'exit',
      'ip domain-name lab.local', 'crypto key generate rsa modulus 2048', 'ip ssh version 2', 'end',
    ]) await cisco.executeCommand(cmd);
    term = new CiscoTerminalSession('t1', cisco);
  }
  await term.init?.();
  return { term, server: srv };
}

/** Inbound TCP connections sshd has accepted, as auth.log records them. */
function openedConnections(server: LinuxServer): number {
  const log = server.executeShellCommandSync('cat /var/log/auth.log');
  return (log.match(/Connection from \S+ port \d+ on/g) ?? []).length;
}

/** Connections sshd saw close without ever authenticating. */
function abandonedConnections(server: LinuxServer): number {
  const log = server.executeShellCommandSync('cat /var/log/auth.log');
  return (log.match(/Connection closed by unknown user/g) ?? []).length;
}

const CLIENTS: readonly ClientKind[] = ['linux', 'windows', 'cisco'];

const UNREACHABLE_WORDING: Readonly<Record<ClientKind, RegExp>> = {
  linux: /ssh: connect to host 10\.0\.80\.9 port 22: No route to host/,
  windows: /ssh: connect to host 10\.0\.80\.9 port 22: No route to host/,
  cisco: /% Connection timed out; remote host not responding/,
};

describe.each(CLIENTS)('one `ssh` from a %s client', (clientKind) => {
  it('opens exactly one connection, and never abandons one', async () => {
    const { term, server } = await labFor(clientKind);
    await line(term, 'ssh alice@10.0.80.9');
    await answerPassword(term, 'alice');
    expect(term.foreground.getPrompt()).toMatch(/alice@/);

    expect(
      openedConnections(server),
      'a real ssh client connects once — reachability is settled by that connection, not by a throwaway probe before it',
    ).toBe(1);
    expect(
      abandonedConnections(server),
      'no connection should be opened and dropped before authentication',
    ).toBe(0);
  }, 40000);

  it('still refuses to connect once the path to the host is gone', async () => {
    const { term, server } = await labFor(clientKind);
    server.getPorts()[0].getCable()?.disconnect();
    await line(term, 'ssh alice@10.0.80.9');
    await flush();

    const text = term.lines.map((l) => l.text).join('\n');
    expect(
      text,
      'dropping the pre-flight probe must not turn an unreachable host into a hang or a login',
    ).toMatch(UNREACHABLE_WORDING[clientKind]);
    expect(term.foreground.getPrompt()).not.toMatch(/alice@/);
  }, 40000);
});
