import type { LinuxCommand } from '../LinuxCommand';
import type { LinuxCommandContext } from '../LinuxCommandContext';
import { makeArgCompleter } from '../completionHelpers';
import { reverseNameOf } from '../../network/ReverseName';
import { TCP_CONGESTION_ALGORITHM } from '@/network/tcp/TcpCongestionControl';
import { runSs, type SsHost } from './ss/SsRun';

const LOCAL_PORT_RANGE_FILE = '/proc/sys/net/ipv4/ip_local_port_range';
const FALLBACK_EPHEMERAL = { low: 1024, high: 4999 };
const DEFAULT_SCREEN_COLUMNS = 80;

function ephemeralPortsOf(ctx: LinuxCommandContext): { low: number; high: number } {
  const text = ctx.executor.vfs.readFile(LOCAL_PORT_RANGE_FILE);
  const [low, high] = (text ?? '').trim().split(/\s+/).map(Number);
  return Number.isFinite(low) && Number.isFinite(high) ? { low, high } : FALLBACK_EPHEMERAL;
}

function hostOf(ctx: LinuxCommandContext, stdin: string | undefined): SsHost {
  const { executor } = ctx;
  return {
    rows: () => executor.kernelSocketRows(),
    procFile: (path) => executor.vfs.readFile(path),
    destroy: (row) => executor.destroySocket(row),
    screenWidth: () => (ctx.outputPiped === true ? null : executor.terminalColumns() ?? DEFAULT_SCREEN_COLUMNS),
    hostName: (address) => reverseNameOf(executor.nss, address),
    serviceName: (port, protocol) => executor.resolveServiceName(port, protocol),
    ephemeralPorts: () => ephemeralPortsOf(ctx),
    cgroupOf: (pid) => executor.cgroupPathFor(pid),
    cookieOf: (socketId) => executor.socketCookies.of(socketId),
    defaultCongestionControl: () => TCP_CONGESTION_ALGORITHM,
    canInspectProcessOf: (uid) => executor.userMgr.currentUid === 0 || executor.userMgr.currentUid === uid,
    servicePort: (name, protocol) => executor.resolveServicePort(name, protocol),
    hostAddresses: (name) => executor.resolveHostAddresses(name),
    interfaceIndex: (name) => (ctx.net.getPorts().has(name) ? ctx.net.getIfIndex(name) : null),
    readFilterFile: (path) => executor.readFile(path),
    stdin,
    namespaceExists: (name) => ctx.netns?.list().includes(name) === true,
  };
}

function withoutFinalNewline(text: string): string {
  return text.endsWith('\n') ? text.slice(0, -1) : text;
}

function execute(ctx: LinuxCommandContext, args: string[], stdin: string | undefined) {
  const result = runSs(args, hostOf(ctx, stdin));
  return {
    output: withoutFinalNewline(result.stdout),
    exitCode: result.exitCode,
    stderr: withoutFinalNewline(result.stderr),
  };
}

export const ssCommand: LinuxCommand = {
  name: 'ss',
  needsNetworkContext: true,
  readsStdin: true,
  ownsHelpOption: true,
  complete: makeArgCompleter({
    flags: [
      '-4', '-6', '-a', '-e', '-H', '-i', '-K', '-l', '-n', '-O', '-o', '-p', '-r', '-s', '-t', '-u', '-w', '-x',
      '--tos', '--cgroup', '--inet-sockopt', 'state', 'exclude', 'dst', 'src', 'dport', 'sport',
    ],
  }),
  manSection: 8,
  usage: 'ss [ OPTIONS ] [ FILTER ]',
  help: 'Another utility to investigate sockets.',
  options: [
    { flag: '-n', aliases: ['--numeric'], description: "Do not try to resolve service names." },
    { flag: '-r', aliases: ['--resolve'], description: 'Try to resolve numeric address/ports.' },
    { flag: '-a', aliases: ['--all'], description: 'Display both listening and non-listening sockets.' },
    { flag: '-l', aliases: ['--listening'], description: 'Display only listening sockets.' },
    { flag: '-o', aliases: ['--options'], description: 'Show timer information.' },
    { flag: '-e', aliases: ['--extended'], description: 'Show detailed socket information.' },
    { flag: '-p', aliases: ['--processes'], description: 'Show process using socket.' },
    { flag: '-i', aliases: ['--info'], description: 'Show internal TCP information.' },
    { flag: '-s', aliases: ['--summary'], description: 'Print summary statistics.' },
    { flag: '-H', aliases: ['--no-header'], description: 'Suppress header line.' },
    { flag: '-O', aliases: ['--oneline'], description: "Print each socket's data on a single line." },
    { flag: '-K', aliases: ['--kill'], description: 'Forcibly close sockets, display what was closed.' },
    { flag: '-4', aliases: ['--ipv4'], description: 'Display only IP version 4 sockets.' },
    { flag: '-6', aliases: ['--ipv6'], description: 'Display only IP version 6 sockets.' },
    { flag: '-t', aliases: ['--tcp'], description: 'Display TCP sockets.' },
    { flag: '-u', aliases: ['--udp'], description: 'Display UDP sockets.' },
    { flag: '-w', aliases: ['--raw'], description: 'Display RAW sockets.' },
    { flag: '-x', aliases: ['--unix'], description: 'Display Unix domain sockets.' },
    { flag: '-f', aliases: ['--family'], takesArg: true, argName: 'FAMILY', description: 'Display sockets of type FAMILY.' },
    { flag: '-A', aliases: ['--query', '--socket'], takesArg: true, argName: 'QUERY', description: 'List of socket tables to dump.' },
    { flag: '-F', aliases: ['--filter'], takesArg: true, argName: 'FILE', description: 'Read filter information from FILE.' },
    { flag: '--tos', description: 'Show tos and priority information.' },
    { flag: '--cgroup', description: 'Show cgroup information.' },
    { flag: '--inet-sockopt', description: 'Show various inet socket options.' },
  ],

  run(ctx: LinuxCommandContext, args: string[], stdin?: string): string {
    const result = execute(ctx, args, stdin);
    return result.stderr === '' ? result.output : [result.output, result.stderr].filter(Boolean).join('\n');
  },

  runWithStatusSync(ctx: LinuxCommandContext, args: string[], stdin?: string) {
    return execute(ctx, args, stdin);
  },
};
