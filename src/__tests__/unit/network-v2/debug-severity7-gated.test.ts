/**
 * `debug` output: when it appears, and what it looks like.
 *
 * Reported from the UI — a router doing nothing but running CDP printed
 * onto a console that had never asked to debug anything, and `no debug
 * all` could not stop it:
 *
 *   Router1#show cdp neighbors
 *   %CDP-7-DEBUGGING: Neighbor ? on GigabitEthernet0/0 refreshed
 *   Router1#no debug all
 *   All possible debugging has been turned off
 *   %CDP-7-DEBUGGING: Neighbor ? on GigabitEthernet0/0 refreshed   <-- still coming
 *
 * Every part of that line was wrong. It was raised by the logging
 * subsystem with no debug flag behind it, so nothing could turn it off;
 * the neighbour was unnamed because the reader looked for a field the
 * payload does not carry; and `%CDP-7-DEBUGGING:` is a shape IOS never
 * prints — debug output is not syslog, it carries the subsystem's own
 * prefix (`CDP-PA:`) and no severity.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { EventBus, __setDefaultEventBus } from '@/events/EventBus';
import { TerminalManager } from '@/terminal/sessions/TerminalManager';
import { sansEstampe, estEstampee } from './_helpers/debugLines';
import type { KeyEvent, TerminalSession } from '@/terminal/sessions/TerminalSession';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

const tick = (ms = 60) => new Promise<void>((r) => setTimeout(r, ms));
const key = (k: string): KeyEvent =>
  ({ key: k, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false });

interface Lab {
  term: TerminalSession;
  /** Type a line into the terminal, as the operator does. */
  type: (cmd: string) => Promise<void>;
  /** One CDP advertisement round, as the 60 s periodic tick would do. */
  cdpRound: () => Promise<void>;
  /** Terminal scrollback, minus the echoed prompts. */
  debugLines: () => string[];
}

/** `who` picks which device's console the terminal is opened on. */
async function lab(who: 'router' | 'switch' = 'router'): Promise<Lab> {
  const bus = new EventBus();
  __setDefaultEventBus(bus);
  EquipmentRegistry.getInstance().setEventBus(bus);
  const manager = new TerminalManager(bus);
  const router = new CiscoRouter('Router1', 0, 0);
  const sw = new CiscoSwitch('switch-cisco', 'Switch1', 8);
  router.setEventBus(bus);
  sw.setEventBus(bus);
  router.powerOn();
  sw.powerOn();
  new Cable('c1').connect(router.getPorts()[0], sw.getPorts()[0]);

  const sid = manager.openTerminal(who === 'router' ? router : sw)!;
  const term = manager.getSession(sid)!;
  for (let i = 0; i < 40 && term.isBooting; i++) await tick(50);

  const type = async (cmd: string) => {
    term.setInput(cmd);
    term.handleKey(key('Enter'));
    await tick();
  };
  await type('enable');

  // CDP always advertises from the router, so a switch console sees the
  // router as its neighbour and vice versa.
  const agent = (router as unknown as { getCdpAgent: () => { advertiseAll: (r: 'periodic') => void } }).getCdpAgent();
  const cdpRound = async () => { agent.advertiseAll('periodic'); await tick(); };
  // First round DISCOVERS the neighbour; later rounds REFRESH it, and
  // only a refresh raises the line under test.
  await cdpRound();

  return {
    term,
    type,
    cdpRound,
    debugLines: () => term.lines.map((l) => l.text).filter((t) => /CDP-PA|%CDP/.test(t)),
  };
}

describe('CDP chatter only appears once `debug cdp` asks for it', () => {
  it('prints nothing while no debug is enabled', async () => {
    const { cdpRound, debugLines } = await lab();
    await cdpRound();
    await cdpRound();

    expect(
      debugLines(),
      'the operator never typed a debug command, so the console must stay quiet',
    ).toEqual([]);
  }, 30000);

  it('`no debug all` really stops it, having announced that it would', async () => {
    const { type, cdpRound, debugLines } = await lab();
    await type('debug cdp');
    await cdpRound();
    const whileOn = debugLines().length;
    expect(whileOn).toBeGreaterThan(0);

    await type('no debug all');
    await cdpRound();
    await cdpRound();

    expect(debugLines().length, 'not one more line may arrive').toBe(whileOn);
  }, 30000);

  it('`undebug all` stops it too', async () => {
    const { type, cdpRound, debugLines } = await lab();
    await type('debug cdp');
    await cdpRound();
    const whileOn = debugLines().length;

    await type('undebug all');
    await cdpRound();

    expect(debugLines().length).toBe(whileOn);
  }, 30000);

  it('a suppressed line is not quietly buffered either', async () => {
    const { term, cdpRound } = await lab();
    await cdpRound();
    const device = (term as unknown as { device: { executeCommand: (c: string) => Promise<string> } }).device;

    expect(
      await device.executeCommand('show logging'),
      'show logging must not leak back the debug output the console was spared',
    ).not.toContain('CDP-PA');
  }, 30000);
});

describe('the line reads like IOS, not like a syslog message', () => {
  it('carries the CDP-PA prefix, the neighbour name and the interface', async () => {
    const { type, cdpRound, debugLines } = await lab();
    await type('debug cdp');
    await cdpRound();

    const line = debugLines()[debugLines().length - 1];
    expect(estEstampee(line), line).toBe(true);
    expect(sansEstampe(line)).toBe('CDP-PA: Packet received from Switch1 on interface GigabitEthernet0/0');
  }, 30000);

  it('never wears the invented %CDP-7-DEBUGGING severity wrapper', async () => {
    const { type, cdpRound, term } = await lab();
    await type('debug cdp');
    await cdpRound();

    const all = term.lines.map((l) => l.text).join('\n');
    expect(all, 'debug output is not syslog — IOS prints no %FACILITY-7-MNEMONIC here').not.toContain('%CDP-7');
    expect(all).not.toContain('DEBUGGING:');
  }, 30000);

  it('names the neighbour instead of rendering it as ?', async () => {
    const { type, cdpRound, debugLines } = await lab();
    await type('debug cdp');
    await cdpRound();

    expect(debugLines().join('\n')).not.toContain('?');
  }, 30000);
});

describe('a switch console behaves the same way', () => {
  it('stays quiet until `debug cdp`, then reports the router in IOS shape', async () => {
    const { type, cdpRound, debugLines } = await lab('switch');
    await cdpRound();
    expect(debugLines(), 'the switch console never asked to debug anything either').toEqual([]);

    await type('debug cdp');
    await cdpRound();
    const line = debugLines()[debugLines().length - 1];
    expect(estEstampee(line), line).toBe(true);
    expect(sansEstampe(line)).toBe('CDP-PA: Packet received from Router1 on interface FastEthernet0/1');

    const whileOn = debugLines().length;
    await type('undebug all');
    await cdpRound();
    expect(debugLines().length).toBe(whileOn);
  }, 30000);
});

describe('every severity-7 family is reachable and unprefixed', () => {
  it.each([
    ['debug lldp', 'LLDP packets debugging is on'],
    ['debug vxlan', 'VXLAN debugging is on'],
    ['debug port-security', 'Port security debugging is on'],
    ['debug ip pim', 'PIM debugging is on'],
  ])('`%s` is a real flag that `undebug all` clears', async (cmd, expected) => {
    const bus = new EventBus();
    __setDefaultEventBus(bus);
    EquipmentRegistry.getInstance().setEventBus(bus);
    const router = new CiscoRouter('R1', 0, 0);
    router.setEventBus(bus);
    router.powerOn();
    await router.executeCommand('enable');

    expect(await router.executeCommand(cmd)).toBe(expected);
    expect(await router.executeCommand('show debugging')).toContain(expected);
    await router.executeCommand('undebug all');
    expect(await router.executeCommand('show debugging')).toBe('No debug flags are enabled');
  }, 30000);
});
