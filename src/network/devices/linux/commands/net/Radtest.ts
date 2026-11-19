import type { LinuxCommand } from '../LinuxCommand';
import type { LinuxCommandContext } from '../LinuxCommandContext';
import { runRadclient } from './Radclient';

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

type AuthType = 'pap' | 'chap' | 'mschap';

const PASSWORD_ATTRIBUTE: Record<AuthType, string> = {
  pap: 'User-Password', chap: 'CHAP-Password', mschap: 'MS-CHAP-Password',
};

async function runRadtest(ctx: LinuxCommandContext, args: string[]): Promise<{ output: string; exitCode: number }> {
  if (args.length < 5) return { output: USAGE, exitCode: 1 };
  let authType: AuthType = 'pap';
  const forwarded: string[] = [];
  let index = 0;
  while (index < args.length && args[index].startsWith('-')) {
    const flag = args[index];
    if (flag === '-4' || flag === '-6' || flag === '-b' || flag === '-x') { if (flag !== '-x') forwarded.push(flag); index++; continue; }
    if (flag === '-d' || flag === '-P') { forwarded.push(flag, args[index + 1] ?? ''); index += 2; continue; }
    if (flag === '-t') {
      const type = args[index + 1];
      if (type === 'eap-md5') return { output: "radtest: No 'radeapclient' program was found.  Cannot perform EAP-MD5.", exitCode: 1 };
      if (type !== 'pap' && type !== 'chap' && type !== 'mschap') return { output: USAGE, exitCode: 1 };
      authType = type;
      index += 2;
      continue;
    }
    return { output: USAGE, exitCode: 1 };
  }
  const positional = args.slice(index);
  if (positional.length < 5 || positional.length > 7) return { output: USAGE, exitCode: 1 };
  const [user, password, server, nasPort, secret, pppHint, nasName] = positional;
  const input = [
    `User-Name = "${user}"`,
    `${PASSWORD_ATTRIBUTE[authType]} = "${password}"`,
    ...(nasName ? [`NAS-IP-Address = ${nasName}`] : []),
    `NAS-Port = ${nasPort}`,
    ...(pppHint !== undefined && pppHint !== '' && pppHint !== '0' ? ['Framed-Protocol = PPP'] : []),
    '',
  ].join('\n');
  return runRadclient(ctx, [...forwarded, '-x', server, 'auth', secret], input);
}

export const radtestCommand: LinuxCommand = {
  name: 'radtest',
  package: 'freeradius-utils',
  needsNetworkContext: true,
  foregroundClient: true,
  manSection: 1,
  usage: USAGE_LINES[0].replace('Usage: ', ''),
  help: 'Send a RADIUS Access-Request to a server and print the reply (a wrapper around radclient).',
  options: [
    { flag: '-t', description: 'Authentication type: pap (default), chap, mschap or eap-md5.', takesArg: true, argName: 'type' },
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
