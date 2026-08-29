import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
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

/** Feed one line to whichever session currently has the keyboard. */
async function line(term: TerminalSession, text: string): Promise<void> {
  const fg = term.foreground as unknown as { setInputBuf: (v: string) => void; handleKey: (e: unknown) => void };
  fg.setInputBuf(text);
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

const text = (term: TerminalSession) => term.lines.map((l) => l.text).join('\n');

type Vendor = 'linux' | 'windows' | 'cisco' | 'huawei';

interface Peer {
  readonly login: string;
  readonly password: string;
  readonly promptPattern: RegExp;
  /** A harmless command every one of these shells understands. */
  readonly commands: readonly string[];
}

const PEERS: Record<Vendor, Peer> = {
  linux:   { login: 'alice', password: 'alice',      promptPattern: /alice@/,   commands: ['whoami', 'pwd', 'echo one', 'echo two', 'hostname'] },
  windows: { login: 'User',  password: 'user',       promptPattern: /C:\\/,     commands: ['whoami', 'cd', 'ver', 'hostname', 'echo one'] },
  cisco:   { login: 'admin', password: 'Admin@123',  promptPattern: /R9[>#]/,   commands: ['show clock', 'show version', 'show users', 'show clock', 'show version'] },
  huawei:  { login: 'admin', password: 'Admin@123',  promptPattern: /<R9>/,     commands: ['display clock', 'display version', 'display users', 'display clock', 'display version'] },
};

/**
 * One switch, one cable per device, so `clientCable.disconnect()` is a
 * pulled link whatever vendor is driving and whatever vendor answers.
 */
interface Lab {
  term: TerminalSession;
  clientCable: Cable;
  server: LinuxServer;
  peerIp: string;
}

async function configureCiscoPeer(dev: CiscoRouter, ip: string, hostname: string): Promise<void> {
  for (const cmd of [
    'enable', 'configure terminal', `hostname ${hostname}`,
    `interface ${dev.getPortNames()[0]}`, `ip address ${ip} 255.255.255.0`, 'no shutdown', 'exit',
    'username admin privilege 15 secret Admin@123', 'enable secret Admin@123',
    'ip domain-name lab.local', 'crypto key generate rsa modulus 2048', 'ip ssh version 2',
    'line vty 0 4', 'login local', 'transport input ssh', 'end',
  ]) await dev.executeCommand(cmd);
}

async function configureHuaweiPeer(dev: HuaweiRouter, ip: string, hostname: string): Promise<void> {
  for (const cmd of [
    'system-view', `sysname ${hostname}`,
    `interface ${dev.getPortNames()[0]}`, `ip address ${ip} 255.255.255.0`, 'undo shutdown', 'quit',
    'aaa', 'local-user admin password irreversible-cipher Admin@123',
    'local-user admin privilege level 15', 'local-user admin service-type ssh terminal', 'quit',
    'rsa local-key-pair create', 'stelnet server enable',
    'ssh user admin authentication-type password', 'ssh user admin service-type stelnet',
    'user-interface vty 0 4', 'authentication-mode aaa', 'protocol inbound ssh', 'quit', 'quit',
  ]) await dev.executeCommand(cmd);
}

async function labFor(clientKind: Vendor, peerKind: Vendor): Promise<Lab> {
  const sw = new GenericSwitch('switch-generic', 'SW');
  const srv = new LinuxServer('linux-server', 'SRV1');
  srv.getPorts()[0].configureIP(new IPAddress('10.0.70.9'), MASK);
  new Cable('cs').connect(srv.getPorts()[0], sw.getPorts()[0]);

  const peerIp = '10.0.70.20';
  if (peerKind === 'linux') {
    // The Linux server on the segment already answers; reuse it.
  } else if (peerKind === 'windows') {
    const peer = new WindowsPC('windows-pc', 'WINPEER');
    peer.getPorts()[0].configureIP(new IPAddress(peerIp), MASK);
    new Cable('cp').connect(peer.getPorts()[0], sw.getPorts()[4]);
  } else if (peerKind === 'cisco') {
    const peer = new CiscoRouter('router-cisco', 'RPEER');
    new Cable('cp').connect(peer.getPorts()[0], sw.getPorts()[4]);
    await configureCiscoPeer(peer, peerIp, 'R9');
  } else {
    const peer = new HuaweiRouter('router-huawei', 'RPEER');
    new Cable('cp').connect(peer.getPorts()[0], sw.getPorts()[4]);
    await configureHuaweiPeer(peer, peerIp, 'R9');
  }

  const clientCable = new Cable('cc');
  let term: TerminalSession;

  if (clientKind === 'linux') {
    const pc = new LinuxPC('linux-pc', 'PC1');
    pc.getPorts()[0].configureIP(new IPAddress('10.0.70.1'), MASK);
    clientCable.connect(pc.getPorts()[0], sw.getPorts()[1]);
    term = new LinuxTerminalSession('t1', pc);
  } else if (clientKind === 'windows') {
    const win = new WindowsPC('windows-pc', 'WIN1');
    win.getPorts()[0].configureIP(new IPAddress('10.0.70.2'), MASK);
    clientCable.connect(win.getPorts()[0], sw.getPorts()[2]);
    term = new WindowsTerminalSession('t1', win);
  } else {
    const cisco = new CiscoRouter('router-cisco', 'R1');
    clientCable.connect(cisco.getPorts()[0], sw.getPorts()[3]);
    await configureCiscoPeer(cisco, '10.0.70.3', 'R1');
    term = new CiscoTerminalSession('t1', cisco);
  }

  await term.init?.();
  return { term, clientCable, server: srv, peerIp: peerKind === 'linux' ? '10.0.70.9' : peerIp };
}

/** How many inbound TCP connections sshd has logged so far. */
function acceptedConnections(server: LinuxServer): number {
  const log = server.executeShellCommandSync('cat /var/log/auth.log');
  return (log.match(/Connection from \S+ port \d+ on/g) ?? []).length;
}

const CLIENTS: readonly Vendor[] = ['linux', 'windows', 'cisco'];
const PEER_KINDS: readonly Vendor[] = ['linux', 'windows', 'cisco', 'huawei'];

describe.each(CLIENTS)('an SSH session opened from a %s client', (clientKind) => {
  it('opens no further connection per command', async () => {
    const { term, server } = await labFor(clientKind, 'linux');
    const peer = PEERS.linux;
    await line(term, `ssh ${peer.login}@10.0.70.9`);
    await answerPassword(term, peer.password);
    expect(term.foreground.getPrompt()).toMatch(peer.promptPattern);

    const afterLogin = acceptedConnections(server);
    for (const cmd of peer.commands) await line(term, cmd);

    expect(
      acceptedConnections(server),
      'a real ssh client reuses its channel; it does not reconnect per command',
    ).toBe(afterLogin);
  }, 40000);
});

const PAIRS: readonly (readonly [Vendor, Vendor])[] =
  CLIENTS.flatMap((c) => PEER_KINDS.map((p) => [c, p] as const));

describe.each(PAIRS)('a %s client onto a %s peer', (clientKind, peerKind) => {
  const peer = PEERS[peerKind];

  it('reaches the remote prompt', async () => {
    const { term, peerIp } = await labFor(clientKind, peerKind);
    await line(term, `ssh ${peer.login}@${peerIp}`);
    await answerPassword(term, peer.password);
    expect(term.foreground.getPrompt()).toMatch(peer.promptPattern);
  }, 40000);

  it('reports a broken pipe once the link is pulled', async () => {
    const { term, clientCable, peerIp } = await labFor(clientKind, peerKind);
    await line(term, `ssh ${peer.login}@${peerIp}`);
    await answerPassword(term, peer.password);
    await line(term, peer.commands[0]);
    clientCable.disconnect();
    await line(term, peer.commands[0]);

    expect(
      text(term),
      'link loss is a transport fact — every vendor on either end dies the same way',
    ).toMatch(/Broken pipe/);
  }, 40000);
});
