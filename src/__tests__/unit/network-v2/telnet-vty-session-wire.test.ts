/**
 * A telnet session toward a router VTY is a real session, not a banner.
 *
 * The port-23 listener already existed and already answered the SYN, so
 * the connect verdict came from the wire — but `onAccept` was empty, so
 * nothing ever followed: no negotiation, no login, no prompt
 * (docs/PRD-VTY-Transport.md §1.3 item 6, §2.1 item 6).
 *
 * These drive the router through a raw TCP socket opened by a real Linux
 * client over real cabling: what goes out is what the operator typed,
 * what comes back is what the device's own CLI produced.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import {
  DO, DONT, IAC, WILL, WONT,
  OPT_ECHO, OPT_NAWS, OPT_SUPPRESS_GO_AHEAD, OPT_TERMINAL_TYPE,
  encodeNegotiation, encodeSubnegotiation, parseTelnetChunk, toNvtText, fromNvtText,
} from '@/network/protocols/telnet/TelnetCodec';
import { TelnetNegotiator } from '@/network/protocols/telnet/TelnetNegotiator';

const MASK = '255.255.255.0';
const PC_IP = '10.0.0.1';
const CISCO_IP = '10.0.0.6';
const HUAWEI_IP = '10.0.0.8';

interface WireSocket {
  write(data: string): void;
  close(): void;
  onData(handler: (data: string) => void): () => void;
}

/** A minimal telnet client: answers the negotiation, keeps the printable text. */
class TelnetClient {
  private carry: readonly number[] = [];
  private readonly negotiator = new TelnetNegotiator({ offer: [], request: [] });
  received = '';
  rawReceived = '';

  constructor(private readonly socket: WireSocket) {
    socket.onData((chunk) => {
      this.rawReceived += chunk;
      const parsed = parseTelnetChunk(chunk, this.carry);
      this.carry = parsed.carry;
      const reply = this.negotiator.respond(parsed.negotiations);
      if (reply) socket.write(reply);
      this.received += fromNvtText(parsed.data);
    });
  }

  send(line: string): void { this.socket.write(toNvtText(`${line}\n`)); }
  clear(): void { this.received = ''; }
  close(): void { this.socket.close(); }
}

async function connectTelnet(pc: LinuxPC, ip: string): Promise<TelnetClient> {
  const socket = await (pc as unknown as { tcpConnect: (h: string, p: number) => Promise<WireSocket | null> })
    .tcpConnect(ip, 23);
  if (!socket) throw new Error(`no telnet socket to ${ip}`);
  return new TelnetClient(socket);
}

/** Lets the handler's promise chain (async `shell.execute`) settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
}

async function buildCiscoLan(): Promise<{ pc: LinuxPC; cisco: CiscoRouter }> {
  const pc = new LinuxPC('linux-pc', 'pc1', 0, 0);
  const cisco = new CiscoRouter('cisco1', 0, 0);
  const sw = new GenericSwitch('switch-generic', 'sw', 8, 0, 0);
  new Cable('c1').connect(pc.getPorts()[0], sw.getPorts()[0]);
  new Cable('c2').connect(cisco.getPorts()[0], sw.getPorts()[1]);
  pc.getPorts()[0].configureIP(new IPAddress(PC_IP), new SubnetMask(MASK));
  for (const cmd of [
    'enable', 'configure terminal',
    'interface GigabitEthernet0/0',
    `ip address ${CISCO_IP} ${MASK}`,
    'no shutdown', 'end',
  ]) await cisco.executeCommand(cmd);
  await pc.executeCommand(`ping -c 1 ${CISCO_IP}`);
  return { pc, cisco };
}

async function buildHuaweiLan(): Promise<{ pc: LinuxPC; huawei: HuaweiRouter }> {
  const pc = new LinuxPC('linux-pc', 'pc1', 0, 0);
  const huawei = new HuaweiRouter('huawei1', 0, 0);
  const sw = new GenericSwitch('switch-generic', 'sw', 8, 0, 0);
  new Cable('c1').connect(pc.getPorts()[0], sw.getPorts()[0]);
  new Cable('c2').connect(huawei.getPorts()[0], sw.getPorts()[1]);
  pc.getPorts()[0].configureIP(new IPAddress(PC_IP), new SubnetMask(MASK));
  for (const cmd of [
    'system-view',
    'interface GigabitEthernet0/0/0',
    `ip address ${HUAWEI_IP} ${MASK}`,
    'undo shutdown', 'quit', 'quit',
  ]) await huawei.executeCommand(cmd);
  await pc.executeCommand(`ping -c 1 ${HUAWEI_IP}`);
  return { pc, huawei };
}

beforeEach(() => { EquipmentRegistry.resetInstance(); });

describe('TelnetCodec — RFC 854 framing', () => {
  it('separates in-band data from option negotiation', () => {
    const chunk = `${encodeNegotiation(DO, OPT_ECHO)}hello${encodeNegotiation(WILL, OPT_NAWS)}`;
    const parsed = parseTelnetChunk(chunk);
    expect(parsed.data).toBe('hello');
    expect(parsed.negotiations).toEqual([
      { verb: DO, option: OPT_ECHO },
      { verb: WILL, option: OPT_NAWS },
    ]);
  });

  it('collapses a doubled IAC back to one literal 0xFF', () => {
    const parsed = parseTelnetChunk(`a${String.fromCharCode(IAC, IAC)}b`);
    expect(parsed.data).toBe(`a${String.fromCharCode(0xff)}b`);
    expect(parsed.negotiations).toHaveLength(0);
  });

  it('escapes a literal 0xFF on the way out so it is not read back as IAC', () => {
    const out = toNvtText(`x${String.fromCharCode(0xff)}y`);
    expect(parseTelnetChunk(out).data).toBe(`x${String.fromCharCode(0xff)}y`);
  });

  it('reads a subnegotiation, IAC-escaped payload included', () => {
    const parsed = parseTelnetChunk(encodeSubnegotiation(OPT_TERMINAL_TYPE, [0, 0xff, 65]));
    expect(parsed.subnegotiations).toEqual([{ option: OPT_TERMINAL_TYPE, params: [0, 0xff, 65] }]);
    expect(parsed.data).toBe('');
  });

  it('carries a sequence split across two segments instead of leaking option bytes', () => {
    const whole = `${encodeNegotiation(DO, OPT_SUPPRESS_GO_AHEAD)}ok`;
    const first = parseTelnetChunk(whole.slice(0, 2));
    expect(first.data).toBe('');
    expect(first.negotiations).toHaveLength(0);
    const second = parseTelnetChunk(whole.slice(2), first.carry);
    expect(second.negotiations).toEqual([{ verb: DO, option: OPT_SUPPRESS_GO_AHEAD }]);
    expect(second.data).toBe('ok');
  });

  it('reads CR LF, CR NUL and bare CR as one end of line', () => {
    expect(fromNvtText('a\r\nb\r\0c\rd')).toBe('a\nb\nc\nd');
  });
});

describe('TelnetNegotiator — RFC 855 state machine', () => {
  it('refuses an option it does not implement, and refuses it only once', () => {
    const n = new TelnetNegotiator({ offer: [OPT_ECHO], request: [] });
    expect(n.respond([{ verb: DO, option: OPT_NAWS }])).toBe(encodeNegotiation(WONT, OPT_NAWS));
    expect(n.respond([{ verb: DO, option: OPT_NAWS }])).toBe('');
  });

  it('grants an option it offers, and does not acknowledge it twice', () => {
    const n = new TelnetNegotiator({ offer: [OPT_ECHO], request: [] });
    expect(n.respond([{ verb: DO, option: OPT_ECHO }])).toBe(encodeNegotiation(WILL, OPT_ECHO));
    expect(n.isLocalEnabled(OPT_ECHO)).toBe(true);
    expect(n.respond([{ verb: DO, option: OPT_ECHO }])).toBe('');
  });

  it('an answer to its own opening offer closes the loop silently', () => {
    const n = new TelnetNegotiator({ offer: [OPT_ECHO], request: [OPT_TERMINAL_TYPE] });
    n.openingOffer();
    expect(n.respond([{ verb: DO, option: OPT_ECHO }])).toBe('');
    expect(n.respond([{ verb: WILL, option: OPT_TERMINAL_TYPE }])).toBe('');
    expect(n.isLocalEnabled(OPT_ECHO)).toBe(true);
    expect(n.isRemoteEnabled(OPT_TERMINAL_TYPE)).toBe(true);
  });

  it('a refusal of a requested option disables it', () => {
    const n = new TelnetNegotiator({ offer: [], request: [OPT_TERMINAL_TYPE] });
    n.openingOffer();
    n.respond([{ verb: WILL, option: OPT_TERMINAL_TYPE }]);
    expect(n.respond([{ verb: WONT, option: OPT_TERMINAL_TYPE }])).toBe(encodeNegotiation(DONT, OPT_TERMINAL_TYPE));
    expect(n.isRemoteEnabled(OPT_TERMINAL_TYPE)).toBe(false);
  });
});

describe('Cisco telnet server — the session is real', () => {
  it('opens with the option negotiation a real IOS telnet server sends', async () => {
    const { pc, cisco } = await buildCiscoLan();
    const client = await connectTelnet(pc, CISCO_IP);
    await settle();
    expect(client.rawReceived).toContain(encodeNegotiation(DO, OPT_TERMINAL_TYPE));
    expect(client.rawReceived).toContain(encodeNegotiation(WILL, OPT_SUPPRESS_GO_AHEAD));
    expect(client.rawReceived).toContain(encodeNegotiation(WILL, OPT_ECHO));
    expect(cisco).toBeDefined();
  });

  it('an unauthenticated line lands straight on the EXEC prompt', async () => {
    const { pc, cisco } = await buildCiscoLan();
    const client = await connectTelnet(pc, CISCO_IP);
    await settle();
    expect(client.received).toContain(`${cisco.getHostname()}>`);
  });

  it('a command typed on the wire really runs on the device', async () => {
    const { pc } = await buildCiscoLan();
    const client = await connectTelnet(pc, CISCO_IP);
    await settle();
    client.clear();
    client.send('show ip interface brief');
    await settle();
    expect(client.received).toContain('GigabitEthernet0/0');
    expect(client.received).toContain(CISCO_IP);
  });

  it('the EXEC mode of the session persists across commands', async () => {
    const { pc, cisco } = await buildCiscoLan();
    const client = await connectTelnet(pc, CISCO_IP);
    await settle();
    client.send('enable');
    await settle();
    expect(client.received).toContain(`${cisco.getHostname()}#`);
    client.clear();
    client.send('configure terminal');
    await settle();
    expect(client.received).toContain(`${cisco.getHostname()}(config)#`);
  });

  it('the session has its own mode — the console is not dragged into config', async () => {
    const { pc, cisco } = await buildCiscoLan();
    const client = await connectTelnet(pc, CISCO_IP);
    await settle();
    client.send('enable');
    await settle();
    client.send('configure terminal');
    await settle();
    expect(await cisco.executeCommand('show clock')).not.toContain('Invalid input');
  });

  it('`login` + `password` challenges for the line password only', async () => {
    const { pc, cisco } = await buildCiscoLan();
    for (const cmd of [
      'configure terminal', 'line vty 0 4', 'password letmein', 'login', 'end',
    ]) await cisco.executeCommand(cmd);

    const client = await connectTelnet(pc, CISCO_IP);
    await settle();
    expect(client.received).toContain('User Access Verification');
    expect(client.received).toContain('Password:');
    expect(client.received).not.toContain('Username:');

    client.clear();
    client.send('letmein');
    await settle();
    expect(client.received).toContain(`${cisco.getHostname()}>`);
  });

  it('a password is never echoed back', async () => {
    const { pc, cisco } = await buildCiscoLan();
    for (const cmd of [
      'configure terminal', 'line vty 0 4', 'password letmein', 'login', 'end',
    ]) await cisco.executeCommand(cmd);
    const client = await connectTelnet(pc, CISCO_IP);
    await settle();
    client.clear();
    client.send('letmein');
    await settle();
    expect(client.received).not.toContain('letmein');
  });

  it('a wrong password is rejected and the third one closes the connection', async () => {
    const { pc, cisco } = await buildCiscoLan();
    for (const cmd of [
      'configure terminal', 'line vty 0 4', 'password letmein', 'login', 'end',
    ]) await cisco.executeCommand(cmd);
    const client = await connectTelnet(pc, CISCO_IP);
    await settle();

    client.clear();
    client.send('nope');
    await settle();
    expect(client.received).toContain('% Login invalid');

    client.send('nope');
    await settle();
    client.clear();
    client.send('nope');
    await settle();
    expect(client.received).toContain('% Bad passwords');
    expect(client.received).toContain('Connection closed by foreign host');
  });

  it('`login local` challenges for a username and a password', async () => {
    const { pc, cisco } = await buildCiscoLan();
    for (const cmd of [
      'configure terminal', 'username bob privilege 15 secret s3cret',
      'line vty 0 4', 'login local', 'end',
    ]) await cisco.executeCommand(cmd);

    const client = await connectTelnet(pc, CISCO_IP);
    await settle();
    expect(client.received).toContain('Username:');

    client.send('bob');
    await settle();
    expect(client.received).toContain('Password:');

    client.clear();
    client.send('s3cret');
    await settle();
    expect(client.received).toContain(cisco.getHostname());
  });

  it('`exit` ends the session and gives the vty line back', async () => {
    const { pc, cisco } = await buildCiscoLan();
    const client = await connectTelnet(pc, CISCO_IP);
    await settle();
    expect(cisco.getSshSessionRegistry().list()).toHaveLength(1);

    client.clear();
    client.send('exit');
    await settle();
    expect(client.received).toContain('Connection closed by foreign host');
    expect(cisco.getSshSessionRegistry().list()).toHaveLength(0);
  });

  it('the open session is visible on the line it took', async () => {
    const { pc, cisco } = await buildCiscoLan();
    await connectTelnet(pc, CISCO_IP);
    await settle();
    const sessions = cisco.getSshSessionRegistry().list();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].line).toBe('vty 0');
    expect(sessions[0].fromIp).toBe(PC_IP);
    expect(sessions[0].localPort).toBe(23);
  });

  it('`transport input ssh` closes the port — no session to be had', async () => {
    const { pc, cisco } = await buildCiscoLan();
    for (const cmd of [
      'configure terminal', 'line vty 0 4', 'transport input ssh', 'end',
    ]) await cisco.executeCommand(cmd);

    const socket = await (pc as unknown as { tcpConnect: (h: string, p: number) => Promise<unknown> })
      .tcpConnect(CISCO_IP, 23);
    expect(socket).toBeNull();
  });

  it('an access-class that denies the source refuses the session', async () => {
    const { pc, cisco } = await buildCiscoLan();
    for (const cmd of [
      'configure terminal',
      'access-list 10 deny 10.0.0.1',
      'access-list 10 permit any',
      'line vty 0 4', 'access-class 10 in', 'end',
    ]) await cisco.executeCommand(cmd);

    const client = await connectTelnet(pc, CISCO_IP);
    await settle();
    expect(client.received).not.toContain(`${cisco.getHostname()}>`);
    expect(cisco.getSshSessionRegistry().list()).toHaveLength(0);
  });
});

describe('Huawei telnet server — same wire, VRP wording', () => {
  it('lands on the VRP EXEC prompt', async () => {
    const { pc, huawei } = await buildHuaweiLan();
    const client = await connectTelnet(pc, HUAWEI_IP);
    await settle();
    expect(client.received).toContain(`<${huawei.getHostname()}>`);
  });

  it('a display command typed on the wire really runs', async () => {
    const { pc } = await buildHuaweiLan();
    const client = await connectTelnet(pc, HUAWEI_IP);
    await settle();
    client.clear();
    client.send('display ip interface brief');
    await settle();
    expect(client.received).toContain('GigabitEthernet0/0/0');
    expect(client.received).toContain(HUAWEI_IP);
  });

  it('`authentication-mode password` announces the VRP login header, not the IOS one', async () => {
    const { pc, huawei } = await buildHuaweiLan();
    for (const cmd of [
      'system-view', 'user-interface vty 0 4',
      'authentication-mode password', 'set authentication password cipher vrp123',
      'quit', 'quit',
    ]) await huawei.executeCommand(cmd);

    const client = await connectTelnet(pc, HUAWEI_IP);
    await settle();
    expect(client.received).toContain('Login authentication');
    expect(client.received).not.toContain('User Access Verification');
    expect(client.received).toContain('Password:');
  });

  it('the session takes a vty line and frees it on quit', async () => {
    const { pc, huawei } = await buildHuaweiLan();
    const client = await connectTelnet(pc, HUAWEI_IP);
    await settle();
    expect(huawei.getSshSessionRegistry().list()).toHaveLength(1);
    client.send('quit');
    await settle();
    expect(huawei.getSshSessionRegistry().list()).toHaveLength(0);
  });
});

describe('the telnet subnegotiation surface', () => {
  it('a terminal-type subnegotiation from the client is accepted without breaking the session', async () => {
    const { pc, cisco } = await buildCiscoLan();
    const socket = await (pc as unknown as { tcpConnect: (h: string, p: number) => Promise<WireSocket | null> })
      .tcpConnect(CISCO_IP, 23);
    if (!socket) throw new Error('no socket');
    const client = new TelnetClient(socket);
    await settle();
    socket.write(encodeSubnegotiation(OPT_TERMINAL_TYPE, [0, ...'VT100'.split('').map(c => c.charCodeAt(0))]));
    await settle();
    client.clear();
    client.send('show version');
    await settle();
    expect(client.received).toContain(cisco.getHostname());
  });
});
