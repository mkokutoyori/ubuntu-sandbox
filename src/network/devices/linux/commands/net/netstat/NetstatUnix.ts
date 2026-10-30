import type { NetstatOptions } from './NetstatArguments';
import type { NetstatInternetHost, NetstatInternetOutput } from './NetstatInternet';
import { padToWidth } from '@/network/devices/shells/cli/TextTable';

const PROGRAM_NAME_WIDTH = 20;
const SS_FREE = 0;
const SS_UNCONNECTED = 1;
const SS_CONNECTING = 2;
const SS_CONNECTED = 3;
const SS_DISCONNECTING = 4;
const SO_ACCEPTCON = 0x10000;
const SO_WAITDATA = 0x20000;
const SO_NOSPACE = 0x40000;
const SOCK_STREAM = 1;
const SOCK_DGRAM = 2;
const SOCK_RAW = 3;
const SOCK_RDM = 4;
const SOCK_SEQPACKET = 5;

const LINE_PATTERN = new RegExp(
  '^\\s*[0-9A-Fa-f]+:\\s+([0-9A-Fa-f]+)\\s+([0-9A-Fa-f]+)\\s+([0-9A-Fa-f]+)\\s+([0-9A-Fa-f]+)\\s+([0-9A-Fa-f]+)\\s+(-?\\d+)(?:\\s+(\\S+))?',
);

function typeName(type: number): string {
  switch (type) {
    case SOCK_STREAM: return 'STREAM';
    case SOCK_DGRAM: return 'DGRAM';
    case SOCK_RAW: return 'RAW';
    case SOCK_RDM: return 'RDM';
    case SOCK_SEQPACKET: return 'SEQPACKET';
    default: return 'UNKNOWN';
  }
}

function stateName(state: number, flags: number): string {
  switch (state) {
    case SS_FREE: return 'FREE';
    case SS_UNCONNECTED: return (flags & SO_ACCEPTCON) !== 0 ? 'LISTENING' : '';
    case SS_CONNECTING: return 'CONNECTING';
    case SS_CONNECTED: return 'CONNECTED';
    case SS_DISCONNECTING: return 'DISCONNECTING';
    default: return 'UNKNOWN';
  }
}

function flagsText(flags: number): string {
  let text = '[ ';
  if ((flags & SO_ACCEPTCON) !== 0) text += 'ACC ';
  if ((flags & SO_WAITDATA) !== 0) text += 'W ';
  if ((flags & SO_NOSPACE) !== 0) text += 'N ';
  return `${text}]`;
}

function row(line: string, hasInode: boolean, options: NetstatOptions, host: NetstatInternetHost): { text: string; bogus: boolean } {
  const match = LINE_PATTERN.exec(line);
  if (match === null) return { text: '', bogus: true };
  const references = parseInt(match[1], 16);
  const protocol = parseInt(match[2], 16);
  const flags = parseInt(match[3], 16);
  const type = parseInt(match[4], 16);
  const state = parseInt(match[5], 16);
  const inode = parseInt(match[6], 10);
  const path = hasInode ? match[7] ?? '' : String(inode);
  if (!options.all) {
    if (state === SS_UNCONNECTED && (flags & SO_ACCEPTCON) !== 0) {
      if (!options.listening) return { text: '', bogus: false };
    } else if (options.listening) {
      return { text: '', bogus: false };
    }
  }
  const protocolName = protocol === 0 ? 'unix' : '??';
  let text = `${padToWidth(protocolName, 5)} ${padToWidth(String(references), 6)} ${padToWidth(flagsText(flags), 11)} `
    + `${padToWidth(typeName(type), 10)} ${padToWidth(stateName(state, flags), 13)} `;
  text += hasInode ? padToWidth(String(inode), 8) : '-       ';
  text += ' ';
  if (options.programs) text += `${padToWidth(host.programOf(inode) ?? '-', PROGRAM_NAME_WIDTH)} `;
  return { text: `${text}${path}\n`, bogus: false };
}

export function renderUnixSockets(
  options: NetstatOptions, host: NetstatInternetHost, programNotice: string,
): NetstatInternetOutput {
  let text = 'Active UNIX domain sockets ';
  text += options.all ? '(servers and established)' : options.listening ? '(only servers)' : '(w/o servers)';
  text += '\nProto RefCnt Flags       Type       State         I-Node  ';
  if (options.programs) text += ` ${padToWidth('PID/Program name', PROGRAM_NAME_WIDTH)}`;
  text += ' Path\n';
  const content = host.procFile('/proc/net/unix');
  if (content === null) {
    if (options.argumentCount > 0) {
      return { text, stderr: `${programNotice}netstat: no support for \`AF UNIX' on this system.\n`, exitCode: 1 };
    }
    return { text, stderr: programNotice, exitCode: 0 };
  }
  const lines = content.split('\n').filter((line) => line.trim() !== '');
  const hasInode = (lines[0] ?? '').includes('Inode');
  let stderr = programNotice;
  for (const line of lines.slice(1)) {
    const rendered = row(line, hasInode, options, host);
    if (rendered.bogus) stderr += 'warning, got bogus unix line.\n';
    else text += rendered.text;
  }
  return { text, stderr, exitCode: 0 };
}
