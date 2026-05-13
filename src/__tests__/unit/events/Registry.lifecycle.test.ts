import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { EventBus } from '@/events/EventBus';
import type { DomainEvent } from '@/events/types';

/**
 * Phase 2: EquipmentRegistry emits lifecycle events on register / deregister
 * / clear. These events are the foundation of the future DevicesProjection
 * (Phase 6) and the BusTracer adapter.
 */
describe('EquipmentRegistry lifecycle events (Phase 2)', () => {
  let registry: EquipmentRegistry;
  let bus: EventBus;
  let trace: DomainEvent[];

  beforeEach(() => {
    EquipmentRegistry.resetInstance();
    registry = EquipmentRegistry.getInstance();
    bus = new EventBus();
    registry.setEventBus(bus);
    trace = [];
    bus.subscribeAll((e) => trace.push(e));
  });

  afterEach(() => {
    registry.setEventBus(null);
    EquipmentRegistry.resetInstance();
  });

  it('emits device.registered when a new device is constructed', () => {
    const pc = new LinuxPC('linux-pc', 'PC-A');
    const event = trace.find((e) => e.topic === 'device.registered');
    expect(event).toBeDefined();
    expect((event as DomainEvent & { topic: 'device.registered' }).payload).toMatchObject({
      id: pc.getId(),
      name: 'PC-A',
    });
  });

  it('does not re-emit device.registered for an already-registered device', () => {
    const pc = new LinuxPC('linux-pc', 'PC-B');
    trace.length = 0;
    registry.register(pc);
    expect(trace.filter((e) => e.topic === 'device.registered')).toHaveLength(0);
  });

  it('emits device.deregistered on deregister()', () => {
    const pc = new LinuxPC('linux-pc', 'PC-C');
    trace.length = 0;
    registry.deregister(pc.getId());
    const event = trace.find((e) => e.topic === 'device.deregistered');
    expect(event).toBeDefined();
    expect((event as DomainEvent & { topic: 'device.deregistered' }).payload).toEqual({
      id: pc.getId(),
    });
  });

  it('does not emit device.deregistered for an unknown id', () => {
    registry.deregister('does-not-exist');
    expect(trace.filter((e) => e.topic === 'device.deregistered')).toHaveLength(0);
  });

  it('emits registry.cleared on clear() when there were devices', () => {
    new LinuxPC('linux-pc', 'PC-D');
    trace.length = 0;
    registry.clear();
    expect(trace.find((e) => e.topic === 'registry.cleared')).toBeDefined();
  });

  it('does not emit registry.cleared on empty clear()', () => {
    registry.clear();
    expect(trace.filter((e) => e.topic === 'registry.cleared')).toHaveLength(0);
  });
});
