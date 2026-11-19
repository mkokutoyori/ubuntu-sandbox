import type { LinuxCommand } from '../LinuxCommand';
import type { LinuxCommandContext } from '../LinuxCommandContext';
import { attr, type RadiusAttribute } from '@/network/radius/types';
import { formatRadiusAttribute } from '@/network/radius/attributeText';
import type { RadiusExchange } from '@/network/radius/RadiusClientAgent';
import { IPAddress } from '@/network/core/types';

const USAGE_LINES = [
  'Usage: radtest [OPTIONS] user passwd radius-server[:port] nas-port-number secret [ppphint] [nasname]',
  '        -d RADIUS_DIR       Set radius directory',
  '        -t <type>           Set authentication method',
  '                            type can be pap, chap, mschap, or eap-md5',
  '        -P protocol         Select udp (default) or tcp',
  '        -x                  Enable debug output',
  '        -4                  Use IPv4 for the NAS address (default)',
  '        -6                  Use IPv6 for the NAS address',
  '        -b                  Mandate checks for Blast RADIUS (this is not set by default).',
];
const USAGE = USAGE_LINES.join('\n');

const RADCLIENT_RETRIES = 3;
const RADCLIENT_TIMEOUT_MS = 5000;

type AuthType = 'pap' | 'chap' | 'mschap';

interface ParsedInvocation {
  authType: AuthType;
  positional: string[];
}

function parseInvocation(args: string[]): ParsedInvocation | string {
  let authType: AuthType = 'pap';
  let index = 0;
  while (index < args.length && args[index].startsWith('-')) {
    const flag = args[index];
    if (flag === '-4' || flag === '-b' || flag === '-x') { index++; continue; }
    if (flag === '-d' || flag === '-P') {
      if (flag === '-P' && args[index + 1] !== 'udp') return `radtest: protocol '${args[index + 1] ?? ''}' is not supported by this radclient; only udp is`;
      index += 2;
      continue;
    }
    if (flag === '-6') return "radtest: the simulated radclient has no IPv6 NAS address (NAS-IPv6-Address); use -4";
    if (flag === '-t') {
      const type = args[index + 1];
      if (type === 'eap-md5') return "radtest: No 'radeapclient' program was found.  Cannot perform EAP-MD5.";
      if (type !== 'pap' && type !== 'chap' && type !== 'mschap') return USAGE;
      authType = type;
      index += 2;
      continue;
    }
    return USAGE;
  }
  const positional = args.slice(index);
  if (positional.length < 5 || positional.length > 7) return USAGE;
  return { authType, positional };
}

async function resolveAddress(ctx: LinuxCommandContext, name: string): Promise<IPAddress | null> {
  return IPAddress.tryParse(name) ?? (await ctx.net.resolveHostname(name));
}

function sentBlock(exchange: RadiusExchange, shown: string[]): string[] {
  return [
    `Sent Access-Request Id ${exchange.request.identifier} from 0.0.0.0:${exchange.sourcePort} to ${exchange.serverIp}:${exchange.serverPort} length ${exchange.length}`,
    '\tMessage-Authenticator = 0x',
    ...shown.map((line) => `\t${line}`),
  ];
}

function receivedBlock(exchange: RadiusExchange, localIp: string): string[] {
  const reply = exchange.reply!;
  const name = reply.code.split('-').map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join('-');
  return [
    `Received ${name} Id ${reply.identifier} from ${exchange.serverIp}:${exchange.serverPort} to ${localIp}:${exchange.sourcePort} length ${exchange.replyLength}`,
    ...reply.attributes.map((attribute) => `\t${formatRadiusAttribute(attribute)}`),
  ];
}

async function runRadtest(ctx: LinuxCommandContext, args: string[]): Promise<{ output: string; exitCode: number }> {
  if (!ctx.radtestClient) return { output: 'radtest: command not found', exitCode: 127 };
  const invocation = parseInvocation(args);
  if (typeof invocation === 'string') return { output: invocation, exitCode: 1 };
  const { authType, positional } = invocation;
  const [user, password, serverArg, nasPort, secret, pppHint, nasName] = positional;

  const [serverName, portText] = serverArg.split(':');
  const port = portText === undefined ? 1812 : Number(portText);
  if (!serverName || !Number.isInteger(port) || port <= 0 || port > 65535) return { output: USAGE, exitCode: 1 };
  const server = await resolveAddress(ctx, serverName);
  if (server === null) return { output: `radclient: Failed to find IP address for host ${serverName}: Name or service not known`, exitCode: 1 };

  const extras: RadiusAttribute[] = [attr('nas-port', Number(nasPort) || 0)];
  if (nasName) {
    const nas = await resolveAddress(ctx, nasName);
    if (nas === null) return { output: `radclient: Failed to find IP address for host ${nasName}: Name or service not known`, exitCode: 1 };
    extras.unshift(attr('nas-ip-address', nas.toString()));
  }
  if (pppHint !== undefined && pppHint !== '' && pppHint !== '0') extras.push(attr('framed-protocol', 1));

  const client = ctx.radtestClient;
  client.setRequestAttributes(extras);
  client.addServer(server.toString(), secret, { timeoutMs: RADCLIENT_TIMEOUT_MS, retransmit: RADCLIENT_RETRIES, ...(portText ? { port } : {}) });
  const statusOf = () => client.listServerStatus().find((entry) => entry.ip === server.toString());
  const requestsBefore = statusOf()?.requests ?? 0;
  try {
    let accepted: boolean;
    if (authType === 'chap') accepted = await client.authenticateChap(user, password, server.toString());
    else if (authType === 'mschap') accepted = (await client.authenticateMsChapV2(user, password, server.toString())).kind === 'accept';
    else accepted = await client.authenticate(user, password, server.toString());

    const exchange = client.getLastExchange();
    if (exchange === null) return { output: 'radclient: Failed to send packet', exitCode: 1 };
    const localIp = String(exchange.request.attributes.find((attribute) => attribute.type === 'nas-ip-address')?.value ?? '0.0.0.0');
    const passwordName = authType === 'pap' ? 'User-Password' : authType === 'chap' ? 'CHAP-Password' : 'MS-CHAP-Password';
    const nasShown = exchange.request.attributes.find((attribute) => attribute.type === 'nas-ip-address');
    const shown = [
      `User-Name = "${user}"`,
      `${passwordName} = "${password}"`,
      ...(nasShown ? [formatRadiusAttribute(nasShown)] : []),
      ...extras.filter((attribute) => attribute.type !== 'nas-ip-address').map(formatRadiusAttribute),
      `Cleartext-Password = "${password}"`,
    ];
    const sentCount = Math.max(1, (statusOf()?.requests ?? 0) - requestsBefore);
    const lines: string[] = [];
    for (let attempt = 0; attempt < sentCount; attempt++) lines.push(...sentBlock(exchange, shown));
    if (exchange.reply === null) {
      lines.push(`(0) No reply from server for ID ${exchange.request.identifier} socket 3`);
      return { output: lines.join('\n'), exitCode: 1 };
    }
    lines.push(...receivedBlock(exchange, localIp));
    if (!accepted) lines.push(`(0) -: Expected Access-Accept got ${exchange.reply.code.split('-').map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join('-')}`);
    return { output: lines.join('\n'), exitCode: accepted ? 0 : 1 };
  } finally {
    client.removeServer(server.toString());
    client.setRequestAttributes([]);
  }
}

export const radtestCommand: LinuxCommand = {
  name: 'radtest',
  package: 'freeradius-utils',
  needsNetworkContext: true,
  foregroundClient: true,
  manSection: 1,
  usage: USAGE_LINES[0].replace('Usage: ', ''),
  help: 'Send a RADIUS Access-Request to a server and print the reply.',
  options: [
    { flag: '-t', description: 'Authentication type: pap (default), chap, or mschap.', takesArg: true, argName: 'type' },
    { flag: '-P', description: 'Transport protocol: udp.', takesArg: true, argName: 'protocol' },
    { flag: '-d', description: 'Set the radius directory.', takesArg: true, argName: 'RADIUS_DIR' },
    { flag: '-x', description: 'Enable debug output.' },
    { flag: '-4', description: 'Use IPv4 for the NAS address (default).' },
  ],

  async run(ctx: LinuxCommandContext, args: string[]): Promise<string> {
    return (await runRadtest(ctx, args)).output;
  },

  runWithStatus(ctx: LinuxCommandContext, args: string[]): Promise<{ output: string; exitCode: number }> {
    return runRadtest(ctx, args);
  },
};
