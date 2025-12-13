/**
 * DeviceFactory - Factory for creating device instances
 * Creates the appropriate device class based on device type
 */

import { BaseDevice } from './common/BaseDevice';
import { createLinuxPC } from './linux/LinuxPC';
import { createWindowsPC } from './windows/WindowsPC';
import { createCiscoRouter, createCiscoSwitch } from './cisco/CiscoDevice';
import {
  DeviceType,
  DeviceConfig,
  DeviceOSType,
  NetworkInterfaceConfig,
  CommandResult,
  getDefaultInterfaces,
  getDefaultDeviceName,
  getDeviceOSType,
  generateId
} from './common/types';
import { NetworkStack } from './common/NetworkStack';
import { Packet } from '../core/network/packet';

/**
 * Generic device class for devices not yet fully implemented
 * Falls back to basic command handling
 */
class GenericDevice extends BaseDevice {
  private deviceType: DeviceType;
  private osTypeValue: DeviceOSType;

  constructor(config: DeviceConfig) {
    super(config);
    this.deviceType = config.type;
    this.osTypeValue = config.osType;
  }

  getOSType(): string {
    return this.osTypeValue;
  }

  getPrompt(): string {
    const prompts: Partial<Record<DeviceType, string>> = {
      'router-cisco': `${this.hostname}#`,
      'switch-cisco': `${this.hostname}#`,
      'router-huawei': `<${this.hostname}>`,
      'switch-huawei': `<${this.hostname}>`,
      'firewall-fortinet': `${this.hostname} #`,
      'firewall-cisco': `${this.hostname}#`,
      'firewall-paloalto': `${this.hostname}>`,
      'windows-pc': `C:\\Users\\Admin>`,
      'windows-server': `C:\\Users\\Administrator>`,
    };
    return prompts[this.deviceType] || `${this.hostname}:~$ `;
  }

  executeCommand(command: string): CommandResult {
    // Basic command handling for generic devices
    const cmd = command.trim().split(/\s+/)[0];

    switch (cmd) {
      case 'hostname':
        return { output: this.hostname, exitCode: 0 };
      case 'help':
      case '?':
        return {
          output: `Device: ${this.name}\nType: ${this.deviceType}\nOS: ${this.osTypeValue}\nThis device type is not fully implemented yet.`,
          exitCode: 0
        };
      case '':
        return { output: '', exitCode: 0 };
      default:
        return {
          output: '',
          error: `Command '${cmd}' not yet implemented for ${this.deviceType}`,
          exitCode: 127
        };
    }
  }
}

/**
 * Factory class for creating network devices
 */
export class DeviceFactory {
  /**
   * Create a device instance based on type
   */
  static createDevice(
    type: DeviceType,
    x: number = 0,
    y: number = 0,
    customConfig?: Partial<DeviceConfig>
  ): BaseDevice {
    const id = customConfig?.id || generateId();
    const name = customConfig?.name || getDefaultDeviceName(type);
    const hostname = customConfig?.hostname || name.toLowerCase().replace(/[^a-z0-9]/g, '-');
    const interfaces = customConfig?.interfaces || getDefaultInterfaces(type);
    const osType = getDeviceOSType(type);

    const baseConfig: DeviceConfig = {
      id,
      name,
      hostname,
      type,
      osType,
      interfaces,
      isPoweredOn: customConfig?.isPoweredOn ?? true,
      x,
      y,
      config: customConfig?.config
    };

    // Create the appropriate device class
    switch (type) {
      case 'linux-pc':
      case 'linux-server':
      case 'db-mysql':
      case 'db-postgres':
      case 'db-oracle':
      case 'db-sqlserver':
        return createLinuxPC({
          id: baseConfig.id,
          name: baseConfig.name,
          hostname: baseConfig.hostname,
          interfaces: baseConfig.interfaces,
          isPoweredOn: baseConfig.isPoweredOn,
          x,
          y
        });

      case 'windows-pc':
      case 'windows-server':
        return createWindowsPC({
          id: baseConfig.id,
          name: baseConfig.name,
          hostname: baseConfig.hostname,
          interfaces: baseConfig.interfaces,
          isPoweredOn: baseConfig.isPoweredOn,
          windowsVersion: type === 'windows-server' ? 'Windows Server 2022' : 'Windows 10 Pro',
          x,
          y
        });

      case 'router-cisco':
        return createCiscoRouter({
          id: baseConfig.id,
          name: baseConfig.name,
          hostname: baseConfig.hostname,
          interfaces: baseConfig.interfaces,
          isPoweredOn: baseConfig.isPoweredOn,
          x,
          y
        });

      case 'switch-cisco':
        return createCiscoSwitch({
          id: baseConfig.id,
          name: baseConfig.name,
          hostname: baseConfig.hostname,
          interfaces: baseConfig.interfaces,
          isPoweredOn: baseConfig.isPoweredOn,
          x,
          y
        });

      // TODO: Implement these device types in future sprints
      case 'mac-pc':
      case 'router-huawei':
      case 'switch-huawei':
      case 'firewall-fortinet':
      case 'firewall-cisco':
      case 'firewall-paloalto':
      case 'access-point':
      case 'cloud':
      default:
        return new GenericDevice(baseConfig);
    }
  }

  /**
   * Create a device from a saved configuration
   */
  static createFromConfig(config: DeviceConfig): BaseDevice {
    return DeviceFactory.createDevice(
      config.type,
      config.x || 0,
      config.y || 0,
      config
    );
  }

  /**
   * Check if a device type has terminal support
   */
  static hasTerminalSupport(type: DeviceType): boolean {
    const terminalDevices: DeviceType[] = [
      'linux-pc',
      'linux-server',
      'windows-pc',
      'windows-server',
      'mac-pc',
      'db-mysql',
      'db-postgres',
      'db-oracle',
      'db-sqlserver',
      'router-cisco',
      'router-huawei',
      'switch-cisco',
      'switch-huawei',
      'firewall-fortinet',
      'firewall-cisco',
      'firewall-paloalto'
    ];
    return terminalDevices.includes(type);
  }

  /**
   * Check if a device type is fully implemented
   */
  static isFullyImplemented(type: DeviceType): boolean {
    const implementedDevices: DeviceType[] = [
      'linux-pc',
      'linux-server',
      'windows-pc',
      'windows-server',
      'db-mysql',
      'db-postgres',
      'db-oracle',
      'db-sqlserver',
      'router-cisco',
      'switch-cisco'
    ];
    return implementedDevices.includes(type);
  }

  /**
   * Get the device category for a type
   */
  static getDeviceCategory(type: DeviceType): string {
    if (type.includes('linux') || type.includes('windows') || type.includes('mac')) {
      if (type.includes('server')) return 'servers';
      return 'computers';
    }
    if (type.startsWith('db-')) return 'databases';
    if (type.includes('router') || type.includes('switch')) return 'network';
    if (type.includes('firewall')) return 'security';
    if (type === 'access-point') return 'wireless';
    if (type === 'cloud') return 'cloud';
    return 'other';
  }
}

// Export types and factory
export { BaseDevice, GenericDevice };
export type { DeviceConfig, NetworkInterfaceConfig };
