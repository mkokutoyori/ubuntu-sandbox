import type { RouterHostsTable } from '../devices/router/dns/RouterHostsTable';

export interface IpsecHost {
  readonly id: string;
  readonly name: string;
  getName(): string;
  _sendIkeUdp(destIp: string, payload: unknown): boolean;
  _sendNatTKeepalive(destIp: string): boolean;
  _getHostnameInternal(): string;
  _getHostsTable(): RouterHostsTable;
}
