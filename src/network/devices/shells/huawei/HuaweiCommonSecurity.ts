/**
 * HuaweiCommonSecurity — management-plane commands common to the Huawei
 * switch and router CLIs: SSH/Telnet servers, SNMP, NTP, info-center
 * (syslog), sFlow, clock timezone, DHCP(-snooping), ARP/IP source guard.
 *
 * The simulator does not model these control protocols, so the commands
 * are recognised and acknowledged (VRP returns no output on success).
 * Single source of truth + a shared registrar so HuaweiSwitchShell and
 * HuaweiVRPShell don't duplicate the wiring (DRY).
 */
import type { CommandTrie } from '../CommandTrie';

export interface LocalUser {
  password?: string;
  privilege?: string;
  serviceType?: string;
}

/** `display local-user` table. */
export function displayLocalUser(users: ReadonlyMap<string, LocalUser>): string {
  const head = [
    '  ----------------------------------------------------------------------',
    '  User-name                State  AuthMask  AdminLevel',
    '  ----------------------------------------------------------------------',
  ];
  const rows = users.size === 0
    ? ['  (no local users configured)']
    : [...users.entries()].map(([n, u]) =>
        `  ${n.padEnd(24)}A      ${(u.serviceType ?? '-').padEnd(9)} ${u.privilege ?? '-'}`);
  return [...head, ...rows,
    '  ----------------------------------------------------------------------',
    `  Total ${users.size} user(s)`].join('\n');
}

export function displaySshServerStatus(): string {
  return [
    'SSH version                     : 2.0',
    'SSH connection timeout          : 60 seconds',
    'SSH server key generating interval : 0 hours',
    'SSH authentication retries      : 3 times',
    'SFTP server                     : Disable',
    'STELNET server                  : Enable',
  ].join('\n');
}

export function displaySnmpSysInfo(): string {
  return [
    'The contact person for this managed node: R&D Beijing, Huawei',
    'The physical location of this node: Beijing China',
    'SNMP version running in the system: SNMPv2c SNMPv3',
  ].join('\n');
}

export function displayNtpStatus(): string {
  return [
    ' clock status: unsynchronized',
    ' clock stratum: 16',
    ' reference clock ID: none',
    ' nominal frequency: 100.0000 Hz',
    ' actual frequency: 100.0000 Hz',
    ' clock precision: 2^18',
    ' clock offset: 0.0000 ms',
  ].join('\n');
}

export function displayDhcpSnooping(): string {
  return [
    'DHCP snooping running information :',
    ' DHCP snooping                : Enable',
    ' Static user max number       : 0',
    ' Check dhcp-giaddr            : Disable',
    ' Check dhcp-chaddr            : Disable',
  ].join('\n');
}

export function displayPortSecurity(): string {
  return [
    'Port-security is enabled on the following interfaces:',
    ' (configuration is recorded per interface; see display this)',
  ].join('\n');
}

/**
 * Register the recognised (acknowledged) management commands shared by
 * both the switch and the router. Wired into the system-view trie of
 * each shell — single source so the list isn't duplicated (DRY).
 */
export function registerHuaweiCommonSecurity(trie: CommandTrie): void {
  // Only keywords with NO richer per-shell handling — registering
  // dhcp/ip/arp/undo here would shadow the router's own commands.
  for (const kw of [
    'stelnet', 'telnet', 'ssh', 'snmp-agent', 'ntp-service',
    'clock', 'info-center', 'sflow',
  ]) {
    trie.registerGreedy(kw, `${kw} configuration`, () => '');
  }
}

/** Register the shared management `display` commands. */
export function registerHuaweiCommonSecurityDisplay(
  trie: CommandTrie,
  getUsers: () => ReadonlyMap<string, LocalUser>,
): void {
  trie.register('display local-user', 'Display local users', () =>
    displayLocalUser(getUsers()));
  trie.registerGreedy('display ssh', 'Display SSH server status', () =>
    displaySshServerStatus());
  trie.registerGreedy('display snmp-agent', 'Display SNMP agent info', () =>
    displaySnmpSysInfo());
  trie.registerGreedy('display ntp-service', 'Display NTP status', () =>
    displayNtpStatus());
  trie.registerGreedy('display dhcp', 'Display DHCP snooping', () =>
    displayDhcpSnooping());
  trie.register('display port-security', 'Display port security', () =>
    displayPortSecurity());
}
