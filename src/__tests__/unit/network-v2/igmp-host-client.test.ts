import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
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

/** PC ── SW ── R1, the classic last-hop-router lab. */
function lab() {
  const bus = new EventBus();
  const pc = new LinuxPC('PC1');
  const sw = new CiscoSwitch('switch-cisco', 'SW', 8);
  const r = new CiscoRouter('R1');
  pc.setEventBus(bus); sw.setEventBus(bus); r.setEventBus(bus);
  new Cable('c1').connect(pc.getPort('eth0')!, sw.getPort('FastEthernet0/1')!);
  new Cable('c2').connect(r.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/2')!);
  pc.getPort('eth0')!.configureIP(new IPAddress('10.0.0.10'), new SubnetMask('255.255.255.0'));
  r.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
  r.getIgmpAgent().enableInterface('GigabitEthernet0/0', 2);
  return { bus, pc, sw, r };
}

function igmpOf(frame: EthernetFrame): IgmpPacket | null {
  const ip = frame.payload as IPv4Packet | undefined;
  if (!ip || ip.protocol !== IP_PROTO_IGMP) return null;
  const p = ip.payload as IgmpPacket | undefined;
  return p && p.type === 'igmp' ? p : null;
}

function tap(dev: { getPort(n: string): import('@/network/hardware/Port').Port | undefined }, portName: string) {
  const out: Array<{ igmp: IgmpPacket; ip: IPv4Packet; eth: EthernetFrame }> = [];
  const port = dev.getPort(portName)!;
  const original = port.sendFrame.bind(port);
  (port as unknown as { sendFrame: (f: EthernetFrame) => void }).sendFrame = (f: EthernetFrame) => {
    const igmp = igmpOf(f);
    if (igmp) out.push({ igmp, ip: f.payload as IPv4Packet, eth: f });
    original(f);
  };
  return out;
}

describe('IGMP host client — joining (P1)', () => {
  it('a real Membership Report goes out on the wire', () => {
    const { pc } = lab();
    const sent = tap(pc, 'eth0');
    expect(pc.joinMulticastGroup('eth0', '239.1.1.1')).toBe(true);
    expect(sent.length).toBe(1);
    expect(sent[0].igmp.messageType).toBe('v2-membership-report');
    expect(sent[0].igmp.groupAddress).toBe('239.1.1.1');
    // RFC 2236 §2: a Report is sent to the group itself, TTL 1.
    expect(sent[0].ip.destinationIP.toString()).toBe('239.1.1.1');
    expect(sent[0].ip.ttl).toBe(1);
    expect(sent[0].ip.sourceIP.toString()).toBe('10.0.0.10');
    // RFC 1112 §6.4 MAC mapping for 239.1.1.1.
    expect(sent[0].eth.dstMAC.toString().toLowerCase()).toBe('01:00:5e:01:01:01');
  });

  it('the downstream router learns the group and tells PIM', () => {
    const { bus, pc, r } = lab();
    const joins: Array<{ groupAddress: string; reporterIp: string }> = [];
    bus.subscribe('igmp.group.joined', (e) => joins.push(e.payload));
    pc.joinMulticastGroup('eth0', '239.2.2.2');
    expect(r.getIgmpAgent().hasMember('GigabitEthernet0/0', '239.2.2.2')).toBe(true);
    expect(joins.some(j => j.groupAddress === '239.2.2.2' && j.reporterIp === '10.0.0.10')).toBe(true);
    expect(r.getPimAgent().getMroute('239.2.2.2')).toBeDefined();
  });

  it('the switch in between snoops the Report and stops flooding the group', () => {
    const { pc, sw } = lab();
    pc.joinMulticastGroup('eth0', '239.3.3.3');
    const groups = sw.getIgmpSnoopingAgent().listGroups(1);
    const g = groups.find(x => x.group.groupAddress === '239.3.3.3');
    expect(g?.group.members.has('FastEthernet0/1')).toBe(true);
    const egress = sw.getIgmpSnoopingAgent().computeEgressPorts('FastEthernet0/2', '239.3.3.3');
    expect(egress).toContain('FastEthernet0/1');
    expect(egress).not.toContain('FastEthernet0/3');
  });

  it('rejects a unicast address and the link-local scope', () => {
    const { pc } = lab();
    expect(pc.joinMulticastGroup('eth0', '10.1.1.1')).toBe(false);
    expect(pc.joinMulticastGroup('eth0', '224.0.0.5')).toBe(false);
    expect(pc.listMulticastGroups()).toEqual([]);
  });

  it('joining twice is idempotent', () => {
    const { pc } = lab();
    const sent = tap(pc, 'eth0');
    pc.joinMulticastGroup('eth0', '239.4.4.4');
    pc.joinMulticastGroup('eth0', '239.4.4.4');
    expect(sent.length).toBe(1);
    expect(pc.listMulticastGroups()).toHaveLength(1);
  });

  it('repeats the unsolicited Report once, per RFC 2236 §8.10', () => {
    const { pc } = lab();
    const sent = tap(pc, 'eth0');
    pc.joinMulticastGroup('eth0', '239.5.5.5');
    expect(sent.length).toBe(1);
    vts.advance(10_000);
    expect(sent.length).toBe(2);
    expect(sent[1].igmp.messageType).toBe('v2-membership-report');
  });
});

describe('IGMP host client — answering Queries (P1)', () => {
  it('answers a General Query for every joined group', () => {
    const { pc, r } = lab();
    pc.joinMulticastGroup('eth0', '239.6.6.6');
    pc.joinMulticastGroup('eth0', '239.7.7.7');
    const sent = tap(pc, 'eth0');
    r.getIgmpAgent().enableInterface('GigabitEthernet0/0', 2);
    // Reports are delayed by a random slice of Max Response Time (10 s).
    vts.advance(10_000);
    const groups = sent.filter(s => s.igmp.messageType === 'v2-membership-report')
      .map(s => s.igmp.groupAddress);
    expect(groups).toContain('239.6.6.6');
    expect(groups).toContain('239.7.7.7');
  });

  it('keeps the router membership alive across the group membership interval', () => {
    const { pc, r } = lab();
    pc.joinMulticastGroup('eth0', '239.8.8.8');
    expect(r.getIgmpAgent().hasMember('GigabitEthernet0/0', '239.8.8.8')).toBe(true);
    // 300 s > the 260 s Group Membership Interval: without real Query/Report
    // exchange the router would have aged this group out.
    for (let i = 0; i < 30; i++) vts.advance(10_000);
    expect(r.getIgmpAgent().hasMember('GigabitEthernet0/0', '239.8.8.8')).toBe(true);
  });

  it('does not answer a Group-Specific Query for a group it has not joined', () => {
    const { pc, r } = lab();
    pc.joinMulticastGroup('eth0', '239.9.9.9');
    const sent = tap(pc, 'eth0');
    r.getIgmpAgent().injectReport('GigabitEthernet0/0', '239.11.11.11', '10.0.0.99');
    // Force the router to emit a Group-Specific Query for the other group.
    r.getIgmpAgent().handleIp('GigabitEthernet0/0', new IPAddress('10.0.0.99'), {
      type: 'ipv4', version: 4, ihl: 6, tos: 0xc0, totalLength: 32,
      identification: 1, flags: 0, fragmentOffset: 0, ttl: 1,
      protocol: IP_PROTO_IGMP, headerChecksum: 0,
      sourceIP: new IPAddress('10.0.0.99'),
      destinationIP: new IPAddress('224.0.0.2'),
      payload: {
        type: 'igmp', version: 2, messageType: 'leave-group',
        maxRespTimeDs: 0, groupAddress: '239.11.11.11', checksum: 0,
      } as IgmpPacket,
    } as IPv4Packet);
    vts.advance(10_000);
    const answered = sent.filter(s => s.igmp.messageType === 'v2-membership-report')
      .map(s => s.igmp.groupAddress);
    expect(answered).not.toContain('239.11.11.11');
  });
});

describe('IGMP host client — leaving (P1)', () => {
  it('emits a real Leave Group to all-routers and the router drops the group', () => {
    const { pc, r } = lab();
    pc.joinMulticastGroup('eth0', '239.12.12.12');
    const sent = tap(pc, 'eth0');
    expect(pc.leaveMulticastGroup('eth0', '239.12.12.12')).toBe(true);
    const leave = sent.find(s => s.igmp.messageType === 'leave-group');
    expect(leave).toBeDefined();
    expect(leave!.igmp.groupAddress).toBe('239.12.12.12');
    expect(leave!.ip.destinationIP.toString()).toBe('224.0.0.2');
    expect(r.getIgmpAgent().hasMember('GigabitEthernet0/0', '239.12.12.12')).toBe(false);
  });

  it('leaving a group never joined is a no-op', () => {
    const { pc } = lab();
    const sent = tap(pc, 'eth0');
    expect(pc.leaveMulticastGroup('eth0', '239.13.13.13')).toBe(false);
    expect(sent.length).toBe(0);
  });

  it('sends no Leave while an IGMPv1 querier is present (RFC 2236 §4)', () => {
    const { pc, r } = lab();
    pc.joinMulticastGroup('eth0', '239.14.14.14');
    // An IGMPv1 Query is identified by Max Response Time 0.
    r.getIgmpAgent().enableInterface('GigabitEthernet0/0', 1);
    const rt = r.getIgmpAgent().getInterfaceRuntime('GigabitEthernet0/0')!;
    rt.queryResponseIntervalDs = 0;
    r.getIgmpAgent().enableInterface('GigabitEthernet0/0', 1);

    expect(pc.getIgmpHostAgent().querierVersion('eth0')).toBe(1);
    const sent = tap(pc, 'eth0');
    pc.leaveMulticastGroup('eth0', '239.14.14.14');
    expect(sent.some(s => s.igmp.messageType === 'leave-group')).toBe(false);
  });

  it('reports as v1 while a v1 querier is present', () => {
    const { pc, r } = lab();
    r.getIgmpAgent().enableInterface('GigabitEthernet0/0', 1);
    const rt = r.getIgmpAgent().getInterfaceRuntime('GigabitEthernet0/0')!;
    rt.queryResponseIntervalDs = 0;
    r.getIgmpAgent().enableInterface('GigabitEthernet0/0', 1);

    const sent = tap(pc, 'eth0');
    pc.joinMulticastGroup('eth0', '239.15.15.15');
    expect(sent[0].igmp.messageType).toBe('v1-membership-report');
  });
});

describe('IGMP host client — NIC-level multicast filtering (P1)', () => {
  it('accepts frames for a joined group and drops frames for other groups', () => {
    const { pc } = lab();
    const agent = pc.getIgmpHostAgent();
    pc.joinMulticastGroup('eth0', '239.16.16.16');
    expect(agent.acceptsGroup('eth0', '239.16.16.16')).toBe(true);
    expect(agent.acceptsGroup('eth0', '239.17.17.17')).toBe(false);
    // The link-local range is always accepted — that is how Queries arrive.
    expect(agent.acceptsGroup('eth0', '224.0.0.1')).toBe(true);
  });
});

describe('IGMP host client — CLI surfaces (P1)', () => {
  it('Linux: ip maddr add joins and ip maddr show lists it', async () => {
    const { pc, r } = lab();
    const sent = tap(pc, 'eth0');
    expect(await pc.executeCommand('ip maddr add 239.20.20.20 dev eth0')).toBe('');
    expect(sent.some(s => s.igmp.groupAddress === '239.20.20.20')).toBe(true);
    expect(r.getIgmpAgent().hasMember('GigabitEthernet0/0', '239.20.20.20')).toBe(true);

    const show = await pc.executeCommand('ip maddr show dev eth0');
    expect(show).toMatch(/inet 239\.20\.20\.20/);
    expect(show).toMatch(/inet 224\.0\.0\.1/);
  });

  it('Linux: ip maddr del leaves the group', async () => {
    const { pc, r } = lab();
    await pc.executeCommand('ip maddr add 239.21.21.21 dev eth0');
    expect(await pc.executeCommand('ip maddr del 239.21.21.21 dev eth0')).toBe('');
    expect(r.getIgmpAgent().hasMember('GigabitEthernet0/0', '239.21.21.21')).toBe(false);
  });

  it('Linux: ip maddr rejects a missing dev and an unknown interface', async () => {
    const { pc } = lab();
    expect(await pc.executeCommand('ip maddr add 239.22.22.22')).toMatch(/"dev" argument is required/);
    expect(await pc.executeCommand('ip maddr add 239.22.22.22 dev eth9')).toMatch(/Cannot find device "eth9"/);
  });

  it('Windows: netsh interface ipv4 show joins lists the joined groups', async () => {
    const bus = new EventBus();
    const winPc = new WindowsPC('windows-pc', 'WIN1');
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    winPc.setEventBus(bus); sw.setEventBus(bus);
    new Cable('c1').connect(winPc.getPort('eth0')!, sw.getPort('FastEthernet0/1')!);
    winPc.getPort('eth0')!.configureIP(new IPAddress('10.0.0.20'), new SubnetMask('255.255.255.0'));
    winPc.joinMulticastGroup('eth0', '239.30.30.30');

    const out = await winPc.executeCommand('netsh interface ipv4 show joins');
    expect(out).toMatch(/239\.30\.30\.30/);
    expect(out).toMatch(/224\.0\.0\.1/);
  });

  it('a LinuxServer joins through the same path', () => {
    const bus = new EventBus();
    const srv = new LinuxServer('linux-server', 'SRV1');
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    srv.setEventBus(bus); sw.setEventBus(bus);
    const srvPort = srv.getPortNames()[0];
    new Cable('c1').connect(srv.getPort(srvPort)!, sw.getPort('FastEthernet0/1')!);
    srv.getPort(srvPort)!.configureIP(new IPAddress('10.0.0.30'), new SubnetMask('255.255.255.0'));
    expect(srv.joinMulticastGroup(srvPort, '239.31.31.31')).toBe(true);
    expect(sw.getIgmpSnoopingAgent().listGroups(1)
      .some(g => g.group.groupAddress === '239.31.31.31')).toBe(true);
  });
});
