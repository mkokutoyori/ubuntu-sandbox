import { BaseCommand } from '@/command-kernel/command/base-command';
import type { CommandContext, CommandDescriptor, ExitCode } from '@/command-kernel/command/types';
import { EXIT_OK } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';

const OP = new DefaultPrivilegePolicy(PrivilegeLevel.OPERATOR);

/**
 * `save` (Huawei VRP, tous équipements — routeur et switch) — feuille
 * standalone. Persistance de la running-config vers la startup-config
 * (équivalent Cisco `write memory`). Le simulateur ne persiste pas de
 * fichier sur disque : la commande retourne le dialogue vendeur exact
 * puis marque succès. La confirmation Y/N est acceptée implicitement
 * (le vrai VRP accepte le prompt vide comme `y`).
 */
export class HuaweiSaveCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'save',
    summary: 'Save current configuration',
    usage: 'save',
    args: [],
    options: [],
    privileges: OP,
    category: 'router',
  };
  readonly allowedModes = ['user-view', 'system-view'];

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const lines = [
      'The current configuration will be written to the device.',
      'Info: Please input the file name ( *.cfg, *.zip ) [vrpcfg.zip]:vrpcfg.zip',
      'Now saving the current configuration to the slot.',
      'Save the configuration successfully.',
    ];
    await ctx.io.stdout.write(`${lines.join('\n')}\n`);
    return EXIT_OK;
  }
}
