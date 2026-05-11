import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { EventBus } from '@/events/EventBus';
import { __setDefaultEventBus } from '@/events/EventBus';
import type { DomainEvent } from '@/events/types';

/**
 * Phase 2: Equipment emits power/position/rename lifecycle events through
 * the default bus. These events feed the future DevicesProjection (Phase 6).
 */
describe('Equipment lifecycle events (Phase 2)', () => {
  let bus: EventBus;
  let trace: DomainEvent[];

  beforeEach(() => {
    EquipmentRegistry.resetInstance();
    bus = new EventBus();
    __setDefaultEventBus(bus);
    EquipmentRegistry.getInstance().setEventBus(bus);
    trace = [];
    bus.subscribeAll((e) => trace.push(e));
  });

  afterEach(() => {
    EquipmentRegistry.getInstance().setEventBus(null);
    EquipmentRegistry.resetInstance();
    __setDefaultEventBus(null);
  });

  it('emits device.power-off then device.power-on on transitions', () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    trace.length = 0;

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
    trace.length = 0;

    // already powered on; powerOn should be a no-op event-wise
    pc.powerOn();
    expect(trace.filter((e) => e.topic === 'device.power-on')).toHaveLength(0);

    pc.powerOff();
    pc.powerOff();
    expect(trace.filter((e) => e.topic === 'device.power-off')).toHaveLength(1);
  });

  it('emits device.position-changed only when coordinates change', () => {
    const pc = new LinuxPC('linux-pc', 'PC3');
    trace.length = 0;

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
    trace.length = 0;

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
});
