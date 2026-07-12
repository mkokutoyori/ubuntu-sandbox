import { BaseCommand } from '@/command-kernel/command/base-command';
import { CommandContext, CommandDescriptor, EXIT_OK, ExitCode } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';

const SLMGR_HELP = `Windows Software Licensing Management Tool

Usage: slmgr.vbs [<ComputerName> [<User> <Password>]] [<Options>]

Global options:
  /ipk <ProductKey>            Install product key (replaces existing key)
  /ato [Activation ID]         Activate Windows
  /dli [Activation ID | All]   Display license information (default: current
                               license)
  /dlv [Activation ID | All]   Display detailed license information
  /xpr [Activation ID]         Expiration date for current license state

Advanced options:
  /cpky                        Clear product key from the registry
  /ilc <License file>          Install license
  /rilc                        Re-install system license files
  /rearm                       Reset the licensing status of the machine
  /upk [Activation ID]         Uninstall product key`;

/**
 * `slmgr` / `slmgr.vbs` — Software Licensing Management Tool. Le parsing et
 * le formatage sont portés par la commande ; l'état d'activation
 * (`installProductKey`/`activate`/lecture) est une capacité device exposée
 * via `machine.licensing`. Présent sur tous les SKU Windows.
 */
export class SlmgrCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'slmgr',
    summary: 'Outil de gestion des licences logicielles Windows',
    usage: SLMGR_HELP,
    args: [{ name: 'targets', type: 'string', required: false, variadic: true, description: 'options slmgr (/ipk, /ato, /dlv, /dli)' }],
    options: [],
    privileges: new DefaultPrivilegePolicy(PrivilegeLevel.ANY),
    category: 'système',
    lenientOptions: true,
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const args = ctx.args.has('targets') ? ctx.args.get<string[]>('targets') : [];
    if (args.some((a) => a === '/?' || a.toLowerCase() === '/help' || a.toLowerCase() === '/h')) {
      await ctx.io.stdout.write(SLMGR_HELP + '\n');
      return EXIT_OK;
    }
    const licensing = ctx.machine.licensing;
    if (!licensing) {
      await ctx.io.stdout.write('slmgr : Software Licensing is not supported on this device.\n');
      return 1;
    }

    const flag = args[0];
    if (flag === '/ipk') {
      const result = licensing.installProductKey(args[1] ?? '');
      await ctx.io.stdout.write(result.message + '\n');
      return result.ok ? EXIT_OK : 1;
    }
    if (flag === '/ato') {
      const result = licensing.activate();
      await ctx.io.stdout.write(result.message + '\n');
      return result.ok ? EXIT_OK : 1;
    }
    if (flag === '/dlv' || flag === '/dli') {
      const key = licensing.productKey();
      const partial = key ? key.slice(-5) : '';
      const lines = [
        `Name: ${ctx.machine.os.prettyName}`,
        `Description: ${ctx.machine.os.prettyName} edition`,
        `Partial Product Key: ${partial}`,
        `License Status: ${licensing.state()}`,
      ];
      await ctx.io.stdout.write(lines.join('\n') + '\n');
      return EXIT_OK;
    }

    await ctx.io.stdout.write('Usage: slmgr.vbs [/ipk <ProductKey> | /ato | /dlv | /dli]\n');
    return 1;
  }
}
