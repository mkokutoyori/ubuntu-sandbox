import type { DetectedDevice } from '../../../identity/DeviceInventory';

export function renderDeviceList(
  devices: readonly DetectedDevice[], vdomIndex: (vdom: string) => number, now: number,
): string {
  const since = (at: number) => `${Math.max(0, Math.floor((now - at) / 1000))}s`;
  return devices.flatMap((device) => [
    `    vd ${device.vdom}/${vdomIndex(device.vdom)}  ${device.mac}`,
    `        created ${since(device.createdAt)}  seen ${since(device.lastSeenAt)}  ${device.iface}`,
    ...(device.address ? [`        ip ${device.address}  src arp`] : []),
    ...(device.hostName ? [`        host '${device.hostName}'  src dhcp`] : []),
  ]).join('\n');
}
