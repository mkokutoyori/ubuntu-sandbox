import type { LinuxCommand } from '../LinuxCommand';
import { runFuser } from './fuser/FuserEngine';
import { FuserProcHost } from './fuser/FuserProcHost';

export const fuserCommand: LinuxCommand = {
  name: 'fuser',
  needsNetworkContext: true,
  readsStdin: true,
  manSection: 1,
  usage: 'fuser [-fIMuvw] [-a|-s] [-4|-6] [-c|-m|-n SPACE] [-k [-i] [-SIGNAL]] NAME...',
  help: 'Identify processes using files or sockets.',
  options: [
    { flag: '-a', description: 'Display unused files too.' },
    { flag: '-k', description: 'Kill processes accessing the file.' },
    { flag: '-i', description: 'Ask before killing (ignored without -k).' },
    { flag: '-l', description: 'List available signal names.' },
    { flag: '-m', description: 'Show all processes using the named filesystems or block device.' },
    { flag: '-M', description: 'Fulfill request only if NAME is a mount point.' },
    { flag: '-n SPACE', description: 'Search in this name space (file, udp, or tcp).' },
    { flag: '-s', description: 'Silent operation.' },
    { flag: '-u', description: 'Display user IDs.' },
    { flag: '-v', description: 'Verbose output.' },
    { flag: '-w', description: 'Kill only processes with write access.' },
    { flag: '-V', description: 'Display version information.' },
    { flag: '-4', description: 'Search IPv4 sockets only.' },
    { flag: '-6', description: 'Search IPv6 sockets only.' },
  ],
  runWithStatusSync: (ctx, args, stdin) => {
    const outcome = runFuser(new FuserProcHost(ctx, stdin), args);
    return { output: outcome.stdout, stderr: outcome.stderr, interleaved: outcome.interleaved, exitCode: outcome.exitCode };
  },
  run: (ctx, args, stdin) => {
    const outcome = runFuser(new FuserProcHost(ctx, stdin), args);
    return outcome.interleaved.replace(/\n$/, '');
  },
};
