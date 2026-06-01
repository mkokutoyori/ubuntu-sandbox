import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { EventBus } from '@/events/EventBus';
import {
  MACAddress, IPAddress, SubnetMask, resetCounters,
  IP_PROTO_TCP, IP_PROTO_UDP, IP_PROTO_ICMP,
} from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import {
  UDP_PORT_NETFLOW, NETFLOW_V5_VERSION, NETFLOW_V5_MAX_RECORDS,
  flowKey, newRecord,
} from '@/network/netflow/types';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

describe('NetFlow — pure helpers', () => {
  it('UDP_PORT_NETFLOW matches the Cisco default', () => {
    expect(UDP_PORT_NETFLOW).toBe(2055);
  });

  it('NETFLOW_V5_MAX_RECORDS caps a single PDU at 30 records', () => {
    expect(NETFLOW_V5_MAX_RECORDS).toBe(30);
  });

  it('flowKey identifies the 7-tuple uniquely', () => {
    const a = flowKey({ sourceIp: '10.0.0.1', destinationIp: '10.0.0.2', sourcePort: 1024, destinationPort: 80, protocol: 6, inputIfIndex: 1, tos: 0 });
    const b = flowKey({ sourceIp: '10.0.0.1', destinationIp: '10.0.0.2', sourcePort: 1024, destinationPort: 80, protocol: 6, inputIfIndex: 1, tos: 0 });
    const c = flowKey({ sourceIp: '10.0.0.1', destinationIp: '10.0.0.2', sourcePort: 1024, destinationPort: 443, protocol: 6, inputIfIndex: 1, tos: 0 });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it('newRecord fills sensible defaults for unset fields', () => {
    const r = newRecord({ sourceIp: '1.1.1.1', destinationIp: '2.2.2.2', protocol: 6, bytes: 1000, packets: 10 });
    expect(r.nextHopIp).toBe('0.0.0.0');
    expect(r.octets).toBe(1000);
    expect(r.packets).toBe(10);
    expect(r.firstSwitchedMs).toBe(r.lastSwitchedMs);
  });
});

describe('NetFlow — recordFlow aggregates by 7-tuple', () => {
  it('two recordFlow calls with the same key merge into one ActiveFlow', () => {
    const r = new CiscoRouter('R1');
    r.getNetFlowAgent().setEnabled(true);
    r.getNetFlowAgent().recordFlow({ sourceIp: '10.0.0.1', destinationIp: '10.0.0.99', sourcePort: 1024, destinationPort: 80, protocol: 6, bytes: 1000, packets: 5 });
    r.getNetFlowAgent().recordFlow({ sourceIp: '10.0.0.1', destinationIp: '10.0.0.99', sourcePort: 1024, destinationPort: 80, protocol: 6, bytes: 500, packets: 3 });
    const flows = r.getNetFlowAgent().listActiveFlows();
    expect(flows.length).toBe(1);
    expect(flows[0].octets).toBe(1500);
    expect(flows[0].packets).toBe(8);
  });

  it('different 7-tuples create separate ActiveFlows', () => {
    const r = new CiscoRouter('R1');
    r.getNetFlowAgent().setEnabled(true);
    r.getNetFlowAgent().recordFlow({ sourceIp: '10.0.0.1', destinationIp: '10.0.0.99', sourcePort: 1024, destinationPort: 80, protocol: 6, bytes: 100 });
    r.getNetFlowAgent().recordFlow({ sourceIp: '10.0.0.1', destinationIp: '10.0.0.99', sourcePort: 1024, destinationPort: 443, protocol: 6, bytes: 200 });
    r.getNetFlowAgent().recordFlow({ sourceIp: '10.0.0.2', destinationIp: '10.0.0.99', sourcePort: 1024, destinationPort: 80, protocol: 6, bytes: 300 });
    expect(r.getNetFlowAgent().listActiveFlows().length).toBe(3);
  });

  it('disabled agent silently drops recordFlow', () => {
    const r = new CiscoRouter('R1');
    r.getNetFlowAgent().setEnabled(false);
    r.getNetFlowAgent().recordFlow({ sourceIp: '10.0.0.1', destinationIp: '10.0.0.99', protocol: 6 });
    expect(r.getNetFlowAgent().listActiveFlows().length).toBe(0);
  });
});

describe('NetFlow — collector registry', () => {
  it('addCollector emits netflow.collector.changed with added=true', () => {
    const bus = new EventBus();
    const r = new CiscoRouter('R1');
    r.setEventBus(bus);
    const events: Array<{ collectorIp: string; added: boolean }> = [];
    bus.subscribe('netflow.collector.changed', (e) => events.push(e.payload));
    r.getNetFlowAgent().addCollector('10.0.0.50');
    expect(events.length).toBe(1);
    expect(events[0]).toMatchObject({ collectorIp: '10.0.0.50', added: true });
  });

  it('removeCollector emits added=false and clears it from listCollectors', () => {
    const r = new CiscoRouter('R1');
    r.getNetFlowAgent().addCollector('10.0.0.50');
    r.getNetFlowAgent().removeCollector('10.0.0.50');
    expect(r.getNetFlowAgent().listCollectors().length).toBe(0);
  });
});

describe('NetFlow — export end-to-end', () => {
  it('flushAllPending exports every active flow to every collector and clears the cache', () => {
    const bus = new EventBus();
    const r = new CiscoRouter('R1');
    const collector = new CiscoRouter('COL');
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    r.setEventBus(bus); collector.setEventBus(bus); sw.setEventBus(bus);
    new Cable('a').connect(r.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/0')!);
    new Cable('b').connect(collector.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/1')!);
    r.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
    collector.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.50'), new SubnetMask('255.255.255.0'));

    r.getNetFlowAgent().setEnabled(true);
    r.getNetFlowAgent().addCollector('10.0.0.50');
    r.getNetFlowAgent().recordFlow({ sourceIp: '192.168.1.10', destinationIp: '8.8.8.8', sourcePort: 5000, destinationPort: 53, protocol: IP_PROTO_UDP, bytes: 100 });
    r.getNetFlowAgent().recordFlow({ sourceIp: '192.168.1.11', destinationIp: '1.1.1.1', sourcePort: 5001, destinationPort: 443, protocol: IP_PROTO_TCP, bytes: 2000 });

    const exports: Array<{ collectorIp: string; flowCount: number }> = [];
    bus.subscribe('netflow.packet.exported', (e) => exports.push(e.payload));
    r.getNetFlowAgent().flushAllPending();
    expect(exports.length).toBe(1);
    expect(exports[0].collectorIp).toBe('10.0.0.50');
    expect(exports[0].flowCount).toBe(2);
    expect(r.getNetFlowAgent().listActiveFlows().length).toBe(0);
  });

  it('exported flows arrive on UDP/2055 as a netflow-v5 payload', () => {
    const bus = new EventBus();
    const r = new CiscoRouter('R1');
    const collector = new CiscoRouter('COL');
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    r.setEventBus(bus); collector.setEventBus(bus); sw.setEventBus(bus);
    const cable = new Cable('a');
    cable.setEventBus(bus);
    let seen: { dport: number; version: number; count: number } | null = null;
    bus.subscribe('cable.frame.delivered', (e) => {
      const ipPkt = (e.payload.frame.payload as unknown) as {
        protocol?: number;
        payload?: { type?: string; destinationPort?: number; payload?: { type?: string; header?: { version?: number; count?: number } } }
      } | undefined;
      const udp = ipPkt?.payload;
      if (udp?.type === 'udp' && udp.destinationPort === UDP_PORT_NETFLOW) {
        const nf = udp.payload;
        if (nf?.type === 'netflow-v5') {
          seen = { dport: udp.destinationPort, version: nf.header!.version!, count: nf.header!.count! };
        }
      }
    });
    cable.connect(r.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/0')!);
    new Cable('b').connect(collector.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/1')!);
    r.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
    collector.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.50'), new SubnetMask('255.255.255.0'));

    r.getNetFlowAgent().setEnabled(true);
    r.getNetFlowAgent().addCollector('10.0.0.50');
    r.getNetFlowAgent().recordFlow({ sourceIp: '192.168.1.10', destinationIp: '8.8.8.8', protocol: IP_PROTO_ICMP, bytes: 64 });
    r.getNetFlowAgent().flushAllPending();

    expect(seen).not.toBeNull();
    expect(seen!.dport).toBe(UDP_PORT_NETFLOW);
    expect(seen!.version).toBe(NETFLOW_V5_VERSION);
    expect(seen!.count).toBe(1);
  });

  it('large bursts are split into 30-record packets', () => {
    const bus = new EventBus();
    const r = new CiscoRouter('R1');
    const collector = new CiscoRouter('COL');
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    r.setEventBus(bus); collector.setEventBus(bus); sw.setEventBus(bus);
    new Cable('a').connect(r.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/0')!);
    new Cable('b').connect(collector.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/1')!);
    r.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
    collector.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.50'), new SubnetMask('255.255.255.0'));

    r.getNetFlowAgent().setEnabled(true);
    r.getNetFlowAgent().addCollector('10.0.0.50');
    for (let i = 0; i < 35; i++) {
      r.getNetFlowAgent().recordFlow({
        sourceIp: `192.168.1.${i}`, destinationIp: '8.8.8.8',
        sourcePort: 5000 + i, destinationPort: 80,
        protocol: IP_PROTO_TCP, bytes: 100,
      });
    }
    const exports: Array<{ flowCount: number }> = [];
    bus.subscribe('netflow.packet.exported', (e) => exports.push(e.payload));
    r.getNetFlowAgent().flushAllPending();
    expect(exports.length).toBe(2);
    expect(exports.reduce((s, e) => s + e.flowCount, 0)).toBe(35);
  });

  it('publishes netflow.flow.expired for every flushed flow', () => {
    const bus = new EventBus();
    const r = new CiscoRouter('R1');
    r.setEventBus(bus);
    r.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
    r.getNetFlowAgent().setEnabled(true);
    r.getNetFlowAgent().addCollector('10.0.0.50');
    r.getNetFlowAgent().recordFlow({ sourceIp: '1.1.1.1', destinationIp: '2.2.2.2', protocol: IP_PROTO_UDP, bytes: 100 });
    r.getNetFlowAgent().recordFlow({ sourceIp: '3.3.3.3', destinationIp: '4.4.4.4', protocol: IP_PROTO_TCP, bytes: 200 });
    const expired: Array<{ reason: string }> = [];
    bus.subscribe('netflow.flow.expired', (e) => expired.push(e.payload));
    r.getNetFlowAgent().flushAllPending();
    expect(expired.length).toBe(2);
    expect(expired.every(e => e.reason === 'manual')).toBe(true);
  });
});

describe('NetFlow — flowSequence increments monotonically', () => {
  it('successive exports carry strictly-increasing flowSequence numbers', () => {
    const bus = new EventBus();
    const r = new CiscoRouter('R1');
    const collector = new CiscoRouter('COL');
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    r.setEventBus(bus); collector.setEventBus(bus); sw.setEventBus(bus);
    new Cable('a').connect(r.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/0')!);
    new Cable('b').connect(collector.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/1')!);
    r.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
    collector.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.50'), new SubnetMask('255.255.255.0'));
    r.getNetFlowAgent().setEnabled(true);
    r.getNetFlowAgent().addCollector('10.0.0.50');

    const seqs: number[] = [];
    bus.subscribe('netflow.packet.exported', (e) => seqs.push(e.payload.flowSequence));
    r.getNetFlowAgent().recordFlow({ sourceIp: '1.1.1.1', destinationIp: '2.2.2.2', protocol: IP_PROTO_UDP });
    r.getNetFlowAgent().flushAllPending();
    r.getNetFlowAgent().recordFlow({ sourceIp: '3.3.3.3', destinationIp: '4.4.4.4', protocol: IP_PROTO_TCP });
    r.getNetFlowAgent().flushAllPending();
    expect(seqs.length).toBe(2);
    expect(seqs[1]).toBeGreaterThan(seqs[0]);
  });
});

describe('NetFlow — Cisco↔Huawei interop', () => {
  it('a Huawei router exports flows to a Cisco collector', () => {
    const bus = new EventBus();
    const r = new HuaweiRouter('HW');
    const collector = new CiscoRouter('COL');
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    r.setEventBus(bus); collector.setEventBus(bus); sw.setEventBus(bus);
    new Cable('a').connect(r.getPort('GE0/0/0')!, sw.getPort('FastEthernet0/0')!);
    new Cable('b').connect(collector.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/1')!);
    r.getPort('GE0/0/0')!.configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
    collector.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.50'), new SubnetMask('255.255.255.0'));

    r.getNetFlowAgent().setEnabled(true);
    r.getNetFlowAgent().addCollector('10.0.0.50');
    r.getNetFlowAgent().recordFlow({ sourceIp: '192.168.1.1', destinationIp: '8.8.4.4', protocol: IP_PROTO_UDP, bytes: 500 });
    const exports: Array<{ collectorIp: string }> = [];
    bus.subscribe('netflow.packet.exported', (e) => exports.push(e.payload));
    r.getNetFlowAgent().flushAllPending();
    expect(exports.some(e => e.collectorIp === '10.0.0.50')).toBe(true);
  });
});
