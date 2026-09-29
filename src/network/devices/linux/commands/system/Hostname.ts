import type { LinuxCommand } from '../LinuxCommand';
import type { LinuxCommandContext } from '../LinuxCommandContext';
import { Deny } from '../../iam/policy/CommandPrivilegePolicy';
import { kernelHostname } from '../../KernelHostname';

const VALID_FLAGS = new Set([
  '-s', '--short', '-f', '--fqdn', '-i', '--ip-address',
  '-d', '--domain', '-A', '--all-fqdns', '-I', '--all-ip-addresses',
]);

export const hostnameCommand: LinuxCommand = {
  name: 'hostname',
  needsNetworkContext: true,
  usage: 'hostname [options] [NEWHOSTNAME]',
  privilege: {
    appliesWhen: (args) => args.some((a) => !a.startsWith('-')),
    deny: Deny.withMessage('hostname: you must be root to change the host name'),
  },
  run(ctx: LinuxCommandContext, args: string[]): string {
    const hn = kernelHostname(ctx.executor.vfs);
    for (const a of args) {
      if (a.startsWith('-') && !VALID_FLAGS.has(a)) return `hostname: unrecognized option: ${a}`;
    }
    if (args.includes('-s') || args.includes('--short')) return hn.split('.')[0];
    if (args.includes('-d') || args.includes('--domain')) return hn.includes('.') ? hn.split('.').slice(1).join('.') : '';
    if (args.includes('-f') || args.includes('--fqdn')) return hn;
    if (args.includes('-i') || args.includes('--ip-address')) return '127.0.1.1';
    if (args.includes('-I') || args.includes('--all-ip-addresses')) return '127.0.1.1';
    if (args.includes('-A') || args.includes('--all-fqdns')) return hn;
    if (args.length > 0 && !args[0].startsWith('-')) {
      ctx.executor.setKernelHostname(args[0]);
      return '';
    }
    return hn;
  },
};
