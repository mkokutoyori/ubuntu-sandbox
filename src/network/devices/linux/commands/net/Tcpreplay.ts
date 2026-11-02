import type { LinuxCommand } from '../LinuxCommand';
import type { LinuxCommandContext } from '../LinuxCommandContext';
import { runTcpreplay, type TcpreplayResult } from '../../network/tcpreplay/TcpreplayRunner';
import { makeArgCompleter } from '../completionHelpers';

function joined(result: TcpreplayResult): string {
  return result.chunks.map((chunk) => chunk.text).join('').replace(/\n$/, '');
}

function shaped(result: TcpreplayResult) {
  const text = (fd: 1 | 2) => result.chunks.filter((chunk) => chunk.fd === fd).map((chunk) => chunk.text).join('').replace(/\n$/, '');
  const chunks = result.chunks.map((chunk, index) => (index === result.chunks.length - 1 ? { fd: chunk.fd, text: chunk.text.replace(/\n$/, '') } : chunk));
  return { output: text(1), stderr: text(2), interleaved: joined(result), chunks, exitCode: result.exitCode };
}

export const tcpreplayCommand: LinuxCommand = {
  name: 'tcpreplay',
  package: 'tcpreplay',
  binaryPath: '/usr/bin/tcpreplay',
  needsNetworkContext: true,
  readsStdin: true,
  ownsHelpOption: true,
  manSection: 1,
  usage: 'tcpreplay [ -<flag> [<val>] | --<name>[{=| }<val>] ]... <pcap_file(s)> | <pcap_dir(s)>',
  help: 'Replay network traffic stored in pcap files.',
  complete: makeArgCompleter({
    flags: ['-d', '-q', '-T', '-v', '-A', '-K', '-c', '-2', '-i', '-I', '-l', '-L', '-x', '-p', '-M', '-t', '-o', '-P', '-V', '-h', '-H'],
    interfacesAfter: ['-i', '-I'],
  }),
  options: [
    { flag: '-i', description: 'Client to server/RX/primary traffic output interface.', takesArg: true, argName: 'intf1' },
    { flag: '-I', description: 'Server to client/TX/secondary traffic output interface.', takesArg: true, argName: 'intf2' },
    { flag: '-l', description: 'Loop through the capture file X times.', takesArg: true, argName: 'loop' },
    { flag: '-L', description: 'Limit the number of packets to send.', takesArg: true, argName: 'limit' },
    { flag: '-t', description: 'Replay packets as fast as possible.' },
    { flag: '-x', description: 'Modify replay speed to a given multiple.', takesArg: true, argName: 'multiplier' },
    { flag: '-p', description: 'Replay packets at a given packets/sec.', takesArg: true, argName: 'pps' },
    { flag: '-M', description: 'Replay packets at a given Mbps.', takesArg: true, argName: 'mbps' },
    { flag: '-o', description: 'Replay one packet at a time for each user input.' },
    { flag: '-K', description: 'Preloads packets into RAM before sending.' },
    { flag: '-v', description: 'Print decoded packets via tcpdump to STDOUT.' },
    { flag: '-2', description: 'Replay two files at a time from a network tap.' },
    { flag: '-c', description: 'Split traffic via a tcpprep cache file.', takesArg: true, argName: 'cachefile' },
    { flag: '-q', description: 'Quiet mode.' },
    { flag: '-V', description: 'Print version information.' },
  ],

  async run(ctx: LinuxCommandContext, args: string[], stdin?: string): Promise<string> {
    return joined(await runTcpreplay(args, ctx.net.buildTcpreplayDeps(stdin)));
  },

  async runWithStatus(ctx: LinuxCommandContext, args: string[], stdin?: string) {
    return shaped(await runTcpreplay(args, ctx.net.buildTcpreplayDeps(stdin)));
  },
};
