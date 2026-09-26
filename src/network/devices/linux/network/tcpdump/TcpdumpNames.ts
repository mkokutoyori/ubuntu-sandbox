import type { CaptureFrame } from './CaptureFrame';
import type { FilterNames } from './TcpdumpFilter';
import type { AddressNames } from './TcpdumpFormat';

export interface CaptureNames {
  servicePort(name: string, protocol?: 'tcp' | 'udp'): number | null;
  serviceName(port: number, protocol: 'tcp' | 'udp'): string | null;
  protocolNumber(name: string): number | null;
  networkNumber(name: string): string | null;
  etherName(mac: string): string | null;
  hostAddress(name: string): Promise<string | null>;
  hostName(ip: string): Promise<string | null>;
}

const OUI_NAMES: ReadonlyMap<number, string> = new Map([
  [0x000000, 'Ethernet'],
  [0x00000c, 'Cisco'],
  [0x00005e, 'IANA'],
  [0x000081, 'Nortel Networks SONMP'],
  [0x0000f8, 'Cisco bridged'],
  [0x0080c2, 'Ethernet bridged'],
  [0x00a03e, 'ATM Forum'],
  [0x00e02f, 'DOCSIS Spanning Tree'],
  [0x080007, 'Appletalk'],
  [0x009069, 'Juniper'],
  [0x080009, 'Hewlett-Packard'],
  [0x00120f, 'IEEE 802.3 Private'],
  [0x0012bb, 'ANSI/TIA'],
  [0x001b21, 'DCBX'],
  [0x002320, 'Nicira Networks'],
  [0x5c16c7, 'Big Switch Networks'],
  [0xb0d2f5, 'Vello Systems'],
  [0x002481, 'HP'],
  [0x0004ea, 'HP-Labs'],
  [0x748771, 'Infoblox Inc'],
  [0xa42305, 'Open Networking Lab'],
  [0x00049f, 'Freescale'],
  [0x0015ad, 'Netronome'],
  [0x001018, 'Broadcom'],
  [0x00e004, 'PMC-Sierra'],
  [0xd0f0db, 'Ericsson'],
]);

const BROADCAST_MAC = 'ff:ff:ff:ff:ff:ff';

function addressesOf(frame: CaptureFrame): string[] {
  return [
    frame.srcIp, frame.dstIp, frame.arpSenderIp, frame.arpTargetIp,
    frame.icmpOrig?.srcIp, frame.icmpOrig?.dstIp,
  ].filter((ip): ip is string => ip !== undefined && ip !== '');
}

export interface NamerOptions {
  stripDomain: boolean;
  isLocal?: (ip: string) => boolean;
}

export class CaptureNamer implements AddressNames {
  private readonly hosts = new Map<string, string>();

  constructor(
    private readonly names: CaptureNames,
    private readonly options: NamerOptions = { stripDomain: false },
  ) {}

  async prepare(frame: CaptureFrame): Promise<void> {
    for (const ip of addressesOf(frame)) {
      if (this.hosts.has(ip)) continue;
      if (this.options.isLocal !== undefined && !this.options.isLocal(ip)) {
        this.hosts.set(ip, ip);
        continue;
      }
      const name = await this.names.hostName(ip);
      this.hosts.set(ip, name === null ? ip : this.options.stripDomain ? name.split('.')[0] : name);
    }
  }

  host(ip: string): string {
    return this.hosts.get(ip) ?? ip;
  }

  service(port: number, protocol: 'tcp' | 'udp'): string {
    return this.names.serviceName(port, protocol) ?? String(port);
  }

  ether(mac: string): string {
    const lower = mac.toLowerCase();
    if (lower === BROADCAST_MAC) return 'Broadcast';
    const named = this.names.etherName(lower);
    if (named !== null) return named;
    const oui = parseInt(lower.split(':').slice(0, 3).join(''), 16);
    return `${lower} (oui ${OUI_NAMES.get(oui) ?? 'Unknown'})`;
  }
}

export async function filterNamesFor(
  names: CaptureNames | undefined,
  compile: (names: FilterNames) => unknown,
): Promise<FilterNames | undefined> {
  if (names === undefined) return undefined;
  const wanted = new Set<string>();
  compile({
    servicePort: (name, protocol) => names.servicePort(name, protocol),
    protocolNumber: (name) => names.protocolNumber(name),
    networkNumber: (name) => names.networkNumber(name),
    hostAddress: (name) => { wanted.add(name); return '0.0.0.0'; },
  });
  const resolved = new Map<string, string | null>();
  for (const name of wanted) resolved.set(name, await names.hostAddress(name));
  return {
    servicePort: (name, protocol) => names.servicePort(name, protocol),
    protocolNumber: (name) => names.protocolNumber(name),
    networkNumber: (name) => names.networkNumber(name),
    hostAddress: (name) => resolved.get(name) ?? null,
  };
}
