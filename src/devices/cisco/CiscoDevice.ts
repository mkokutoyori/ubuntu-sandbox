/**
 * STUB FILE - CiscoDevice for UI compatibility
 * Real implementation will be rebuilt with TDD
 */

import { BaseDevice } from '../common/BaseDevice';
import { DeviceConfig, DeviceType } from '../common/types';

export class CiscoRouter extends BaseDevice {
  constructor(config: DeviceConfig) {
    super({ ...config, type: 'cisco-router' });
  }

  async executeCommand(command: string): Promise<string> {
    return `STUB: Command "${command}" will be implemented with TDD`;
  }

  getOSType(): 'linux' | 'windows' | 'cisco-ios' | 'unknown' {
    return 'cisco-ios';
  }
}

export class CiscoSwitch extends BaseDevice {
  constructor(config: DeviceConfig) {
    super({ ...config, type: 'cisco-switch' });
  }

  async executeCommand(command: string): Promise<string> {
    return `STUB: Command "${command}" will be implemented with TDD`;
  }

  getOSType(): 'linux' | 'windows' | 'cisco-ios' | 'unknown' {
    return 'cisco-ios';
  }
}

export class CiscoL3Switch extends BaseDevice {
  constructor(config: DeviceConfig) {
    super({ ...config, type: 'cisco-l3-switch' });
  }

  async executeCommand(command: string): Promise<string> {
    return `STUB: Command "${command}" will be implemented with TDD`;
  }

  getOSType(): 'linux' | 'windows' | 'cisco-ios' | 'unknown' {
    return 'cisco-ios';
  }
}
