import type { Equipment } from '@/network';
import { WindowsPC } from '@/network/devices/WindowsPC';
import type { WindowsShellSession } from '@/network/devices/windows/shell/WindowsShellSession';

export interface WindowsSessionRequest {
  readonly device: Equipment;
  readonly user: string;
  readonly directory?: string;
  readonly forkFrom?: WindowsShellSession | null;
  readonly inheritDriveDirectories?: boolean;
}

export function leaseWindowsSession(request: WindowsSessionRequest): WindowsShellSession | null {
  const { device } = request;
  if (!(device instanceof WindowsPC)) return null;
  if (request.forkFrom) return device.forkShellSession(request.forkFrom, request.inheritDriveDirectories ?? true);
  return device.openShellSession({ user: request.user, cwd: request.directory || `C:\\Users\\${request.user}` });
}

export function returnWindowsSession(device: Equipment, session: WindowsShellSession | null): void {
  if (session !== null && device instanceof WindowsPC) device.closeShellSession(session);
}
