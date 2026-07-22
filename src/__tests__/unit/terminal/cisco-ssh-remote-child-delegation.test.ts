/**
 * SSH from one Cisco/Huawei device's interactive terminal session into
 * another must delegate EVERY key (not just the prompt/banner text) to the
 * remote child session — exactly like Windows/Linux already do via
 * `if (this.hasActiveChild) return this.foreground.handleKey(e);` at the
 * top of their `handleKey()` override.
 *
 * CLITerminalSession (the shared Cisco/Huawei base) had no such override,
 * so `handleKey()` fell through to the base `TerminalSession.handleKey`,
 * which always operates on `this` — the LOCAL/outer session. The visible
 * prompt happened to read correctly (`getPrompt()` does delegate), which
 * made an SSH session LOOK like it was talking to the remote device while
 * every command it ran (including config changes) was silently applied to
 * the local device instead. `show`-style commands masked the bug because
 * both devices are the same vendor/model and return look-alike output;
 * a `hostname` change on the "remote" session exposes it immediately by
 * mutating the wrong device.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { EventBus, __setDefaultEventBus } from '@/events/EventBus';
import { TerminalManager } from '@/terminal/sessions/TerminalManager';
import type { CiscoTerminalSession } from '@/terminal/sessions/CiscoTerminalSession';
import type { KeyEvent } from '@/terminal/sessions/TerminalSession';

function key(k: string): KeyEvent {
  return { key: k, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false };
}
const tick = (ms = 30) => new Promise<void>((r) => setTimeout(r, ms));

async function waitBoot(session: CiscoTerminalSession): Promise<void> {
  for (let i = 0; i < 40; i++) {
    if (!session.isBooting) return;
    await tick(50);
  }
}

async function type(session: CiscoTerminalSession, cmd: string): Promise<void> {
  session.setInput(cmd);
  session.handleKey(key('Enter'));
  await tick();
}

describe('Cisco IOS interactive SSH — remote child delegation', () => {
  let bus: EventBus;
  let manager: TerminalManager;
  let r1: CiscoRouter;
  let r2: CiscoRouter;

  beforeEach(async () => {
    EquipmentRegistry.resetInstance();
    bus = new EventBus();
    __setDefaultEventBus(bus);
    EquipmentRegistry.getInstance().setEventBus(bus);
    manager = new TerminalManager(bus);

    r1 = new CiscoRouter('Router1');
    r2 = new CiscoRouter('Router2');
    r1.setEventBus(bus);
    r2.setEventBus(bus);
    new Cable('c1').connect(r1.getPorts()[0], r2.getPorts()[0]);

    const mask = new SubnetMask('255.255.255.0');
    r1.getPorts()[0].configureIP(new IPAddress('10.0.0.1'), mask);
    r2.getPorts()[0].configureIP(new IPAddress('10.0.0.2'), mask);

    // Provision r2 as an SSH server, reachable from r1.
    await r2.executeCommand('enable');
    await r2.executeCommand('configure terminal');
    await r2.executeCommand('ip domain-name lab.local');
    await r2.executeCommand('crypto key generate rsa modulus 1024');
    await r2.executeCommand('username admin privilege 15 secret Cisco123');
    await r2.executeCommand('line vty 0 4');
    await r2.executeCommand('login local');
    await r2.executeCommand('transport input ssh');
    await r2.executeCommand('end');
  });

  async function openR1Terminal(): Promise<CiscoTerminalSession> {
    const sid = manager.openTerminal(r1)!;
    const session = manager.getSession(sid) as CiscoTerminalSession;
    await waitBoot(session);
    return session;
  }

  async function sshFromR1IntoR2(session: CiscoTerminalSession): Promise<void> {
    await type(session, 'enable');
    await type(session, 'ssh -l admin 10.0.0.2');
    await tick(50);
    session.setPasswordBuf('Cisco123');
    session.handleKey(key('Enter'));
    await tick(100);
  }

  it('an interactive SSH session actually delegates keys to the remote child', async () => {
    const session = await openR1Terminal();
    await sshFromR1IntoR2(session);

    expect(session.hasActiveChild).toBe(true);
  });

  it('a config command typed over SSH mutates the REMOTE device, not the local one', async () => {
    const session = await openR1Terminal();
    await sshFromR1IntoR2(session);

    await type(session, 'configure terminal');
    await type(session, 'hostname SSH-MUTATED');
    await type(session, 'end');

    expect(r2.getHostname()).toBe('SSH-MUTATED');
    expect(r1.getHostname()).toBe('Router1');
  });

  it('`show ?` typed over SSH renders under the remote session\'s own prompt', async () => {
    const session = await openR1Terminal();
    await sshFromR1IntoR2(session);

    session.setInput('show ');
    session.handleKey(key('?'));
    await tick();

    const helpEcho = session.lines.find((l) => l.text.includes('show ?'));
    expect(helpEcho?.text.startsWith('Router2#')).toBe(true);
    expect(helpEcho?.text.startsWith('Router1#')).toBe(false);
  });
});
