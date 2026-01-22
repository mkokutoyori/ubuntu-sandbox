/**
 * STUB FILE - LinuxPC for UI compatibility
 * Real implementation will be rebuilt with TDD
 */

import { BaseDevice } from '../common/BaseDevice';
import { DeviceConfig } from '../common/types';

export class LinuxPC extends BaseDevice {
  constructor(config: DeviceConfig) {
    super({ ...config, type: 'linux-pc' });
  }

  async executeCommand(command: string): Promise<string> {
    return `STUB: Command "${command}" will be implemented with TDD`;
  }

  getOSType(): 'linux' | 'windows' | 'cisco-ios' | 'unknown' {
    return 'linux';
  }
}
