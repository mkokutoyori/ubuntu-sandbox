import { describe, expect, beforeEach, test } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { WindowsTerminalSession } from '@/terminal/sessions/WindowsTerminalSession';
import type { KeyEvent } from '@/terminal/sessions/TerminalSession';
import { ShellSubShellAdapter } from '@/shell/ShellSubShellAdapter';

function key(k: string, opts: { ctrlKey?: boolean; shiftKey?: boolean } = {}): KeyEvent {
  return { key: k, ctrlKey: opts.ctrlKey ?? false, altKey: false, metaKey: false, shiftKey: opts.shiftKey ?? false };
}

async function flush(times = 6): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
    await new Promise<void>((r) => setTimeout(r, 0));
  }
}

async function buildPair(): Promise<{ winA: WindowsPC; winB: WindowsPC }> {
  EquipmentRegistry.getInstance().clear();
  const winA = new WindowsPC('windows-pc', 'winA', 0, 0);
  const winB = new WindowsPC('windows-pc', 'winB', 0, 0);
  const sw = new GenericSwitch('switch-generic', 'sw', 8, 0, 0);
  new Cable('c1').connect(winA.getPorts()[0], sw.getPorts()[0]);
  new Cable('c2').connect(winB.getPorts()[0], sw.getPorts()[1]);
  const mask = new SubnetMask('255.255.255.0');
  winA.getPorts()[0].configureIP(new IPAddress('10.0.0.1'), mask);
  winB.getPorts()[0].configureIP(new IPAddress('10.0.0.2'), mask);
  return { winA, winB };
}

async function typeRoot(t: WindowsTerminalSession, line: string): Promise<void> {
  t.setInput(line);
  t.handleKey(key('Enter'));
  await flush();
}

async function typeSub(t: WindowsTerminalSession, line: string): Promise<void> {
  t.setInputBuf(line);
  t.handleKey(key('Enter'));
  await flush();
}

describe('Phase 1B — WindowsTerminalSession migrated onto IShell', () => {
  let winA: WindowsPC;
  let winB: WindowsPC;
  let term: WindowsTerminalSession;

  beforeEach(async () => {
    ({ winA, winB } = await buildPair());
    term = new WindowsTerminalSession('t', winA);
    await term.init();
  });

  test('powershell launch pushes an IShell-backed adapter', async () => {
    await typeRoot(term, 'powershell');
    const active = (term as unknown as { activeSubShell: unknown }).activeSubShell;
    expect(active).toBeInstanceOf(ShellSubShellAdapter);
    expect((active as ShellSubShellAdapter).inner.kind).toBe('powershell');
    expect(term.shellMode).toBe('powershell');
  });

  test('PS prompt reflects the per-terminal session cwd', async () => {
    await typeRoot(term, 'powershell');
    expect(term.getPrompt()).toMatch(/^PS [A-Z]:\\/);
  });

  test('cls in PowerShell clears the screen', async () => {
    await typeRoot(term, 'powershell');
    await typeSub(term, 'echo before-cls');
    const before = term.lines.length;
    await typeSub(term, 'cls');
    expect(term.lines.length).toBeLessThan(before);
  });

  test('exit pops PowerShell back to cmd', async () => {
    await typeRoot(term, 'powershell');
    expect(term.shellMode).toBe('powershell');
    await typeSub(term, 'exit');
    expect(term.shellMode).toBe('cmd');
    expect(term.getPrompt()).toMatch(/^[A-Z]:\\/);
  });

  test('nested cmd from PS pushes an IShell-backed adapter', async () => {
    await typeRoot(term, 'powershell');
    await typeSub(term, 'cmd');
    const active = (term as unknown as { activeSubShell: unknown }).activeSubShell;
    expect(active).toBeInstanceOf(ShellSubShellAdapter);
    expect((active as ShellSubShellAdapter).inner.kind).toBe('cmd');
    expect(term.shellMode).toBe('cmd');
  });

  test('SSH push from cmd lands on the remote real terminal session', async () => {
    term.setInput('ssh User@10.0.0.2');
    term.handleKey(key('Enter'));
    await flush();
    expect(term.currentInputMode.type).toBe('password');
    term.setPasswordBuf('user');
    term.handleKey(key('Enter'));
    await flush();
    expect(term.foreground).not.toBe(term);
    expect(term.foreground.isRemoteChild).toBe(true);
  });

  test('two terminals on the same WindowsPC keep independent cwd through PS', async () => {
    const t1 = new WindowsTerminalSession('t1', winA);
    const t2 = new WindowsTerminalSession('t2', winA);
    await t1.init();
    await t2.init();

    await typeRoot(t1, 'powershell');
    await typeSub(t1, 'cd D:\\');
    await typeRoot(t2, 'powershell');

    expect(t1.getPrompt()).not.toBe(t2.getPrompt());
  });
});
