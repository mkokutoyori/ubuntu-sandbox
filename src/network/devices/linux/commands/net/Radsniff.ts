import type { LinuxCommand } from '../LinuxCommand';
import type { LinuxCommandContext } from '../LinuxCommandContext';
import { decodePcap } from '@/network/capture/pcap/PcapFile';
import { fileTextToBytes } from '@/crypto/encoding';
import { decodeRadiusPacket, isRadiusDecodeError } from '@/network/radius/codec';
import { formatRadiusAttribute, radiusAttributeDisplayName } from '@/network/radius/attributeText';
import { decryptUserPassword, RADIUS_PACKET_NAME, type RadiusPacket } from '@/network/radius/types';
import { formatLocalTime } from '../../system/SystemInfo';

const VERSION = '3.2.11';
const USAGE = [
  'Usage: radsniff [options][stats options] -- [pcap files]',
  'options:',
  '  -c <count>            Number of packets to read.',
  '  -h                    This help message.',
  '  -I <file>             Read packets from file.',
  '  -p <port>             Filter packets by port (default is 1812).',
  '  -q                    Print less debugging information.',
  '  -s <secret>           RADIUS secret.',
  '  -v                    Show program version information.',
  '  -x                    Print more debugging information.',
].join('\n');

const REFUSED: Readonly<Record<string, string>> = {
  a: 'listing interfaces for a live capture', C: 'UDP checksum validation', d: 'a configuration or dictionary directory', D: 'a dictionary directory',
  e: 'event filtering', f: 'a PCAP filter expression', i: 'a live capture (write a capture with tcpdump -w and read it back with -- file)',
  l: 'attribute listing', L: 'retransmission linking attributes', m: 'promiscuous mode', P: 'daemonizing', r: 'a request attribute filter',
  R: 'a response attribute filter', S: 'writing PCAP data to stdout', t: 'a capture timeout', w: 'writing packets to a file', W: 'periodic statistics',
  T: 'the lost-request timeout',
};
const WITH_ARGUMENT = new Set(['a', 'c', 'd', 'D', 'e', 'f', 'i', 'I', 'l', 'L', 'p', 'P', 'r', 'R', 's', 't', 'T', 'w', 'W']);
const RESPONSES = new Set(['access-accept', 'access-reject', 'access-challenge', 'accounting-response', 'coa-ack', 'coa-nak', 'disconnect-ack', 'disconnect-nak']);

interface Seen {
  readonly packet: RadiusPacket;
  readonly source: string;
  readonly sourcePort: number;
  readonly destination: string;
  readonly destinationPort: number;
  readonly seconds: number;
  readonly micros: number;
}

function timeText(seconds: number, micros: number, zone: string | undefined): string {
  let scaled = micros;
  if (scaled !== 0) while (scaled < 100000) scaled *= 10;
  return `${formatLocalTime('%Y-%m-%d %H:%M:%S', seconds * 1000, zone)}.${micros === 0 ? '000000' : String(scaled)}`;
}

function difference(endSeconds: number, endMicros: number, startSeconds: number, startMicros: number): { seconds: number; micros: number } {
  let seconds = endSeconds - startSeconds;
  let micros = endMicros - startMicros;
  if (micros < 0) { micros += 1_000_000; seconds -= 1; }
  return { seconds, micros };
}

const elapsedText = (value: { seconds: number; micros: number }): string => `+${value.seconds}.${String(Math.floor(value.micros / 1000)).padStart(3, '0')}`;

function ipv4Text(bytes: Uint8Array, offset: number): string {
  return `${bytes[offset]}.${bytes[offset + 1]}.${bytes[offset + 2]}.${bytes[offset + 3]}`;
}

function readRadius(data: Uint8Array): { packet: RadiusPacket; source: string; sourcePort: number; destination: string; destinationPort: number } | null {
  if (data.length < 14 + 20 + 8 || data[12] !== 0x08 || data[13] !== 0x00) return null;
  const ip = 14;
  const headerLength = (data[ip] & 0x0f) * 4;
  if (data[ip + 9] !== 17 || data.length < ip + headerLength + 8) return null;
  const udp = ip + headerLength;
  const length = (data[udp + 4] << 8) | data[udp + 5];
  const payload = data.subarray(udp + 8, udp + length);
  const packet = decodeRadiusPacket(payload);
  if (isRadiusDecodeError(packet)) return null;
  return {
    packet, source: ipv4Text(data, ip + 12), destination: ipv4Text(data, ip + 16),
    sourcePort: (data[udp] << 8) | data[udp + 1], destinationPort: (data[udp + 2] << 8) | data[udp + 3],
  };
}

function attributeLines(packet: RadiusPacket, secret: string | null, isRequest: boolean): string[] {
  const lines = packet.attributes.map((attribute) => {
    if (attribute.type === 'user-password' && isRequest) {
      return secret === null
        ? `\t${radiusAttributeDisplayName(attribute)} = 0x${String(attribute.value)}`
        : `\t${radiusAttributeDisplayName(attribute)} = "${decryptUserPassword(String(attribute.value), secret, packet.authenticator)}"`;
    }
    return `\t${formatRadiusAttribute(attribute)}`;
  });
  lines.push(`\tAuthenticator-Field = 0x${packet.authenticator}`);
  return lines;
}

async function runRadsniff(ctx: LinuxCommandContext, args: string[]): Promise<{ output: string; exitCode: number }> {
  let verbosity = 1;
  let count = Infinity;
  let port = 1812;
  let secret: string | null = null;
  const files: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const token = args[index];
    if (token === '--') { files.push(...args.slice(index + 1)); break; }
    if (!token.startsWith('-') || token === '-') return { output: USAGE, exitCode: 1 };
    for (let position = 1; position < token.length; position++) {
      const letter = token[position];
      if (WITH_ARGUMENT.has(letter)) {
        const rest = token.slice(position + 1);
        const value = rest !== '' ? rest : args[++index];
        if (value === undefined) return { output: USAGE, exitCode: 1 };
        if (letter === 'I') files.push(value);
        else if (letter === 'c') count = Number(value);
        else if (letter === 'p') port = Number(value);
        else if (letter === 's') secret = value;
        else return { output: `radsniff: -${letter} is not implemented in this simulator: ${REFUSED[letter]}.`, exitCode: 1 };
        break;
      }
      if (letter === 'h') return { output: USAGE, exitCode: 0 };
      if (letter === 'v') return { output: `radsniff version ${VERSION}`, exitCode: 0 };
      if (letter === 'q') verbosity = 0;
      else if (letter === 'x') verbosity++;
      else if (REFUSED[letter] !== undefined) return { output: `radsniff: -${letter} is not implemented in this simulator: ${REFUSED[letter]}.`, exitCode: 1 };
      else return { output: USAGE, exitCode: 1 };
    }
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535 || (count !== Infinity && !Number.isInteger(count))) return { output: USAGE, exitCode: 1 };
  if (verbosity > 3) return { output: 'radsniff: more than -xx (a hexadecimal dump of every packet) is not implemented in this simulator.', exitCode: 1 };
  if (files.length === 0) return { output: 'radsniff: a live capture is not implemented in this simulator: write one with tcpdump -w and read it back with radsniff -- file.', exitCode: 1 };
  const zone = ctx.executor.identity.timezone;
  const ports = new Set([port, port + 1, 3799]);
  const lines: string[] = [];
  let number = 0;
  let first: { seconds: number; micros: number } | null = null;
  for (const file of files) {
    const content = ctx.executor.vfs.readFile(file);
    if (content === null) return { output: `radsniff: Failed opening ${file}: No such file or directory`, exitCode: 1 };
    const read = decodePcap(fileTextToBytes(content));
    if (read.kind === 'unreadable') return { output: `radsniff: Failed opening ${file}: ${read.message}`, exitCode: 1 };
    const requests: Seen[] = [];
    for (const record of read.records) {
      if (number >= count) break;
      const decoded = readRadius(record.data);
      if (decoded === null) continue;
      if (!ports.has(decoded.sourcePort) && !ports.has(decoded.destinationPort)) continue;
      number++;
      const micros = read.header.nanosecond ? Math.floor(record.subsecond / 1000) : record.subsecond;
      first ??= { seconds: record.seconds, micros };
      const seen: Seen = { ...decoded, seconds: record.seconds, micros };
      const response = RESPONSES.has(decoded.packet.code);
      let latency: { seconds: number; micros: number } | null = null;
      let status = '';
      if (response) {
        const at = requests.findIndex((candidate) => candidate.packet.identifier === decoded.packet.identifier
          && candidate.source === decoded.destination && candidate.sourcePort === decoded.destinationPort && candidate.destination === decoded.source);
        if (at >= 0) latency = difference(record.seconds, micros, requests[at].seconds, requests[at].micros);
        else status = '** noreq ** ';
      } else requests.push(seen);
      if (verbosity === 0) continue;
      const name = RADIUS_PACKET_NAME[decoded.packet.code];
      const left = response ? `${decoded.destination}:${decoded.destinationPort}` : `${decoded.source}:${decoded.sourcePort}`;
      const right = response ? `${decoded.source}:${decoded.sourcePort}` : `${decoded.destination}:${decoded.destinationPort}`;
      const text = `${status}${name} Id ${decoded.packet.identifier} ${file}:${left} ${response ? '<-' : '->'} ${right} ${elapsedText(difference(record.seconds, micros, first.seconds, first.micros))}${latency === null ? '' : ` ${elapsedText(latency)}`}`;
      lines.push(`${timeText(record.seconds, micros, zone)} (${number}) ${text}`);
      if (verbosity > 1) lines.push(...attributeLines(decoded.packet, secret, !response));
    }
  }
  return { output: lines.join('\n'), exitCode: 0 };
}

export const radsniffCommand: LinuxCommand = {
  name: 'radsniff',
  package: 'freeradius-utils',
  needsNetworkContext: true,
  manSection: 8,
  usage: '[options][stats options] -- [pcap files]',
  help: 'Read RADIUS packets from capture files and print them as exchanges.',
  options: [
    { flag: '-c', description: 'Number of packets to read.', takesArg: true, argName: 'count' },
    { flag: '-I', description: 'Read packets from file.', takesArg: true, argName: 'file' },
    { flag: '-p', description: 'Filter packets by port (default is 1812).', takesArg: true, argName: 'port' },
    { flag: '-q', description: 'Print less debugging information.' },
    { flag: '-s', description: 'RADIUS secret.', takesArg: true, argName: 'secret' },
    { flag: '-v', description: 'Show program version information.' },
    { flag: '-x', description: 'Print more debugging information.' },
  ],
  async run(ctx: LinuxCommandContext, args: string[]): Promise<string> {
    return (await runRadsniff(ctx, args)).output;
  },
  runWithStatus(ctx: LinuxCommandContext, args: string[]): Promise<{ output: string; exitCode: number }> {
    return runRadsniff(ctx, args);
  },
};
