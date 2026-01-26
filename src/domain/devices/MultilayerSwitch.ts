/**
 * MultilayerSwitch - Generic Layer 3 Switch
 *
 * Switch with routing capabilities (similar to Cisco L3 Switch but generic).
 */

import { Switch } from './Switch';
import { DeviceConfig, OSType } from './types';
import { NetworkInterface } from './NetworkInterface';

export class MultilayerSwitch extends Switch {
  private routingEnabled: boolean;
  private interfaceMap: Map<string, NetworkInterface>;

  constructor(config: DeviceConfig) {
    const id = config.id || `mls-${Date.now()}`;
    const name = config.name || id;

    // Multilayer switches typically have 24-48 ports
    super(id, name, 24);

    // Override type
    (this as any).type = 'multilayer-switch';

    // Set hostname
    this.setHostname(config.hostname || 'MLS');

    // Set position if provided
    if (config.x !== undefined && config.y !== undefined) {
      this.setPosition(config.x, config.y);
    }

    // Create interfaces for all ports
    this.interfaceMap = new Map();
    for (let i = 0; i < 24; i++) {
      const portName = `eth${i}`;
      const iface = new NetworkInterface(portName, portName);
      this.interfaceMap.set(portName, iface);
    }

    // Enable routing
    this.routingEnabled = true;

    // Power on if requested
    if (config.isPoweredOn !== false) {
      this.powerOn();
    }
  }

  /**
   * Get device type
   */
  public getType(): string {
    return 'multilayer-switch';
  }

  /**
   * Get OS type
   */
  public getOSType(): OSType {
    return 'linux';
  }

  /**
   * Get all interfaces
   */
  public getInterfaces(): NetworkInterface[] {
    return Array.from(this.interfaceMap.values());
  }

  /**
   * Get interface by name
   */
  public getInterface(name: string): NetworkInterface | undefined {
    return this.interfaceMap.get(name);
  }

  /**
   * Check if routing is enabled
   */
  public isRoutingEnabled(): boolean {
    return this.routingEnabled;
  }

  /**
   * Enable/disable routing
   */
  public setRoutingEnabled(enabled: boolean): void {
    this.routingEnabled = enabled;
  }

  /**
   * Check if this is a Layer 3 device
   */
  public isLayer3Device(): boolean {
    return this.routingEnabled;
  }
}
