import type { Port } from '../../hardware/Port';

export function dhcpEnabledFor(port: Port | undefined, configured: boolean): boolean {
  if (configured) return true;
  return !port?.getIPAddress();
}
