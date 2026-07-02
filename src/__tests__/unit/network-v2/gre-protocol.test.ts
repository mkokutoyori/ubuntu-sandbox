import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { EventBus } from '@/events/EventBus';
import {
  MACAddress, IPAddress, SubnetMask, resetCounters,
  IP_PROTO_ICMP, nextIPv4Id, computeIPv4Checksum,
  type IPv4Packet, type ICMPPacket,
} from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import {
  IP_PROTO_GRE, GRE_PROTOCOL_IPV4, matchTunnel, defaultTunnel,
} from '@/network/gre/types';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

function makeInner(srcIp: string, dstIp: string): IPv4Packet {
  const icmp: ICMPPacket = {
    type: 'icmp', icmpType: 8, code: 0, checksum: 0,
    id: 1, sequence: 1, data: 'gre-test',
  };
  const pkt: IPv4Packet = {
    type: 'ipv4', version: 4, ihl: 5, tos: 0,
    totalLength: 28,
    identification: nextIPv4Id(), flags: 0, fragmentOffset: 0,
    ttl: 64, protocol: IP_PROTO_ICMP, headerChecksum: 0,
    sourceIP: new IPAddress(srcIp),
    destinationIP: new IPAddress(dstIp),
    payload: icmp,
  };
  pkt.headerChecksum = computeIPv4Checksum(pkt);
  return pkt;
}

describe('GRE — pure helpers', () => {
  it('IP_PROTO_GRE matches IANA assignment', () => {
    expect(IP_PROTO_GRE).toBe(47);
  });

  it('GRE_PROTOCOL_IPV4 follows RFC 1701 EtherType encoding', () => {
    expect(GRE_PROTOCOL_IPV4).toBe(0x0800);
  });

  it('matchTunnel finds the right (src,dst,key) on the receiving side', () => {
    const t1 = defaultTunnel('Tunnel0', '10.0.0.1', '10.0.0.2');
    const t2 = defaultTunnel('Tunnel1', '10.0.0.1', '10.0.0.3');
    expect(matchTunnel([t1, t2], '10.0.0.2', '10.0.0.1', null)?.tunnelId).toBe('Tunnel0');
    expect(matchTunnel([t1, t2], '10.0.0.3', '10.0.0.1', null)?.tunnelId).toBe('Tunnel1');
    expect(matchTunnel([t1, t2], '10.0.0.99', '10.0.0.1', null)).toBeNull();
  });

  it('matchTunnel honours the tunnel key', () => {
    const t = defaultTunnel('Tunnel0', '10.0.0.1', '10.0.0.2');
    t.key = 42;
    expect(matchTunnel([t], '10.0.0.2', '10.0.0.1', 42)?.tunnelId).toBe('Tunnel0');
    expect(matchTunnel([t], '10.0.0.2', '10.0.0.1', 99)).toBeNull();
  });
});

describe('GRE — tunnel registry', () => {
  it('addTunnel registers a tunnel and emits gre.tunnel.changed with added=true', () => {
    const bus = new EventBus();
    const r = new CiscoRouter('R1');
    r.setEventBus(bus);
    const events: Array<{ tunnelId: string; added: boolean }> = [];
    bus.subscribe('gre.tunnel.changed', (e) => events.push(e.payload));
    r.getGreAgent().addTunnel('Tunnel0', '10.0.0.1', '10.0.0.2', { overlayIp: '192.168.99.1', overlayMask: '255.255.255.252' });
    expect(events.length).toBe(1);
    expect(events[0]).toMatchObject({ tunnelId: 'Tunnel0', added: true });
    expect(r.getGreAgent().getTunnel('Tunnel0')?.overlayIp).toBe('192.168.99.1');
  });

  it('removeTunnel emits gre.tunnel.changed with added=false', () => {
    const bus = new EventBus();
    const r = new CiscoRouter('R1');
    r.setEventBus(bus);
    r.getGreAgent().addTunnel('Tunnel0', '10.0.0.1', '10.0.0.2');
    const events: Array<{ added: boolean }> = [];
    bus.subscribe('gre.tunnel.changed', (e) => events.push(e.payload));
    r.getGreAgent().removeTunnel('Tunnel0');
    expect(events.some(e => !e.added)).toBe(true);
    expect(r.getGreAgent().getTunnel('Tunnel0')).toBeUndefined();
  });
});

describe('GRE — encap/decap end-to-end', () => {
  it('encapsulated packet rides IP/47 from R1 to R2 and the peer decaps it', () => {
    const bus = new EventBus();
    const r1 = new CiscoRouter('R1');
    const r2 = new CiscoRouter('R2');
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    r1.setEventBus(bus); r2.setEventBus(bus); sw.setEventBus(bus);
    new Cable('a').connect(r1.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/1')!);
    new Cable('b').connect(r2.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/2')!);
    r1.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
    r2.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));

    r1.getGreAgent().addTunnel('Tunnel0', '10.0.0.1', '10.0.0.2');
    r2.getGreAgent().addTunnel('Tunnel0', '10.0.0.2', '10.0.0.1');

    const decaps: Array<{ tunnelId: string; innerSourceIp: string | null; innerDestinationIp: string | null }> = [];
    bus.subscribe('gre.packet.decapsulated', (e) => decaps.push(e.payload));

    const inner = makeInner('192.168.99.1', '192.168.99.2');
    r1.getGreAgent().encapsulateAndSend('Tunnel0', inner);

    expect(decaps.length).toBe(1);
    expect(decaps[0].tunnelId).toBe('Tunnel0');
    expect(decaps[0].innerSourceIp).toBe('192.168.99.1');
    expect(decaps[0].innerDestinationIp).toBe('192.168.99.2');
  });

  it('publishes gre.packet.encapsulated on send', () => {
    const bus = new EventBus();
    const r1 = new CiscoRouter('R1');
    const r2 = new CiscoRouter('R2');
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    r1.setEventBus(bus); r2.setEventBus(bus); sw.setEventBus(bus);
    new Cable('a').connect(r1.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/1')!);
    new Cable('b').connect(r2.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/2')!);
    r1.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
    r2.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));

    r1.getGreAgent().addTunnel('Tunnel0', '10.0.0.1', '10.0.0.2');
    r2.getGreAgent().addTunnel('Tunnel0', '10.0.0.2', '10.0.0.1');

    const encaps: Array<{ tunnelId: string; protocolType: number }> = [];
    bus.subscribe('gre.packet.encapsulated', (e) => encaps.push(e.payload));

    r1.getGreAgent().encapsulateAndSend('Tunnel0', makeInner('192.168.99.1', '192.168.99.2'));
    expect(encaps.length).toBe(1);
    expect(encaps[0].tunnelId).toBe('Tunnel0');
    expect(encaps[0].protocolType).toBe(GRE_PROTOCOL_IPV4);
  });

  it('the outer header uses IP protocol 47 (GRE) on the wire', () => {
    const bus = new EventBus();
    const r1 = new CiscoRouter('R1');
    const r2 = new CiscoRouter('R2');
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    r1.setEventBus(bus); r2.setEventBus(bus); sw.setEventBus(bus);
    const cable = new Cable('a');
    cable.setEventBus(bus);
    let seen: { proto: number; outerSrc: string; outerDst: string } | null = null;
    bus.subscribe('cable.frame.delivered', (e) => {
      const ipPkt = (e.payload.frame.payload as unknown) as { protocol?: number; sourceIP?: { toString: () => string }; destinationIP?: { toString: () => string } } | undefined;
      if (ipPkt?.protocol === IP_PROTO_GRE) {
        seen = { proto: ipPkt.protocol, outerSrc: ipPkt.sourceIP!.toString(), outerDst: ipPkt.destinationIP!.toString() };
      }
    });
    cable.connect(r1.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/1')!);
    new Cable('b').connect(r2.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/2')!);
    r1.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
    r2.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));

    r1.getGreAgent().addTunnel('Tunnel0', '10.0.0.1', '10.0.0.2');
    r2.getGreAgent().addTunnel('Tunnel0', '10.0.0.2', '10.0.0.1');
    r1.getGreAgent().encapsulateAndSend('Tunnel0', makeInner('192.168.99.1', '192.168.99.2'));

    expect(seen).not.toBeNull();
    expect(seen!.proto).toBe(IP_PROTO_GRE);
    expect(seen!.outerSrc).toBe('10.0.0.1');
    expect(seen!.outerDst).toBe('10.0.0.2');
  });
});

describe('GRE — key mismatch', () => {
  it('a packet with the wrong tunnel key is dropped with reason=key-mismatch', () => {
    const bus = new EventBus();
    const r1 = new CiscoRouter('R1');
    const r2 = new CiscoRouter('R2');
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    r1.setEventBus(bus); r2.setEventBus(bus); sw.setEventBus(bus);
    new Cable('a').connect(r1.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/1')!);
    new Cable('b').connect(r2.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/2')!);
    r1.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
    r2.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));

    r1.getGreAgent().addTunnel('Tunnel0', '10.0.0.1', '10.0.0.2', { key: 100 });
    r2.getGreAgent().addTunnel('Tunnel0', '10.0.0.2', '10.0.0.1', { key: 999 });

    const drops: Array<{ reason: string }> = [];
    bus.subscribe('gre.packet.dropped', (e) => drops.push(e.payload));

    r1.getGreAgent().encapsulateAndSend('Tunnel0', makeInner('192.168.99.1', '192.168.99.2'));
    expect(drops.some(d => d.reason === 'key-mismatch')).toBe(true);
  });
});

describe('GRE — Cisco↔Huawei interop', () => {
  it('a tunnel between a Cisco and a Huawei router carries traffic both ways', () => {
    const bus = new EventBus();
    const cisco = new CiscoRouter('CSCO');
    const huawei = new HuaweiRouter('HW');
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    cisco.setEventBus(bus); huawei.setEventBus(bus); sw.setEventBus(bus);
    new Cable('a').connect(cisco.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/1')!);
    new Cable('b').connect(huawei.getPort('GE0/0/0')!, sw.getPort('FastEthernet0/2')!);
    cisco.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
    huawei.getPort('GE0/0/0')!.configureIP(new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));

    cisco.getGreAgent().addTunnel('Tunnel0', '10.0.0.1', '10.0.0.2');
    huawei.getGreAgent().addTunnel('Tunnel0', '10.0.0.2', '10.0.0.1');

    cisco.getGreAgent().encapsulateAndSend('Tunnel0', makeInner('192.168.99.1', '192.168.99.2'));
    huawei.getGreAgent().encapsulateAndSend('Tunnel0', makeInner('192.168.99.2', '192.168.99.1'));

    expect(huawei.getGreAgent().getTunnel('Tunnel0')?.packetsIn).toBeGreaterThanOrEqual(1);
    expect(cisco.getGreAgent().getTunnel('Tunnel0')?.packetsIn).toBeGreaterThanOrEqual(1);
  });
});

describe('GRE — disabled tunnel', () => {
  it('setTunnelEnabled(false) drops the next encap with reason=tunnel-down', () => {
    const bus = new EventBus();
    const r = new CiscoRouter('R1');
    r.setEventBus(bus);
    r.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
    r.getGreAgent().addTunnel('Tunnel0', '10.0.0.1', '10.0.0.2');
    r.getGreAgent().setTunnelEnabled('Tunnel0', false);
    const drops: Array<{ reason: string }> = [];
    bus.subscribe('gre.packet.dropped', (e) => drops.push(e.payload));
    r.getGreAgent().encapsulateAndSend('Tunnel0', makeInner('1.1.1.1', '2.2.2.2'));
    expect(drops.some(d => d.reason === 'tunnel-down')).toBe(true);
  });

  it('encapsulateAndSend on an unknown tunnel reports no-tunnel', () => {
    const bus = new EventBus();
    const r = new CiscoRouter('R1');
    r.setEventBus(bus);
    const drops: Array<{ reason: string }> = [];
    bus.subscribe('gre.packet.dropped', (e) => drops.push(e.payload));
    r.getGreAgent().encapsulateAndSend('TunnelMissing', makeInner('1.1.1.1', '2.2.2.2'));
    expect(drops.some(d => d.reason === 'no-tunnel')).toBe(true);
  });
});
