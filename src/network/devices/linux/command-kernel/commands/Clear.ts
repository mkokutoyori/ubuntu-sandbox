import { ParsedArgs } from '@/command-kernel/args/parsed-args';
import { BaseCommand } from '@/command-kernel/command/base-command';
import { CommandContext, CommandDescriptor, EXIT_OK, ExitCode } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel, Session } from '@/command-kernel/session/types';

/** Séquence ANSI effaçant l'écran et ramenant le curseur en haut à gauche. */
const CLEAR_SEQUENCE = '\x1b[2J\x1b[H';

/**
 * `clear` — efface l'écran du terminal (émet la séquence ANSI
 * « effacer + curseur origine »). Aucun état machine requis.
 */
export class ClearCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'clear',
    summary: 'Efface l\'écran du terminal',
    usage: 'clear',
    args: [{ name: 'operands', type: 'string', required: false, variadic: true, description: 'ignoré' }],
    options: [],
    privileges: new DefaultPrivilegePolicy(PrivilegeLevel.ANY),
    category: 'système',
    lenientOptions: true,
  };

  protected override validate(_args: ParsedArgs, _session: Session): void {
    // `clear` ignore tout argument (comme GNU coreutils) : rien à valider.
  }

  async execute(ctx: CommandContext): Promise<ExitCode> {
    await ctx.io.stdout.write(CLEAR_SEQUENCE);
    return EXIT_OK;
  }
}

/** `reset` — réinitialise le terminal ; ici équivalent visuel de `clear`. */
export class ResetCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'reset',
    summary: 'Réinitialise le terminal',
    usage: 'reset',
    args: [{ name: 'operands', type: 'string', required: false, variadic: true, description: 'ignoré' }],
    options: [],
    privileges: new DefaultPrivilegePolicy(PrivilegeLevel.ANY),
    category: 'système',
    lenientOptions: true,
  };

  protected override validate(_args: ParsedArgs, _session: Session): void {
    // `reset` ignore tout argument : rien à valider.
  }

  async execute(ctx: CommandContext): Promise<ExitCode> {
    await ctx.io.stdout.write(CLEAR_SEQUENCE);
    return EXIT_OK;
  }
}
