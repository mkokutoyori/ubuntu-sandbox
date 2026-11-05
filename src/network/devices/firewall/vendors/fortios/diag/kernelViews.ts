import type { Firewall } from '../../../Firewall';
import { prefixLength } from './getViews';
import type { IpsecTunnelTable } from '../../../vpn/IpsecTunnelTable';

const MAIN_TABLE = 254;
const PROTO_KERNEL = 2;
const PROTO_STATIC = 11;
const PROTO_OTHER = 14;
const SCOPE_UNIVERSE = 0;
const SCOPE_LINK = 253;

function protocolNumber(kind: string, protocol: string | undefined): number {
  if (protocol !== undefined) return PROTO_OTHER;
  return kind === 'connected' ? PROTO_KERNEL : PROTO_STATIC;
}

export function renderKernelRoutes(fw: Firewall): string {
  return fw.getRouteTable().selected().map((route) => {
    const connected = route.kind === 'connected';
    const gateway = route.nextHop !== undefined && route.nextHop.length > 0 && !connected ? route.nextHop : '0.0.0.0';
    const source = connected ? fw.listL3Interfaces().find((entry) => entry.name === route.iface)?.ip ?? '0.0.0.0' : '0.0.0.0';
    return `tab=${MAIN_TABLE} vf=0 scope=${connected ? SCOPE_LINK : SCOPE_UNIVERSE} type=1 `
      + `proto=${protocolNumber(route.kind, route.protocol)} prio=${route.priority} `
      + `0.0.0.0/0->${route.network}/${prefixLength(route.mask)} pref=${source} gwy=${gateway} `
      + `dev=${fw.interfaceIndex(route.iface)}(${route.iface})`;
  }).join('\n');
}

export function renderNetlinkInterfaceList(fw: Firewall): string {
  return fw.listL3Interfaces().map((iface) => {
    const counters = fw.getPort(iface.name)?.getCounters();
    const flags = iface.up ? 'up broadcast run multicast' : 'broadcast multicast';
    return [
      `if=${iface.name} family=00 type=1 index=${fw.interfaceIndex(iface.name)} mtu=${iface.mtu} link=0 master=0`,
      `ref=1 state=${iface.up ? 'start present' : 'present'} fw_flags=0 flags=${flags}`,
      `stat: rxp=${counters?.framesIn ?? 0} txp=${counters?.framesOut ?? 0} rxb=${counters?.bytesIn ?? 0} `
        + `txb=${counters?.bytesOut ?? 0} rxe=${counters?.errorsIn ?? 0} txe=${counters?.errorsOut ?? 0} `
        + `rxd=${counters?.dropsIn ?? 0} txd=${counters?.dropsOut ?? 0} mc=${counters?.multicastIn ?? 0} collision=0`,
      '',
    ].join('\n');
  }).join('\n');
}

const CIPHER_ROWS = ['null', 'des', '3des', 'aes'] as const;
const INTEGRITY_ROWS = ['null', 'md5', 'sha1', 'sha256', 'sha384', 'sha512'] as const;

function cipherRow(cipher: string): string {
  if (cipher.startsWith('aes')) return 'aes';
  return cipher;
}

export function renderIpsecCryptoStats(tunnels: IpsecTunnelTable): string {
  const cipher = new Map<string, [number, number]>();
  const integrity = new Map<string, [number, number]>();
  const add = (table: Map<string, [number, number]>, key: string, sent: number, received: number): void => {
    const [s, r] = table.get(key) ?? [0, 0];
    table.set(key, [s + sent, r + received]);
  };
  for (const tunnel of tunnels.all()) {
    const counters = tunnels.stateOf(tunnel.name)?.counters;
    const proposal = tunnel.proposals[0];
    if (counters === undefined || proposal === undefined) continue;
    add(cipher, cipherRow(proposal.cipher), counters.sentPackets, counters.receivedPackets);
    add(integrity, proposal.integrity, counters.sentPackets, counters.receivedPackets);
  }
  const rows = (names: readonly string[], table: Map<string, [number, number]>): string[] =>
    names.map((name) => {
      const [sent, received] = table.get(name) ?? [0, 0];
      return `        ${`${name}:`.padEnd(8)}${sent}      ${received}`;
    });
  return [
    'IPsec crypto devices in use:',
    'SOFTWARE (encrypted/decrypted):',
    ...rows(CIPHER_ROWS, cipher),
    'SOFTWARE (generated/validated):',
    ...rows(INTEGRITY_ROWS, integrity),
  ].join('\n');
}
