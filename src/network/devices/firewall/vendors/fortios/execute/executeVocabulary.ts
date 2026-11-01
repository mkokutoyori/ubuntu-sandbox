import { pingOptionsFor } from '../../../diag/PingOptions';
import type { FortiScope } from '../schema/types';

export type CliScope = Exclude<FortiScope, 'both'>;

export interface FortiExecuteOption {
  readonly keyword: string;
  readonly description: string;
  readonly options?: readonly FortiExecuteOption[];
  readonly argument?: string;
  readonly alone?: boolean;
}

export interface FortiExecuteCommand {
  readonly name: string;
  readonly help: string;
  readonly options?: readonly FortiExecuteOption[];
  readonly scope?: FortiScope;
}

function pingOptionKeywords(family: 'ipv4' | 'ipv6'): readonly FortiExecuteOption[] {
  return pingOptionsFor(family)
    .map(spec => ({ keyword: spec.name, description: spec.help }));
}

export const FORTI_EXECUTE_COMMANDS: readonly FortiExecuteCommand[] = Object.freeze([
  { name: 'backup', help: 'Backup the configuration to a remote server.',
    options: [
      { keyword: 'config', description: 'Back up the configuration.',
        options: [{ keyword: 'tftp', description: 'Send to a TFTP server.', argument: '<file> <server> [password]' }] },
      { keyword: 'full-config', description: 'Back up the full configuration, defaults included.',
        options: [{ keyword: 'tftp', description: 'Send to a TFTP server.', argument: '<file> <server> [password]' }] },
    ] },
  { name: 'batch', help: 'Run a series of CLI commands.',
    options: [
      { keyword: 'start', description: 'Batch mode start.' },
      { keyword: 'end', description: 'Batch mode end.' },
      { keyword: 'lastlog', description: 'Read the result of last batch commands.' },
      { keyword: 'status', description: 'Batch mode status.' },
    ] },
  { name: 'cfg', help: 'Save or reload the configuration in manual mode.',
    options: [
      { keyword: 'reload', description: 'Reboot to reload the configs.' },
      { keyword: 'save', description: 'Save configs.' },
    ] },
  { name: 'clear', help: 'Clear system tables.',
    options: [{ keyword: 'system', description: 'System tables.',
      options: [{ keyword: 'arp', description: 'ARP table.',
        options: [{ keyword: 'table', description: 'Clear the ARP cache.' }] }] }] },
  { name: 'date', help: 'Display or set the system date.' },
  { name: 'dhcp', help: 'DHCP server operations.',
    options: [
      { keyword: 'lease-list', description: 'List all DHCP leases.', argument: '[interface]' },
      { keyword: 'lease-clear', description: 'Clear DHCP leases.', argument: '<address>|<first>-<last>',
        options: [{ keyword: 'all', description: 'Clear every lease.' }] },
    ] },
  { name: 'dhcp6', help: 'DHCPv6 server operations.',
    options: [
      { keyword: 'lease-list', description: 'List all DHCPv6 leases.', argument: '[interface]' },
      { keyword: 'lease-clear', description: 'Clear DHCPv6 leases.', argument: '<address>',
        options: [{ keyword: 'all', description: 'Clear every lease.' }] },
    ] },
  { name: 'disconnect-admin-session', help: 'Disconnect a logged-in administrator.' },
  { name: 'disk', help: 'List, format or scan the storage partitions.',
    options: [
      { keyword: 'list', description: 'List disk devices and partitions.' },
      { keyword: 'format', description: 'Format a partition.' },
      { keyword: 'scan', description: 'Scan a partition and fix errors.' },
    ] },
  { name: 'enter', help: 'Select virtual domain.' },
  { name: 'factoryreset', help: 'Reset the configuration to factory default.' },
  { name: 'erase-disk', help: 'Erase a disk.' },
  { name: 'factoryreset2',
    help: 'Reset to factory default, keeping VDOMs, interfaces and static routes.' },
  { name: 'formatlogdisk', help: 'Format the log disk.' },
  { name: 'ha', help: 'Cluster operations.',
    options: [
      { keyword: 'disconnect', description: 'Disconnect a unit from the cluster.', argument: '<serial> <interface> <address>' },
      { keyword: 'failover', description: 'Force a failover.',
        options: [{ keyword: 'set', description: 'Give the primary role up.' }] },
      { keyword: 'manage', description: 'Log into another cluster member.', argument: '<index> [admin]' },
      { keyword: 'set-priority', description: 'Set a member device priority.', argument: '<serial> <priority>' },
      { keyword: 'synchronize', description: 'Start or stop synchronisation.',
        options: [
          { keyword: 'start', description: 'Start a configuration synchronisation.' },
          { keyword: 'stop', description: 'Stop a configuration synchronisation.' },
        ] },
    ] },
  { name: 'interface', help: 'Interface client operations.',
    options: [
      { keyword: 'dhcpclient-renew', description: 'Renew the DHCP lease.', argument: '<interface>' },
      { keyword: 'dhcp6client-renew', description: 'Renew the DHCPv6 lease.', argument: '<interface>' },
      { keyword: 'pppoe-reconnect', description: 'Reconnect to the PPPoE server.', argument: '<interface>' },
    ] },
  { name: 'log', help: 'Log operations.' },
  { name: 'ping', help: 'Send ICMP echo requests.', scope: 'vdom' },
  { name: 'policy-packet-capture', help: 'Captured-packet operations.',
    options: [{ keyword: 'delete-all', description: 'Delete all captured packets.' }] },
  { name: 'ping6', help: 'Send IPv6 ICMP echo requests.', scope: 'vdom' },
  { name: 'ping-options', help: 'Set ICMP echo request (ping) options.',
    options: pingOptionKeywords('ipv4'), scope: 'vdom' },
  { name: 'ping6-options', help: 'Set IPv6 ICMP echo request (ping6) options.',
    options: pingOptionKeywords('ipv6'), scope: 'vdom' },
  { name: 'reboot', help: 'Reboot this device.' },
  { name: 'restore', help: 'Restore the configuration from a remote server.',
    options: [{ keyword: 'config', description: 'Restore the configuration.',
      options: [
        { keyword: 'tftp', description: 'Fetch from a TFTP server.', argument: '<file> <server> [password]' },
        { keyword: 'flash', description: 'Restore a stored revision.', argument: '<revision id>' },
      ] }] },
  { name: 'revision', help: 'List or delete stored configuration revisions.',
    options: [
      { keyword: 'list', description: 'List the stored revisions.',
        options: [{ keyword: 'config', description: 'Configuration revisions.' }] },
      { keyword: 'delete', description: 'Delete a stored revision.',
        options: [{ keyword: 'config', description: 'Configuration revisions.', argument: '<revision id>' }] },
    ] },
  { name: 'router', help: 'Routing process operations.',
    options: [
      { keyword: 'clear', description: 'Clear routing sessions.',
        options: [
          { keyword: 'ospf', description: 'OSPF process.',
            options: [{ keyword: 'process', description: 'Restart the OSPF process.' }] },
          { keyword: 'bgp', description: 'BGP sessions.',
            options: [
              { keyword: 'all', description: 'Every BGP session.' },
              { keyword: 'external', description: 'Every external BGP session.' },
              { keyword: 'ip', description: 'One neighbour.', argument: '<neighbour address>' },
              { keyword: 'as', description: 'Every neighbour of an AS.', argument: '<AS number>' },
            ] },
        ] },
      { keyword: 'restart', description: 'Restart all routing processes.' },
    ] },
  { name: 'set', help: 'Set an operational filter.',
    options: [{ keyword: 'system', description: 'System filters.',
      options: [{ keyword: 'session', description: 'Session table.',
        options: [{ keyword: 'filter', description: 'Session filter.', argument: '<field> <value>' }] }] }] },
  { name: 'shutdown', help: 'Shut down this device.' },
  { name: 'sync-session', help: 'Sync all sessions from peers.' },
  { name: 'ssh', help: 'Open an SSH session to a remote host.', scope: 'vdom' },
  { name: 'telnet', help: 'Open a telnet session to a remote host.', scope: 'vdom' },
  { name: 'update-av', help: 'Update antivirus definitions from FortiGuard.' },
  { name: 'update-geo-ip', help: 'Update the IP geography database.' },
  { name: 'update-ips', help: 'Update IPS definitions from FortiGuard.' },
  { name: 'update-now', help: 'Update all FortiGuard databases now.' },
  { name: 'time', help: 'Display or set the system time.' },
  { name: 'upd-vd-license', help: 'Update the VDOM license.' },
  { name: 'traceroute', help: 'Trace the route to a destination.', scope: 'vdom' },
  { name: 'tracert6', help: 'Traceroute for IPv6.', scope: 'vdom' },
  { name: 'vpn', help: 'VPN operations.',
    options: [
      { keyword: 'certificate', description: 'Certificate operations.',
        options: [
          { keyword: 'local', description: 'Local certificates.',
            options: [
              { keyword: 'generate', description: 'Generate a key pair and a request.',
                options: [{ keyword: 'rsa', description: 'RSA key.', argument: '<name> <key size> <subject> [country state city org unit email san]' }] },
              { keyword: 'import', description: 'Import a certificate.',
                options: [{ keyword: 'tftp', description: 'Fetch from a TFTP server.', argument: '<file> <server> [format]' }] },
              { keyword: 'export', description: 'Export a certificate.',
                options: [{ keyword: 'tftp', description: 'Send to a TFTP server.', argument: '<name> <file> <server>' }] },
            ] },
          { keyword: 'ca', description: 'CA certificates.',
            options: [
              { keyword: 'import', description: 'Import a certificate.',
                options: [{ keyword: 'tftp', description: 'Fetch from a TFTP server.', argument: '<file> <server> [format]' }] },
              { keyword: 'export', description: 'Export a certificate.',
                options: [{ keyword: 'tftp', description: 'Send to a TFTP server.', argument: '<name> <file> <server>' }] },
            ] },
        ] },
      { keyword: 'ipsec', description: 'IPsec tunnel operations.',
        options: [{ keyword: 'tunnel', description: 'Tunnels.',
          options: [
            { keyword: 'up', description: 'Bring a tunnel up.', argument: '<tunnel>' },
            { keyword: 'down', description: 'Bring a tunnel down.', argument: '<tunnel>' },
          ] }] },
      { keyword: 'sslvpn', description: 'SSL-VPN connection operations.',
        options: [
          { keyword: 'list', description: 'List the connections.', alone: true,
            options: [
              { keyword: 'web', description: 'Web-mode users.' },
              { keyword: 'tunnel', description: 'Tunnel-mode users.' },
            ] },
          { keyword: 'del-all', description: 'Delete every connection.', alone: true,
            options: [{ keyword: 'tunnel', description: 'Tunnel-mode connections.' }] },
          { keyword: 'del-web', description: 'Delete one web-mode connection.', argument: '<index>' },
          { keyword: 'del-tunnel', description: 'Delete one tunnel-mode connection.', argument: '<index>' },
        ] },
    ] },
]);

export interface FortiExecuteLeaf {
  readonly words: readonly string[];
  readonly description: string;
  readonly argument?: string;
}

function leavesOf(option: FortiExecuteOption, parents: readonly string[], depth: number): FortiExecuteLeaf[] {
  const words = [...parents, option.keyword];
  const own: FortiExecuteLeaf[] = (option.options === undefined || option.argument !== undefined || option.alone === true) && (depth >= 2 || option.argument !== undefined)
    ? [{ words, description: option.description, ...(option.argument === undefined ? {} : { argument: option.argument }) }]
    : [];
  return [...own, ...(option.options ?? []).flatMap(child => leavesOf(child, words, depth + 1))];
}

function legendsOf(option: FortiExecuteOption, parents: readonly string[]): Array<readonly [readonly string[], string]> {
  const path = [...parents, option.keyword];
  if (option.options === undefined) return [];
  return [[path, option.description], ...option.options.flatMap(child => legendsOf(child, path))];
}

export function executeLegends(where: CliScope): ReadonlyArray<readonly [readonly string[], string]> {
  return executeCommandsIn(where).flatMap(command => (command.options ?? [])
    .flatMap(option => legendsOf(option, ['execute', command.name])));
}

export function missingKeywords(command: FortiExecuteCommand, words: readonly string[]): readonly string[] | null {
  let level: readonly FortiExecuteOption[] | undefined = command.options;
  let node: FortiExecuteOption | undefined;
  for (const word of words) {
    node = level?.find(option => option.keyword === word);
    if (node === undefined) return null;
    level = node.options;
  }
  if (node === undefined || node.options === undefined || node.argument !== undefined || node.alone === true) return null;
  return node.options.map(option => option.keyword);
}

export function executeLeaves(command: FortiExecuteCommand): readonly FortiExecuteLeaf[] {
  return (command.options ?? []).flatMap(option => leavesOf(option, [], 1));
}

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

export function offeredIn(scope: FortiScope | undefined, where: CliScope): boolean {
  return scope === undefined || scope === 'both' || scope === where;
}

export function executeCommandsIn(where: CliScope): readonly FortiExecuteCommand[] {
  return FORTI_EXECUTE_COMMANDS.filter(command => offeredIn(command.scope, where));
}

export function executeNames(where: CliScope): readonly string[] {
  return executeCommandsIn(where).map(command => command.name);
}

export function executeOptionNames(command: string): readonly string[] {
  const found = FORTI_EXECUTE_COMMANDS.find(entry => entry.name === command);
  return (found?.options ?? []).map(option => option.keyword);
}
