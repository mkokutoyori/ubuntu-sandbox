import type { LinuxCommand } from '../LinuxCommand';
import type { LinuxCommandContext } from '../LinuxCommandContext';
import { makeArgCompleter } from '../completionHelpers';
import { runSnmpwalk, type NetSnmpHost } from '@/network/snmp/netsnmp/Snmpwalk';

function linuxNetSnmpHost(ctx: LinuxCommandContext): NetSnmpHost {
  return {
    resolveHostname: (name) => ctx.net.resolveHostname(name),
    openSession: (processName) => ctx.net.openSnmpSession(processName),
    homeDirectory: () => {
      const users = ctx.executor.userMgr;
      return users.getUser(users.currentUser)?.home ?? '/root';
    },
  };
}

export const snmpwalkCommand: LinuxCommand = {
  name: 'snmpwalk',
  package: 'snmp',
  needsNetworkContext: true,
  manSection: 1,
  usage: 'snmpwalk [APPLICATION OPTIONS] [COMMON OPTIONS] AGENT [OID]',
  help: 'snmpwalk - retrieve a subtree of management values using SNMP GETNEXT requests',
  complete: makeArgCompleter({
    flags: ['-v', '-c', '-t', '-r', '-O', '-C', '-L', '-V', '-h', '--help', '--version'],
    wordsAfter: { '-v': ['1', '2c', '3'] },
    hostsAtBarePosition: true,
  }),
  options: [
    { flag: '-v', description: 'specifies SNMP version to use (1|2c|3)', takesArg: true, argName: '1|2c|3' },
    { flag: '-c', description: 'set the community string', takesArg: true, argName: 'COMMUNITY' },
    { flag: '-t', description: 'set the request timeout (in seconds)', takesArg: true, argName: 'TIMEOUT' },
    { flag: '-r', description: 'set the number of retries', takesArg: true, argName: 'RETRIES' },
    { flag: '-O', description: 'Toggle various defaults controlling output display', takesArg: true, argName: 'OUTOPTS' },
    { flag: '-C', description: 'Set various application specific behaviours (p, i, I, c, t, T, E)', takesArg: true, argName: 'APPOPTS' },
    { flag: '-L', description: 'Toggle various defaults controlling logging (e, o, n)', takesArg: true, argName: 'LOGOPTS' },
    { flag: '-V', description: 'display package version number', aliases: ['--version'] },
  ],

  async run(ctx: LinuxCommandContext, args: string[]): Promise<string> {
    const outcome = await runSnmpwalk(linuxNetSnmpHost(ctx), args);
    return [outcome.stdout, outcome.stderr].filter((text) => text.length > 0).join('\n');
  },

  async runWithStatus(ctx: LinuxCommandContext, args: string[]) {
    const outcome = await runSnmpwalk(linuxNetSnmpHost(ctx), args);
    return { output: outcome.stdout, exitCode: outcome.exitCode, stderr: outcome.stderr };
  },
};
