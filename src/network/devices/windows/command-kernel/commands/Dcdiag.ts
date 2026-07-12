import { BaseCommand } from '@/command-kernel/command/base-command';
import { CommandContext, CommandDescriptor, EXIT_OK, ExitCode } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import { DomainControllerDiagnostics } from '@/command-kernel/machine/types';

const DCDIAG_HELP = `Usage: dcdiag.exe /s:<Directory Server> [/u:<Domain>\\<Username> /p:*|<Password>|""]
                  [/hqv] [/n:<Naming Context>] [/f:<Log>] [/x:<XMLLog.xml>]
                  [/skip:<Test>] [/test:<Test>]

   /h                   Display this help screen.
   /s:<Directory Server> Use <Directory Server> as home server.
   /n:<Naming Context>  Use <Naming Context> as the naming context to test.
   /u:<Domain>\\<Username> Use domain\\username credentials for binding.
   /p:*|<Password>|""   Use <Password> as the password. Use "*" to prompt.
   /a                   Test all the servers in this site.
   /e                   Test all the servers in the entire enterprise.
   /q                   Quiet - Only print error messages.
   /v                   Verbose - Print extended information.
   /i                   Ignore - ignores superfluous error messages.
   /fix                 Fix - Make safe repairs.
   /f:<Log>             Redirect all output to a log file.
   /ferr:<ErrLog>       Redirect fatal error output to a log file.
   /c                   Comprehensive - Run all tests except those disabled.
   /test:<Test>         Test only this test. Required tests are still run.
   /skip:<Test>         Skip the named test.

Tests run: Connectivity, Advertising, NetLogons, SysVolCheck, KdcEvent,
           LocatorCheck.`;

/**
 * `dcdiag` — diagnostic de contrôleur de domaine. L'état de santé provient
 * de la primitive `machine.domain.dcDiagnostics()` (services AD réels,
 * partage SYSVOL) ; le formatage section par section, calqué sur l'outil
 * réel, est porté ici. Sur une machine non promue (`isDc: false`), refuse de
 * s'exécuter — aucun diagnostic serveur ne « passe » sur un poste non DC.
 */
export class DcdiagCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'dcdiag',
    summary: 'Diagnostic de contrôleur de domaine Active Directory',
    usage: DCDIAG_HELP,
    args: [{ name: 'targets', type: 'string', required: false, variadic: true, description: 'options dcdiag (/test:, /s:, ...)' }],
    options: [],
    privileges: new DefaultPrivilegePolicy(PrivilegeLevel.ANY),
    category: 'système',
    lenientOptions: true,
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const args = ctx.args.has('targets') ? ctx.args.get<string[]>('targets') : [];
    if (args.some((a) => a === '/?' || a === '/h' || a.toLowerCase() === '/help')) {
      await ctx.io.stdout.write(DCDIAG_HELP + '\n');
      return EXIT_OK;
    }
    if (!ctx.machine.domain) {
      await ctx.io.stdout.write('dcdiag : Directory Server Diagnosis is not supported on this device.\n');
      return 1;
    }

    const diag = ctx.machine.domain.dcDiagnostics();
    if (!diag.isDc) {
      await ctx.io.stdout.write('Directory Server Diagnosis\n\nDcdiag can only be run on a domain controller.\n');
      return 1;
    }

    await ctx.io.stdout.write(this.formatReport(diag) + '\n');
    return EXIT_OK;
  }

  /** Reproduit la mise en page section par section de `dcdiag`. */
  private formatReport(d: DomainControllerDiagnostics): string {
    const test = (name: string, ok: boolean, server = d.hostname): string =>
      `      Starting test: ${name}\n         ${'.'.repeat(25)} ${server} ${ok ? 'passed' : 'failed'} test ${name}`;

    return [
      'Directory Server Diagnosis',
      '',
      'Performing initial setup:',
      `   * Verifying that the local machine ${d.hostname}, is a DC.`,
      `   * Connecting to directory service on server ${d.hostname}.`,
      '   Done gathering initial info.',
      '',
      'Doing initial required tests',
      '',
      `   Testing server: ${d.siteName}\\${d.hostname}`,
      test('Connectivity', true),
      '',
      'Doing primary tests',
      '',
      `   Testing server: ${d.siteName}\\${d.hostname}`,
      test('Advertising', d.servicesRunning.netlogon),
      test('NetLogons', d.servicesRunning.netlogon),
      test('SysVolCheck', d.sysvolShareExists),
      test('KdcEvent', d.servicesRunning.kdc),
      '',
      `Running enterprise tests on : ${d.dnsName}`,
      test('LocatorCheck', d.servicesRunning.netlogon, d.dnsName),
    ].join('\n');
  }
}
