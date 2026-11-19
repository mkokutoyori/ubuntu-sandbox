import type { LinuxCommand } from '../LinuxCommand';
import type { LinuxCommandContext } from '../LinuxCommandContext';
import type { RadutmpEntry } from '../../freeradius/RadiusdService';
import { formatLocalTime } from '../../system/SystemInfo';
import { IPAddress } from '@/network/core/types';

const VERSION = '3.2.11';
const HEADER_WITH_NAME = 'Login      Name\t      What  TTY  When      From\t    Location';
const HEADER_WITHOUT_NAME = 'Login      Port    What      When\t  From\t    Location';

const USAGE = [
  'Usage: radwho [-d raddb] [-cfihnprRsSZ] [-N nas] [-P nas_port] [-u user] [-U user]',
  '  -c                   Show caller ID, if available.',
  '  -d                   Set the raddb directory (default is /etc/freeradius/3.0).',
  '  -F <file>            Use radutmp <file>.',
  '  -i                   Show session ID.',
  '  -n                   No full name.',
  '  -N <nas-ip-address>  Show entries matching the given NAS IP address.',
  '  -p                   Show port type.',
  '  -P <port>            Show entries matching the given nas port.',
  '  -r                   Print output as raw comma-delimited data.',
  '  -R                   Print output as RADIUS attributes and values.',
  '                       includes ALL information from the radutmp record.',
  '  -s                   Show full name.',
  '  -S                   Hide shell users from radius.',
  '  -u <user>            Show entries matching the given user.',
  '  -U <user>            Like -u, but case-sensitive.',
  '  -v                   Show program version information.',
  '  -Z                   Include accounting stop information in radius output.  Requires -R.',
].join('\n');

const WITH_ARGUMENT = new Set(['d', 'D', 'F', 'N', 'P', 'u', 'U']);
const FLAGS = new Set(['f', 'n', 's', 'S', 'i', 'p', 'c', 'r', 'R', 'v', 'Z']);

interface Parsed {
  flags: Set<string>;
  values: Map<string, string>;
  showName: number;
  invalid: boolean;
}

function parse(args: string[]): Parsed {
  const parsed: Parsed = { flags: new Set(), values: new Map(), showName: -1, invalid: false };
  for (let index = 0; index < args.length; index++) {
    const token = args[index];
    if (!token.startsWith('-') || token === '-') break;
    for (let position = 1; position < token.length; position++) {
      const letter = token[position];
      if (WITH_ARGUMENT.has(letter)) {
        const rest = token.slice(position + 1);
        const value = rest !== '' ? rest : args[++index];
        if (value === undefined) { parsed.invalid = true; return parsed; }
        parsed.values.set(letter, value);
        break;
      }
      if (!FLAGS.has(letter)) { parsed.invalid = true; return parsed; }
      parsed.flags.add(letter);
      if (letter === 'n') parsed.showName = 0;
      else if (letter === 's') parsed.showName = 1;
      else if (letter === 'c') parsed.showName = 1;
    }
  }
  return parsed;
}

function field(text: string, width: number, precision = width): string {
  return text.slice(0, precision).padEnd(width);
}

function protocolText(entry: RadutmpEntry, showPortType: boolean): string {
  if (showPortType) {
    const portType = 'ASITX'.includes(entry.portType) ? entry.portType : ' ';
    if (entry.protocol === 'S') return `SLP ${portType}`;
    if (entry.protocol === 'P') return `PPP ${portType}`;
    return `shl ${portType}`;
  }
  if (entry.protocol === 'S') return 'SLIP';
  if (entry.protocol === 'P') return 'PPP';
  return 'shell';
}

function timeText(entry: RadutmpEntry, showName: boolean, zone: string | undefined): string {
  const ctime = formatLocalTime('%a %b %e %H:%M:%S %Y', entry.timeMs, zone);
  return showName ? `${ctime.slice(0, 4)}${ctime.slice(11, 16)}` : `${ctime.slice(0, 4)}${ctime.slice(8, 16)}`;
}

export async function runRadwho(ctx: LinuxCommandContext, args: string[]): Promise<{ output: string; exitCode: number }> {
  const options = parse(args);
  if (options.invalid) return { output: USAGE, exitCode: 1 };
  if (options.flags.has('v')) return { output: `radwho version ${VERSION}`, exitCode: 0 };
  if (!ctx.radiusd) return { output: 'radwho: command not found', exitCode: 127 };
  const radiusOutput = options.flags.has('R');
  const raw = options.flags.has('r');
  const zap = options.flags.has('Z') && radiusOutput;
  const user = options.values.get('u') ?? options.values.get('U');
  const caseSensitive = options.values.has('U') && !options.values.has('u');
  const portFilter = options.values.has('P') ? parseInt(options.values.get('P')!, 10) || 0 : null;
  const nasFilter = options.values.has('N') ? IPAddress.tryParse(options.values.get('N')!)?.toString() ?? null : null;
  if (zap && user === undefined && portFilter === null) {
    if (nasFilter === null) return { output: USAGE, exitCode: 1 };
    return { output: `Acct-Status-Type = Accounting-Off\nNAS-IP-Address = ${nasFilter}\nAcct-Delay-Time = 0`, exitCode: 0 };
  }
  if (options.values.has('F')) {
    return { output: `radwho: -F is not implemented in this simulator: the session table is the server's, not a file to read.`, exitCode: 1 };
  }
  const showName = options.showName < 0 ? true : options.showName === 1;
  const showCallerId = options.flags.has('c');
  const showSessionId = options.flags.has('i');
  const zone = ctx.executor.identity.timezone;
  const nowMs = ctx.executor.simulatedDate().getTime();
  const lines: string[] = [];
  if (!raw && !radiusOutput) lines.push(showName ? HEADER_WITH_NAME : HEADER_WITHOUT_NAME);
  for (const entry of ctx.radiusd.utmpEntries()) {
    if (options.flags.has('S') && !'PCS'.includes(entry.protocol)) continue;
    if (user !== undefined) {
      const matches = caseSensitive ? entry.login.startsWith(user) : entry.login.toLowerCase().startsWith(user.toLowerCase());
      if (!matches) continue;
    }
    if (portFilter !== null && entry.nasPort !== portFilter) continue;
    if (nasFilter !== null && entry.nasAddress !== nasFilter) continue;
    const limit = showName ? 999 : 99999;
    const overflow = !raw && entry.nasPort > limit;
    const portIndicator = overflow ? '>' : 'S';
    const portNumber = overflow ? limit : entry.nasPort;
    if (radiusOutput) {
      lines.push(`User-Name = "${entry.login}"`, `Acct-Session-Id = "${entry.sessionId}"`);
      if (zap) lines.push('Acct-Status-Type = Stop');
      lines.push(`NAS-IP-Address = ${entry.nasAddress}`, `NAS-Port = ${entry.nasPort}`);
      if (entry.protocol === 'S') lines.push('Service-Type = Framed-User', 'Framed-Protocol = SLIP');
      else if (entry.protocol === 'P') lines.push('Service-Type = Framed-User', 'Framed-Protocol = PPP');
      else lines.push('Service-type = Login-User');
      if (entry.framedAddress !== null) lines.push(`Framed-IP-Address = ${entry.framedAddress}`);
      const elapsed = Math.floor((nowMs - entry.timeMs) / 1000);
      if (elapsed >= 0 && elapsed <= 86400 * 365) lines.push(`Acct-Session-Time = ${elapsed}`);
      if (entry.callerId !== '') lines.push(`Calling-Station-Id = "${entry.callerId}"`);
      lines.push('');
      continue;
    }
    const gecos = ctx.executor.userMgr.getUser(entry.login)?.gecos.split(',')[0] ?? entry.login;
    const nas = entry.nasAddress;
    const framed = entry.framedAddress ?? '';
    const proto = protocolText(entry, options.flags.has('p'));
    const when = timeText(entry, showName, zone);
    const middle = showCallerId ? entry.callerId : showSessionId ? entry.sessionId : gecos;
    if (showName) {
      lines.push(raw
        ? `${entry.login},${middle},${proto},S${entry.nasPort},${when},${nas},${framed}`
        : `${field(entry.login, 10)} ${field(middle, 17)} ${field(proto, 5)} ${portIndicator}${String(portNumber).padEnd(3)} ${field(when, 9)} ${field(nas, 15)} ${framed.slice(0, 19)}`);
    } else {
      lines.push(raw
        ? `${entry.login},${portIndicator}${entry.nasPort},${proto},${when},${nas},${framed}`
        : `${field(entry.login, 10)} ${portIndicator}${String(portNumber).padEnd(5)}  ${field(proto, 6)} ${field(when, 13)} ${field(nas, 15)} ${framed.slice(0, 28)}`);
    }
  }
  return { output: lines.join('\n'), exitCode: 0 };
}

export const radwhoCommand: LinuxCommand = {
  name: 'radwho',
  package: 'freeradius-utils',
  needsNetworkContext: true,
  manSection: 1,
  usage: '[options]',
  help: 'Show the sessions the RADIUS server holds open, from the accounting records it received.',
  options: [
    { flag: '-n', description: 'No full name.' },
    { flag: '-s', description: 'Show full name.' },
    { flag: '-i', description: 'Show session ID.' },
    { flag: '-c', description: 'Show caller ID, if available.' },
    { flag: '-p', description: 'Show port type.' },
    { flag: '-r', description: 'Print output as raw comma-delimited data.' },
    { flag: '-R', description: 'Print output as RADIUS attributes and values.' },
    { flag: '-u', description: 'Show entries matching the given user.', takesArg: true, argName: 'user' },
    { flag: '-U', description: 'Like -u, but case-sensitive.', takesArg: true, argName: 'user' },
    { flag: '-v', description: 'Show program version information.' },
  ],

  async run(ctx: LinuxCommandContext, args: string[]): Promise<string> {
    return (await runRadwho(ctx, args)).output;
  },

  runWithStatus(ctx: LinuxCommandContext, args: string[]): Promise<{ output: string; exitCode: number }> {
    return runRadwho(ctx, args);
  },
};
