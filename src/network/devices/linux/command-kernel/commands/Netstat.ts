import { StreamingCommand } from '@/command-kernel/command/streaming-command';
import { CommandContext, CommandDescriptor, EXIT_OK, ExitCode } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import { cmdNetstat, type NetstatInputs } from '../../LinuxNetCommands';

function wantsContinuous(argv: readonly string[]): boolean {
  return argv.some((a) => a.startsWith('-') && !a.startsWith('--') && a.includes('c'))
    || argv.includes('--continuous');
}

/**
 * `netstat [-r|-i|-s] [-tulpna46] [-c]` — état des connexions, routes,
 * interfaces et statistiques. `-c`/`--continuous` tient le terminal et
 * réaffiche la liste chaque seconde (§14.6) jusqu'à Ctrl+C ; sinon un seul
 * affichage. Accède à l'état réseau uniquement par `ctx.machine.netstat` ;
 * réutilise le rendu partagé `cmdNetstat`.
 */
export class NetstatCommand extends StreamingCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'netstat',
    summary: 'Affiche connexions réseau, tables de routage et statistiques',
    usage: 'netstat [-r|-i|-s] [-tulpna46] [-c]',
    args: [{ name: 'operands', type: 'string', required: false, variadic: true, description: '[options]' }],
    options: [],
    privileges: new DefaultPrivilegePolicy(PrivilegeLevel.ANY),
    category: 'réseau',
    lenientOptions: true,
  };

  private readonly INTERVAL_MS = 1000;

  override isStreaming(argv: readonly string[]): boolean {
    return wantsContinuous(argv);
  }

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const argv = ctx.args.has('operands') ? ctx.args.get<string[]>('operands') : [];
    const inspect = ctx.machine.netstat;
    if (!inspect) {
      await ctx.io.stdout.write('netstat: network inspection unavailable\n');
      return 1;
    }

    const render = (): string => {
      const inputs: NetstatInputs = {
        routes: inspect.routes(),
        interfaces: inspect.interfaces(),
        sockets: inspect.sockets(),
        isServer: inspect.isServer(),
        resolveService: (port, proto) => inspect.resolveService(port, proto),
      };
      return cmdNetstat(argv, inputs);
    };

    // Un seul affichage : pas de `-c`, OU appel programmatique (sans flux
    // terminal vivant) qui ne doit jamais tourner indéfiniment.
    if (!wantsContinuous(argv) || !ctx.io.interaction) {
      await this.emit(ctx, render());
      return EXIT_OK;
    }

    // `-c` : la liste entière est réaffichée chaque seconde jusqu'à Ctrl+C.
    while (!ctx.signal.aborted) {
      await this.emit(ctx, render());
      if (!ctx.signal.aborted) await this.pace(this.INTERVAL_MS, ctx.signal);
    }
    return EXIT_OK;
  }
}
