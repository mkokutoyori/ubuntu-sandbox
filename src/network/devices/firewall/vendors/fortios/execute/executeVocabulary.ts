import { pingOptionsFor } from '../../../diag/PingOptions';

export interface FortiExecuteOption {
  readonly keyword: string;
  readonly description: string;
}

export interface FortiExecuteCommand {
  readonly name: string;
  readonly help: string;
  readonly options?: readonly FortiExecuteOption[];
}

function pingOptionKeywords(family: 'ipv4' | 'ipv6'): readonly FortiExecuteOption[] {
  return pingOptionsFor(family)
    .map(spec => ({ keyword: spec.name, description: spec.help }));
}

export const FORTI_EXECUTE_COMMANDS: readonly FortiExecuteCommand[] = Object.freeze([
  { name: 'backup', help: 'Backup the configuration to a remote server.' },
  { name: 'clear', help: 'Clear system tables.',
    options: [{ keyword: 'system', description: 'System tables.' }] },
  { name: 'date', help: 'Display or set the system date.' },
  { name: 'dhcp', help: 'DHCP server operations.',
    options: [
      { keyword: 'lease-list', description: 'List all DHCP leases.' },
      { keyword: 'lease-clear', description: 'Clear DHCP leases.' },
    ] },
  { name: 'dhcp6', help: 'DHCPv6 server operations.',
    options: [
      { keyword: 'lease-list', description: 'List all DHCPv6 leases.' },
      { keyword: 'lease-clear', description: 'Clear DHCPv6 leases.' },
    ] },
  { name: 'disconnect-admin-session', help: 'Disconnect a logged-in administrator.' },
  { name: 'enter', help: 'Select virtual domain.' },
  { name: 'factoryreset', help: 'Reset the configuration to factory default.' },
  { name: 'ha', help: 'Cluster operations.',
    options: [
      { keyword: 'disconnect', description: 'Disconnect a unit from the cluster.' },
      { keyword: 'failover', description: 'Force a failover.' },
      { keyword: 'manage', description: 'Log into another cluster member.' },
      { keyword: 'set-priority', description: 'Set a member device priority.' },
      { keyword: 'synchronize', description: 'Start or stop synchronisation.' },
    ] },
  { name: 'interface', help: 'Interface client operations.',
    options: [
      { keyword: 'dhcpclient-renew', description: 'Renew the DHCP lease.' },
      { keyword: 'dhcp6client-renew', description: 'Renew the DHCPv6 lease.' },
      { keyword: 'pppoe-reconnect', description: 'Reconnect to the PPPoE server.' },
    ] },
  { name: 'log', help: 'Log operations.' },
  { name: 'ping', help: 'Send ICMP echo requests.' },
  { name: 'policy-packet-capture', help: 'Captured-packet operations.',
    options: [{ keyword: 'delete-all', description: 'Delete all captured packets.' }] },
  { name: 'ping6', help: 'Send IPv6 ICMP echo requests.' },
  { name: 'ping-options', help: 'Set ICMP echo request (ping) options.',
    options: pingOptionKeywords('ipv4') },
  { name: 'ping6-options', help: 'Set IPv6 ICMP echo request (ping6) options.',
    options: pingOptionKeywords('ipv6') },
  { name: 'reboot', help: 'Reboot this device.' },
  { name: 'restore', help: 'Restore the configuration from a remote server.' },
  { name: 'revision', help: 'List or delete stored configuration revisions.' },
  { name: 'router', help: 'Routing process operations.',
    options: [
      { keyword: 'clear', description: 'Clear routing sessions.' },
      { keyword: 'restart', description: 'Restart all routing processes.' },
    ] },
  { name: 'set', help: 'Set an operational filter.',
    options: [{ keyword: 'system', description: 'System filters.' }] },
  { name: 'shutdown', help: 'Shut down this device.' },
  { name: 'sync-session', help: 'Sync all sessions from peers.' },
  { name: 'ssh', help: 'Open an SSH session to a remote host.' },
  { name: 'telnet', help: 'Open a telnet session to a remote host.' },
  { name: 'update-av', help: 'Update antivirus definitions from FortiGuard.' },
  { name: 'update-ips', help: 'Update IPS definitions from FortiGuard.' },
  { name: 'update-now', help: 'Update all FortiGuard databases now.' },
  { name: 'time', help: 'Display or set the system time.' },
  { name: 'traceroute', help: 'Trace the route to a destination.' },
  { name: 'tracert6', help: 'Traceroute for IPv6.' },
  { name: 'vpn', help: 'VPN operations.',
    options: [
      { keyword: 'certificate', description: 'Certificate operations.' },
      { keyword: 'ipsec', description: 'IPsec tunnel operations.' },
      { keyword: 'sslvpn', description: 'SSL-VPN connection operations.' },
    ] },
]);

export interface PrefixResolution {
  readonly name?: string;
  readonly candidates: readonly string[];
}

export function resolvePrefix(
  typed: string, vocabulary: readonly string[],
): PrefixResolution {
  if (vocabulary.includes(typed)) return { name: typed, candidates: [typed] };

  const candidates = vocabulary.filter(name => name.startsWith(typed));
  if (candidates.length === 1) return { name: candidates[0], candidates };
  return { candidates };
}

export function executeNames(): readonly string[] {
  return FORTI_EXECUTE_COMMANDS.map(command => command.name);
}
