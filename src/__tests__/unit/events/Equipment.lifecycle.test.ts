import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { EventBus } from '@/events/EventBus';
import { __setDefaultEventBus } from '@/events/EventBus';
import type { DomainEvent } from '@/events/types';

/**
 * Phase 2: Equipment emits power/position/rename lifecycle events.
 *
 * These cases used to subscribe to the DEFAULT bus and observe nothing,
 * because `Equipment.getBus()` returns a bus of its own — deliberately,
 * so an event of A is never delivered on the bus of B. The convention
 * `kerberos-replication-observability` already followed is to subscribe
 * to the bus of the device that PUBLISHES; three other files were moved
 * onto it earlier and this one was missed.
 *
 * `traceOf` therefore takes the device, and every case names the
 * publisher rather than assuming a global. Note what makes the old
 * shape dangerous rather than merely wrong: an `expect(...).toHaveLength(0)`
 * on a bus nobody publishes to passes for the wrong reason, so each case
 * here also asserts a NON-empty outcome — the witness that something was
 * emitted at all.
 */
describe('Equipment lifecycle events (Phase 2)', () => {
  beforeEach(() => {
    EquipmentRegistry.resetInstance();
    __setDefaultEventBus(new EventBus());
  });

  afterEach(() => {
    EquipmentRegistry.resetInstance();
    __setDefaultEventBus(null);
  });

  function traceOf(device: LinuxPC): DomainEvent[] {
    const trace: DomainEvent[] = [];
    device.getBus().subscribeAll((e) => trace.push(e));
    return trace;
  }

  it('emits device.power-off then device.power-on on transitions', () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    const trace = traceOf(pc);

    pc.powerOff();
    pc.powerOn();

    const topics = trace.map((e) => e.topic);
    expect(topics).toContain('device.power-off');
    expect(topics).toContain('device.power-on');

    const off = trace.find((e) => e.topic === 'device.power-off');
    expect((off as DomainEvent & { topic: 'device.power-off' }).payload.id).toBe(pc.getId());
  });

  it('does not emit power events for no-op toggles', () => {
    const pc = new LinuxPC('linux-pc', 'PC2');
    const trace = traceOf(pc);

    // already powered on; powerOn should be a no-op event-wise
    pc.powerOn();
    expect(trace.filter((e) => e.topic === 'device.power-on')).toHaveLength(0);

    pc.powerOff();
    pc.powerOff();
    expect(trace.filter((e) => e.topic === 'device.power-off')).toHaveLength(1);
  });

  it('emits device.position-changed only when coordinates change', () => {
    const pc = new LinuxPC('linux-pc', 'PC3');
    const trace = traceOf(pc);

    pc.setPosition(10, 20);
    pc.setPosition(10, 20); // no-op
    pc.setPosition(15, 20);

    const evts = trace.filter((e) => e.topic === 'device.position-changed');
    expect(evts).toHaveLength(2);
    expect((evts[1] as DomainEvent & { topic: 'device.position-changed' }).payload).toEqual({
      id: pc.getId(),
      x: 15,
      y: 20,
    });
  });

  it('emits device.renamed on setName when the name actually changes', () => {
    const pc = new LinuxPC('linux-pc', 'PC4');
    const trace = traceOf(pc);

    pc.setName('PC4');   // no-op
    pc.setName('PC4-bis');

    const evts = trace.filter((e) => e.topic === 'device.renamed');
    expect(evts).toHaveLength(1);
    expect((evts[0] as DomainEvent & { topic: 'device.renamed' }).payload).toEqual({
      id: pc.getId(),
      oldName: 'PC4',
      newName: 'PC4-bis',
    });
  });

  it('TEMOIN : le bus d\'une machine ne recoit pas les evenements d\'une AUTRE', () => {
    const a = new LinuxPC('linux-pc', 'PCA');
    const b = new LinuxPC('linux-pc', 'PCB');
    const traceA = traceOf(a);
    const traceB = traceOf(b);

    a.setName('PCA-bis');

    expect(traceA.filter((e) => e.topic === 'device.renamed')).toHaveLength(1);
    expect(traceB.filter((e) => e.topic === 'device.renamed')).toHaveLength(0);
  });
});
