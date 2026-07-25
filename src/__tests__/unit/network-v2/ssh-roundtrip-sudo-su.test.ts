import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { WindowsPC } from '@/network/devices/WindowsPC';
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
const key = (k: string, mods: Record<string, boolean> = {}) =>
  ({ key: k, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, ...mods }) as never;

const flush = async () => {
  for (let i = 0; i < 40; i++) { await Promise.resolve(); await new Promise<void>((r) => setTimeout(r, 0)); }
};

async function lab(): Promise<LinuxTerminalSession> {
  const sw = new GenericSwitch('switch-generic', 'SW');
  const pc = new LinuxPC('linux-pc', 'PC1');
  const win = new WindowsPC('windows-pc', 'WIN1');
  const pc2 = new LinuxPC('linux-pc', 'PC2');
  pc.getPorts()[0].configureIP(new IPAddress('10.0.40.1'), MASK);
  win.getPorts()[0].configureIP(new IPAddress('10.0.40.4'), MASK);
  pc2.getPorts()[0].configureIP(new IPAddress('10.0.40.2'), MASK);
  new Cable('c1').connect(pc.getPorts()[0], sw.getPorts()[0]);
  new Cable('c2').connect(win.getPorts()[0], sw.getPorts()[1]);
  new Cable('c3').connect(pc2.getPorts()[0], sw.getPorts()[2]);

  const term = new LinuxTerminalSession('t1', pc);
  await term.init?.();
  return term;
}

async function type(term: LinuxTerminalSession, line: string): Promise<void> {
  term.setInputBuf(line);
  term.handleKey(key('Enter'));
  await flush();
}

async function typeAtRoot(term: LinuxTerminalSession, line: string): Promise<void> {
  term.setInput(line);
  term.handleKey(key('Enter'));
  await flush();
}

/** Answer whatever password challenge the terminal is currently showing. */
async function answerPassword(term: LinuxTerminalSession, password: string): Promise<void> {
  for (let i = 0; i < 60 && term.currentInputMode.type !== 'password'; i++) await flush();
  // The prompt actually appearing IS the behaviour under test: the UI
  // symptom is that `sudo su` stops challenging for a password.
  expect(term.currentInputMode.type, 'a password challenge should be showing').toBe('password');
  term.setPasswordBuf(password);
  term.handleKey(key('Enter'));
  await flush();
}

function screen(term: LinuxTerminalSession): string {
  return term.lines.map((l) => l.text).join('\n');
}

describe('sudo su still works after an SSH round trip (user report)', () => {
  it('sudo su works before any SSH', async () => {
    const term = await lab();
    await typeAtRoot(term, 'sudo su');
    await answerPassword(term, 'admin');
    await type(term, 'whoami');
    expect(screen(term)).toContain('root');
  }, 30000);

  it('sudo su still works after ssh to Windows and back out with exit', async () => {
    const term = await lab();

    await typeAtRoot(term, 'ssh Administrator@10.0.40.4');
    await answerPassword(term, 'admin');
    expect(term.getPrompt()).toMatch(/^[A-Z]:\\/);

    await type(term, 'exit');
    expect(term.getPrompt(), 'we should be back on the local Linux prompt').toMatch(/@PC1/);

    await typeAtRoot(term, 'sudo su');
    await answerPassword(term, 'admin');
    await type(term, 'whoami');
    expect(screen(term)).toContain('root');
  }, 30000);

  it('sudo su works on a Linux box reached THROUGH a Windows hop', async () => {
    const term = await lab();

    await typeAtRoot(term, 'ssh Administrator@10.0.40.4');
    await answerPassword(term, 'admin');
    expect(term.getPrompt()).toMatch(/^[A-Z]:\\/);

    await type(term, 'ssh user@10.0.40.2');
    await answerPassword(term, 'admin');
    expect(term.getPrompt(), 'second hop should land on the Linux box').toMatch(/@PC2/);

    const before = screen(term).length;
    await type(term, 'sudo su');
    await answerPassword(term, 'admin');
    await type(term, 'whoami');
    expect(screen(term).slice(before)).toContain('root');
  }, 30000);
});
