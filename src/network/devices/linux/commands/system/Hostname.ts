import type { LinuxCommand } from '../LinuxCommand';
import type { LinuxCommandContext } from '../LinuxCommandContext';

const VALID_FLAGS = new Set([
  '-s', '--short', '-f', '--fqdn', '-i', '--ip-address',
  '-d', '--domain', '-A', '--all-fqdns', '-I', '--all-ip-addresses',
]);

export const hostnameCommand: LinuxCommand = {
  name: 'hostname',
  needsNetworkContext: true,
  usage: 'hostname [options] [NEWHOSTNAME]',
  run(ctx: LinuxCommandContext, args: string[]): string {
    const hn = (ctx.executor.vfs.readFile('/etc/hostname') ?? 'localhost').trim();
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
      ctx.executor.vfs.writeFile('/etc/hostname', args[0] + '\n', 0, 0, 0o022);
      return '';
    }
    return hn;
  },
};
