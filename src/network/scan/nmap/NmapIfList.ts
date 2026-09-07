import type { Equipment } from '@/network/equipment/Equipment';
import { NMAP_TABLE, renderTable } from '@/network/devices/shells/cli/TextTable';

export type NmapInterfaceType = 'ethernet' | 'loopback' | 'point2point' | 'other';

export interface NmapInterface {
  name: string;
  shortName: string;
  ip: string | null;
  maskBits: number;
  type: NmapInterfaceType;
  up: boolean;
  mtu: number;
  mac?: string;
}

export interface NmapRoute {
  dest: string;
  maskBits: number;
  dev: string;
  metric: number;
  gateway?: string;
}

const INTERFACES_BANNER =
  '************************INTERFACES************************';
const ROUTES_BANNER =
  '**************************ROUTES**************************';

export function interfacesOf(device: Equipment | null): NmapInterface[] {
  if (!device) return [];
  const ports = [...device.getPorts()].sort(
    (a, b) => Number(b.isLoopback()) - Number(a.isLoopback()));
  return ports.map((port) => {
    const ip = port.getIPAddress();
    const mask = port.getSubnetMask();
    const loopback = port.isLoopback();
    return {
      name: port.getName(),
      shortName: port.getName(),
      ip: ip ? ip.toString() : null,
      maskBits: mask ? mask.toCIDR() : 0,
      type: loopback ? 'loopback' : port.isCarrierless() ? 'other' : 'ethernet',
      up: port.getIsUp(),
      mtu: port.getMTU(),
      mac: loopback || port.isCarrierless() ? undefined : port.getMAC().toString().toUpperCase(),
    };
  });
}

export function renderIfList(
  interfaces: readonly NmapInterface[], routes: readonly NmapRoute[],
): string {
  const out: string[] = [];

  if (interfaces.length === 0) {
    out.push('INTERFACES: NONE FOUND(!)');
  } else {
    out.push(INTERFACES_BANNER);
    out.push(...renderTable<NmapInterface>(interfaces, [
      { header: 'DEV', value: (i) => i.name },
      { header: '(SHORT)', value: (i) => `(${i.shortName})` },
      { header: 'IP/MASK', value: (i) => `${i.ip ?? '(none)'}/${i.maskBits}` },
      { header: 'TYPE', value: (i) => i.type },
      { header: 'UP', value: (i) => (i.up ? 'up' : 'down') },
      { header: 'MTU', value: (i) => String(i.mtu) },
      { header: 'MAC', value: (i) => i.mac ?? '' },
    ], NMAP_TABLE));
    out.push('');
  }

  if (routes.length === 0) {
    out.push('ROUTES: NONE FOUND(!)');
  } else {
    out.push(ROUTES_BANNER);
    out.push(...renderTable<NmapRoute>(routes, [
      { header: 'DST/MASK', value: (r) => `${r.dest}/${r.maskBits}` },
      { header: 'DEV', value: (r) => r.dev },
      { header: 'METRIC', value: (r) => String(r.metric) },
      { header: 'GATEWAY', value: (r) => r.gateway ?? '' },
    ], NMAP_TABLE));
    out.push('');
  }

  return out.join('\n');
}
