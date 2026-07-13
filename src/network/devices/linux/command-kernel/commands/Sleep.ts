import { ParsedArgs } from '@/command-kernel/args/parsed-args';
import { BaseCommand } from '@/command-kernel/command/base-command';
import { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel, Session } from '@/command-kernel/session/types';

/** Facteurs de conversion des suffixes de durée en secondes. */
const DURATION_FACTORS: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };

/**
 * `sleep` — suspend l'exécution pendant une durée. Commande **autonome** :
 * l'analyse des opérandes `NOMBRE[s|m|h|d]` (y compris les sommes de
 * plusieurs durées) est implémentée ici, sans dépendance à un module
 * hérité. Le simulateur étant synchrone, la durée calculée n'est pas
 * réellement attendue : seule la validation compte, avec les codes de
 * sortie GNU (1 sur opérande manquant ou invalide, sinon 0).
 */
export class SleepCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'sleep',
    summary: 'Suspend l\'exécution pendant une durée',
    usage: 'sleep NOMBRE[SUFFIXE]...',
    args: [{ name: 'operands', type: 'string', required: false, variadic: true, description: 'durées (NOMBRE[s|m|h|d])' }],
    options: [],
    privileges: new DefaultPrivilegePolicy(PrivilegeLevel.ANY),
    category: 'système',
    lenientOptions: true,
  };

  protected override validate(_args: ParsedArgs, _session: Session): void {
    // Les erreurs d'opérande de `sleep` (« missing operand »,
    // « invalid time interval ») doivent sortir avec le code 1 propre à
    // GNU `sleep` ; elles sont donc rendues dans `execute` plutôt que via
    // `UsageError` (code 2). Rien à valider ici en amont.
  }

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const operands = ctx.args.has('operands') ? ctx.args.get<string[]>('operands') : [];
    const durations = operands.filter((a) => !a.startsWith('-'));
    if (durations.length === 0) {
      await ctx.io.stdout.write('sleep: missing operand\n');
      return 1;
    }
    for (const token of durations) {
      const m = /^(\d+(?:\.\d+)?|\.\d+)([smhd]?)$/.exec(token);
      if (!m) {
        await ctx.io.stdout.write(`sleep: invalid time interval '${token}'\n`);
        return 1;
      }
      // Durée valide : convertie mais non attendue (simulateur synchrone).
      void (Number.parseFloat(m[1]) * DURATION_FACTORS[m[2] || 's']);
    }
    return 0;
  }
}
