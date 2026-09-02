/**
 * `radtest` (freeradius-utils) — send one RADIUS Access-Request and print
 * the reply. Backed by a dedicated, one-shot-per-invocation
 * `RadiusClientAgent` (`ctx.radtestClient`) rather than any persistent NAS
 * configuration — only present on `LinuxServer` (mirrors how the Oracle
 * client tools are server-only in this simulator).
 */
import type { LinuxCommand } from '../LinuxCommand';
import type { LinuxCommandContext } from '../LinuxCommandContext';

const USAGE = 'Usage: radtest [-t pap|chap|mschap] <user> <password> <server>[:port] <nas-port> <secret>';

type AuthType = 'pap' | 'chap' | 'mschap';

function pickLocalIp(ctx: LinuxCommandContext): string {
  for (const port of ctx.net.getPorts().values()) {
    const ip = port.getIPAddress();
    if (ip) return ip.toString();
  }
  return '127.0.0.1';
}

async function runRadtest(ctx: LinuxCommandContext, args: string[]): Promise<string> {
  if (!ctx.radtestClient) return 'radtest: command not found';

  let authType: AuthType = 'pap';
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-t') {
      const t = args[++i];
      if (t !== 'pap' && t !== 'chap' && t !== 'mschap') return `radtest: invalid -t argument: '${t ?? ''}'`;
      authType = t;
      continue;
    }
    positional.push(args[i]);
  }
  if (positional.length < 5) return USAGE;
  const [user, password, serverArg, nasPort, secret] = positional;
  const [serverIp, portStr] = serverArg.split(':');
  if (!serverIp) return USAGE;
  const port = portStr ? Number(portStr) : 1812;
  if (portStr && (!Number.isInteger(port) || port <= 0 || port > 65535)) {
    return `radtest: invalid port in '${serverArg}'`;
  }

  const identifier = Math.floor(Math.random() * 256);
  const lines = [
    `Sending Access-Request of id ${identifier} to ${serverIp} port ${port}`,
    `\tUser-Name = "${user}"`,
    authType === 'pap'
      ? `\tUser-Password = "${password}"`
      : `\t${authType === 'chap' ? 'CHAP-Password' : 'MS-CHAP2-Response'} = 0x<hidden>`,
    `\tNAS-IP-Address = ${pickLocalIp(ctx)}`,
    `\tNAS-Port = ${nasPort}`,
  ];

  const client = ctx.radtestClient;
  client.addServer(serverIp, secret, { timeoutMs: 3000, retransmit: 1, ...(portStr ? { port } : {}) });
  const timeoutsBefore = client.listServerStatus().find((s) => s.ip === serverIp)?.timeouts ?? 0;
  try {
    let accepted: boolean;
    if (authType === 'chap') {
      accepted = await client.authenticateChap(user, password, serverIp);
    } else if (authType === 'mschap') {
      accepted = (await client.authenticateMsChapV2(user, password, serverIp)).kind === 'accept';
    } else {
      accepted = await client.authenticate(user, password, serverIp);
    }
    const timeoutsAfter = client.listServerStatus().find((s) => s.ip === serverIp)?.timeouts ?? 0;
    if (timeoutsAfter > timeoutsBefore) {
      lines.push(`radtest: no response from server ${serverIp}:${port}`);
    } else {
      lines.push(
        accepted
          ? `rad_recv: Access-Accept packet from host ${serverIp} port ${port}, id=${identifier}`
          : `rad_recv: Access-Reject packet from host ${serverIp} port ${port}, id=${identifier}`,
      );
    }
    return lines.join('\n');
  } finally {
    client.removeServer(serverIp);
  }
}

export const radtestCommand: LinuxCommand = {
  name: 'radtest',
  package: 'freeradius-utils',
  needsNetworkContext: true,
  manSection: 1,
  usage: USAGE,
  help: 'Send a RADIUS Access-Request to a server and print the reply.',
  options: [
    { flag: '-t', description: 'Authentication type: pap (default), chap, or mschap.', takesArg: true, argName: 'type' },
  ],

  run(ctx: LinuxCommandContext, args: string[]): Promise<string> {
    return runRadtest(ctx, args);
  },

  async runWithStatus(ctx: LinuxCommandContext, args: string[]): Promise<{ output: string; exitCode: number }> {
    const output = await runRadtest(ctx, args);
    const exitCode = /Access-Accept/.test(output) ? 0 : /no response/.test(output) ? 2 : 1;
    return { output, exitCode };
  },
};
