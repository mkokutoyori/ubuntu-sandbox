import type { CommandSpec } from '../../CommandTable';

export interface DhcpBindingRow {
  ipAddress: string;
  clientId: string;
  leaseExpiration: number;
  type: string;
}

export interface DhcpViewServer {
  formatPoolShow(poolName?: string): string;
  formatStatsShow(): string;
  formatConflictShow(): string;
  formatExcludedShow(): string;
  getBindings(): Map<string, DhcpBindingRow>;
  getRelayStats(): Readonly<{ forwarded: number; repliesForwarded: number; dropped: number }>;
  clearBindings(): void;
  clearBinding(ip: string): void;
  clearConflicts(): void;
  clearStats(): void;
}

const EXEC = Object.freeze(['user', 'privileged']);
const PRIVILEGED = Object.freeze(['privileged']);

function clientIdText(clientId: string): string {
  const hex = `01${clientId.replace(/[^0-9a-fA-F]/g, '')}`.toLowerCase();
  return (hex.match(/.{1,4}/g) ?? [hex]).join('.');
}

function leaseExpirationText(at: number): string {
  if (!at) return 'Infinite';
  return new Date(at).toUTCString().slice(5, 25);
}

export function formatDhcpBindings(server: DhcpViewServer, filter?: string): string {
  const lines: string[] = [
    'Bindings from all pools not associated with VRF:',
    'IP address          Client-ID/              Lease expiration        Type',
    '                    Hardware address/',
    '                    User name',
  ];
  for (const binding of server.getBindings().values()) {
    if (filter && binding.ipAddress !== filter) continue;
    lines.push(
      binding.ipAddress.padEnd(20)
      + clientIdText(binding.clientId).padEnd(24)
      + leaseExpirationText(binding.leaseExpiration).padEnd(24)
      + binding.type);
  }
  return lines.join('\n');
}

export function formatDhcpRelayStats(server: DhcpViewServer): string {
  const relay = server.getRelayStats();
  return [
    'DHCP Relay Statistics:',
    '',
    'Message              Count',
    `Requests forwarded   ${relay.forwarded}`,
    `Replies forwarded    ${relay.repliesForwarded}`,
    `Packets dropped      ${relay.dropped}`,
  ].join('\n');
}

export function showIpDhcpSpecs(server: () => DhcpViewServer | undefined): CommandSpec[] {
  const withServer = (render: (s: DhcpViewServer) => string) => (): string => {
    const engine = server();
    return engine ? render(engine) : '';
  };
  return [
    {
      id: 'show-ip-dhcp-pool',
      path: ['show', 'ip', 'dhcp', 'pool',
        { name: 'nom', type: 'WORD' as const, optional: true, description: 'Pool name' }],
      description: 'DHCP pool information',
      modes: EXEC, minPrivilege: 1,
      run: (_session, args) => withServer(s => s.formatPoolShow(
        args.nom ? String(args.nom) : undefined))(),
    },
    {
      id: 'show-ip-dhcp-binding',
      path: ['show', 'ip', 'dhcp', 'binding',
        { name: 'adresse', type: 'IP_ADDR' as const, optional: true, description: 'Binding address' }],
      description: 'DHCP address bindings',
      modes: EXEC, minPrivilege: 1,
      run: (_session, args) => withServer(s => formatDhcpBindings(
        s, args.adresse ? String(args.adresse) : undefined))(),
    },
    {
      id: 'show-ip-dhcp-conflict',
      path: ['show', 'ip', 'dhcp', 'conflict'],
      description: 'DHCP address conflicts',
      modes: EXEC, minPrivilege: 1,
      run: withServer(s => s.formatConflictShow()),
    },
    {
      id: 'show-ip-dhcp-excluded-address',
      path: ['show', 'ip', 'dhcp', 'excluded-address'],
      description: 'DHCP excluded addresses',
      modes: EXEC, minPrivilege: 1,
      run: withServer(s => s.formatExcludedShow()),
    },
    {
      id: 'show-ip-dhcp-server-statistics',
      path: ['show', 'ip', 'dhcp', 'server', 'statistics'],
      description: 'DHCP server statistics',
      modes: EXEC, minPrivilege: 1,
      run: withServer(s => s.formatStatsShow()),
    },
    {
      id: 'show-ip-dhcp-relay-statistics',
      path: ['show', 'ip', 'dhcp', 'relay', 'statistics'],
      description: 'DHCP relay agent statistics',
      modes: EXEC, minPrivilege: 1,
      run: withServer(s => formatDhcpRelayStats(s)),
    },
    {
      id: 'clear-ip-dhcp-binding',
      path: ['clear', 'ip', 'dhcp', 'binding',
        { name: 'cible', type: 'WORD' as const, description: 'Address, or * for every binding' }],
      description: 'Clear DHCP address bindings',
      modes: PRIVILEGED, minPrivilege: 15,
      run: (_session, args) => {
        const engine = server();
        if (!engine) return '';
        const cible = String(args.cible ?? '');
        if (cible === '*') engine.clearBindings();
        else engine.clearBinding(cible);
        return '';
      },
    },
    {
      id: 'clear-ip-dhcp-conflict',
      path: ['clear', 'ip', 'dhcp', 'conflict',
        { name: 'cible', type: 'WORD' as const, description: 'Address, or * for every conflict' }],
      description: 'Clear DHCP address conflicts',
      modes: PRIVILEGED, minPrivilege: 15,
      run: withServer(s => { s.clearConflicts(); return ''; }),
    },
    {
      id: 'clear-ip-dhcp-server-statistics',
      path: ['clear', 'ip', 'dhcp', 'server', 'statistics'],
      description: 'Clear DHCP server statistics',
      modes: PRIVILEGED, minPrivilege: 15,
      run: withServer(s => { s.clearStats(); return ''; }),
    },
  ];
}

export const SHOW_IP_DHCP_PATHS: readonly string[] = Object.freeze([
  'show ip dhcp pool',
  'show ip dhcp binding',
  'show ip dhcp conflict',
  'show ip dhcp excluded-address',
  'show ip dhcp server statistics',
  'show ip dhcp relay statistics',
  'clear ip dhcp binding',
  'clear ip dhcp conflict',
  'clear ip dhcp server statistics',
]);
