import type { CommandSpec } from '@/cli/CommandTable';

export interface SwitchExecViewHost {
  ipTraffic(): string;
  dhcpStatistics(): string;
  dhcpLease(): string;
  dhcpDatabase(): string;
  dhcpSnoopingStatistics(): string;
}

const EXEC = Object.freeze(['user', 'privileged']);

type Vue = readonly [string, readonly string[], string, keyof SwitchExecViewHost];

const VUES: readonly Vue[] = [
  ['show-ip-traffic', ['show', 'ip', 'traffic'],
    'IP traffic statistics', 'ipTraffic'],
  ['show-ip-dhcp-statistics', ['show', 'ip', 'dhcp', 'statistics'],
    'Display DHCP server statistics', 'dhcpStatistics'],
  ['show-ip-dhcp-lease', ['show', 'ip', 'dhcp', 'lease'],
    'Display DHCP client leases', 'dhcpLease'],
  ['show-ip-dhcp-database', ['show', 'ip', 'dhcp', 'database'],
    'Display DHCP database agents', 'dhcpDatabase'],
  ['show-ip-dhcp-snooping-statistics', ['show', 'ip', 'dhcp', 'snooping', 'statistics'],
    'Display DHCP snooping statistics', 'dhcpSnoopingStatistics'],
];

export function switchExecViewSpecs(ctx: () => SwitchExecViewHost): CommandSpec[] {
  return VUES.map(([id, chemin, description, rendu]): CommandSpec => ({
    id,
    path: [...chemin],
    description,
    modes: EXEC, minPrivilege: 1,
    run: () => ctx()[rendu](),
  }));
}
