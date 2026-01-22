/**
 * STUB FILE - WindowsPC for UI compatibility
 * Real implementation will be rebuilt with TDD
 */

import { BaseDevice } from '../common/BaseDevice';
import { DeviceConfig } from '../common/types';

export class WindowsPC extends BaseDevice {
  constructor(config: DeviceConfig) {
    super({ ...config, type: 'windows-pc' });
  }

  async executeCommand(command: string): Promise<string> {
    return `STUB: Command "${command}" will be implemented with TDD`;
  }

  getOSType(): 'linux' | 'windows' | 'cisco-ios' | 'unknown' {
    return 'windows';
  }
}
