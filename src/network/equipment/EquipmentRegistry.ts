/**
 * EquipmentRegistry — Injectable registry for network equipment
 *
 * Fixes:
 * - 1.3: Static global registry replaced with injectable singleton
 * - Testable: Can be instantiated per-test without global state pollution
 * - Lifecycle: Supports device deregistration (power-off, removal)
 * - Filterable: Query by type, power state, or custom predicate
 */

import type { Equipment } from './Equipment';
import type { DeviceType } from '../core/types';
import { getDefaultEventBus, type IEventBus } from '@/events/EventBus';

/**
 * Injectable registry for Equipment instances.
 *
 * Replaces the static `Equipment.registry` Map with a proper
 * service that can be injected, mocked, and isolated per test.
 *
 * @example
 * ```ts
 * // Production: use default singleton
 * const registry = EquipmentRegistry.getInstance();
 *
 * // Tests: use isolated instance
 * const testRegistry = new EquipmentRegistry();
 * ```
 */
export class EquipmentRegistry {
  private static instance: EquipmentRegistry | null = null;

  private readonly devices: Map<string, Equipment> = new Map();

  /**
   * Optional bus injection. When unset, lifecycle events are published on
   * the default singleton bus (see `getDefaultEventBus()`).
   * Phase 2 of the reactive refactor — cf. §10.3.
   */
  private busOverride: IEventBus | null = null;

  /** Inject a custom bus for tests / multi-topology scenarios. */
  setEventBus(bus: IEventBus | null): void {
    this.busOverride = bus;
  }

  private getBus(): IEventBus {
    return this.busOverride ?? getDefaultEventBus();
  }

  /**
   * Get the singleton instance (for production use).
   * Use `new EquipmentRegistry()` for test isolation.
   */
  static getInstance(): EquipmentRegistry {
    if (!EquipmentRegistry.instance) {
      EquipmentRegistry.instance = new EquipmentRegistry();
    }
    return EquipmentRegistry.instance;
  }

  /** Reset the singleton (for test teardown) */
  static resetInstance(): void {
    EquipmentRegistry.instance?.clear();
    EquipmentRegistry.instance = null;
  }

  // ─── Core CRUD ────────────────────────────────────────────────────

  /** Register a device in the registry */
  register(device: Equipment): void {
    const id = device.getId();
    if (this.devices.has(id)) return;
    this.devices.set(id, device);
    this.getBus().publish({
      topic: 'device.registered',
      payload: {
        id,
        type: String(device.getDeviceType()),
        name: device.getName(),
      },
    });
  }

  /** Deregister a device (e.g., on removal from topology) */
  deregister(id: string): boolean {
    const removed = this.devices.delete(id);
    if (removed) {
      this.getBus().publish({
        topic: 'device.deregistered',
        payload: { id },
      });
    }
    return removed;
  }

  /** Look up a device by ID */
  getById(id: string): Equipment | undefined {
    return this.devices.get(id);
  }

  /** Check if a device exists in the registry */
  has(id: string): boolean {
    return this.devices.has(id);
  }

  // ─── Queries ──────────────────────────────────────────────────────

  /** Get all registered devices */
  getAll(): Equipment[] {
    return Array.from(this.devices.values());
  }

  /** Get all devices of a specific type */
  getByType(type: DeviceType): Equipment[] {
    return this.getAll().filter(d => d.getDeviceType() === type);
  }

  /** Get only powered-on devices */
  getPoweredOn(): Equipment[] {
    return this.getAll().filter(d => d.getIsPoweredOn());
  }

  /** Query with a custom predicate */
  query(predicate: (device: Equipment) => boolean): Equipment[] {
    return this.getAll().filter(predicate);
  }

  /** Get the count of registered devices */
  get size(): number {
    return this.devices.size;
  }

  // ─── Lifecycle ────────────────────────────────────────────────────

  /** Clear all registrations */
  clear(): void {
    if (this.devices.size === 0) return;
    this.devices.clear();
    this.getBus().publish({
      topic: 'registry.cleared',
      payload: {},
    });
  }
}
