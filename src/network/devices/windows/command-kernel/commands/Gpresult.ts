import { BaseCommand } from '@/command-kernel/command/base-command';
import { CommandContext, CommandDescriptor, EXIT_OK, ExitCode } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import { WindowsGpResult } from '@/command-kernel/machine/types';

const GPRESULT_HELP = `GPRESULT [/S system [/U username [/P [password]]]] [/SCOPE scope]
         [/USER targetusername] [/R | /V | /Z] [(/X | /H) <filename> [/F]]

Description:
    This command line tool displays the Resultant Set of Policy (RSoP)
    information for a target user and computer.

Parameter List:
    /S       system           Specifies the remote system to connect to.

    /U       [domain\\]user    Specifies the user context under which
                              the command should execute.
                              Can not be used with /X, /H.

    /P       [password]       Specifies the password for the given
                              user context. Prompts for input if omitted.
                              Can not be used with /X, /H.

    /SCOPE   scope            Specifies whether the user or the
                              computer settings need to be displayed.
                              Valid values: "USER", "COMPUTER".

    /USER    [domain\\]user    Specifies the user name for which the
                              RSoP data is to be displayed.

    /X       <filename>       Saves the report in XML format at the
                              location and with the file name specified
                              by the <filename> parameter. (valid for
                              Windows Vista SP1 and later)

    /H       <filename>       Saves the report in HTML format at the
                              location and with the file name specified
                              by the <filename> parameter. (valid for
                              Windows Vista SP1 and later)

    /F                        Forces gpresult to overwrite the file name
                              specified in the /X or /H command.

    /R                        Displays RSoP summary data.

    /V                        Specifies that verbose information should
                              be displayed. Verbose information provides
                              additional detailed settings that have been
                              applied with a precedence of 1.

    /Z                        Specifies that the super-verbose information
                              should be displayed. Super-verbose information
                              provides additional detailed settings that
                              have been applied with a precedence of 1 and
                              higher. This allows you to see if a setting was
                              set in multiple places.

    /?                        Displays this help message.

Examples:
    GPRESULT /R
    GPRESULT /H GPReport.html
    GPRESULT /USER targetusername /V
    GPRESULT /S system /USER targetusername /SCOPE COMPUTER /Z
    GPRESULT /S system /U username /P password /SCOPE USER /V`;

/**
 * `gpresult` — affiche le jeu de stratégies résultant (RSoP). L'état typé
 * provient de la primitive `machine.domain.groupPolicyResult()` (`null`
 * hors domaine) ; le formatage texte de la section « COMPUTER SETTINGS »,
 * calqué sur l'outil réel, est porté ici. Hors domaine, le message d'échec
 * standard est renvoyé : aucune fonctionnalité serveur n'est exposée.
 */
export class GpresultCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'gpresult',
    summary: 'Affiche le jeu de stratégies résultant (RSoP)',
    usage: GPRESULT_HELP,
    args: [{ name: 'targets', type: 'string', required: false, variadic: true, description: 'options gpresult (/r, /v, /z, /scope, ...)' }],
    options: [],
    privileges: new DefaultPrivilegePolicy(PrivilegeLevel.ANY),
    category: 'système',
    lenientOptions: true,
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const args = ctx.args.has('targets') ? ctx.args.get<string[]>('targets') : [];
    if (args.some((a) => a === '/?' || a.toLowerCase() === '/help')) {
      await ctx.io.stdout.write(GPRESULT_HELP + '\n');
      return EXIT_OK;
    }
    if (!ctx.machine.domain) {
      await ctx.io.stdout.write('gpresult : Group Policy is not supported on this device.\n');
      return 1;
    }

    const rsop = ctx.machine.domain.groupPolicyResult();
    if (!rsop) {
      await ctx.io.stdout.write(
        'gpresult : The processing of Group Policy failed. This computer is not a member of a domain.\n',
      );
      return 1;
    }

    await ctx.io.stdout.write(this.formatRsop(rsop) + '\n');
    return EXIT_OK;
  }

  /** Reproduit la mise en page section par section de `gpresult /r`. */
  private formatRsop(r: WindowsGpResult): string {
    const lines: string[] = [
      'Microsoft (R) Windows (R) Operating System Group Policy Result tool v2.0',
      'Copyright (C) Microsoft Corp. 1981-2001',
      '',
      `RSOP data for ${r.netbiosName}\\${r.currentUser} on ${r.hostname} : Logging Mode`,
      '-------------------------------------------------------------',
      '',
      'COMPUTER SETTINGS',
      '------------------',
      `    Last time Group Policy was applied: ${r.lastAppliedAt ? r.lastAppliedAt.toString() : 'N/A'}`,
      `    Group Policy was applied from:      ${r.dcAddress}`,
      `    Domain Name:                        ${r.netbiosName}`,
      `    Domain Type:                        Windows Active Directory`,
      '',
      '    Applied Group Policy Objects',
      '    -----------------------------',
    ];
    if (r.appliedGpoNames.length === 0) lines.push('        N/A');
    else for (const name of r.appliedGpoNames) lines.push(`        ${name}`);
    if (r.logonBanner) {
      lines.push('', '    Legal Notice', '    ------------', `        Caption: ${r.logonBanner.title}`, `        Text:    ${r.logonBanner.text}`);
    }
    if (r.startupScript) {
      lines.push('', '    Startup Scripts', '    ---------------', `        ${r.startupScript}`);
    }
    lines.push('', 'USER SETTINGS', '------------------', '    N/A');
    return lines.join('\n');
  }
}
