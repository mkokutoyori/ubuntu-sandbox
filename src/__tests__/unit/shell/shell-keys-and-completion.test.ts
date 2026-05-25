import { describe, expect, beforeEach, test } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { WindowsTerminalSession } from '@/terminal/sessions/WindowsTerminalSession';
import type { KeyEvent } from '@/terminal/sessions/TerminalSession';
import { reinstallDefaultShells } from '@/shell/registerDefaults';
import { ShellFactory } from '@/shell/ShellFactory';

function key(k: string, opts: { ctrlKey?: boolean } = {}): KeyEvent {
  return { key: k, ctrlKey: opts.ctrlKey ?? false, altKey: false, metaKey: false, shiftKey: false };
}

async function flush(times = 6): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
    await new Promise<void>((r) => setTimeout(r, 0));
  }
}

async function buildPair(): Promise<{ winA: WindowsPC; linuxA: LinuxPC }> {
  EquipmentRegistry.getInstance().clear();
  const winA = new WindowsPC('windows-pc', 'winA', 0, 0);
  const linuxA = new LinuxPC('linux-pc', 'linuxA', 0, 0);
  const sw = new GenericSwitch('switch-generic', 'sw', 8, 0, 0);
  new Cable('c1').connect(winA.getPorts()[0], sw.getPorts()[0]);
  new Cable('c2').connect(linuxA.getPorts()[0], sw.getPorts()[1]);
  const mask = new SubnetMask('255.255.255.0');
  winA.getPorts()[0].configureIP(new IPAddress('10.0.0.3'), mask);
  linuxA.getPorts()[0].configureIP(new IPAddress('10.0.0.1'), mask);
  return { winA, linuxA };
}

async function sshLogin(t: WindowsTerminalSession, line: string, pw: string): Promise<void> {
  t.setInput(line);
  t.handleKey(key('Enter'));
  await flush();
  if (t.currentInputMode.type === 'password') {
    t.setPasswordBuf(pw);
    t.handleKey(key('Enter'));
    await flush();
  }
}

describe('Shell special-key contract over SSH', () => {
  beforeEach(() => { reinstallDefaultShells(); });

  test('Ctrl+L on a remote shell is classified as clear-screen', async () => {
    const { winA, linuxA: _l } = await buildPair();
    const term = new WindowsTerminalSession('t', winA);
    await term.init();
    await sshLogin(term, 'ssh user@10.0.0.1', 'admin');
    const active = (term as unknown as { activeSubShell: unknown }).activeSubShell as {
      handleKey: (e: KeyEvent) => boolean;
    };
    const handled = active.handleKey(key('l', { ctrlKey: true }));
    expect(handled).toBe(false);
  });

  test('Ctrl+D on the remote primary asks the adapter to pop (eof)', async () => {
    const { winA } = await buildPair();
    const term = new WindowsTerminalSession('t', winA);
    await term.init();
    await sshLogin(term, 'ssh user@10.0.0.1', 'admin');
    const active = (term as unknown as { activeSubShell: { handleKey: (e: KeyEvent) => boolean } }).activeSubShell;
    expect(active.handleKey(key('d', { ctrlKey: true }))).toBe(true);
  });

  test('getCompletions on the remote sub-shell delegates to the remote device', async () => {
    const { winA } = await buildPair();
    const term = new WindowsTerminalSession('t', winA);
    await term.init();
    await sshLogin(term, 'ssh user@10.0.0.1', 'admin');
    const active = (term as unknown as { activeSubShell: { getCompletions?: (s: string) => string[] } }).activeSubShell;
    expect(typeof active.getCompletions).toBe('function');
    const out = active.getCompletions?.('ec') ?? [];
    expect(Array.isArray(out)).toBe(true);
  });

  test('ShellFactory reset wipes the registry; reinstall restores all built-ins', () => {
    ShellFactory.reset();
    expect(ShellFactory.has('bash')).toBe(false);
    expect(ShellFactory.has('cmd')).toBe(false);
    reinstallDefaultShells();
    for (const k of ['bash', 'cmd', 'powershell', 'sqlplus', 'rman', 'cisco-ios', 'huawei-vrp', 'sftp']) {
      expect(ShellFactory.has(k)).toBe(true);
    }
  });
});
