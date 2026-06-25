import { Equipment, isFullyImplemented } from '@/network';
import type { ICLIDevice } from '@/network';
import type { TerminalSession } from './TerminalSession';
import { LinuxTerminalSession } from './LinuxTerminalSession';
import { CiscoTerminalSession } from './CiscoTerminalSession';
import { HuaweiTerminalSession } from './HuaweiTerminalSession';
import { WindowsTerminalSession } from './WindowsTerminalSession';

export function createSessionForDevice(device: Equipment, sessionId: string): TerminalSession | null {
  switch (device.getOSType()) {
    case 'linux':
      return new LinuxTerminalSession(sessionId, device);
    case 'cisco-ios':
      return new CiscoTerminalSession(sessionId, device as ICLIDevice);
    case 'huawei-vrp':
      return new HuaweiTerminalSession(sessionId, device as ICLIDevice);
    case 'windows':
      return new WindowsTerminalSession(sessionId, device);
    default:
      if (!isFullyImplemented(device.getDeviceType())) return null;
      return new LinuxTerminalSession(sessionId, device);
  }
}
