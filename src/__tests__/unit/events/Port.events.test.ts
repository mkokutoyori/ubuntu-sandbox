import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Port } from '@/network/hardware/Port';
import { Cable } from '@/network/hardware/Cable';
import { MACAddress, IPAddress, SubnetMask } from '@/network/core/types';
import type { EthernetFrame } from '@/network/core/types';
import { EventBus } from '@/events/EventBus';
import type { DomainEvent } from '@/events/types';

/**
 * Phase 3: Port emits port.* events in parallel to legacy onFrame /
 * onLinkChange callbacks. Cable emits cable.* events. Existing callbacks
 * stay live so the rest of the codebase keeps working until Phase 8.
 */
describe('Port events (Phase 3)', () => {
  let bus: EventBus;
  let trace: DomainEvent[];

  beforeEach(() => {
    bus = new EventBus();
    trace = [];
    bus.subscribeAll((e) => trace.push(e));
  });

  afterEach(() => {
    trace = [];
  });

  const buildFrame = (): EthernetFrame => ({
    srcMAC: MACAddress.parse('00:11:22:33:44:55'),
    dstMAC: MACAddress.parse('66:77:88:99:aa:bb'),
    etherType: 0x0800,
    payload: null,
  });

  it('publishes port.frame.tx-blocked when no cable is connected', () => {
    const port = new Port('eth0');
    port.setEventBus(bus);
    port.setEquipmentId('dev1');

    expect(port.sendFrame(buildFrame())).toBe(false);

    const blocked = trace.find((e) => e.topic === 'port.frame.tx-blocked');
    expect(blocked).toBeDefined();
    expect((blocked as DomainEvent & { topic: 'port.frame.tx-blocked' }).payload).toMatchObject({
      deviceId: 'dev1',
      portName: 'eth0',
      reason: 'no-cable',
    });
  });

  it('publishes port.frame.tx-blocked when the link is down', () => {
    const port = new Port('eth0');
    port.setEventBus(bus);
    port.setEquipmentId('dev1');
    port.setUp(false);

    expect(port.sendFrame(buildFrame())).toBe(false);

    const blocked = trace.find(
      (e) => e.topic === 'port.frame.tx-blocked' && e.payload.reason === 'link-down',
    );
    expect(blocked).toBeDefined();
  });

  it('publishes port.link.up / port.link.down on setUp transitions', () => {
    const port = new Port('eth1');
    port.setEventBus(bus);
    port.setEquipmentId('dev1');

    port.setUp(false); // up→down
    port.setUp(true);  // down→up
    port.setUp(true);  // no-op

    const linkEvents = trace.filter(
      (e) => e.topic === 'port.link.up' || e.topic === 'port.link.down',
    );
    expect(linkEvents.map((e) => e.topic)).toEqual([
      'port.link.down',
      'port.link.up',
    ]);
  });

  it('publishes port.config.ip-changed on configureIP and clearIP', () => {
    const port = new Port('eth0');
    port.setEventBus(bus);
    port.setEquipmentId('dev1');

    port.configureIP(IPAddress.parse('10.0.0.1'), new SubnetMask('255.255.255.0'));
    port.clearIP();
    port.clearIP(); // no-op

    const events = trace.filter((e) => e.topic === 'port.config.ip-changed');
    expect(events).toHaveLength(2);
    const first = (events[0] as DomainEvent & { topic: 'port.config.ip-changed' }).payload;
    expect(first.ip).not.toBeNull();
    expect(first.mask).not.toBeNull();
    expect(
      (events[1] as DomainEvent & { topic: 'port.config.ip-changed' }).payload.ip,
    ).toBeNull();
  });

  it('publishes port.config.mtu-changed only when value changes', () => {
    const port = new Port('eth0');
    port.setEventBus(bus);
    port.setEquipmentId('dev1');

    port.setMTU(1500); // initial value already 1500 — no event
    port.setMTU(9000);
    port.setMTU(9000); // no-op

    const events = trace.filter((e) => e.topic === 'port.config.mtu-changed');
    expect(events).toHaveLength(1);
    expect((events[0] as DomainEvent & { topic: 'port.config.mtu-changed' }).payload.mtu).toBe(9000);
  });
});

describe('Cable + Port frame events (Phase 3)', () => {
  let bus: EventBus;
  let trace: DomainEvent[];

  const buildFrame = (): EthernetFrame => ({
    srcMAC: MACAddress.parse('00:11:22:33:44:55'),
    dstMAC: MACAddress.parse('66:77:88:99:aa:bb'),
    etherType: 0x0800,
    payload: null,
  });

  beforeEach(() => {
    bus = new EventBus();
    trace = [];
    bus.subscribeAll((e) => trace.push(e));
  });

  it('publishes a full tx-requested → dispatched → delivered → received chain', () => {
    const portA = new Port('eth0');
    const portB = new Port('eth0');
    portA.setEquipmentId('A');
    portB.setEquipmentId('B');
    portA.setEventBus(bus);
    portB.setEventBus(bus);

    const cable = new Cable('cab1');
    cable.setEventBus(bus);
    cable.connect(portA, portB);

    trace.length = 0;
    expect(portA.sendFrame(buildFrame())).toBe(true);

    const topics = trace.map((e) => e.topic);
    expect(topics).toContain('port.frame.tx-requested');
    expect(topics).toContain('cable.frame.dispatched');
    expect(topics).toContain('port.frame.received');
    expect(topics).toContain('cable.frame.delivered');

    // Order: tx-requested → dispatched → received → delivered
    const idxTx = topics.indexOf('port.frame.tx-requested');
    const idxDispatch = topics.indexOf('cable.frame.dispatched');
    const idxReceived = topics.indexOf('port.frame.received');
    const idxDelivered = topics.indexOf('cable.frame.delivered');

    expect(idxTx).toBeLessThan(idxDispatch);
    expect(idxDispatch).toBeLessThan(idxReceived);
    expect(idxReceived).toBeLessThan(idxDelivered);

    const recv = trace.find((e) => e.topic === 'port.frame.received');
    expect((recv as DomainEvent & { topic: 'port.frame.received' }).payload).toMatchObject({
      deviceId: 'B',
      portName: 'eth0',
    });
  });

  it('publishes cable.connected and cable.negotiated on connect()', () => {
    const portA = new Port('eth0');
    const portB = new Port('eth0');
    portA.setEquipmentId('A');
    portB.setEquipmentId('B');
    portA.setEventBus(bus);
    portB.setEventBus(bus);

    const cable = new Cable('cab1');
    cable.setEventBus(bus);
    cable.connect(portA, portB);

    expect(trace.find((e) => e.topic === 'cable.connected')).toBeDefined();
    expect(trace.find((e) => e.topic === 'cable.negotiated')).toBeDefined();
  });

  it('publishes cable.frame.lost with simulated-loss when rng triggers loss', () => {
    const portA = new Port('eth0');
    const portB = new Port('eth0');
    portA.setEquipmentId('A');
    portB.setEquipmentId('B');
    portA.setEventBus(bus);
    portB.setEventBus(bus);

    const cable = new Cable('cab1');
    cable.setEventBus(bus);
    cable.setRng(() => 0.0); // always below the loss threshold
    cable.setPacketLossRate(0.5);
    cable.connect(portA, portB);

    trace.length = 0;
    expect(portA.sendFrame(buildFrame())).toBe(false);

    const lost = trace.find((e) => e.topic === 'cable.frame.lost');
    expect(lost).toBeDefined();
    expect((lost as DomainEvent & { topic: 'cable.frame.lost' }).payload.reason).toBe('simulated-loss');
  });

  it('publishes cable.disconnected on disconnect()', () => {
    const portA = new Port('eth0');
    const portB = new Port('eth0');
    portA.setEquipmentId('A');
    portB.setEquipmentId('B');
    portA.setEventBus(bus);
    portB.setEventBus(bus);

    const cable = new Cable('cab1');
    cable.setEventBus(bus);
    cable.connect(portA, portB);

    trace.length = 0;
    cable.disconnect();
    expect(trace.find((e) => e.topic === 'cable.disconnected')).toBeDefined();
  });
});
