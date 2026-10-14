/**
 * `ntp-service unicast-server <ip> version <n>` and `... source-interface
 * <if>` were parsed, validated and then dropped: the line read back without
 * them and the request left as version 4 from the egress interface. Both are
 * now stored on the association and decide what the wire carries: the NTP
 * version byte of the request, and the source address of the datagram.
 *
 * Measured against HEAD (git worktree): the 3 option cases fall; the
 * witness (a plain unicast-server leaves as version 4 from the first
 * interface) passes either way.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { EventBus } from '@/events/EventBus';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import type { VirtualTimeScheduler } from '@/events/Scheduler';
import { installVirtualClock, converge } from '../../support/ntpTime';

let clock: VirtualTimeScheduler;

beforeEach(() => {
  clock = installVirtualClock();
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

interface Seen { version: number; source: string; destination: string }

async function lab(serverLine: string) {
  const bus = new EventBus();
  const huawei = new HuaweiRouter('R1');
  const reference = new CiscoRouter('R2');
  const sw = new GenericSwitch('switch-generic', 'SW');
  for (const device of [huawei, reference, sw]) device.setEventBus(bus);
  const cables = [new Cable('a'), new Cable('b'), new Cable('c')];
  cables.forEach((cable) => cable.setEventBus(bus));
  cables[0].connect(huawei.getPorts()[0], sw.getPorts()[0]);
  cables[1].connect(huawei.getPorts()[1], sw.getPorts()[1]);
  cables[2].connect(reference.getPort('GigabitEthernet0/0')!, sw.getPorts()[2]);
  const seen: Seen[] = [];
  bus.subscribe('cable.frame.delivered', (event) => {
    const packet = event.payload.frame.payload as unknown as {
      protocol?: number; sourceIP?: { toString(): string }; destinationIP?: { toString(): string };
      payload?: { destinationPort?: number; payload?: Uint8Array };
    } | undefined;
    const body = packet?.payload?.payload;
    if (packet?.protocol === 17 && packet.payload?.destinationPort === 123 && body instanceof Uint8Array && (body[0] & 7) === 3) {
      seen.push({ version: (body[0] >> 3) & 7, source: packet.sourceIP!.toString(), destination: packet.destinationIP!.toString() });
    }
  });
  for (const command of ['enable', 'configure terminal', 'interface GigabitEthernet0/0', 'ip address 10.0.0.1 255.255.255.0',
    'no shutdown', 'exit', 'ntp master 2', 'end']) await reference.executeCommand(command);
  for (const command of ['system-view', 'interface GigabitEthernet0/0/0', 'ip address 10.0.0.2 255.255.255.0', 'undo shutdown', 'quit',
    'interface GigabitEthernet0/0/1', 'ip address 10.0.0.3 255.255.255.0', 'undo shutdown', 'quit', serverLine, 'return']) {
    await huawei.executeCommand(command);
  }
  converge(clock, 200_000);
  return { huawei, seen };
}

describe('unicast-server options reach the wire', () => {
  it('witness: a plain unicast-server leaves as version 4 and synchronises', async () => {
    const { huawei, seen } = await lab('ntp-service unicast-server 10.0.0.1');
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((s) => s.version === 4)).toBe(true);
    expect(await huawei.executeCommand('display ntp-service status')).toContain('Clock status: synchronized');
  });

  it('[fails before] version 3 is the version byte of every request', async () => {
    const { seen } = await lab('ntp-service unicast-server 10.0.0.1 version 3');
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((s) => s.version === 3)).toBe(true);
  });

  it('[fails before] source-interface decides the source address of the request', async () => {
    const { seen } = await lab('ntp-service unicast-server 10.0.0.1 source-interface GigabitEthernet0/0/1');
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((s) => s.source === '10.0.0.3')).toBe(true);
  });

  it('[fails before] the configuration reads both options back', async () => {
    const { huawei } = await lab('ntp-service unicast-server 10.0.0.1 version 3 source-interface GigabitEthernet0/0/1 preference');
    const config = await huawei.executeCommand('display current-configuration');
    expect(config.split('\n').filter((l) => l.includes('ntp-service'))).toEqual(['ntp-service unicast-server 10.0.0.1 version 3 source-interface GigabitEthernet0/0/1 preference']);
  });
});
