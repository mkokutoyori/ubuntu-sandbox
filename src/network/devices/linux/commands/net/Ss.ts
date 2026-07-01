/**
 * `ss` — socket statistics (iproute2), replacement for `netstat`.
 *
 * Rendering lives in `cmdSs` (LinuxNetCommands.ts) — this file only wires
 * a `LinuxCommand` onto the narrow context (socket table + NSS service
 * name/port resolution), matching the extraction pattern used by
 * `route`/`ifconfig`/`nmap` (see `linux_gap.md` §8.4/§9). Previously this
 * command lived as a `case 'ss':` branch inside `LinuxCommandExecutor`.
 */

import type { LinuxCommand } from '../LinuxCommand';
import type { LinuxCommandContext } from '../LinuxCommandContext';
import { cmdSs } from '../../LinuxNetCommands';

export const ssCommand: LinuxCommand = {
  name: 'ss',
  needsNetworkContext: true,
  manSection: 8,
  usage: 'ss [-t] [-u] [-l] [-a] [-n] [-p] [-4] [-6] [-s] [state STATE] [FILTER]',
  help: 'Investigate sockets (modern replacement for netstat).',
  options: [
    { flag: '-t', description: 'Show TCP sockets.' },
    { flag: '-u', description: 'Show UDP sockets.' },
    { flag: '-l', description: 'Show only listening sockets.' },
    { flag: '-a', description: 'Show all sockets (listening and non-listening).' },
    { flag: '-n', description: 'Do not resolve service names.' },
    { flag: '-p', description: 'Show the process using each socket.' },
    { flag: '-4', description: 'Show only IPv4 sockets.' },
    { flag: '-6', description: 'Show only IPv6 sockets.' },
    { flag: '-s', description: 'Print summary statistics.' },
  ],

  run(ctx: LinuxCommandContext, args: string[]): string {
    return cmdSs(
      args,
      ctx.profile.isServer,
      ctx.executor.getSocketTable(),
      (port, proto) => ctx.executor.resolveServiceName(port, proto),
      (name) => ctx.executor.resolveServicePort(name),
    );
  },
};
