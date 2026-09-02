import type { LinuxCommand } from '../LinuxCommand';
import type { LinuxCommandContext } from '../LinuxCommandContext';
import { runTcpdump } from '../../network/tcpdump/TcpdumpRunner';
import { makeArgCompleter } from '../completionHelpers';

export const tcpdumpCommand: LinuxCommand = {
  name: 'tcpdump',
  package: 'tcpdump',
  needsNetworkContext: true,
  complete: makeArgCompleter({
    flags: ['-A', '-D', '-X', '-c', '-e', '-i', '-n', '-q', '-r', '-s', '-t',
      '-v', '-w', '-x', '-y'],
    interfacesAfter: ['-i'],
  }),
  manSection: 8,
  usage: 'tcpdump [-AbdDefhHIJKlLnNOpqStuUvxX#] [-c count] [-i interface] [-r file] [-s snaplen] [-w file] [-y datalinktype] [expression]',
  help: 'Dump traffic on a network interface, or read it back from a capture file.',
  options: [
    { flag: '-i', description: 'Listen on this interface.', takesArg: true, argName: 'interface' },
    { flag: '-c', description: 'Exit after receiving this many packets.', takesArg: true, argName: 'count' },
    { flag: '-n', description: 'Do not resolve addresses to names.' },
    { flag: '-e', description: 'Print the link-level header on each line.' },
    { flag: '-q', description: 'Quick, quiet output — less protocol detail.' },
    { flag: '-v', description: 'Verbose output (repeat for more detail: -v, -vv, -vvv).' },
    { flag: '-t', description: 'Suppress/alter timestamp printing (repeat for other formats).' },
    { flag: '-x', description: 'Print each packet in hex.' },
    { flag: '-X', description: 'Print each packet in hex and ASCII.' },
    { flag: '-A', description: 'Print each packet in ASCII.' },
    { flag: '-s', description: 'Snapshot length in bytes.', takesArg: true, argName: 'snaplen' },
    { flag: '-w', description: 'Write raw captured packets to this file.', takesArg: true, argName: 'file' },
    { flag: '-r', description: 'Read packets from this capture file.', takesArg: true, argName: 'file' },
    { flag: '-y', description: 'Set the data link type.', takesArg: true, argName: 'datalinktype' },
    { flag: '-D', description: 'List available interfaces.' },
  ],

  async run(ctx: LinuxCommandContext, args: string[]): Promise<string> {
    const result = await runTcpdump(args, ctx.net.buildTcpdumpDeps());
    return [result.stdout, result.stderr].filter((s) => s.length > 0).join('\n');
  },

  async runWithStatus(ctx: LinuxCommandContext, args: string[]) {
    const result = await runTcpdump(args, ctx.net.buildTcpdumpDeps());
    return { output: result.stdout, exitCode: result.exitCode, stderr: result.stderr };
  },
};
