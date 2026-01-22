/**
 * STUB FILE - DeviceFactory for UI compatibility
 * Real implementation will be rebuilt with TDD
 */

import { BaseDevice } from './common/BaseDevice';
import { DeviceType, DeviceConfig } from './common/types';
import { LinuxPC } from './linux/LinuxPC';
import { WindowsPC } from './windows/WindowsPC';
import { CiscoRouter, CiscoSwitch, CiscoL3Switch } from './cisco/CiscoDevice';

export class DeviceFactory {
  static createDevice(type: DeviceType, x: number = 0, y: number = 0): BaseDevice {
    const config: DeviceConfig = { type, x, y };

    switch (type) {
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
      default:
        throw new Error(`Unknown device type: ${type}`);
    }
  }

  static isFullyImplemented(): boolean {
    // Stub implementation - returns false as we're using stubs
    return false;
  }
}
