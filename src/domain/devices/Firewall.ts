/**
 * Firewall - Generic Network Firewall
 *
 * Layer 3 security device with multiple zones (inside, outside, dmz).
 * Base class for specific firewall implementations.
 */

import { Router } from './Router';
import { DeviceConfig, OSType } from './types';

export class Firewall extends Router {
  protected zones: Map<string, string[]>;

  constructor(config: DeviceConfig) {
    const id = config.id || `firewall-${Date.now()}`;
    const name = config.name || id;

    // Firewalls have at least 3 interfaces (inside, outside, dmz)
    super(id, name, 4);

    // Override type
    (this as any).type = 'firewall';

    // Set default hostname
    this.setHostname(config.hostname || 'firewall');

    // Set position if provided
    if (config.x !== undefined && config.y !== undefined) {
      this.setPosition(config.x, config.y);
    }

    // Initialize zones
    this.zones = new Map([
      ['inside', ['eth0']],
      ['outside', ['eth1']],
      ['dmz', ['eth2']]
    ]);

    // Power on if requested
    if (config.isPoweredOn !== false) {
      this.powerOn();
    }
  }

  /**
   * Get device type
   */
  public getType(): string {
    return 'firewall';
  }

  /**
   * Get OS type
   */
  public getOSType(): OSType {
    return 'linux'; // Generic firewalls use Linux-like CLI
  }

  /**
   * Check if this is a Layer 3 device
   */
  public isLayer3Device(): boolean {
    return true;
  }

  /**
   * Get zone for an interface
   */
  public getZone(interfaceName: string): string | undefined {
    for (const [zone, interfaces] of this.zones) {
      if (interfaces.includes(interfaceName)) {
        return zone;
      }
    }
    return undefined;
  }

  /**
   * Set zone for an interface
   */
  public setZone(interfaceName: string, zone: string): void {
    // Remove from current zone
    for (const [_, interfaces] of this.zones) {
      const idx = interfaces.indexOf(interfaceName);
      if (idx !== -1) {
        interfaces.splice(idx, 1);
      }
    }

    // Add to new zone
    if (!this.zones.has(zone)) {
      this.zones.set(zone, []);
    }
    this.zones.get(zone)!.push(interfaceName);
  }
}
