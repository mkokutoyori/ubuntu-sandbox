/**
 * How each platform's own telnet client words what happened.
 *
 * `launchTelnet` used to print the BSD client's transcript on every
 * platform, so a Cisco router answered a refused connection with
 * `telnet: connect to address 10.0.0.1: Connection refused` — the Linux
 * wording, on an IOS prompt. The scripted paths (`CiscoShellBase.
 * runOutboundTelnet`, `HuaweiVRPShell.runOutboundTelnet`,
 * `WindowsPC.cmdTelnet`) had the right words all along, which meant the
 * same failure read differently depending on whether the command reached
 * a terminal or a pipe.
 *
 * Every string here is taken from those existing implementations rather
 * than written afresh, so the interactive and scripted paths cannot say
 * different things about the same event.
 */

/** What a telnet attempt can print, per platform. */
export interface TelnetDialect {
  /** No host on the command line. */
  usage: string;
  /** The name does not resolve to anything on the topology. */
  unresolved(host: string, port: number): string[];
  /** The target refused the connection (or nothing was listening). */
  refused(host: string, ip: string, port: number): string[];
  /** Nothing came back at all — the packet was dropped, not rejected. */
  timedOut(host: string, ip: string, port: number): string[];
  /** No route resolves, so nothing was ever sent — ENETUNREACH. */
  unreachable(host: string, ip: string, port: number): string[];
  /** The session is open; these lines precede the remote's own output. */
  connected(host: string, ip: string): string[];
}

/** Linux/BSD `telnet(1)` — the previous behaviour, unchanged. */
export const BSD_TELNET: TelnetDialect = {
  usage: 'usage: telnet host-name [port]',
  unresolved: (host, port) => [
    `telnet: could not resolve ${host}/${port}: Name or service not known`,
  ],
  refused: (_host, ip) => [
    `Trying ${ip}...`,
    `telnet: connect to address ${ip}: Connection refused`,
  ],
  timedOut: (_host, ip) => [
    `Trying ${ip}...`,
    `telnet: connect to address ${ip}: Connection timed out`,
  ],
  unreachable: (_host, ip) => [
    `Trying ${ip}...`,
    `telnet: connect to address ${ip}: Network is unreachable`,
  ],
  connected: (host, ip) => [
    `Trying ${ip}...`,
    `Connected to ${host}.`,
    "Escape character is '^]'.",
  ],
};

/**
 * Cisco IOS. Note the space before the ellipsis (`Trying x ...`) — IOS
 * writes it that way and the scripted path already did.
 *
 * IOS puts `Open` on the same line as `Trying`; here the transcript is
 * line-based, so it lands on the next line. That is the one cosmetic
 * difference, and it is deliberate rather than an oversight.
 */
export const IOS_TELNET: TelnetDialect = {
  usage: '% Incomplete command.',
  unresolved: (host) => [
    `Trying ${host} ...`,
    '% Connection timed out; remote host not responding',
  ],
  refused: (host) => [
    `Trying ${host} ...`,
    '% Connection refused by remote host',
  ],
  timedOut: (host) => [
    `Trying ${host} ...`,
    '% Connection timed out; remote host not responding',
  ],
  unreachable: (host) => [
    `Trying ${host} ...`,
    '% Destination unreachable; gateway or host down',
  ],
  connected: (host) => [`Trying ${host} ...`, 'Open'],
};

/** Huawei VRP. One failure wording covers every reason, as on the box. */
export const VRP_TELNET: TelnetDialect = {
  usage: 'Error: Incomplete command.',
  unresolved: (host) => [
    `Trying ${host} ...`,
    'Error: Failed to connect to the remote host.',
  ],
  refused: (host) => [
    `Trying ${host} ...`,
    'Error: Failed to connect to the remote host.',
  ],
  timedOut: (host) => [
    `Trying ${host} ...`,
    'Error: Failed to connect to the remote host.',
  ],
  unreachable: (host) => [
    `Trying ${host} ...`,
    'Error: Failed to connect to the remote host.',
  ],
  connected: (host) => [
    `Trying ${host} ...`,
    'Press CTRL+K to abort',
    `Connected to ${host} ...`,
  ],
};

/** Windows `telnet.exe`, which reports the port it failed on. */
export const WINDOWS_TELNET: TelnetDialect = {
  usage: 'usage: telnet host-name [port]',
  unresolved: (host, port) => [
    `Connecting To ${host}...Could not open connection to the host, on port ${port}: Network is unreachable`,
  ],
  refused: (host, _ip, port) => [
    `Connecting To ${host}...Could not open connection to the host, on port ${port}: Connect failed`,
  ],
  timedOut: (host, _ip, port) => [
    `Connecting To ${host}...Could not open connection to the host, on port ${port}: Connect failed`,
  ],
  unreachable: (host, _ip, port) => [
    `Connecting To ${host}...Could not open connection to the host, on port ${port}: Network is unreachable`,
  ],
  connected: (host) => [
    `Connecting To ${host}...`,
    'Welcome to Microsoft Telnet Client',
    '',
    "Escape Character is 'CTRL+]'",
  ],
};
