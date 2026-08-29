/**
 * PRD audit #26 — control-plane agents (NTP/SNMP/Syslog/NetFlow/RADIUS) and
 * TcpStack used to build their outgoing Ethernet frame with
 * `dstMAC: MACAddress.broadcast()` unconditionally, instead of consulting
 * the ARP cache and, on a miss, queuing the packet behind a real ARP
 * request/reply round-trip the way ICMP/UDP forwarding already does
 * (`EndHost.fwdQueueAndResolve` / `Router.queueAndResolve`). These tests
 * assert the real next-hop MAC is now resolved and used on the wire.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { EventBus } from '@/events/EventBus';
import { MACAddress, IPAddress, SubnetMask, resetCounters, type EthernetFrame, type IPv4Packet } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { UDP_PORT_NTP } from '@/network/ntp/types';
import { UDP_PORT_SYSLOG } from '@/network/syslog/types';
import { UDP_PORT_NETFLOW } from '@/network/netflow/types';
import { UDP_PORT_SNMP_TRAP } from '@/network/snmp/types';
import { UDP_PORT_RADIUS_AUTH } from '@/network/radius/types';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

/** Every UDP/dport frame the peer actually saw, keyed by destination port. */
function captureUdpFrames(bus: EventBus): Map<number, EthernetFrame[]> {
  const byPort = new Map<number, EthernetFrame[]>();
  bus.subscribe('cable.frame.delivered', (e) => {
    const frame = e.payload.frame;
    const ip = frame.payload as IPv4Packet | undefined;
    const udp = ip && typeof ip === 'object' && 'payload' in ip ? (ip.payload as { type?: string; destinationPort?: number } | undefined) : undefined;
    if (udp?.type === 'udp' && typeof udp.destinationPort === 'number') {
      const list = byPort.get(udp.destinationPort) ?? [];
      list.push(frame);
      byPort.set(udp.destinationPort, list);
    }
  });
  return byPort;
}

function twoRoutersOnASwitch(nameA: string, ipA: string, nameB: string, ipB: string) {
  const bus = new EventBus();
  const a = new CiscoRouter(nameA);
  const b = new CiscoRouter(nameB);
  const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
  a.setEventBus(bus); b.setEventBus(bus); sw.setEventBus(bus);
  const c1 = new Cable('c1'); c1.setEventBus(bus);
  const c2 = new Cable('c2'); c2.setEventBus(bus);
  c1.connect(a.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/1')!);
  c2.connect(b.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/2')!);
  a.configureInterface('GigabitEthernet0/0', new IPAddress(ipA), new SubnetMask('255.255.255.0'));
  b.configureInterface('GigabitEthernet0/0', new IPAddress(ipB), new SubnetMask('255.255.255.0'));
  a._clearArpEntry(ipB);
  b._clearArpEntry(ipA);
  return { bus, a, b, sw };
}

describe('ARP-aware control-plane sends (audit #26)', () => {
  it('NTP client resolves the server MAC via ARP instead of broadcasting', async () => {
    const { bus, a: server, b: client } = twoRoutersOnASwitch('NTP-SRV', '10.0.0.1', 'NTP-CLI', '10.0.0.2');
    const arpTargets: string[] = [];
    bus.subscribe('host.arp.request-sent', (e) => arpTargets.push(e.payload.targetIp));
    const udpFrames = captureUdpFrames(bus);

    await server.executeCommand('enable');
    await server.executeCommand('configure terminal');
    await server.executeCommand('ntp master 3');
    await server.executeCommand('end');

    await client.executeCommand('enable');
    await client.executeCommand('configure terminal');
    await client.executeCommand('ntp server 10.0.0.1');
    await client.executeCommand('end');

    expect(client.getNtpAgent().isSynced()).toBe(true);
    expect(arpTargets).toContain('10.0.0.1');

    const ntpFrames = udpFrames.get(UDP_PORT_NTP) ?? [];
    expect(ntpFrames.length).toBeGreaterThan(0);
    const serverMac = server.getPort('GigabitEthernet0/0')!.getMAC().toString();
    for (const f of ntpFrames) {
      expect(f.dstMAC.toString()).not.toBe(MACAddress.broadcast().toString());
    }
    // At least the request that reached the server used its real MAC.
    expect(ntpFrames.some(f => f.dstMAC.toString() === serverMac)).toBe(true);
  });

  it('NetFlow export resolves the collector MAC via ARP instead of broadcasting', () => {
    const { bus, a: exporter, b: collector } = twoRoutersOnASwitch('NF-EXP', '10.0.0.1', 'NF-COL', '10.0.0.2');
    const arpTargets: string[] = [];
    bus.subscribe('host.arp.request-sent', (e) => arpTargets.push(e.payload.targetIp));
    const udpFrames = captureUdpFrames(bus);

    exporter.getNetFlowAgent().setEnabled(true);
    exporter.getNetFlowAgent().addCollector('10.0.0.2');
    exporter.getNetFlowAgent().recordFlow({
      sourceIp: '192.168.1.10', destinationIp: '8.8.8.8',
      sourcePort: 5000, destinationPort: 53, protocol: 17, bytes: 100,
    });
    exporter.getNetFlowAgent().flushAllPending();

    expect(arpTargets).toContain('10.0.0.2');
    const nfFrames = udpFrames.get(UDP_PORT_NETFLOW) ?? [];
    expect(nfFrames.length).toBeGreaterThan(0);
    const collectorMac = collector.getPort('GigabitEthernet0/0')!.getMAC().toString();
    for (const f of nfFrames) {
      expect(f.dstMAC.toString()).not.toBe(MACAddress.broadcast().toString());
    }
    expect(nfFrames.some(f => f.dstMAC.toString() === collectorMac)).toBe(true);
  });

  it('SNMP trap resolves the NMS MAC via ARP instead of broadcasting', () => {
    const { bus, a: router, b: nms } = twoRoutersOnASwitch('SNMP-R', '10.0.0.1', 'SNMP-NMS', '10.0.0.2');
    const arpTargets: string[] = [];
    bus.subscribe('host.arp.request-sent', (e) => arpTargets.push(e.payload.targetIp));
    const udpFrames = captureUdpFrames(bus);

    router.getSnmpAgent().addTrapHost('10.0.0.2', 'public');
    router.getSnmpAgent().sendTrap('1.3.6.1.6.3.1.1.5.3');

    expect(arpTargets).toContain('10.0.0.2');
    const trapFrames = udpFrames.get(UDP_PORT_SNMP_TRAP) ?? [];
    expect(trapFrames.length).toBeGreaterThan(0);
    const nmsMac = nms.getPort('GigabitEthernet0/0')!.getMAC().toString();
    for (const f of trapFrames) {
      expect(f.dstMAC.toString()).not.toBe(MACAddress.broadcast().toString());
    }
    expect(trapFrames.some(f => f.dstMAC.toString() === nmsMac)).toBe(true);
  });

  it('Syslog forward resolves the collector MAC via ARP instead of broadcasting', () => {
    const { bus, a: router, b: collector } = twoRoutersOnASwitch('SYS-R', '10.0.0.1', 'SYS-COL', '10.0.0.2');
    const arpTargets: string[] = [];
    bus.subscribe('host.arp.request-sent', (e) => arpTargets.push(e.payload.targetIp));
    const udpFrames = captureUdpFrames(bus);

    router.getSyslogAgent().addServer('10.0.0.2');
    router.getSyslogAgent().sendImmediate('notification', '%SYS-5-RESTART',
      'Configuration changed by console');

    expect(arpTargets).toContain('10.0.0.2');
    const syslogFrames = udpFrames.get(UDP_PORT_SYSLOG) ?? [];
    expect(syslogFrames.length).toBeGreaterThan(0);
    const collectorMac = collector.getPort('GigabitEthernet0/0')!.getMAC().toString();
    for (const f of syslogFrames) {
      expect(f.dstMAC.toString()).not.toBe(MACAddress.broadcast().toString());
    }
    expect(syslogFrames.some(f => f.dstMAC.toString() === collectorMac)).toBe(true);
  });

  it('RADIUS Access-Request resolves the AAA server MAC via ARP instead of broadcasting', async () => {
    const { bus, a: nas, b: aaa } = twoRoutersOnASwitch('RAD-NAS', '10.0.0.1', 'RAD-AAA', '10.0.0.2');
    const arpTargets: string[] = [];
    bus.subscribe('host.arp.request-sent', (e) => arpTargets.push(e.payload.targetIp));
    const udpFrames = captureUdpFrames(bus);

    aaa.getRadiusServer().setSharedSecret('shared');
    aaa.getRadiusServer().addUser('alice', 'wonderland');
    nas.getRadiusClient().addServer('10.0.0.2', 'shared', { timeoutMs: 200, retransmit: 0 });

    const accepted = await nas.getRadiusClient().authenticate('alice', 'wonderland');
    expect(accepted).toBe(true);
    expect(arpTargets).toContain('10.0.0.2');

    const radiusFrames = udpFrames.get(UDP_PORT_RADIUS_AUTH) ?? [];
    expect(radiusFrames.length).toBeGreaterThan(0);
    const aaaMac = aaa.getPort('GigabitEthernet0/0')!.getMAC().toString();
    for (const f of radiusFrames) {
      expect(f.dstMAC.toString()).not.toBe(MACAddress.broadcast().toString());
    }
    expect(radiusFrames.some(f => f.dstMAC.toString() === aaaMac)).toBe(true);
  });

  it('TCP SYN resolves the peer MAC via ARP instead of broadcasting', () => {
    const { bus, a: client, b: server } = twoRoutersOnASwitch('TCP-CLI', '10.0.0.1', 'TCP-SRV', '10.0.0.2');
    const arpTargets: string[] = [];
    bus.subscribe('host.arp.request-sent', (e) => arpTargets.push(e.payload.targetIp));
    let sawUnicastSyn = false;
    const serverMac = server.getPort('GigabitEthernet0/0')!.getMAC().toString();
    bus.subscribe('cable.frame.delivered', (e) => {
      const frame = e.payload.frame;
      const ip = frame.payload as IPv4Packet | undefined;
      if (ip && typeof ip === 'object' && (ip as { protocol?: number }).protocol === 6) {
        if (frame.dstMAC.toString() === serverMac) sawUnicastSyn = true;
      }
    });

    server.getTcpStack().listen(49, { onAccept: () => undefined });
    const socket = client.getTcpStack().connect('10.0.0.2', 49);

    expect(socket).not.toBeNull();
    expect(socket!.state).toBe('established');
    expect(arpTargets).toContain('10.0.0.2');
    expect(sawUnicastSyn).toBe(true);
  });
});
