import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { LinuxTerminalSession } from '@/terminal/sessions/LinuxTerminalSession';
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

interface Lab { term: LinuxTerminalSession }

async function lab(): Promise<Lab> {
  const sw = new GenericSwitch('switch-generic', 'SW');
  const pc1 = new LinuxPC('linux-pc', 'PC1');
  const pc2 = new LinuxPC('linux-pc', 'PC2');
  const win = new WindowsPC('windows-pc', 'WIN1');
  const cisco = new CiscoRouter('router-cisco', 'R1');

  pc1.getPorts()[0].configureIP(new IPAddress('10.0.60.1'), MASK);
  pc2.getPorts()[0].configureIP(new IPAddress('10.0.60.2'), MASK);
  win.getPorts()[0].configureIP(new IPAddress('10.0.60.4'), MASK);
  new Cable('c1').connect(pc1.getPorts()[0], sw.getPorts()[0]);
  new Cable('c2').connect(pc2.getPorts()[0], sw.getPorts()[1]);
  new Cable('c3').connect(win.getPorts()[0], sw.getPorts()[2]);
  new Cable('c4').connect(cisco.getPorts()[0], sw.getPorts()[3]);

  for (const cmd of [
    'enable', 'configure terminal', 'hostname R1',
    `interface ${cisco.getPortNames()[0]}`, 'ip address 10.0.60.6 255.255.255.0', 'no shutdown', 'exit',
    'username admin privilege 15 secret Admin@123', 'enable secret Admin@123',
    'ip domain-name lab.local', 'crypto key generate rsa modulus 2048', 'ip ssh version 2',
    'line vty 0 4', 'login local', 'transport input ssh', 'end',
  ]) await cisco.executeCommand(cmd);

  const term = new LinuxTerminalSession('t1', pc1);
  await term.init?.();
  return { term };
}

async function line(term: LinuxTerminalSession, text: string): Promise<void> {
  term.setInputBuf(text);
  term.handleKey(key('Enter'));
  await flush();
}

/** A hop: type the ssh line, answer the challenge it must raise. */
async function hop(term: LinuxTerminalSession, cmd: string, password: string): Promise<void> {
  await line(term, cmd);
  for (let i = 0; i < 60 && term.currentInputMode.type !== 'password'; i++) await flush();
  expect(term.currentInputMode.type, `\`${cmd}\` must challenge for a password`).toBe('password');
  term.setPasswordBuf(password);
  term.handleKey(key('Enter'));
  await flush();
}

describe('an SSH hop inherits the remote terminal, whatever the vendor', () => {
  it('hop 1: linux -> linux', async () => {
    const { term } = await lab();
    await hop(term, 'ssh user@10.0.60.2', 'admin');
    expect(term.getPrompt()).toMatch(/@PC2/);
  }, 30000);

  it('hop 2: from that linux frame, on to windows', async () => {
    const { term } = await lab();
    await hop(term, 'ssh user@10.0.60.2', 'admin');
    await hop(term, 'ssh Administrator@10.0.60.4', 'admin');
    expect(term.getPrompt()).toMatch(/^[A-Z]:\\/);
  }, 30000);

  it('hop 3: a windows frame runs its OWN outbound ssh, back to linux', async () => {
    const { term } = await lab();
    await hop(term, 'ssh user@10.0.60.2', 'admin');
    await hop(term, 'ssh Administrator@10.0.60.4', 'admin');
    await hop(term, 'ssh user@10.0.60.1', 'admin');
    expect(term.getPrompt(), 'the third hop should land back on PC1').toMatch(/@PC1/);
  }, 30000);

  it('a windows frame can also reach a router', async () => {
    const { term } = await lab();
    await hop(term, 'ssh user@10.0.60.2', 'admin');
    await hop(term, 'ssh Administrator@10.0.60.4', 'admin');
    await hop(term, 'ssh admin@10.0.60.6', 'Admin@123');
    expect(term.getPrompt()).toMatch(/^R1[>#]/);
  }, 30000);

  it('sudo su still challenges and elevates three hops deep', async () => {
    const { term } = await lab();
    await hop(term, 'ssh user@10.0.60.2', 'admin');
    await hop(term, 'ssh Administrator@10.0.60.4', 'admin');
    await hop(term, 'ssh user@10.0.60.1', 'admin');

    const before = term.lines.length;
    await line(term, 'sudo su');
    for (let i = 0; i < 60 && term.currentInputMode.type !== 'password'; i++) await flush();
    expect(term.currentInputMode.type, 'sudo su must challenge').toBe('password');
    term.setPasswordBuf('admin');
    term.handleKey(key('Enter'));
    await flush();

    await line(term, 'whoami');
    expect(term.lines.slice(before).map((l) => l.text).join('\n')).toMatch(/\broot\b/);
  }, 30000);
});
