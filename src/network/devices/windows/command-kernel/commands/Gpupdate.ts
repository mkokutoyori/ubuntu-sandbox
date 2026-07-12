import { BaseCommand } from '@/command-kernel/command/base-command';
import { CommandContext, CommandDescriptor, EXIT_OK, ExitCode } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';

const GPUPDATE_HELP = `Microsoft (R) Windows (R) Operating System Group Policy Update Utility v2.0
(C) Microsoft Corporation. All rights reserved.


Description: Updates multiple Group Policy settings.

Syntax: GPUpdate [/Target:{Computer | User}] [/Force] [/Wait:<value>]
                  [/Logoff] [/Boot] [/Sync]

Parameters :

    Value                       Description
    /Target:{Computer | User}   Specifies that only User or only Computer
                                policy settings are updated.
                                By default, both User and Computer policy
                                settings are updated.

    /Force                      Reapplies all policy settings. By default,
                                only policy settings that have changed are
                                applied.

    /Wait:{value}               Sets the number of seconds to wait for policy
                                processing to finish. The default is 600
                                seconds. The value '0' means not to wait.
                                The value '-1' means to wait indefinitely.

    /Logoff                     Causes a logoff after the Group Policy settings
                                have been updated. This is required for those
                                Group Policy client-side extensions that do not
                                process policy on a background update cycle but
                                that do process policy when a user logs on.
                                Examples include user-targeted Software
                                Installation and Folder Redirection. This option
                                has no effect if there are no extensions called
                                that require a logoff.

    /Boot                       Causes a reboot after the Group Policy settings
                                are applied. This is required for those Group
                                Policy client-side extensions that do not process
                                policy on a background update cycle but that do
                                process policy at computer startup. Examples
                                include computer-targeted Software Installation.
                                This option has no effect if there are no
                                extensions called that require a reboot.

    /Sync                       Causes the next foreground policy application to
                                be done synchronously. Foreground policy
                                applications occur at computer boot and user
                                logon. You can specify this for the user,
                                computer or both using the /Target parameter.
                                The /Force and /Wait parameters will be ignored
                                if specified.`;

/**
 * `gpupdate` — force le rafraîchissement des stratégies de groupe. La
 * mutation réelle (pull LDAP depuis le contrôleur de domaine + application
 * des overrides de politique) est portée par la primitive
 * `machine.domain.gpupdateForce()` ; cette commande ne fait que dispatcher
 * les options et formater le retour console. Hors domaine, `gpupdateForce`
 * échoue proprement (« not joined to a domain ») : aucune fonctionnalité
 * serveur n'est ainsi exposée sur un poste non joint.
 */
export class GpupdateCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'gpupdate',
    summary: 'Actualise les stratégies de groupe (Group Policy)',
    usage: GPUPDATE_HELP,
    args: [{ name: 'targets', type: 'string', required: false, variadic: true, description: 'options gpupdate (/force, /target:...)' }],
    options: [],
    privileges: new DefaultPrivilegePolicy(PrivilegeLevel.ANY),
    category: 'système',
    lenientOptions: true,
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const args = ctx.args.has('targets') ? ctx.args.get<string[]>('targets') : [];
    if (args.some((a) => a === '/?' || a.toLowerCase() === '/help')) {
      await ctx.io.stdout.write(GPUPDATE_HELP + '\n');
      return EXIT_OK;
    }
    if (!ctx.machine.domain) {
      await ctx.io.stdout.write('gpupdate : Group Policy is not supported on this device.\n');
      return 1;
    }

    const result = ctx.machine.domain.gpupdateForce();
    if (!result.ok) {
      await ctx.io.stdout.write(result.message + '\n');
      return 1;
    }

    await ctx.io.stdout.write(
      'Updating policy...\n\n' +
      'Computer Policy update has completed successfully.\n' +
      'User Policy update has completed successfully.\n',
    );
    return EXIT_OK;
  }
}
