import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { EXIT_OK } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';

const ANY = new DefaultPrivilegePolicy(PrivilegeLevel.ANY);

/**
 * `lsof [-p PID] [-u USER] [-i [proto:][port]]` — reconstruit la table à
 * l'identique de `cmdLsof` : une ligne `cwd` par processus (via
 * `machine.processControl`), puis une ligne par socket ouverte (via
 * `machine.netstat`), même filtrage et même mise en forme colonnes.
 */
export class LsofCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'lsof',
    summary: 'Liste les fichiers et sockets ouverts par les processus',
    usage: 'lsof [-p PID] [-u USER] [-i [proto:][port]]',
    args: [
      { name: 'rest', type: 'string', required: false, variadic: true, description: '-p PID, -u USER, -i spec' },
    ],
    options: [],
    privileges: ANY,
    category: 'linux',
    lenientOptions: true,
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const args = ctx.args.get<string[] | undefined>('rest') ?? [];

    const pIdx = args.indexOf('-p');
    const filterPid = pIdx >= 0 && args[pIdx + 1] ? (parseInt(args[pIdx + 1], 10) || null) : null;

    const uIdx = args.indexOf('-u');
    const filterUser = uIdx >= 0 ? (args[uIdx + 1] ?? null) : null;

    const iIdx = args.indexOf('-i');
    let filterProto: string | undefined, filterPort: number | undefined;
    const hasInetFilter = iIdx >= 0;
    if (hasInetFilter) {
      const spec = args[iIdx + 1] ?? '';
      const portMatch = spec.match(/:(\d+)$/);
      const protoMatch = spec.match(/^(tcp|udp)/i);
      filterProto = protoMatch ? protoMatch[1].toLowerCase() : undefined;
      filterPort = portMatch ? parseInt(portMatch[1], 10) : undefined;
    }

    const lines = ['COMMAND     PID   USER   FD    TYPE DEVICE SIZE/OFF NODE NAME'];
    const procs = ctx.machine.processControl?.list() ?? [];
    let nodeSeq = 10_000;

    for (const p of procs) {
      if (filterPid !== null && p.pid !== filterPid) continue;
      if (filterUser !== null && p.user !== filterUser) continue;
      if (!hasInetFilter) {
        lines.push(`${p.comm.padEnd(10)} ${String(p.pid).padStart(5)}  ${p.user.padEnd(6)} cwd    DIR    8,1     4096    2 ${p.cwd ?? '/'}`);
      }
    }

    const sockets = ctx.machine.netstat?.sockets() ?? [];
    for (const s of sockets) {
      if (filterPid !== null && s.pid !== filterPid) continue;
      if (filterUser !== null) {
        const proc = s.pid ? ctx.machine.processControl?.get(s.pid) : null;
        if (!proc || proc.user !== filterUser) continue;
      }
      if (hasInetFilter) {
        if (filterProto && s.protocol !== filterProto) continue;
        if (filterPort !== undefined && s.localPort !== filterPort) continue;
      }
      const ipv = s.localAddress.includes(':') ? 'IPv6' : 'IPv4';
      const peer = s.state === 'LISTEN' || s.state === 'CLOSED'
        ? '*:*'
        : `${s.remoteAddress}:${s.remotePort}`;
      const target = s.state === 'LISTEN'
        ? `*:${s.localPort} (LISTEN)`
        : `${s.localAddress}:${s.localPort}->${peer} (${s.state})`;
      const comm = (s.processName ?? 'unknown').slice(0, 10);
      const pid = String(s.pid ?? 0).padStart(5);
      const proc = s.pid ? ctx.machine.processControl?.get(s.pid) : null;
      const user = (proc?.user ?? 'root').padEnd(6);
      lines.push(`${comm.padEnd(10)} ${pid}  ${user} ${String((s.id ?? 0) + 3).padStart(3)}u  ${ipv} ${String(nodeSeq++).padStart(5)}      0t0  ${s.protocol.toUpperCase()} ${target}`);
    }

    if (lines.length === 1) {
      if (filterPid !== null) {
        await ctx.io.stdout.write(`lsof: PID ${filterPid}: No such process\n`);
        return EXIT_OK;
      }
      return EXIT_OK;
    }
    await ctx.io.stdout.write(lines.join('\n') + '\n');
    return EXIT_OK;
  }
}
