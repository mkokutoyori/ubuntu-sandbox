import { IPv6Address } from '@/network/core/types';
import type { NetstatOptions } from './NetstatArguments';

export interface NetstatInternetHost {
  procFile(path: string): string | null;
  hostName(address: string): string | null;
  serviceName(port: number, protocol: string): string | null;
  userName(uid: number): string | null;
  programOf(inode: number): string | null;
}

const TCP_STATE_NAMES: readonly string[] = [
  '', 'ESTABLISHED', 'SYN_SENT', 'SYN_RECV', 'FIN_WAIT1', 'FIN_WAIT2', 'TIME_WAIT', 'CLOSE',
  'CLOSE_WAIT', 'LAST_ACK', 'LISTEN', 'CLOSING',
];

const TCP_ESTABLISHED = 1;
const TCP_CLOSE = 7;
const PROGRAM_NAME_WIDTH = 20;
const ADDRESS_SHORT_LENGTH = 22;
const CLOCK_TICKS_PER_SECOND = 100;

interface ProcNetLine {
  readonly localAddress: string;
  readonly localPort: number;
  readonly remoteAddress: string;
  readonly remotePort: number;
  readonly state: number;
  readonly transmitQueue: number;
  readonly receiveQueue: number;
  readonly timerRunning: number;
  readonly timerLength: number;
  readonly retransmits: number;
  readonly uid: number;
  readonly timeout: number;
  readonly inode: number;
  readonly ipv6: boolean;
  readonly remoteIsNull: boolean;
}

const LINE_PATTERN = new RegExp(
  '^\\s*\\d+: ([0-9A-Fa-f]+):([0-9A-Fa-f]+) ([0-9A-Fa-f]+):([0-9A-Fa-f]+) ([0-9A-Fa-f]+) '
  + '([0-9A-Fa-f]+):([0-9A-Fa-f]+) ([0-9A-Fa-f]+):([0-9A-Fa-f]+) ([0-9A-Fa-f]+) +(-?\\d+) +(-?\\d+) +(\\d+)',
);

function bytesOfWord(word: number): number[] {
  return [word & 0xff, (word >>> 8) & 0xff, (word >>> 16) & 0xff, (word >>> 24) & 0xff];
}

function addressOfHex(hexText: string): { text: string; unspecified: boolean; ipv6: boolean } {
  if (hexText.length > 8) {
    const bytes: number[] = [];
    for (let word = 0; word < 4; word++) bytes.push(...bytesOfWord(parseInt(hexText.slice(word * 8, word * 8 + 8), 16)));
    const hextets: number[] = [];
    for (let index = 0; index < 16; index += 2) hextets.push((bytes[index] << 8) | bytes[index + 1]);
    return { text: new IPv6Address(hextets).toString(), unspecified: bytes.every((byte) => byte === 0), ipv6: true };
  }
  const word = parseInt(hexText, 16);
  return { text: bytesOfWord(word).join('.'), unspecified: word === 0, ipv6: false };
}

function parseLine(line: string): ProcNetLine | null {
  const match = LINE_PATTERN.exec(line);
  if (match === null) return null;
  const local = addressOfHex(match[1]);
  const remote = addressOfHex(match[3]);
  return {
    localAddress: local.text, localPort: parseInt(match[2], 16),
    remoteAddress: remote.text, remotePort: parseInt(match[4], 16),
    state: parseInt(match[5], 16),
    transmitQueue: parseInt(match[6], 16), receiveQueue: parseInt(match[7], 16),
    timerRunning: parseInt(match[8], 16), timerLength: parseInt(match[9], 16),
    retransmits: parseInt(match[10], 16),
    uid: parseInt(match[11], 10), timeout: parseInt(match[12], 10), inode: parseInt(match[13], 10),
    ipv6: local.ipv6, remoteIsNull: remote.unspecified,
  };
}

function hostText(
  address: string, ipv6: boolean, numeric: boolean, host: NetstatInternetHost,
): string {
  const unspecified = ipv6 ? address === '::' : address === '0.0.0.0';
  if (unspecified) return numeric ? address : ipv6 ? '[::]' : address;
  if (numeric) return address;
  return host.hostName(address) ?? address;
}

function portText(port: number, protocol: string, numeric: boolean, host: NetstatInternetHost): string {
  if (port === 0) return '*';
  if (numeric) return String(port);
  return host.serviceName(port, protocol) ?? String(port);
}

function endpointText(
  address: string, port: number, ipv6: boolean, protocol: string, options: NetstatOptions, host: NetstatInternetHost,
): string {
  const shownAddress = hostText(address, ipv6, options.numericHosts, host);
  const shownPort = portText(port, protocol, options.numericPorts, host);
  if (!options.wide && shownAddress.length + shownPort.length > ADDRESS_SHORT_LENGTH) {
    const portLength = Math.min(shownPort.length, ADDRESS_SHORT_LENGTH - 4);
    const addressLength = ADDRESS_SHORT_LENGTH - portLength;
    return `${shownAddress.slice(0, addressLength)}:${shownPort.slice(0, portLength)}`;
  }
  return `${shownAddress}:${shownPort}`;
}

function timerText(line: ProcNetLine, tcp: boolean): string {
  const seconds = (line.timerLength / CLOCK_TICKS_PER_SECOND).toFixed(2);
  const counters = `${seconds}/${tcp ? line.retransmits : 0}/${line.timeout}`;
  if (line.timerRunning === 0) return `off (0.00/${tcp ? line.retransmits : 0}/${line.timeout})`;
  if (tcp) {
    switch (line.timerRunning) {
      case 1: return `on (${counters})`;
      case 2: return `keepalive (${counters})`;
      case 3: return `timewait (${counters})`;
      case 4: return `probe (${counters})`;
      default: return `unkn-${line.timerRunning} (${counters})`;
    }
  }
  if (line.timerRunning === 1 || line.timerRunning === 2) return `on${line.timerRunning} (${counters})`;
  return `unkn-${line.timerRunning} (${counters})`;
}

function trailer(
  line: ProcNetLine, tcp: boolean, options: NetstatOptions, host: NetstatInternetHost,
): string {
  let text = '';
  if (options.extended > 1) {
    const user = options.numericUsers ? null : host.userName(line.uid);
    text += ` ${(user ?? String(line.uid)).padEnd(10)} `;
    text += String(line.inode).padEnd(10);
  }
  if (options.programs) text += ` ${(host.programOf(line.inode) ?? '-').padEnd(PROGRAM_NAME_WIDTH)}`;
  if (options.timers) text += ` ${timerText(line, tcp)}`;
  return `${text}\n`;
}

function tcpRow(
  protocol: string, line: ProcNetLine, options: NetstatOptions, host: NetstatInternetHost,
): string {
  const local = endpointText(line.localAddress, line.localPort, line.ipv6, 'tcp', options, host);
  const remote = endpointText(line.remoteAddress, line.remotePort, line.ipv6, 'tcp', options, host);
  const state = TCP_STATE_NAMES[line.state] ?? '';
  return `${protocol.padEnd(4)}  ${String(line.receiveQueue).padStart(6)} ${String(line.transmitQueue).padStart(6)} `
    + `${local.padEnd(Math.max(23, local.length))} ${remote.padEnd(Math.max(23, remote.length))} ${state.padEnd(11)}`
    + trailer(line, true, options, host);
}

function datagramRow(
  protocol: string, line: ProcNetLine, options: NetstatOptions, host: NetstatInternetHost, state: string, family: string,
): string {
  const local = endpointText(line.localAddress, line.localPort, line.ipv6, family, options, host);
  const remote = endpointText(line.remoteAddress, line.remotePort, line.ipv6, family, options, host);
  return `${protocol.padEnd(5)} ${String(line.receiveQueue).padStart(6)} ${String(line.transmitQueue).padStart(6)} `
    + `${local.padEnd(23)} ${remote.padEnd(23)} ${state.padEnd(11)}`
    + trailer(line, false, options, host);
}

function datagramWanted(line: ProcNetLine, options: NetstatOptions): boolean {
  if (options.all) return true;
  return options.listening ? line.remoteIsNull : !line.remoteIsNull;
}

function datagramState(line: ProcNetLine): string {
  if (line.state === TCP_ESTABLISHED) return 'ESTABLISHED';
  return line.state === TCP_CLOSE ? '' : 'UNKNOWN';
}

type Family = { readonly file: string; readonly protocol: string; readonly ipv6: boolean };

function linesOf(text: string): ProcNetLine[] {
  const parsed: ProcNetLine[] = [];
  text.split('\n').slice(1).forEach((line) => {
    if (line.trim() === '') return;
    const entry = parseLine(line);
    if (entry !== null) parsed.push(entry);
  });
  return parsed;
}

export interface NetstatInternetOutput {
  readonly text: string;
  readonly stderr: string;
  readonly exitCode: number;
}

function missing(feature: string): string {
  return `netstat: no support for \`${feature}' on this system.\n`;
}

export function renderInternetConnections(
  options: NetstatOptions, host: NetstatInternetHost, programNotice: string,
): NetstatInternetOutput {
  const everything = options.argumentCount === 0;
  const wantsTable = everything || options.tcp || options.sctp || options.udp || options.udpLite || options.raw;
  let text = '';
  let stderr = '';
  if (wantsTable) {
    stderr += programNotice;
    text += 'Active Internet connections ';
    text += options.all ? '(servers and established)' : options.listening ? '(only servers)' : '(w/o servers)';
    text += '\nProto Recv-Q Send-Q Local Address           Foreign Address         State      ';
    if (options.extended > 1) text += ' User       Inode     ';
    if (options.programs) text += ` ${'PID/Program name'.padEnd(PROGRAM_NAME_WIDTH)}`;
    if (options.timers) text += ' Timer';
    text += '\n';
  }
  const tables: ReadonlyArray<{
    wanted: boolean; name: string; v4: Family; v6: Family; render: (protocol: string, line: ProcNetLine) => string | null;
  }> = [
    {
      wanted: everything || options.tcp, name: 'AF INET (tcp)',
      v4: { file: '/proc/net/tcp', protocol: 'tcp', ipv6: false }, v6: { file: '/proc/net/tcp6', protocol: 'tcp6', ipv6: true },
      render: (protocol, line) => {
        const hidden = options.listening ? line.remotePort !== 0 : line.remotePort === 0;
        return !options.all && hidden ? null : tcpRow(protocol, line, options, host);
      },
    },
    {
      wanted: everything || options.udp, name: 'AF INET (udp)',
      v4: { file: '/proc/net/udp', protocol: 'udp', ipv6: false }, v6: { file: '/proc/net/udp6', protocol: 'udp6', ipv6: true },
      render: (protocol, line) => (datagramWanted(line, options)
        ? datagramRow(protocol, line, options, host, datagramState(line), 'udp') : null),
    },
    {
      wanted: everything || options.udpLite, name: 'AF INET (udplite)',
      v4: { file: '/proc/net/udplite', protocol: 'udpl', ipv6: false },
      v6: { file: '/proc/net/udplite6', protocol: 'udpl6', ipv6: true },
      render: (protocol, line) => (datagramWanted(line, options)
        ? datagramRow(protocol, line, options, host, datagramState(line), 'udp') : null),
    },
    {
      wanted: everything || options.sctp, name: 'AF INET (sctp)',
      v4: { file: '/proc/net/sctp/eps', protocol: 'sctp', ipv6: false },
      v6: { file: '/proc/net/sctp/eps', protocol: 'sctp6', ipv6: true },
      render: () => null,
    },
    {
      wanted: everything || options.raw, name: 'AF INET (raw)',
      v4: { file: '/proc/net/raw', protocol: 'raw', ipv6: false }, v6: { file: '/proc/net/raw6', protocol: 'raw6', ipv6: true },
      render: (protocol, line) => (datagramWanted(line, options) ? rawRow(protocol, line, options, host) : null),
    },
  ];
  for (const table of tables) {
    if (!table.wanted) continue;
    for (const family of [table.v4, table.v6]) {
      if (!everything && !(family.ipv6 ? options.inet6 : options.inet)) continue;
      const content = host.procFile(family.file);
      if (content === null) {
        if (family.ipv6 || options.noProtocol) continue;
        if (options.argumentCount > 0 || options.verbose) stderr += missing(table.name);
        if (options.argumentCount > 0) return { text, stderr, exitCode: 1 };
        continue;
      }
      for (const line of linesOf(content)) {
        const row = table.render(family.protocol, line);
        if (row !== null) text += row;
      }
    }
  }
  return { text, stderr, exitCode: 0 };
}

function rawRow(
  protocol: string, line: ProcNetLine, options: NetstatOptions, host: NetstatInternetHost,
): string {
  const local = endpointText(line.localAddress, line.localPort, line.ipv6, 'raw', options, host);
  const remote = endpointText(line.remoteAddress, line.remotePort, line.ipv6, 'raw', options, host);
  return `${protocol.padEnd(4)}  ${String(line.receiveQueue).padStart(6)} ${String(line.transmitQueue).padStart(6)} `
    + `${local.padEnd(23)} ${remote.padEnd(23)} ${String(line.state).padEnd(11)}${trailer(line, false, options, host)}`;
}

export function renderUnixSockets(
  options: NetstatOptions, host: NetstatInternetHost, programNotice: string,
): NetstatInternetOutput {
  let text = 'Active UNIX domain sockets ';
  text += options.all ? '(servers and established)' : options.listening ? '(only servers)' : '(w/o servers)';
  text += '\nProto RefCnt Flags       Type       State         I-Node  ';
  if (options.programs) text += ` ${'PID/Program name'.padEnd(PROGRAM_NAME_WIDTH)}`;
  text += ' Path\n';
  if (host.procFile('/proc/net/unix') === null && options.argumentCount > 0) {
    return { text, stderr: programNotice + missing('AF UNIX'), exitCode: 1 };
  }
  return { text, stderr: programNotice, exitCode: 0 };
}
