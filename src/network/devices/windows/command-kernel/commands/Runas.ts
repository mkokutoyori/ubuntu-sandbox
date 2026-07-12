import { BaseCommand } from '@/command-kernel/command/base-command';
import { CommandContext, CommandDescriptor, EXIT_OK, ExitCode } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import { parseRunasArgs, validateRunasUser } from '@/network/devices/windows/WinRunas';

const RUNAS_HELP = `RUNAS USAGE:

RUNAS [ [/noprofile | /profile] [/env] [/savecred | /netonly] ]
        /user:<UserName> program

RUNAS [ [/noprofile | /profile] [/env] [/savecred] ]
        /smartcard [/user:<UserName>] program

RUNAS [ [/noprofile | /profile] [/env] [/netonly] ]
        /trustlevel:<Level> program

   /noprofile        specifies that the user's profile should not be loaded.
                     This causes the application to load more quickly, but
                     can cause some applications to malfunction.
   /profile          specifies that the user's profile should be loaded.
                     This is the default.
   /env              to use current environment instead of user's.
   /netonly          use if the credentials specified are for remote
                     access only.
   /savecred         to use credentials previously saved by the user.
                     This option is not available on Windows 7 Home or
                     Windows 7 Starter Editions and will be ignored.
   /smartcard        use if the credentials are to be supplied from a
                     smartcard.
   /user             <UserName> should be in form USER@DOMAIN or DOMAIN\\USER
   /showtrustlevels  displays the trust levels that can be used as arguments
                     to /trustlevel.
   /trustlevel       <Level> should be one of levels enumerated
                     in /showtrustlevels.

   Example:
   > runas /noprofile /user:mymachine\\administrator cmd
   > runas /profile /env /user:mydomain\\admin "mmc %windir%\\system32\\dsa.msc"
   > runas /env /user:user@domain.microsoft.com "notepad \\"my file.txt\\""

   NOTE:  Enter user's password only when prompted.
   NOTE:  /profile is not compatible with /netonly.
   NOTE:  /savecred is not compatible with /smartcard.`;

/**
 * `runas` — chemin non-interactif (`device.executeCommand('runas …')`, sans
 * terminal pour demander le mot de passe : pas de vérification, comme
 * l'ancienne `WindowsPC.cmdRunas`). Le vrai prompt masqué vérifié vit dans
 * `WindowsTerminalSession` et n'est pas touché ici.
 *
 * Le parsing (`parseRunasArgs`) et la validation (`validateRunasUser`) sont
 * des helpers purs partagés avec le chemin terminal ; le changement
 * d'identité et la ré-entrée récursive du shell sont délégués à la primitive
 * device `machine.runAs.runCommandAs`.
 */
export class RunasCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'runas',
    summary: 'Exécute un programme sous une autre identité',
    usage: RUNAS_HELP,
    args: [{ name: 'targets', type: 'string', required: false, variadic: true, description: '[/netonly] [/savecred] /user:<UserName> program' }],
    options: [],
    privileges: new DefaultPrivilegePolicy(PrivilegeLevel.ANY),
    category: 'système',
    lenientOptions: true,
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const args = ctx.args.has('targets') ? ctx.args.get<string[]>('targets') : [];
    if (args.some((a) => a === '/?')) {
      await ctx.io.stdout.write(RUNAS_HELP + '\n');
      return EXIT_OK;
    }
    const runAs = ctx.machine.runAs;
    if (!runAs) {
      await ctx.io.stdout.write('runas : identity elevation is not supported on this device.\n');
      return 1;
    }

    const parsed = parseRunasArgs(args);
    if (parsed.ok === false) {
      await ctx.io.stdout.write(parsed.error + '\n');
      return 1;
    }
    const { userName, command, netOnly } = parsed.invocation;

    // `/netonly` : sémantique réelle simplifiée à « exécuter en tant que
    // l'appelant » (le compte cible n'est jamais vérifié ni activé localement).
    if (netOnly) {
      const out = await runAs.runCommandAs(runAs.currentUser(), command);
      await ctx.io.stdout.write(out + '\n');
      return EXIT_OK;
    }

    const validation = validateRunasUser(runAs, userName);
    if (validation.ok === false) {
      await ctx.io.stdout.write(validation.error + '\n');
      return 1;
    }

    const out = await runAs.runCommandAs(userName, command);
    await ctx.io.stdout.write(out + '\n');
    return EXIT_OK;
  }
}
