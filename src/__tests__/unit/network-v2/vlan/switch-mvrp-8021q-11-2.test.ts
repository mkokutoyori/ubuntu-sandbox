/**
 * IEEE Std 802.1Q-2022, 11.2 (MVRP) on a bridge: a VLAN declared by one
 * bridge is created dynamically on its neighbours and carried only on the
 * Ports that registered it (docs/rfc/dot1q/8021Q-2022.pdf).
 *
 *   11.2.3.2.2 a registration creates the VLAN on the receiving bridge
 *   10.3       MAP relays it through the next bridge, and a withdrawn
 *              declaration removes it from every bridge again
 *   8.8.2      a dynamically registered VLAN is forwarded only on the Ports
 *              that registered it
 *
 * Measured on a git worktree of HEAD before the change: Switch has no
 * setMvrpEnabled/configureMvrpPort, so all 4 cases fall. The witness (a
 * statically configured VLAN is forwarded on a trunk with MVRP disabled)
 * passes either way: it proves the lab forwards frames at all.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { MACAddress, resetCounters, ETHERTYPE_IPV4 } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { Port } from '@/network/hardware/Port';
import { Cable } from '@/network/hardware/Cable';
import type { EthernetFrame } from '@/network/core/types';
import type { TaggedEthernetFrame } from '@/network/devices/Switch';
import { installVirtualClock } from '@/__tests__/support/ntpTime';
import type { VirtualTimeScheduler } from '@/events/Scheduler';

let clock: VirtualTimeScheduler;

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
  clock = installVirtualClock();
});

function trunk(sw: CiscoSwitch, ...ports: string[]): void {
  for (const p of ports) sw.setSwitchportMode(p, 'trunk');
}

function link(a: CiscoSwitch, pa: string, b: CiscoSwitch, pb: string): void {
  new Cable(`${a.getName()}-${b.getName()}`).connect(a.getPort(pa)!, b.getPort(pb)!);
}

function mvrpOn(sw: CiscoSwitch, ...ports: string[]): void {
  sw.setMvrpEnabled(true);
  for (const p of ports) sw.configureMvrpPort(p, { enabled: true });
}

function settle(seconds = 90): void {
  for (let i = 0; i < seconds; i++) clock.advance(1000);
}

function tagged(vid: number): TaggedEthernetFrame {
  return {
    srcMAC: new MACAddress('aa:bb:cc:00:00:01'), dstMAC: MACAddress.broadcast(),
    etherType: ETHERTYPE_IPV4, payload: { type: 'test' },
    dot1q: { tpid: 0x8100, pcp: 0, dei: 0, vid },
  };
}

function sniff(sw: CiscoSwitch, portName: string): EthernetFrame[] {
  const sniffer = new Port(`sniff-${portName}`);
  const frames: EthernetFrame[] = [];
  sniffer.onFrame((_n, f) => { if (f.etherType === ETHERTYPE_IPV4) frames.push(f); });
  new Cable(`c-${portName}`).connect(sw.getPort(portName)!, sniffer);
  return frames;
}

async function configure(sw: CiscoSwitch, lines: string[]): Promise<void> {
  for (const line of ['enable', 'configure terminal', ...lines, 'end']) await sw.executeCommand(line);
}

async function chain(): Promise<{ sw1: CiscoSwitch; sw2: CiscoSwitch; sw3: CiscoSwitch }> {
  const sw1 = new CiscoSwitch('switch-cisco', 'SW1', 8);
  const sw2 = new CiscoSwitch('switch-cisco', 'SW2', 8);
  const sw3 = new CiscoSwitch('switch-cisco', 'SW3', 8);
  await configure(sw1, ['vlan 100', 'interface FastEthernet0/1', 'switchport mode access', 'switchport access vlan 100']);
  trunk(sw1, 'FastEthernet0/8');
  trunk(sw2, 'FastEthernet0/7', 'FastEthernet0/8');
  trunk(sw3, 'FastEthernet0/7');
  link(sw1, 'FastEthernet0/8', sw2, 'FastEthernet0/7');
  link(sw2, 'FastEthernet0/8', sw3, 'FastEthernet0/7');
  mvrpOn(sw1, 'FastEthernet0/8');
  mvrpOn(sw2, 'FastEthernet0/7', 'FastEthernet0/8');
  mvrpOn(sw3, 'FastEthernet0/7');
  return { sw1, sw2, sw3 };
}

describe('11.2: dynamic VLAN registration between bridges', () => {
  it('creates the VLAN on the neighbour that did not have it', async () => {
    const { sw2 } = await chain();
    expect(sw2.getVLANs().has(100)).toBe(false);
    settle();
    expect(sw2.getVLANs().has(100)).toBe(true);
    expect(sw2.isMvrpDynamicVlan(100)).toBe(true);
  });

  it('relays the registration through the middle bridge to the third', async () => {
    const { sw3 } = await chain();
    settle();
    expect(sw3.getVLANs().has(100)).toBe(true);
  });

  it('removes the VLAN everywhere once the declaring bridge withdraws it', async () => {
    const { sw1, sw2, sw3 } = await chain();
    settle();
    await configure(sw1, ['interface FastEthernet0/1', 'switchport access vlan 1', 'no vlan 100']);
    settle(120);
    expect(sw2.getVLANs().has(100)).toBe(false);
    expect(sw3.getVLANs().has(100)).toBe(false);
  });

  it('forwards a dynamic VLAN only on the Port that registered it', async () => {
    const { sw1, sw2 } = await chain();
    sw2.setSwitchportMode('FastEthernet0/6', 'trunk');
    const unregistered = sniff(sw2, 'FastEthernet0/6');
    settle();
    sw2.getPort('FastEthernet0/8')!.receiveFrame(tagged(100));
    expect(sw1.getMACTable().some((e) => e.vlan === 100 && e.mac.toLowerCase() === 'aa:bb:cc:00:00:01')).toBe(true);
    expect(unregistered).toHaveLength(0);
  });

  it('witness: a statically configured VLAN is forwarded on a trunk without MVRP', async () => {
    const sw2 = new CiscoSwitch('switch-cisco', 'SW2', 8);
    await configure(sw2, ['vlan 100']);
    trunk(sw2, 'FastEthernet0/6', 'FastEthernet0/7');
    const out = sniff(sw2, 'FastEthernet0/6');
    settle();
    sw2.getPort('FastEthernet0/7')!.receiveFrame(tagged(100));
    expect(out.length).toBeGreaterThan(0);
  });
});
