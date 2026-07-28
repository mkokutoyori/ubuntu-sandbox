/**
 * Severity 7 is `debug` output, and IOS only produces it while the
 * matching `debug` is on.
 *
 * The logging subsystem used to raise those lines straight off the event
 * bus with no gate at all, so a router doing nothing but running CDP
 * printed neighbour chatter onto a console that had never asked to debug
 * anything — and `no debug all` could not stop it, because the lines were
 * never in the debug registry it clears. Reported from the UI:
 *
 *   Router1#show cdp neighbors
 *   %CDP-7-DEBUGGING: Neighbor ? on GigabitEthernet0/0 refreshed
 *   Router1#no debug all
 *   All possible debugging has been turned off
 *   %CDP-7-DEBUGGING: Neighbor ? on GigabitEthernet0/0 refreshed   <-- still coming
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
import type { CiscoTerminalSession } from '@/terminal/sessions/CiscoTerminalSession';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

const tick = (ms = 60) => new Promise<void>((r) => setTimeout(r, ms));

interface Lab {
  router: CiscoRouter;
  term: CiscoTerminalSession;
  /** One CDP advertisement round, as the 60 s periodic tick would do. */
  cdpRound: () => Promise<void>;
  consoleLines: () => string[];
}

async function lab(): Promise<Lab> {
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

  const sid = manager.openTerminal(router)!;
  const term = manager.getSession(sid) as CiscoTerminalSession;
  for (let i = 0; i < 40 && term.isBooting; i++) await tick(50);
  await router.executeCommand('enable');

  const agent = (router as unknown as { getCdpAgent: () => { advertiseAll: (r: 'periodic') => void } }).getCdpAgent();
  const cdpRound = async () => { agent.advertiseAll('periodic'); await tick(); };
  // First round: the neighbour is DISCOVERED, later rounds REFRESH it —
  // only the refresh raises the severity-7 line under test.
  await cdpRound();

  return {
    router,
    term,
    cdpRound,
    consoleLines: () => term.lines.map((l) => l.text).filter((t) => t.startsWith('%CDP')),
  };
}

describe('CDP neighbour chatter is debug output, not unsolicited console noise', () => {
  it('prints nothing while no debug is enabled', async () => {
    const { cdpRound, consoleLines, router } = await lab();
    await cdpRound();
    await cdpRound();

    expect(await router.executeCommand('show debugging')).toBe('No debug flags are enabled');
    expect(
      consoleLines(),
      'the operator never typed a debug command, so the console must stay quiet',
    ).toEqual([]);
  }, 30000);

  it('prints the neighbour once `debug cdp` is on, naming it', async () => {
    const { cdpRound, consoleLines, router } = await lab();
    expect(await router.executeCommand('debug cdp')).toBe('CDP packets debugging is on');
    await cdpRound();

    const lines = consoleLines();
    expect(lines.length).toBeGreaterThan(0);
    expect(
      lines[lines.length - 1],
      'the payload carries the neighbour name — rendering it as ? loses the whole point of the line',
    ).toContain('Neighbor Switch1 on GigabitEthernet0/0 refreshed');
  }, 30000);

  it('`show debugging` lists it, and `no debug all` really stops it', async () => {
    const { cdpRound, consoleLines, router } = await lab();
    await router.executeCommand('debug cdp');
    await cdpRound();
    expect(await router.executeCommand('show debugging')).toContain('CDP packets debugging is on');
    const whileOn = consoleLines().length;
    expect(whileOn).toBeGreaterThan(0);

    expect(await router.executeCommand('no debug all')).toBe('All possible debugging has been turned off');
    await cdpRound();
    await cdpRound();

    expect(
      consoleLines().length,
      'no debug all reported success, so not one more line may arrive',
    ).toBe(whileOn);
    expect(await router.executeCommand('show debugging')).toBe('No debug flags are enabled');
  }, 30000);

  it('`undebug all` stops it too', async () => {
    const { cdpRound, consoleLines, router } = await lab();
    await router.executeCommand('debug cdp');
    await cdpRound();
    const whileOn = consoleLines().length;

    await router.executeCommand('undebug all');
    await cdpRound();

    expect(consoleLines().length).toBe(whileOn);
  }, 30000);

  it('a line dropped by the gate never reaches the buffer either', async () => {
    const { cdpRound, router } = await lab();
    await cdpRound();

    expect(
      await router.executeCommand('show logging'),
      'suppressed debug output must not be quietly buffered — show logging would leak it back',
    ).not.toContain('%CDP-7');
  }, 30000);
});

describe('a switch console is gated the same way', () => {
  it('stays quiet until `debug cdp`, then reports the neighbour', async () => {
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

    const sid = manager.openTerminal(sw)!;
    const term = manager.getSession(sid)!;
    for (let i = 0; i < 40 && term.isBooting; i++) await tick(50);
    await sw.executeCommand('enable');

    const agent = (router as unknown as { getCdpAgent: () => { advertiseAll: (r: 'periodic') => void } }).getCdpAgent();
    const round = async () => { agent.advertiseAll('periodic'); await tick(); };
    await round();
    await round();

    const cdpLines = () => term.lines.map((l) => l.text).filter((t) => t.startsWith('%CDP'));
    expect(cdpLines(), 'the switch console never asked to debug anything either').toEqual([]);

    await sw.executeCommand('debug cdp');
    await round();
    expect(cdpLines().length).toBeGreaterThan(0);

    const whileOn = cdpLines().length;
    await sw.executeCommand('undebug all');
    await round();
    expect(cdpLines().length).toBe(whileOn);
  }, 30000);
});

describe('the gate covers every severity-7 producer, not just CDP', () => {
  it.each([
    ['debug lldp', 'LLDP packets debugging is on'],
    ['debug vxlan', 'VXLAN debugging is on'],
    ['debug port-security', 'Port security debugging is on'],
    ['debug ip pim', 'PIM debugging is on'],
  ])('`%s` is a real, reachable flag', async (cmd, expected) => {
    const { router } = await lab();
    expect(await router.executeCommand(cmd)).toBe(expected);
    expect(await router.executeCommand('show debugging')).toContain(expected);
    await router.executeCommand('undebug all');
    expect(await router.executeCommand('show debugging')).toBe('No debug flags are enabled');
  }, 30000);
});
