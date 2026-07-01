/**
 * Small helper that pulls the application-layer banner (or the listener's
 * process name) from a remote device's `SocketTable`. Shared between
 * `nmap`, `nc`, `curl`, and any future protocol-inspection tool so we
 * only speak the "banner registered on bind" contract in one place.
 */

import type { Equipment } from '../../../../equipment/Equipment';

type SocketTableProbe = {
  getBannerForPort(protocol: 'tcp' | 'udp', port: number): string | null;
  getListenerProcess(protocol: 'tcp' | 'udp', port: number): string | null;
};

function socketTableOf(device: Equipment): SocketTableProbe | null {
  const st = (device as unknown as { socketTable?: SocketTableProbe }).socketTable;
  return st ?? null;
}

export function grabBanner(device: Equipment, port: number): string | null {
  return socketTableOf(device)?.getBannerForPort('tcp', port) ?? null;
}

export function grabListenerProcess(device: Equipment, port: number): string | null {
  return socketTableOf(device)?.getListenerProcess('tcp', port) ?? null;
}
