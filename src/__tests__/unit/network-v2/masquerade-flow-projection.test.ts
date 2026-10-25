/**
 * La projection qui vide les flux MASQUERADE d'une machine (masq_device_event et masq_inet_event, net/netfilter/nf_nat_masquerade.c) ne lit
 * que deux sujets du bus de la machine : l'interface qui se ferme et l'adresse qui se retire. Ce fichier tient ses conditions une a une,
 * sans laboratoire : la table des flux est factice, le bus est un vrai, et chaque cas dit quel flux part et lequel reste.
 */
import { describe, it, expect } from 'vitest';
import { EventBus } from '@/events/EventBus';
import type { FlowView } from '@/network/devices/linux/ConnectionTracker';
import { MasqueradeFlowProjection, type FlowTable } from '@/network/devices/linux/MasqueradeFlowProjection';

const THIS_MACHINE = 'gw';
const FIRST = '203.0.113.1';
const SECOND = '198.51.100.1';

const flow = (masqueradeInterface: string | null, translated: string): FlowView => ({
  original: { protocol: 1, srcIP: '10.0.0.2', srcPort: 0, dstIP: '203.0.113.2', dstPort: 0, icmpType: 8, icmpId: 7 },
  reply: { protocol: 1, srcIP: '203.0.113.2', srcPort: 0, dstIP: translated, dstPort: 0, icmpType: 0, icmpId: 7 },
  remainingMs: 30_000, replied: true, assured: false, tcpState: null, mark: 0, natSource: true, natDestination: false,
  masqueradeInterface,
});

class Table implements FlowTable {
  constructor(private flows: FlowView[]) {}

  delete(matches: (view: FlowView) => boolean): readonly FlowView[] {
    const doomed = this.flows.filter(matches);
    this.flows = this.flows.filter((view) => !matches(view));
    return doomed;
  }

  left(): string[] {
    return this.flows.map((view) => `${view.masqueradeInterface}:${view.reply.dstIP}`);
  }
}

function lab(): { bus: EventBus; table: Table; projection: MasqueradeFlowProjection } {
  const bus = new EventBus();
  const table = new Table([flow('eth1', FIRST), flow('eth2', SECOND), flow(null, FIRST)]);
  return { bus, table, projection: new MasqueradeFlowProjection(bus, table, THIS_MACHINE) };
}

const linkChanged = (bus: EventBus, iface: string, up: boolean, deviceId = THIS_MACHINE): void =>
  bus.publish({ topic: 'host.link.state-changed', payload: { deviceId, iface, up } });

const addressChanged = (bus: EventBus, iface: string, ip: string, added: boolean, deviceId = THIS_MACHINE): void =>
  bus.publish({ topic: 'host.address.changed', payload: { deviceId, iface, ip, cidr: 24, added } });

describe('an interface that is closed takes the flows masqueraded onto it', () => {
  it('removes the flows of that interface, and keeps the others and the flows nothing masqueraded', () => {
    const { bus, table } = lab();
    linkChanged(bus, 'eth1', false);
    expect(table.left()).toEqual([`eth2:${SECOND}`, `null:${FIRST}`]);
  });

  it('removes nothing when the interface comes up', () => {
    const { bus, table } = lab();
    linkChanged(bus, 'eth1', true);
    expect(table.left()).toHaveLength(3);
  });

  it('removes nothing when another machine closes an interface of the same name', () => {
    const { bus, table } = lab();
    linkChanged(bus, 'eth1', false, 'other');
    expect(table.left()).toHaveLength(3);
  });

  it('removes nothing for an interface no flow was masqueraded onto', () => {
    const { bus, table } = lab();
    linkChanged(bus, 'eth3', false);
    expect(table.left()).toHaveLength(3);
  });
});

describe('an address that is removed takes the flows masqueraded with it', () => {
  it('removes the flows of that interface translated by that address, and only those', () => {
    const { bus, table } = lab();
    addressChanged(bus, 'eth1', FIRST, false);
    expect(table.left()).toEqual([`eth2:${SECOND}`, `null:${FIRST}`]);
  });

  it('keeps the flows of the interface when the address removed is another one', () => {
    const { bus, table } = lab();
    addressChanged(bus, 'eth1', '192.0.2.9', false);
    expect(table.left()).toHaveLength(3);
  });

  it('keeps the flows of another interface that carry the same address', () => {
    const { bus, table } = lab();
    addressChanged(bus, 'eth2', FIRST, false);
    expect(table.left()).toHaveLength(3);
  });

  it('removes nothing when the address is added', () => {
    const { bus, table } = lab();
    addressChanged(bus, 'eth1', FIRST, true);
    expect(table.left()).toHaveLength(3);
  });

  it('removes nothing when another machine removes the address', () => {
    const { bus, table } = lab();
    addressChanged(bus, 'eth1', FIRST, false, 'other');
    expect(table.left()).toHaveLength(3);
  });
});

describe('a disposed projection stops reading the bus', () => {
  it('ignores both subjects', () => {
    const { bus, table, projection } = lab();
    projection.dispose();
    linkChanged(bus, 'eth1', false);
    addressChanged(bus, 'eth2', SECOND, false);
    expect(table.left()).toHaveLength(3);
  });
});
