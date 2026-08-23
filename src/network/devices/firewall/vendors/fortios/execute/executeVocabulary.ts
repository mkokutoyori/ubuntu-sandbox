export interface FortiExecuteCommand {
  readonly name: string;
  readonly help: string;
}

export const FORTI_EXECUTE_COMMANDS: readonly FortiExecuteCommand[] = Object.freeze([
  { name: 'backup', help: 'Backup the configuration to a remote server.' },
  { name: 'date', help: 'Display or set the system date.' },
  { name: 'dhcp', help: 'DHCP server operations.' },
  { name: 'factoryreset', help: 'Reset the configuration to factory default.' },
  { name: 'ha', help: 'Cluster operations.' },
  { name: 'log', help: 'Log operations.' },
  { name: 'ping', help: 'Send ICMP echo requests.' },
  { name: 'ping-options', help: 'Set ICMP echo request (ping) options.' },
  { name: 'reboot', help: 'Reboot this device.' },
  { name: 'restore', help: 'Restore the configuration from a remote server.' },
  { name: 'revision', help: 'List or delete stored configuration revisions.' },
  { name: 'shutdown', help: 'Shut down this device.' },
  { name: 'ssh', help: 'Open an SSH session to a remote host.' },
  { name: 'telnet', help: 'Open a telnet session to a remote host.' },
  { name: 'time', help: 'Display or set the system time.' },
  { name: 'traceroute', help: 'Trace the route to a destination.' },
  { name: 'vpn', help: 'VPN operations.' },
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
