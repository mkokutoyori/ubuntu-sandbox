import { BaseCommand } from '@/command-kernel/command/base-command';
import { CommandContext, CommandDescriptor, EXIT_OK, ExitCode } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';

const NLTEST_HELP = `Usage: nltest [/OPTIONS]

/DSGETDC:<DomainName> - Call DsGetDcName
    /FORCE - Bypass the DC cache
    /GC - Locate a Global Catalog server
    /KDC - Locate a KDC server
    /PDC - Locate the Primary Domain Controller
    /DS - Return a DS-enabled DC
    /IP - Return the IP address of the DC
    /SITE:<Site> - Locate a DC in the named site
/DSGETDCNAME:<DomainName> - Call DsGetDcName (verbose)
/DCLIST:<DomainName> - Get list of DC's for a domain
/DCNAME:<DomainName> - Get the PDC name for a domain
/SC_QUERY:<DomainName> - Query secure channel for <Domain>
/SC_RESET:<DomainName>[\\<DCName>] - Reset secure channel
/SC_VERIFY:<DomainName> - Verify secure channel for <Domain>
/DOMAIN_TRUSTS - Query the domain trusts
/USER:<UserName> - Query User info on a domain controller

Status of the operation is reported as:
    The command completed successfully
    Getting DC name failed: Status = <code>`;

/**
 * `nltest` — outils de diagnostic Netlogon. Seul `/dsgetdc:<domaine>` est
 * implémenté (localisation d'un DC via `machine.domain.locateDomainController`,
 * qui effectue une vraie sonde réseau TCP/389). Hors domaine ou pour un
 * domaine non joint, échoue proprement (`ERROR_NO_SUCH_DOMAIN`) — aucune
 * fonctionnalité serveur exposée.
 */
export class NltestCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'nltest',
    summary: 'Diagnostic Netlogon / localisation de contrôleur de domaine',
    usage: NLTEST_HELP,
    args: [{ name: 'targets', type: 'string', required: false, variadic: true, description: 'options nltest (/dsgetdc:<domaine>, ...)' }],
    options: [],
    privileges: new DefaultPrivilegePolicy(PrivilegeLevel.ANY),
    category: 'système',
    lenientOptions: true,
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const args = ctx.args.has('targets') ? ctx.args.get<string[]>('targets') : [];
    if (args.some((a) => a === '/?' || a.toLowerCase() === '/help')) {
      await ctx.io.stdout.write(NLTEST_HELP + '\n');
      return EXIT_OK;
    }
    if (!ctx.machine.domain) {
      await ctx.io.stdout.write('nltest : Netlogon diagnostics are not supported on this device.\n');
      return 1;
    }

    const dsgetdc = args.find((a) => a.toLowerCase().startsWith('/dsgetdc:'));
    if (!dsgetdc) {
      await ctx.io.stdout.write('NLTEST usage: NLTEST [/DSGETDC:domain]\n');
      return 1;
    }

    const domain = dsgetdc.slice('/dsgetdc:'.length);
    const loc = ctx.machine.domain.locateDomainController(domain);
    if (!loc.ok) {
      const msg = loc.reason === 'no-such-domain'
        ? 'Getting DC name failed: Status = 1355 0x54b ERROR_NO_SUCH_DOMAIN'
        : 'Getting DC name failed: Status = 1722 0x6ba RPC_S_SERVER_UNAVAILABLE';
      await ctx.io.stdout.write(msg + '\n');
      return 1;
    }

    const out = [
      `           DC: \\\\${loc.dcAddress}`,
      `      Address: \\\\${loc.dcAddress}`,
      `     Dom Name: ${loc.dnsName}`,
      ` Dc Site Name: ${loc.siteName}`,
      `The command completed successfully`,
    ].join('\n');
    await ctx.io.stdout.write(out + '\n');
    return EXIT_OK;
  }
}
