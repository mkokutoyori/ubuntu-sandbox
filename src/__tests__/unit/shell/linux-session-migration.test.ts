import { describe, expect, beforeEach, test } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { LinuxTerminalSession } from '@/terminal/sessions/LinuxTerminalSession';
import type { KeyEvent } from '@/terminal/sessions/TerminalSession';
import { ShellSubShellAdapter } from '@/shell/ShellSubShellAdapter';

function key(k: string): KeyEvent {
  return { key: k, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false };
}

async function flush(times = 6): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
    await new Promise<void>((r) => setTimeout(r, 0));
  }
}

async function buildLan(): Promise<{ pc: LinuxPC; srv: LinuxServer }> {
  EquipmentRegistry.getInstance().clear();
  const pc = new LinuxPC('linux-pc', 'pc1', 0, 0);
  const srv = new LinuxServer('linux-server', 'srv1', 0, 0);
  const sw = new GenericSwitch('switch-generic', 'sw', 8, 0, 0);
  new Cable('c1').connect(pc.getPorts()[0], sw.getPorts()[0]);
  new Cable('c2').connect(srv.getPorts()[0], sw.getPorts()[1]);
  const mask = new SubnetMask('255.255.255.0');
  pc.getPorts()[0].configureIP(new IPAddress('10.0.0.1'), mask);
  srv.getPorts()[0].configureIP(new IPAddress('10.0.0.2'), mask);
  return { pc, srv };
}

async function typeRoot(t: LinuxTerminalSession, line: string): Promise<void> {
  t.setInput(line);
  t.handleKey(key('Enter'));
  await flush();
}

describe('Phase 1B Linux — SqlPlus & RMAN go through IShell', () => {
  let srv: LinuxServer;
  let term: LinuxTerminalSession;

  beforeEach(async () => {
    ({ srv } = await buildLan());
    term = new LinuxTerminalSession('t', srv);
    await term.init();
  });

  test('sqlplus push wraps an IShell-backed adapter', async () => {
    await typeRoot(term, 'sqlplus / as sysdba');
    const active = (term as unknown as { activeSubShell: unknown }).activeSubShell;
    expect(active).toBeInstanceOf(ShellSubShellAdapter);
    expect((active as ShellSubShellAdapter).inner.kind).toBe('sqlplus');
  });

  test('sqlplus prompt is SQL>', async () => {
    await typeRoot(term, 'sqlplus / as sysdba');
    expect(term.getPrompt()).toMatch(/^SQL>/);
  });

  test('rman push wraps an IShell-backed adapter', async () => {
    await typeRoot(term, 'rman target /');
    const active = (term as unknown as { activeSubShell: unknown }).activeSubShell;
    expect(active).toBeInstanceOf(ShellSubShellAdapter);
    expect((active as ShellSubShellAdapter).inner.kind).toBe('rman');
  });

  test('rman prompt is RMAN>', async () => {
    await typeRoot(term, 'rman target /');
    expect(term.getPrompt()).toMatch(/^RMAN>/);
  });
});
