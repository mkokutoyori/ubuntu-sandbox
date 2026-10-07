import type { LinuxCommand } from '../LinuxCommand';
import type { LinuxCommandContext } from '../LinuxCommandContext';
import { makeArgCompleter } from '../completionHelpers';
import { reverseNameOf } from '../../network/ReverseName';
import type { NssPasswdEntry } from '../../nss/types';
import { runNetstat, type NetstatHost } from './netstat/NetstatRun';

const PROGRAM_NAME_LENGTH = 19;

interface ProgramTable {
  readonly byInode: ReadonlyMap<number, string>;
  readonly notice: string;
}

function programNameOf(arguments0: string): string {
  return arguments0.startsWith('/') ? arguments0.slice(arguments0.lastIndexOf('/') + 1) : arguments0;
}

function loadPrograms(ctx: LinuxCommandContext): ProgramTable {
  const { executor } = ctx;
  const currentUid = executor.userMgr.currentUid;
  const byInode = new Map<number, string>();
  const owned = executor.kernelSocketRows()
    .filter((row) => row.owner !== null && row.owner.fd !== null)
    .sort((a, b) => (a.owner?.pid ?? 0) - (b.owner?.pid ?? 0) || (a.owner?.fd ?? 0) - (b.owner?.fd ?? 0));
  for (const row of owned) {
    const owner = row.owner;
    if (owner === null || byInode.has(row.entry.id)) continue;
    if (currentUid !== 0 && owner.uid !== currentUid) continue;
    const process = executor.processMgr.get(owner.pid);
    const name = row.entry.processName ?? programNameOf(process?.command.split(/\s+/)[0] ?? owner.name);
    byInode.set(row.entry.id, `${owner.pid}/${name}`.slice(0, PROGRAM_NAME_LENGTH));
  }
  const denied = currentUid !== 0 && executor.processMgr.list().some((process) => process.uid !== currentUid);
  let notice = '';
  if (denied) {
    notice = byInode.size === 0
      ? `(No info could be read for "-p": geteuid()=${currentUid} but you should be root.)\n`
      : '(Not all processes could be identified, non-owned process info\n will not be shown, you would have to be root to see it all.)\n';
  }
  return { byInode, notice };
}

function hostOf(ctx: LinuxCommandContext): NetstatHost {
  const { executor } = ctx;
  let programs: ProgramTable | null = null;
  const table = (): ProgramTable => (programs ??= loadPrograms(ctx));
  return {
    procFile: (path) => executor.vfs.readFile(path),
    hostName: (address) => reverseNameOf(executor.nss, address),
    serviceName: (port, protocol) => executor.resolveServiceName(port, protocol),
    userName: (uid) => {
      const result = executor.nss.lookup<NssPasswdEntry>('passwd', (source) => source.getpwuid?.(uid));
      return result.status === 'SUCCESS' && result.entry ? result.entry.name : null;
    },
    programOf: (inode) => table().byInode.get(inode) ?? null,
    programNotice: () => table().notice,
    routes: () => executor.netstatTable('routes'),
    interfaces: () => executor.netstatTable('interfaces'),
    statistics: () => executor.netstatTable('statistics'),
  };
}

function withoutFinalNewline(text: string): string {
  return text.endsWith('\n') ? text.slice(0, -1) : text;
}

function execute(ctx: LinuxCommandContext, args: string[]) {
  const result = runNetstat(args, hostOf(ctx));
  return {
    output: withoutFinalNewline(result.stdout),
    exitCode: result.exitCode,
    stderr: withoutFinalNewline(result.stderr),
    stderrFirst: result.stderrFirst === true,
  };
}

export const netstatCommand: LinuxCommand = {
  name: 'netstat',
  needsNetworkContext: true,
  ownsHelpOption: true,
  package: 'net-tools',
  complete: makeArgCompleter({
    flags: ['-a', '-c', '-e', '-g', '-i', '-l', '-M', '-n', '-o', '-p', '-r', '-s', '-t', '-u', '-U', '-v', '-W', '-w', '-x', '-4', '-6'],
  }),
  manSection: 8,
  usage: 'netstat [-vWnNcaeol] [<Socket> ...]',
  help: 'Print network connections, routing tables, interface statistics, masquerade connections, and multicast memberships.',
  options: [
    { flag: '-r', aliases: ['--route'], description: 'Display the kernel routing tables.' },
    { flag: '-i', aliases: ['--interfaces'], description: 'Display a table of all network interfaces.' },
    { flag: '-s', aliases: ['--statistics'], description: 'Display summary statistics for each protocol.' },
    { flag: '-n', aliases: ['--numeric'], description: 'Show numerical addresses instead of trying to determine symbolic host, port or user names.' },
    { flag: '-W', aliases: ['--wide'], description: "Do not truncate IP addresses." },
    { flag: '-e', aliases: ['--extend'], description: 'Display additional information.' },
    { flag: '-p', aliases: ['--programs'], description: 'Show the PID and name of the program to which each socket belongs.' },
    { flag: '-o', aliases: ['--timers'], description: 'Include information related to networking timers.' },
    { flag: '-l', aliases: ['--listening'], description: 'Show only listening sockets.' },
    { flag: '-a', aliases: ['--all'], description: 'Show both listening and non-listening sockets.' },
    { flag: '-t', aliases: ['--tcp'], description: 'Show TCP sockets.' },
    { flag: '-u', aliases: ['--udp'], description: 'Show UDP sockets.' },
    { flag: '-U', aliases: ['--udplite'], description: 'Show UDP-Lite sockets.' },
    { flag: '-w', aliases: ['--raw'], description: 'Show RAW sockets.' },
    { flag: '-x', aliases: ['--unix'], description: 'Show Unix domain sockets.' },
    { flag: '-4', description: 'Show IPv4 sockets only.' },
    { flag: '-6', description: 'Show IPv6 sockets only.' },
  ],

  run(ctx: LinuxCommandContext, args: string[]): string {
    const result = execute(ctx, args);
    if (result.stderr === '') return result.output;
    return (result.stderrFirst ? [result.stderr, result.output] : [result.output, result.stderr])
      .filter(Boolean).join('\n');
  },

  runWithStatusSync(ctx: LinuxCommandContext, args: string[]) {
    const { output, exitCode, stderr, stderrFirst } = execute(ctx, args);
    if (!stderrFirst || stderr === '') return { output, exitCode, stderr };
    return { output, exitCode, stderr, interleaved: [stderr, output].filter(Boolean).join('\n') };
  },
};
