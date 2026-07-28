import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { EventBus } from '@/events/EventBus';
import { VirtualTimeScheduler, __setDefaultScheduler } from '@/events/Scheduler';
import {
  MACAddress, IPAddress, SubnetMask, resetCounters,
  type EthernetFrame, type IPv4Packet,
} from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { IP_PROTO_IGMP, type IgmpPacket } from '@/network/igmp/types';

let vts: VirtualTimeScheduler;

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
  vts = new VirtualTimeScheduler();
  __setDefaultScheduler(vts);
});

afterEach(() => {
  __setDefaultScheduler(null);
});

/** No multicast router anywhere — that is the whole point of the querier. */
function routerlessLab() {
  const bus = new EventBus();
  const sw = new CiscoSwitch('switch-cisco', 'SW', 8);
  const pc = new LinuxPC('PC1');
  sw.setEventBus(bus); pc.setEventBus(bus);
  new Cable('c1').connect(pc.getPort('eth0')!, sw.getPort('FastEthernet0/1')!);
  pc.getPort('eth0')!.configureIP(new IPAddress('192.168.1.10'), new SubnetMask('255.255.255.0'));
  return { bus, sw, pc };
}

async function run(sw: CiscoSwitch, lines: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const l of lines) out.push(await sw.executeCommand(l));
  return out;
}

function igmpOf(frame: EthernetFrame): IgmpPacket | null {
  const ip = frame.payload as IPv4Packet | undefined;
  if (!ip || ip.protocol !== IP_PROTO_IGMP) return null;
  const p = ip.payload as IgmpPacket | undefined;
  return p && p.type === 'igmp' ? p : null;
}

/** Only IGMP frames — the port also carries STP BPDUs every 2 s. */
function tapPort(sw: CiscoSwitch, portName: string): EthernetFrame[] {
  const seen: EthernetFrame[] = [];
  const port = sw.getPort(portName)!;
  const original = port.sendFrame.bind(port);
  (port as unknown as { sendFrame: (f: EthernetFrame) => void }).sendFrame = (f: EthernetFrame) => {
    if (igmpOf(f)) seen.push(f);
    original(f);
  };
  return seen;
}

describe('IGMP snooping querier (P4)', () => {
  it('stays operationally down with no source address configured', async () => {
    const { sw } = routerlessLab();
    await run(sw, ['enable', 'configure terminal', 'ip igmp snooping querier', 'end']);
    vts.advance(5_000);
    expect(sw.getIgmpSnoopingAgent().querierSourceIp(1)).toBeNull();
    expect(sw.getIgmpSnoopingAgent().isQuerierOperational(1)).toBe(false);
  });

  it('originates General Queries once an address is configured', async () => {
    const { sw } = routerlessLab();
    const seen = tapPort(sw, 'FastEthernet0/1');
    await run(sw, [
      'enable', 'configure terminal',
      'ip igmp snooping querier address 192.168.1.1',
      'ip igmp snooping querier',
      'end',
    ]);
    vts.advance(1_000);
    const queries = seen.map(igmpOf).filter(p => p?.messageType === 'membership-query');
    expect(queries.length).toBeGreaterThan(0);
    expect(queries[0]!.groupAddress).toBe('0.0.0.0');
    const ip = seen[0].payload as IPv4Packet;
    expect(ip.sourceIP.toString()).toBe('192.168.1.1');
    expect(ip.destinationIP.toString()).toBe('224.0.0.1');
    expect(seen[0].dstMAC.toString().toLowerCase()).toBe('01:00:5e:00:00:01');
  });

  it('repeats them on the 60 s IOS default interval, not IGMP 125 s', async () => {
    const { sw } = routerlessLab();
    const seen = tapPort(sw, 'FastEthernet0/1');
    await run(sw, [
      'enable', 'configure terminal',
      'ip igmp snooping querier address 192.168.1.1',
      'ip igmp snooping querier',
      'end',
    ]);
    vts.advance(1_000);
    const first = seen.length;
    vts.advance(59_000);
    expect(seen.length).toBe(first);
    vts.advance(2_000);
    expect(seen.length).toBeGreaterThan(first);
  });

  it('learns and maintains group membership with no router upstream', async () => {
    const { sw, pc } = routerlessLab();
    await run(sw, [
      'enable', 'configure terminal',
      'ip igmp snooping querier address 192.168.1.1',
      'ip igmp snooping querier',
      'end',
    ]);
    vts.advance(1_000);
    // The host answers the Query it just received.
    pc.joinMulticastGroup('eth0', '239.9.9.9');
    vts.advance(11_000);
    const groups = sw.getIgmpSnoopingAgent().listGroups(1);
    expect(groups.some(g => g.group.groupAddress === '239.9.9.9'
      && g.group.members.has('FastEthernet0/1'))).toBe(true);
  });

  it('uses the VLAN SVI address when no querier address is configured', async () => {
    const { sw } = routerlessLab();
    await run(sw, [
      'enable', 'configure terminal',
      'interface Vlan1', 'ip address 192.168.1.2 255.255.255.0', 'exit',
      'ip igmp snooping querier',
      'end',
    ]);
    expect(sw.getIgmpSnoopingAgent().querierSourceIp(1)).toBe('192.168.1.2');
    expect(sw.getIgmpSnoopingAgent().isQuerierOperational(1)).toBe(true);
  });

  it('per-VLAN querier works independently of the global one', async () => {
    const { sw } = routerlessLab();
    await run(sw, [
      'enable', 'configure terminal',
      'ip igmp snooping querier address 192.168.1.1',
      'ip igmp snooping vlan 1 querier',
      'end',
    ]);
    expect(sw.getIgmpSnoopingAgent().getConfig().querierEnabled).toBe(false);
    expect(sw.getIgmpSnoopingAgent().isQuerierOperational(1)).toBe(true);
  });

  it('yields to a real querier with a lower address, and takes over when it goes quiet', async () => {
    const { sw } = routerlessLab();
    await run(sw, [
      'enable', 'configure terminal',
      'ip igmp snooping querier address 192.168.1.100',
      'ip igmp snooping querier',
      'end',
    ]);
    const agent = sw.getIgmpSnoopingAgent();
    expect(agent.isQuerierOperational(1)).toBe(true);

    const v = agent.getVlanState(1)!;
    v.querierIp = '192.168.1.1';
    v.lastQuerierMs = vts.now();
    expect(agent.isQuerierOperational(1)).toBe(false);

    vts.advance(256_000);
    expect(agent.isQuerierOperational(1)).toBe(true);
  });

  it('no ip igmp snooping querier stops it', async () => {
    const { sw } = routerlessLab();
    await run(sw, [
      'enable', 'configure terminal',
      'ip igmp snooping querier address 192.168.1.1',
      'ip igmp snooping querier',
      'no ip igmp snooping querier',
      'end',
    ]);
    expect(sw.getIgmpSnoopingAgent().isQuerierOperational(1)).toBe(false);
  });

  it('show ip igmp snooping querier reports admin and operational state', async () => {
    const { sw } = routerlessLab();
    await run(sw, [
      'enable', 'configure terminal',
      'ip igmp snooping querier address 192.168.1.1',
      'ip igmp snooping querier',
      'end',
    ]);
    const out = await sw.executeCommand('show ip igmp snooping querier');
    expect(out).toMatch(/Admin state\s+: Enabled/);
    expect(out).toMatch(/Operational state\s+: Enabled/);
    expect(out).toMatch(/Querier address\s+: 192\.168\.1\.1/);
    expect(out).toMatch(/Query interval\s+: 60/);
  });

  it('a custom query-interval is honoured', async () => {
    const { sw } = routerlessLab();
    const seen = tapPort(sw, 'FastEthernet0/1');
    await run(sw, [
      'enable', 'configure terminal',
      'ip igmp snooping querier address 192.168.1.1',
      'ip igmp snooping querier query-interval 10',
      'ip igmp snooping querier',
      'end',
    ]);
    vts.advance(1_000);
    const first = seen.length;
    vts.advance(11_000);
    expect(seen.length).toBeGreaterThan(first);
  });
});
