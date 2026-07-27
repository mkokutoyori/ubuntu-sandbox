import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

const MASK = '255.255.255.0';

async function natRouter(name: string, ip: string): Promise<CiscoRouter> {
  const r = new CiscoRouter(name, 0, 0);
  const iface = r.getPortNames()[0];
  for (const cmd of [
    'enable', 'configure terminal', `hostname ${name}`,
    `interface ${iface}`, `ip address ${ip} ${MASK}`, 'ip nat inside', 'no shutdown', 'exit',
    'access-list 1 permit 10.0.0.0 0.0.0.255',
    `ip nat inside source list 1 interface ${iface} overload`,
    'end',
  ]) await r.executeCommand(cmd);
  return r;
}

/** Every `nat.*` topic this engine can publish, seen on one bus. */
function collectNatTopics(router: CiscoRouter): string[] {
  const seen: string[] = [];
  const bus = (router as unknown as { getBus: () => { subscribeAll?: (h: (e: { topic: string }) => void) => void } }).getBus();
  bus.subscribeAll?.((e) => { if (e.topic.startsWith('nat.')) seen.push(e.topic); });
  return seen;
}

describe('a router\'s NAT engine publishes on its own bus, not a shared one', () => {
  it('nothing a router\'s NAT engine publishes reaches another router\'s bus', async () => {
    const sw = new GenericSwitch('switch-generic', 'sw', 8, 0, 0);
    const a = await natRouter('R_A', '10.0.0.1');
    const b = await natRouter('R_B', '10.0.0.2');
    new Cable('ca').connect(a.getPorts()[0], sw.getPorts()[0]);
    new Cable('cb').connect(b.getPorts()[0], sw.getPorts()[1]);

    const onA = collectNatTopics(a);
    const onB = collectNatTopics(b);

    // Make A's NAT engine emit: a translation is the engine's own event,
    // published on whichever bus it was wired to.
    const natA = (a as unknown as { natEngine: { translateOutbound?: (...args: unknown[]) => unknown } }).natEngine;
    (natA as unknown as { emitSignalRefresh?: () => void }).emitSignalRefresh?.();
    await a.executeCommand('show ip nat translations');

    expect(
      onB,
      'B subscribed to its own bus — an event from A must never be delivered there, ' +
      'not merely filtered out by a predicate once it has arrived',
    ).toEqual([]);
    expect(Array.isArray(onA)).toBe(true);
  }, 30000);

  it('the NAT engine is wired to the router\'s bus, not the global one', async () => {
    const r = await natRouter('R_C', '10.0.0.3');
    const ownBus = (r as unknown as { getBus: () => unknown }).getBus();
    const engineBus = (r as unknown as {
      natEngine: { getBus?: () => unknown; busOverride?: unknown };
    }).natEngine;

    // Reading the engine's own wiring: a bus it never received leaves it
    // on the process-wide default, which is what makes cross-router
    // delivery possible in the first place.
    const wired = (engineBus as unknown as { busOverride?: unknown }).busOverride;
    expect(
      wired,
      'the owning router must hand its bus to the NAT engine, as it already does for IPSec',
    ).toBe(ownBus);
  }, 30000);
});
