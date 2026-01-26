/**
 * DeviceFactory - Factory for creating network devices
 *
 * Creates devices based on configuration:
 * - LinuxPC, WindowsPC for workstations
 * - CiscoRouter, CiscoSwitch, CiscoL3Switch for Cisco devices
 * - Generic PC, Switch, Router, Hub for simulation
 *
 * @example
 * ```typescript
 * const pc = DeviceFactory.createDevice({
 *   type: 'linux-pc',
 *   name: 'Ubuntu PC',
 *   x: 100,
 *   y: 200
 * });
 * ```
 */

import { BaseDevice } from './BaseDevice';
import { DeviceConfig } from './types';
import { PC } from './PC';
import { Switch } from './Switch';
import { Router } from './Router';
import { Hub } from './Hub';
import { LinuxPC } from './LinuxPC';
import { WindowsPC } from './WindowsPC';
import { CiscoRouter } from './CiscoRouter';
import { CiscoSwitch } from './CiscoSwitch';
import { CiscoL3Switch } from './CiscoL3Switch';
import { generateDeviceId } from './types';

/**
 * DeviceFactory - Creates network devices
 */
export class DeviceFactory {
  /**
   * Creates a device based on configuration
   *
   * @param config - Device configuration
   * @returns Created device
   */
  public static createDevice(config: DeviceConfig): BaseDevice {
    // Generate ID if not provided
    if (!config.id) {
      config.id = generateDeviceId(config.type);
    }

    // Generate name if not provided
    if (!config.name) {
      config.name = config.id;
    }

    // Create device based on type
    switch (config.type) {
      case 'linux-pc':
        return new LinuxPC(config);

      case 'windows-pc':
        return new WindowsPC(config);

      case 'cisco-router':
        return new CiscoRouter(config);

      case 'cisco-switch':
        return new CiscoSwitch(config);

      case 'cisco-l3-switch':
        return new CiscoL3Switch(config);

      case 'pc': {
        // Generic PC
        const pc = new PC(config.id, config.name);
        if (config.hostname) pc.setHostname(config.hostname);
        if (config.x !== undefined && config.y !== undefined) {
          pc.setPosition(config.x, config.y);
        }
        if (config.isPoweredOn !== false) {
          pc.powerOn();
        }
        return pc;
      }

      case 'switch': {
        // Generic switch (default 8 ports)
        const portCount = config.interfaces?.length || 8;
        const sw = new Switch(config.id, config.name, portCount);
        if (config.hostname) sw.setHostname(config.hostname);
        if (config.x !== undefined && config.y !== undefined) {
          sw.setPosition(config.x, config.y);
        }
        if (config.isPoweredOn !== false) {
          sw.powerOn();
        }
        return sw;
      }

      case 'router': {
        // Generic router (default 2 interfaces)
        const ifaceCount = config.interfaces?.length || 2;
        const router = new Router(config.id, config.name, ifaceCount);
        if (config.hostname) router.setHostname(config.hostname);
        if (config.x !== undefined && config.y !== undefined) {
          router.setPosition(config.x, config.y);
        }
        if (config.isPoweredOn !== false) {
          router.powerOn();
        }
        return router;
      }

      case 'hub': {
        // Hub (default 8 ports)
        const portCount = config.interfaces?.length || 8;
        const hub = new Hub(config.id, config.name, portCount);
        if (config.hostname) hub.setHostname(config.hostname);
        if (config.x !== undefined && config.y !== undefined) {
          hub.setPosition(config.x, config.y);
        }
        if (config.isPoweredOn !== false) {
          hub.powerOn();
        }
        return hub;
      }

      default:
        throw new Error(`Unknown device type: ${config.type}`);
    }
  }

  /**
   * Creates multiple devices from configurations
   *
   * @param configs - Array of device configurations
   * @returns Array of created devices
   */
  public static createDevices(configs: DeviceConfig[]): BaseDevice[] {
    return configs.map(config => this.createDevice(config));
  }

  /**
   * Checks if device type has terminal support
   *
   * @param type - Device type
   * @returns True if device has terminal support
   */
  public static hasTerminalSupport(type: string): boolean {
    switch (type) {
      case 'linux-pc':
      case 'windows-pc':
      case 'cisco-router':
      case 'cisco-switch':
      case 'cisco-l3-switch':
        return true;
      case 'pc':
      case 'switch':
      case 'router':
      case 'hub':
      case 'test':
      default:
        return false;
    }
  }

  /**
   * Checks if device type is fully implemented
   *
   * @param type - Device type
   * @returns True if device is fully implemented
   */
  public static isFullyImplemented(type?: string): boolean {
    if (!type) return false;

    switch (type) {
      case 'linux-pc':
      case 'windows-pc':
      case 'cisco-router':
      case 'cisco-switch':
      case 'cisco-l3-switch':
        return true;
      default:
        return false;
    }
  }
}
