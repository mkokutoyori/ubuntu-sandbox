/**
 * `telnet` from a terminal opens a real session on the remote VTY.
 *
 * Until now the three telnet clients printed a static "Connected to …"
 * banner and returned: the connect verdict was genuine, but no session
 * followed, so an operator could never actually drive the remote device
 * (docs/PRD-VTY-Transport.md §2.1 item 6).
 *
 * These drive the real terminal sessions — keystrokes in, rendered lines
 * out — over real cabling, and assert that what appears on screen is the
 * remote device's own text.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { LinuxTerminalSession } from '@/terminal/sessions/LinuxTerminalSession';
import { WindowsTerminalSession } from '@/terminal/sessions/WindowsTerminalSession';
import { CiscoTerminalSession } from '@/terminal/sessions/CiscoTerminalSession';
import { HuaweiTerminalSession } from '@/terminal/sessions/HuaweiTerminalSession';
import type { KeyEvent } from '@/terminal/sessions/TerminalSession';

const MASK = '255.255.255.0';
const PC_IP = '10.0.0.1';
const WIN_IP = '10.0.0.2';
const CISCO_IP = '10.0.0.6';
const HUAWEI_IP = '10.0.0.8';

function key(k: string): KeyEvent {
  return { key: k, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false };
}

async function flush(times = 40): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
    await new Promise<void>((r) => setTimeout(r, 0));
  }
}

interface AnySession {
  setInput(text: string): void;
  setInputBuf(text: string): void;
  handleKey(e: KeyEvent): boolean;
  lines: ReadonlyArray<{ text: string }>;
}

/**
 * A terminal reads normal-mode input from `input` and sub-shell input
 * from `_inputBuf`; setting both lets one helper drive either mode.
 */
async function type(session: AnySession, cmd: string): Promise<void> {
  session.setInput(cmd);
  session.setInputBuf(cmd);
  session.handleKey(key('Enter'));
  await flush();
}

function screen(session: AnySession): string {
  return session.lines.map((l) => l.text).join('\n');
}

interface Lan {
  pc: LinuxPC;
  win: WindowsPC;
  cisco: CiscoRouter;
  huawei: HuaweiRouter;
}

async function buildLan(): Promise<Lan> {
  const pc = new LinuxPC('linux-pc', 'pc1', 0, 0);
  const win = new WindowsPC('windows-pc', 'win1', 0, 0);
  const cisco = new CiscoRouter('cisco1', 0, 0);
  const huawei = new HuaweiRouter('huawei1', 0, 0);
  const sw = new GenericSwitch('switch-generic', 'sw', 8, 0, 0);

  new Cable('c1').connect(pc.getPorts()[0], sw.getPorts()[0]);
  new Cable('c2').connect(win.getPorts()[0], sw.getPorts()[1]);
  new Cable('c3').connect(cisco.getPorts()[0], sw.getPorts()[2]);
  new Cable('c4').connect(huawei.getPorts()[0], sw.getPorts()[3]);

  const mask = new SubnetMask(MASK);
  pc.getPorts()[0].configureIP(new IPAddress(PC_IP), mask);
  win.getPorts()[0].configureIP(new IPAddress(WIN_IP), mask);

  for (const cmd of [
    'enable', 'configure terminal',
    'interface GigabitEthernet0/0', `ip address ${CISCO_IP} ${MASK}`, 'no shutdown', 'end',
  ]) await cisco.executeCommand(cmd);
  for (const cmd of [
    'system-view', 'interface GigabitEthernet0/0/0',
    `ip address ${HUAWEI_IP} ${MASK}`, 'undo shutdown', 'quit', 'quit',
  ]) await huawei.executeCommand(cmd);

  await pc.executeCommand(`ping -c 1 ${CISCO_IP}`);
  await pc.executeCommand(`ping -c 1 ${HUAWEI_IP}`);
  return { pc, win, cisco, huawei };
}

beforeEach(() => { EquipmentRegistry.resetInstance(); });

describe('telnet from a Linux terminal', () => {
  it('lands on the remote EXEC prompt instead of a static banner', async () => {
    const { pc, cisco } = await buildLan();
    const term = new LinuxTerminalSession('t1', pc);
    await type(term, `telnet ${CISCO_IP}`);

    expect(screen(term)).toContain(`Trying ${CISCO_IP}...`);
    expect(term.getPrompt()).toContain(`${cisco.getHostname()}>`);
  });

  it('runs a command on the remote device and shows its real output', async () => {
    const { pc } = await buildLan();
    const term = new LinuxTerminalSession('t1', pc);
    await type(term, `telnet ${CISCO_IP}`);
    await type(term, 'show ip interface brief');

    const out = screen(term);
    expect(out).toContain('GigabitEthernet0/0');
    expect(out).toContain(CISCO_IP);
  });

  it('the remote EXEC mode persists across commands', async () => {
    const { pc, cisco } = await buildLan();
    const term = new LinuxTerminalSession('t1', pc);
    await type(term, `telnet ${CISCO_IP}`);
    await type(term, 'enable');
    expect(term.getPrompt()).toContain(`${cisco.getHostname()}#`);
    await type(term, 'configure terminal');
    expect(term.getPrompt()).toContain(`${cisco.getHostname()}(config)#`);
  });

  it('a configuration typed over telnet really reaches the device', async () => {
    const { pc, cisco } = await buildLan();
    const term = new LinuxTerminalSession('t1', pc);
    await type(term, `telnet ${CISCO_IP}`);
    await type(term, 'enable');
    await type(term, 'configure terminal');
    await type(term, 'hostname R-TELNET');
    expect(cisco.getHostname()).toBe('R-TELNET');
  });

  it('the line typed by the operator is not printed twice', async () => {
    const { pc } = await buildLan();
    const term = new LinuxTerminalSession('t1', pc);
    await type(term, `telnet ${CISCO_IP}`);
    await type(term, 'show clock');
    const occurrences = screen(term).split('show clock').length - 1;
    expect(occurrences).toBe(1);
  });

  it('`exit` closes the session and hands the terminal back to bash', async () => {
    const { pc, cisco } = await buildLan();
    const term = new LinuxTerminalSession('t1', pc);
    await type(term, `telnet ${CISCO_IP}`);
    expect(cisco.getSshSessionRegistry().list()).toHaveLength(1);

    await type(term, 'exit');
    expect(cisco.getSshSessionRegistry().list()).toHaveLength(0);
    expect(term.getPrompt()).not.toContain(cisco.getHostname());
  });

  it('the line password is asked by the remote, and never echoed', async () => {
    const { pc, cisco } = await buildLan();
    for (const cmd of [
      'configure terminal', 'line vty 0 4', 'password letmein', 'login', 'end',
    ]) await cisco.executeCommand(cmd);

    const term = new LinuxTerminalSession('t1', pc);
    await type(term, `telnet ${CISCO_IP}`);
    expect(screen(term)).toContain('User Access Verification');

    await type(term, 'letmein');
    expect(term.getPrompt()).toContain(`${cisco.getHostname()}>`);
  });

  it('an unreachable target is refused, with no session opened', async () => {
    const { pc, cisco } = await buildLan();
    for (const cmd of [
      'configure terminal', 'line vty 0 4', 'transport input ssh', 'end',
    ]) await cisco.executeCommand(cmd);

    const term = new LinuxTerminalSession('t1', pc);
    await type(term, `telnet ${CISCO_IP}`);
    expect(screen(term)).toMatch(/Connection refused/);
    expect(cisco.getSshSessionRegistry().list()).toHaveLength(0);
  });

  it('an unknown name is reported, without touching the wire', async () => {
    const { pc } = await buildLan();
    const term = new LinuxTerminalSession('t1', pc);
    await type(term, 'telnet nosuchhost');
    expect(screen(term)).toMatch(/could not resolve nosuchhost/);
  });

  it('reaches a Huawei VTY the same way', async () => {
    const { pc, huawei } = await buildLan();
    const term = new LinuxTerminalSession('t1', pc);
    await type(term, `telnet ${HUAWEI_IP}`);
    expect(term.getPrompt()).toContain(`<${huawei.getHostname()}>`);

    await type(term, 'display ip interface brief');
    expect(screen(term)).toContain('GigabitEthernet0/0/0');
  });
});

describe('telnet from a Windows terminal', () => {
  it('lands on the remote EXEC prompt and runs a command', async () => {
    const { win, cisco } = await buildLan();
    await win.executeCommand(`ping ${CISCO_IP}`);
    const term = new WindowsTerminalSession('t2', win);
    await type(term as unknown as AnySession, `telnet ${CISCO_IP}`);
    expect(term.getPrompt()).toContain(`${cisco.getHostname()}>`);

    await type(term as unknown as AnySession, 'show ip interface brief');
    expect(screen(term as unknown as AnySession)).toContain('GigabitEthernet0/0');
  });

  it('`exit` frees the vty line', async () => {
    const { win, cisco } = await buildLan();
    await win.executeCommand(`ping ${CISCO_IP}`);
    const term = new WindowsTerminalSession('t2', win);
    await type(term as unknown as AnySession, `telnet ${CISCO_IP}`);
    expect(cisco.getSshSessionRegistry().list()).toHaveLength(1);
    await type(term as unknown as AnySession, 'exit');
    expect(cisco.getSshSessionRegistry().list()).toHaveLength(0);
  });
});

describe('telnet from a router CLI', () => {
  it('a Huawei router telnets into the Cisco router and drives it', async () => {
    const { huawei, cisco } = await buildLan();
    await huawei.executeCommand(`ping -c 1 ${CISCO_IP}`);
    const term = new HuaweiTerminalSession('t3', huawei);
    await type(term as unknown as AnySession, `telnet ${CISCO_IP}`);
    expect(term.getPrompt()).toContain(`${cisco.getHostname()}>`);

    await type(term as unknown as AnySession, 'show ip interface brief');
    expect(screen(term as unknown as AnySession)).toContain('GigabitEthernet0/0');
  });

  it('a Cisco router telnets into the Huawei router', async () => {
    const { cisco, huawei } = await buildLan();
    await cisco.executeCommand(`ping ${HUAWEI_IP}`);
    const term = new CiscoTerminalSession('t4', cisco);
    await type(term as unknown as AnySession, `telnet ${HUAWEI_IP}`);
    expect(term.getPrompt()).toContain(`<${huawei.getHostname()}>`);
  });
});
