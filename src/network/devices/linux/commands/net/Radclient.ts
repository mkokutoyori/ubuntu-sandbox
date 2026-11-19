import type { LinuxCommand } from '../LinuxCommand';
import type { LinuxCommandContext } from '../LinuxCommandContext';
import { attr, type RadiusAttribute } from '@/network/radius/types';
import { formatRadiusAttribute } from '@/network/radius/attributeText';
import type { RadiusExchange } from '@/network/radius/RadiusClientAgent';
import { IPAddress } from '@/network/core/types';
import { parsePairList, usersPairToAttribute, type UsersPair } from '../../freeradius/UsersFileParser';

const VERSION = '3.2.11';

const USAGE_LINES = [
  'Usage: radclient [options] server[:port] <command> [<secret>]',
  "  <command>              One of auth, acct, status, coa, disconnect or auto.",
  '  -4                     Use IPv4 address of server',
  '  -6                     Use IPv6 address of server.',
  '  -b                     Mandate checks for Blast RADIUS issue (this is not set by default).',
  "  -c <count>             Send each packet 'count' times.",
  '  -d <raddb>             Set user dictionary directory (defaults to /etc/freeradius/3.0).',
  '  -D <dictdir>           Set main dictionary directory (defaults to /usr/share/freeradius).',
  '  -f <file>[:<file>]     Read packets from file, not stdin.',
  '                         If a second file is provided, it will be used to verify responses',
  '  -F                     Print the file name, packet number and reply code.',
  '  -h                     Print usage help information.',
  '  -n <num>               Send N requests/s',
  "  -p <num>               Send 'num' packets from a file in parallel.",
  '  -q                     Do not print anything out.',
  "  -r <retries>           If timeout, retry sending the packet 'retries' times.",
  '  -s                     Print out summary information of auth results.',
  '  -S <file>              read secret from file, not command line.',
  "  -t <timeout>           Wait 'timeout' seconds before retrying (may be a floating point number).",
  '  -v                     Show program version information.',
  '  -x                     Debugging mode.',
  '  -P <proto>             Use proto (tcp or udp) for transport.',
];
export const RADCLIENT_USAGE = USAGE_LINES.join('\n');

const OPTIONS_WITH_ARGUMENT = new Set(['c', 'd', 'D', 'f', 'i', 'n', 'p', 'P', 'r', 'S', 't']);
const KNOWN_FLAGS = new Set(['4', '6', 'b', 'F', 'h', 'q', 's', 'v', 'x']);

const RADCLIENT_RETRIES = 3;
const RADCLIENT_TIMEOUT_SECONDS = 5;

type AuthType = 'pap' | 'chap' | 'mschap';

interface Options {
  flags: Set<string>;
  values: Map<string, string>;
  debugLevel: number;
  positional: string[];
}

function parseOptions(args: string[]): Options | null {
  const parsed: Options = { flags: new Set(), values: new Map(), debugLevel: 0, positional: [] };
  let index = 0;
  for (; index < args.length; index++) {
    const token = args[index];
    if (!token.startsWith('-') || token === '-') break;
    if (token === '--') { index++; break; }
    for (let position = 1; position < token.length; position++) {
      const letter = token[position];
      if (OPTIONS_WITH_ARGUMENT.has(letter)) {
        const rest = token.slice(position + 1);
        const value = rest !== '' ? rest : args[++index];
        if (value === undefined) return null;
        parsed.values.set(letter, value);
        break;
      }
      if (!KNOWN_FLAGS.has(letter)) return null;
      parsed.flags.add(letter);
      if (letter === 'x') parsed.debugLevel++;
    }
  }
  parsed.positional = args.slice(index);
  return parsed;
}

const REFUSED_FLAGS: Record<string, string> = {
  '6': 'there is no IPv6 transport in the RADIUS client',
  b: 'Blast RADIUS checks are not modelled',
  F: 'per-file reporting is not modelled',
};

const REFUSED_VALUES: Record<string, string> = {
  D: 'only the built-in dictionaries are modelled',
  n: 'a request rate is not modelled',
  p: 'parallel packets are not modelled',
  P: 'only UDP is modelled by this client',
};

const REFUSED_COMMANDS: Record<string, string> = {
  acct: 'the client sends authentication requests only',
  status: 'the client sends authentication requests only',
  coa: 'the client sends authentication requests only',
  disconnect: 'the client sends authentication requests only',
  auto: 'the client sends authentication requests only',
};

interface Packet {
  pairs: UsersPair[];
}

function readPackets(text: string): Packet[] | { error: string } {
  const packets: Packet[] = [];
  let current: UsersPair[] = [];
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].trim();
    if (line === '' || line.startsWith('#')) {
      if (line === '' && current.length > 0) { packets.push({ pairs: current }); current = []; }
      continue;
    }
    const parsed = parsePairList(line);
    if ('error' in parsed) return { error: `radclient: Error parsing line ${index + 1}: ${parsed.error}` };
    current.push(...parsed.pairs);
  }
  if (current.length > 0) packets.push({ pairs: current });
  return packets;
}

function nameOf(pair: UsersPair): string {
  return pair.name.toLowerCase();
}

function describe(exchange: RadiusExchange, shown: string[], debug: boolean): string[] {
  return [
    `Sent Access-Request Id ${exchange.request.identifier} from 0.0.0.0:${exchange.sourcePort} to ${exchange.serverIp}:${exchange.serverPort} length ${exchange.length}`,
    ...(debug ? ['\tMessage-Authenticator = 0x', ...shown.map((line) => `\t${line}`)] : []),
  ];
}

function codeName(code: string): string {
  return code.split('-').map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join('-');
}

export async function runRadclient(ctx: LinuxCommandContext, args: string[], stdin?: string): Promise<{ output: string; exitCode: number }> {
  const options = parseOptions(args);
  if (options === null) return { output: RADCLIENT_USAGE, exitCode: 1 };
  if (options.flags.has('v')) return { output: `radclient version ${VERSION}`, exitCode: 0 };
  if (options.flags.has('h')) return { output: RADCLIENT_USAGE, exitCode: 1 };
  for (const [flag, reason] of Object.entries(REFUSED_FLAGS)) {
    if (options.flags.has(flag)) return { output: `radclient: -${flag} is not implemented in this simulator: ${reason}.`, exitCode: 1 };
  }
  for (const [flag, reason] of Object.entries(REFUSED_VALUES)) {
    if (options.values.has(flag)) return { output: `radclient: -${flag} is not implemented in this simulator: ${reason}.`, exitCode: 1 };
  }
  const secretFile = options.values.get('S');
  const expectedPositionals = secretFile === undefined ? 3 : 2;
  if (options.positional.length !== expectedPositionals) return { output: RADCLIENT_USAGE, exitCode: 1 };
  const [serverArg, command] = options.positional;
  if (REFUSED_COMMANDS[command] !== undefined) {
    return { output: `radclient: the ${command} command is not implemented in this simulator: ${REFUSED_COMMANDS[command]}.`, exitCode: 1 };
  }
  if (command !== 'auth') return { output: `radclient: Invalid request type "${command}"`, exitCode: 1 };
  if (!ctx.radtestClient) return { output: 'radclient: command not found', exitCode: 127 };
  const count = options.values.has('c') ? Number(options.values.get('c')) : 1;
  const retries = options.values.has('r') ? Number(options.values.get('r')) : RADCLIENT_RETRIES;
  const timeoutText = options.values.get('t');
  if ((options.values.has('c') && !(count >= 1)) || (options.values.has('r') && !(retries >= 1 && retries <= 1000))
    || (timeoutText !== undefined && !/^\d/.test(timeoutText))) {
    return { output: RADCLIENT_USAGE, exitCode: 1 };
  }
  const timeoutMs = (timeoutText === undefined ? RADCLIENT_TIMEOUT_SECONDS : Number(timeoutText)) * 1000;

  let secret = options.positional[2];
  if (secretFile !== undefined) {
    const content = ctx.executor.vfs.readFile(secretFile);
    if (content === null) return { output: `radclient: Error reading ${secretFile}: No such file or directory`, exitCode: 1 };
    secret = content.split('\n')[0].trim();
  }

  const [serverName, portText] = serverArg.split(':');
  const port = portText === undefined ? 1812 : Number(portText);
  if (!serverName || !Number.isInteger(port) || port <= 0 || port > 65535) return { output: RADCLIENT_USAGE, exitCode: 1 };
  const server = IPAddress.tryParse(serverName) ?? (await ctx.net.resolveHostname(serverName));
  if (server === null) return { output: `radclient: Failed to find IP address for host ${serverName}: Name or service not known`, exitCode: 1 };

  let input = stdin ?? '';
  const fileArgument = options.values.get('f');
  if (fileArgument !== undefined) {
    const file = fileArgument.split(':')[0];
    const content = ctx.executor.vfs.readFile(file);
    if (content === null) return { output: `radclient: Error opening ${file}: No such file or directory`, exitCode: 1 };
    input = content;
  }
  const packets = readPackets(input);
  if ('error' in packets) return { output: packets.error, exitCode: 1 };
  if (packets.length === 0) return { output: 'radclient: Nothing to send.', exitCode: 1 };

  const quiet = options.flags.has('q');
  const lines: string[] = [];
  let accepted = 0;
  let rejected = 0;
  let lost = 0;
  let failed = 0;
  let number = 0;
  const client = ctx.radtestClient;
  client.addServer(server.toString(), secret, { timeoutMs, retransmit: retries, ...(portText ? { port } : {}) });
  const statusOf = () => client.listServerStatus().find((entry) => entry.ip === server.toString());
  try {
    for (const packet of packets) {
      for (let repeat = 0; repeat < count; repeat++, number++) {
        let user: string | null = null;
        let password: string | null = null;
        let authType: AuthType = 'pap';
        let passwordName = 'User-Password';
        const extras: RadiusAttribute[] = [];
        const shown: string[] = [];
        for (const pair of packet.pairs) {
          const key = nameOf(pair);
          if (key === 'user-name') user = pair.value;
          else if (key === 'user-password' || key === 'cleartext-password') { password = pair.value; passwordName = pair.name; }
          else if (key === 'chap-password') { password = pair.value; authType = 'chap'; passwordName = pair.name; }
          else if (key === 'ms-chap-password') { password = pair.value; authType = 'mschap'; passwordName = pair.name; }
          else if (key === 'message-authenticator') { shown.push('Message-Authenticator = 0x'); continue; }
          else {
            const attribute = usersPairToAttribute(pair);
            if (attribute === null) return { output: `radclient: Failed to parse attribute "${pair.name}"`, exitCode: 1 };
            extras.push(attribute);
          }
          shown.push(key === 'user-name' || key.endsWith('password') ? `${pair.name} = "${pair.value}"` : formatRadiusAttribute(usersPairToAttribute(pair) ?? attr('user-name', pair.value)));
        }
        if (user === null || password === null) {
          return { output: 'radclient: Packet is missing User-Name or a password attribute.', exitCode: 1 };
        }
        client.setRequestAttributes(extras);
        const requestsBefore = statusOf()?.requests ?? 0;
        let ok: boolean;
        if (authType === 'chap') ok = await client.authenticateChap(user, password, server.toString());
        else if (authType === 'mschap') ok = (await client.authenticateMsChapV2(user, password, server.toString())).kind === 'accept';
        else ok = await client.authenticate(user, password, server.toString());
        const exchange = client.getLastExchange();
        if (exchange === null) { failed++; lost++; continue; }
        const display = [...shown];
        if (passwordName.toLowerCase() !== 'cleartext-password') display.push(`Cleartext-Password = "${password}"`);
        const localIp = String(exchange.request.attributes.find((attribute) => attribute.type === 'nas-ip-address')?.value ?? '0.0.0.0');
        const nasShown = exchange.request.attributes.find((attribute) => attribute.type === 'nas-ip-address');
        if (nasShown && !shown.some((line) => line.toLowerCase().startsWith('nas-ip-address'))) {
          display.splice(Math.min(2, display.length), 0, formatRadiusAttribute(nasShown));
        }
        const sent = Math.max(1, (statusOf()?.requests ?? 0) - requestsBefore);
        if (!quiet) for (let attempt = 0; attempt < sent; attempt++) lines.push(...describe(exchange, display, options.debugLevel > 0));
        if (exchange.reply === null) {
          if (!quiet) lines.push(`(${number}) No reply from server for ID ${exchange.request.identifier} socket 3`);
          lost++;
          failed++;
          continue;
        }
        if (!quiet) {
          lines.push(`Received ${codeName(exchange.reply.code)} Id ${exchange.reply.identifier} from ${exchange.serverIp}:${exchange.serverPort} to ${localIp}:${exchange.sourcePort} length ${exchange.replyLength}`);
          if (options.debugLevel > 0) lines.push(...exchange.reply.attributes.map((attribute) => `\t${formatRadiusAttribute(attribute)}`));
        }
        if (ok) accepted++;
        else {
          rejected++;
          failed++;
          if (!quiet) lines.push(`(${number}) -: Expected Access-Accept got ${codeName(exchange.reply.code)}`);
        }
      }
    }
  } finally {
    client.removeServer(server.toString());
    client.setRequestAttributes([]);
  }
  if (options.flags.has('s')) {
    lines.push('Packet summary:', `\tAccepted      : ${accepted}`, `\tRejected      : ${rejected}`, `\tLost          : ${lost}`,
      '\tPassed filter : 0', `\tFailed filter : ${failed - lost}`);
  }
  return { output: lines.join('\n'), exitCode: lost > 0 || failed > 0 ? 1 : 0 };
}

export const radclientCommand: LinuxCommand = {
  name: 'radclient',
  package: 'freeradius-utils',
  needsNetworkContext: true,
  foregroundClient: true,
  readsStdin: true,
  manSection: 1,
  usage: '[options] server[:port] <command> [<secret>]',
  help: 'Send RADIUS authentication requests built from attribute lists and print the replies.',
  options: [
    { flag: '-c', description: "Send each packet 'count' times.", takesArg: true, argName: 'count' },
    { flag: '-f', description: 'Read packets from file, not stdin.', takesArg: true, argName: 'file' },
    { flag: '-q', description: 'Do not print anything out.' },
    { flag: '-r', description: 'If timeout, retry sending the packet this many times.', takesArg: true, argName: 'retries' },
    { flag: '-s', description: 'Print out summary information of auth results.' },
    { flag: '-S', description: 'Read secret from file, not command line.', takesArg: true, argName: 'file' },
    { flag: '-t', description: 'Wait this many seconds before retrying.', takesArg: true, argName: 'timeout' },
    { flag: '-v', description: 'Show program version information.' },
    { flag: '-x', description: 'Debugging mode.' },
  ],

  async run(ctx: LinuxCommandContext, args: string[], stdin?: string): Promise<string> {
    return (await runRadclient(ctx, args, stdin)).output;
  },

  runWithStatus(ctx: LinuxCommandContext, args: string[], stdin?: string): Promise<{ output: string; exitCode: number }> {
    return runRadclient(ctx, args, stdin);
  },
};
