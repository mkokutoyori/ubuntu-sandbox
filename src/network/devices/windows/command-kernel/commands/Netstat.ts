import { StreamingCommand } from '@/command-kernel/command/streaming-command';
import { CommandContext, CommandDescriptor, EXIT_OK, ExitCode } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';

/**
 * `netstat [-a] [-n] [-r] [intervalle]` — connexions réseau actives.
 * Commande à comportement **défini par ses arguments** (§14.6) : un
 * intervalle final entier positif (`netstat -an 1`) la fait ré-afficher la
 * table toutes les N secondes jusqu'à Ctrl+C — elle est alors *streaming* ;
 * sans intervalle, un seul affichage. `isStreaming(argv)` porte cette
 * décision, si bien que l'entrée terminal générique la route correctement
 * sans intercepteur dédié.
 */
export class NetstatCommand extends StreamingCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'netstat',
    summary: 'Affiche les connexions réseau actives',
    usage: 'netstat [-a] [-n] [-r] [intervalle]',
    args: [{ name: 'targets', type: 'string', required: false, variadic: true, description: 'options netstat [intervalle]' }],
    options: [],
    privileges: new DefaultPrivilegePolicy(PrivilegeLevel.ANY),
    category: 'système',
    // Options groupées façon Windows (`-an`, `-e`…) : atterrissent en
    // positionnels bruts comme `ping`/`arp`, jamais rejetées par le parseur.
    lenientOptions: true,
  };

  override isStreaming(argv: readonly string[]): boolean {
    return this.intervalMs(argv) !== null;
  }

  /** Intervalle de rafraîchissement en ms si le dernier argument est un
   *  entier positif (`netstat … N`), sinon `null`. */
  private intervalMs(argv: readonly string[]): number | null {
    const last = argv[argv.length - 1];
    return last !== undefined && /^[1-9]\d*$/.test(last) ? parseInt(last, 10) * 1000 : null;
  }

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const raw = ctx.args.has('targets') ? ctx.args.get<string[]>('targets') : [];
    const intervalMs = this.intervalMs(raw);
    const flags = intervalMs !== null ? raw.slice(0, -1) : raw;

    do {
      await this.emit(ctx, (await this.render(ctx, flags)).join('\n'));
      if (intervalMs !== null) await this.pace(intervalMs, ctx.signal);
    } while (intervalMs !== null && !ctx.signal.aborted);
    return EXIT_OK;
  }

  private async render(ctx: CommandContext, args: readonly string[]): Promise<string[]> {
    const hasFlag = (ch: string): boolean => args.some((a) => a.startsWith('-') && !a.startsWith('--') && a.includes(ch));

    if (hasFlag('r')) {
      // Route table needs gateway/interface data not yet exposed by
      // `NetworkApi` — prints nothing rather than a wrong table, matching
      // the pre-migration bridge's documented gap.
      return [''];
    }

    const showAll = hasFlag('a');
    const lines: string[] = ['', 'Active Connections', '', '  Proto  Local Address          Foreign Address        State'];

    const sockets = (await ctx.machine.net.connections?.()) ?? [];
    for (const sock of sockets) {
      if (!showAll && sock.state !== 'ESTABLISHED') continue;
      const proto = sock.protocol.toUpperCase();
      const local = `0.0.0.0:${sock.localPort}`.padEnd(22);
      const remote = (sock.state === 'LISTEN' ? '0.0.0.0:0' : `${sock.remoteAddress}:${sock.remotePort}`).padEnd(22);
      const state = sock.state === 'LISTEN' ? 'LISTENING' : sock.state;
      lines.push(`  ${proto.padEnd(7)}${local}${remote}${state}`);
    }
    return lines;
  }
}
