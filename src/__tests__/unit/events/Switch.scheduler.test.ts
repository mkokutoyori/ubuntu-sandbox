import { describe, it, expect } from 'vitest';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { VirtualTimeScheduler } from '@/events/Scheduler';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

/**
 * Phase 4b1: Switch.macAgingTimer is now driven by an injectable
 * IScheduler. Existing call sites (the production singleton fallback)
 * continue to work; tests can pass a VirtualTimeScheduler to deterministically
 * advance MAC aging without relying on real wall-clock time.
 */
describe('Switch MAC aging via VirtualTimeScheduler (Phase 4b1)', () => {
  it('aging-process startup uses the injected scheduler', () => {
    EquipmentRegistry.resetInstance();
    const scheduler = new VirtualTimeScheduler();
    const sw = new CiscoSwitch('SW1');
    sw.setScheduler(scheduler);

    // Powering on the switch starts the aging interval.
    sw.powerOn();
    sw.powerOn(); // no-op
    expect(scheduler.pendingCount()).toBeGreaterThanOrEqual(1);

    sw.powerOff();
    // After power-off, the aging interval must be cancelled — there
    // should be no leaked timer left for the switch.
    expect(scheduler.pendingCount()).toBe(0);
  });
});
