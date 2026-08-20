import type { RouterHostsTable } from '../devices/router/dns/RouterHostsTable';

export interface IpsecHost {
  readonly id: string;
  readonly name: string;
  getName(): string;
  _sendIkeUdp(destIp: string, payload: unknown): boolean;
  _sendNatTKeepalive(destIp: string): boolean;
  _getHostnameInternal(): string;
  _getHostsTable(): RouterHostsTable;
  _ipsecLocalIp(iface: string): string | null;
  _ipsecLocalIps(): string[];
  _ipsecInterfaceDown(iface: string): boolean;
  _ipsecEgressInterfaceFor(peerIp: string): string | undefined;
}
