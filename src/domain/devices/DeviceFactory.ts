/**
 * DeviceFactory - Factory for creating network devices
 *
 * Creates devices based on configuration:
 * - Computers: LinuxPC, WindowsPC
 * - Servers: LinuxServer, WindowsServer
 * - Network: Switch, Router, Hub, CiscoRouter, CiscoSwitch, CiscoL3Switch
 * - Security: Firewall, CiscoASA
 * - Wireless: AccessPoint, WirelessController
 * - Infrastructure: Cloud, MultilayerSwitch
 * - End Devices: IPPhone, Printer
 *
 * @example
 * ```typescript
 * const server = DeviceFactory.createDevice({
 *   type: 'linux-server',
 *   name: 'Web Server',
 *   hostname: 'web01'
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
import { LinuxServer } from './LinuxServer';
import { WindowsServer } from './WindowsServer';
import { CiscoRouter } from './CiscoRouter';
import { CiscoSwitch } from './CiscoSwitch';
import { CiscoL3Switch } from './CiscoL3Switch';
import { Firewall } from './Firewall';
import { CiscoASA } from './CiscoASA';
import { AccessPoint } from './AccessPoint';
import { WirelessController } from './WirelessController';
import { Cloud } from './Cloud';
import { MultilayerSwitch } from './MultilayerSwitch';
import { IPPhone } from './IPPhone';
import { Printer } from './Printer';
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
      // === COMPUTERS ===
      case 'linux-pc':
        return new LinuxPC(config);

      case 'windows-pc':
        return new WindowsPC(config);

      case 'pc': {
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

      // === SERVERS ===
      case 'linux-server':
        return new LinuxServer(config);

      case 'windows-server':
        return new WindowsServer(config);

      // === NETWORK DEVICES - LAYER 2 ===
      case 'switch': {
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

      case 'cisco-switch':
        return new CiscoSwitch(config);

      case 'hub': {
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

      // === NETWORK DEVICES - LAYER 3 ===
      case 'router': {
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

      case 'cisco-router':
        return new CiscoRouter(config);

      case 'cisco-l3-switch':
        return new CiscoL3Switch(config);

      case 'multilayer-switch':
        return new MultilayerSwitch(config);

      // === SECURITY DEVICES ===
      case 'firewall':
        return new Firewall(config);

      case 'cisco-asa':
        return new CiscoASA(config);

      // === WIRELESS DEVICES ===
      case 'access-point':
        return new AccessPoint(config);

      case 'wireless-controller':
        return new WirelessController(config);

      // === INFRASTRUCTURE ===
      case 'cloud':
        return new Cloud(config);

      // === END DEVICES ===
      case 'ip-phone':
        return new IPPhone(config);

      case 'printer':
        return new Printer(config);

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
      // Full terminal support
      case 'linux-pc':
      case 'linux-server':
      case 'windows-pc':
      case 'windows-server':
      case 'cisco-router':
      case 'cisco-switch':
      case 'cisco-l3-switch':
      case 'cisco-asa':
        return true;

      // No terminal support
      case 'pc':
      case 'switch':
      case 'router':
      case 'hub':
      case 'firewall':
      case 'access-point':
      case 'wireless-controller':
      case 'cloud':
      case 'multilayer-switch':
      case 'ip-phone':
      case 'printer':
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
      case 'linux-server':
      case 'windows-pc':
      case 'windows-server':
      case 'cisco-router':
      case 'cisco-switch':
      case 'cisco-l3-switch':
      case 'cisco-asa':
        return true;
      default:
        return false;
    }
  }

  /**
   * Get all supported device types
   */
  public static getSupportedTypes(): string[] {
    return [
      // Computers
      'pc', 'linux-pc', 'windows-pc',
      // Servers
      'linux-server', 'windows-server',
      // Network - Layer 2
      'switch', 'cisco-switch', 'hub',
      // Network - Layer 3
      'router', 'cisco-router', 'cisco-l3-switch', 'multilayer-switch',
      // Security
      'firewall', 'cisco-asa',
      // Wireless
      'access-point', 'wireless-controller',
      // Infrastructure
      'cloud',
      // End Devices
      'ip-phone', 'printer'
    ];
  }
}
