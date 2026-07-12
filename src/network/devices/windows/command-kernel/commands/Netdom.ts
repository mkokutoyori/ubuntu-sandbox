import { BaseCommand } from '@/command-kernel/command/base-command';
import { CommandContext, CommandDescriptor, EXIT_OK, ExitCode } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import { DomainApi, DomainTrustDirection } from '@/command-kernel/machine/types';

const NETDOM_HELP = `NETDOM is a command that enables administrators to manage Active Directory
domains and trust relationships from the command prompt.

The syntax of this command is:

NETDOM  operation  [parameters]

Operations:

    NETDOM JOIN      - Joins a workstation or member server to a domain.
    NETDOM TRUST     - Manages or verifies the trust relationship between
                       domains.

NETDOM JOIN <Computer> /Domain:<Domain> [/OU:<OU path>]
    [/UserD:<User> [/PasswordD:[<Password>|*]]]
    [/UserO:<User> [/PasswordO:[<Password>|*]]]
    [/Server:<DomainController>] [/REBoot[:<Time in seconds>]]

NETDOM TRUST <TrustingDomainName> /Domain:<TrustedDomainName>
    [/UserD:<User> [/PasswordD:[<Password>|*]]]
    [/UserO:<User> [/PasswordO:[<Password>|*]]]
    [/Direction:<Direction>] [/Transitive:<Yes|No>]
    [/ADD [/REALm]] [/REMove] [/VERify]

    /Direction accepts INBOUND, OUTBOUND or BIDIRECTIONAL.

NETDOM HELP <operation> - Displays detailed help for an operation.`;

/**
 * `netdom` — équivalent cmd de `Add-Computer -DomainName` (`netdom join`) et
 * `New-ADTrust` (`netdom trust`), même dialogue LDAP réel sous-jacent. Le
 * parsing des options et le formatage console sont portés par la commande ;
 * les mutations (jointure, approbation) restent des primitives device
 * exposées via `machine.domain`. `netdom trust` échoue proprement hors DC
 * — aucune fonctionnalité serveur exposée sur un poste.
 */
export class NetdomCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'netdom',
    summary: 'Gère les jointures de domaine et les relations d\'approbation',
    usage: NETDOM_HELP,
    args: [{ name: 'targets', type: 'string', required: false, variadic: true, description: 'opération netdom (join, trust) et paramètres' }],
    options: [],
    privileges: new DefaultPrivilegePolicy(PrivilegeLevel.ANY),
    category: 'système',
    lenientOptions: true,
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const args = ctx.args.has('targets') ? ctx.args.get<string[]>('targets') : [];
    if (args.length === 0 || args.some((a) => a === '/?' || a.toLowerCase() === '/help' || a.toLowerCase() === 'help')) {
      await ctx.io.stdout.write(NETDOM_HELP + '\n');
      return EXIT_OK;
    }
    const domain = ctx.machine.domain;
    if (!domain) {
      await ctx.io.stdout.write('netdom : domain operations are not supported on this device.\n');
      return 1;
    }

    const sub = args[0].toLowerCase();
    if (sub === 'trust') {
      return this.runTrust(ctx, domain, args.slice(1));
    }
    if (sub === 'join') {
      return this.runJoin(ctx, domain, args.slice(1));
    }
    await ctx.io.stdout.write('NETDOM JOIN /Domain:<Domain> /UserD:<User> /PasswordD:<Password> [/Server:<DC>]\n');
    return 1;
  }

  private async runJoin(ctx: CommandContext, domain: DomainApi, rest: string[]): Promise<ExitCode> {
    const opts = this.parseOptions(rest);
    const domainName = opts.get('domain') ?? '';
    const userD = opts.get('userd') ?? '';
    const passwordD = opts.get('passwordd') ?? '';
    if (!domainName || !userD) {
      await ctx.io.stdout.write('NETDOM JOIN /Domain:<Domain> /UserD:<User> /PasswordD:<Password> [/Server:<DC>]\n');
      return 1;
    }
    const dcAddress = opts.get('server') || domain.resolveDcAddress(domainName) || '';
    if (!dcAddress) {
      await ctx.io.stdout.write('The specified domain either does not exist or could not be contacted.\nThe command failed to complete successfully.\n');
      return 1;
    }
    const result = domain.joinDomain(domainName, dcAddress, userD, passwordD);
    if (!result.ok) {
      await ctx.io.stdout.write(`${result.message}\nThe command failed to complete successfully.\n`);
      return 1;
    }
    await ctx.io.stdout.write(
      `The computer name '${ctx.machine.hostname}' has been successfully joined to the domain '${domainName}'.\nThe command completed successfully.\n`,
    );
    return EXIT_OK;
  }

  private async runTrust(ctx: CommandContext, domain: DomainApi, rest: string[]): Promise<ExitCode> {
    const opts = this.parseOptions(rest);
    const remoteRealm = opts.get('d') ?? '';
    const server = opts.get('server') ?? '';
    const userD = opts.get('userd') ?? '';
    const passwordD = opts.get('passwordd') ?? '';
    const rawDir = opts.get('direction');
    const direction: DomainTrustDirection =
      rawDir === 'Inbound' || rawDir === 'Outbound' || rawDir === 'Bidirectional' ? rawDir : 'Bidirectional';
    const transitive = (opts.get('transitive') ?? '').toLowerCase() !== 'no';

    if (!remoteRealm || !server || !userD) {
      await ctx.io.stdout.write('NETDOM TRUST /d:<RemoteRealm> /Server:<RemoteDC> /UserD:<User> /PasswordD:<Password> [/Direction:<Inbound|Outbound|Bidirectional>] [/Transitive:No]\n');
      return 1;
    }
    const result = domain.establishTrust(remoteRealm, server, direction, transitive, userD, passwordD);
    if (result === null) {
      await ctx.io.stdout.write('The trust could not be established. This computer is not a domain controller.\nThe command failed to complete successfully.\n');
      return 1;
    }
    if (!result.ok) {
      await ctx.io.stdout.write(`${result.message}\nThe command failed to complete successfully.\n`);
      return 1;
    }
    await ctx.io.stdout.write(`The trust with '${remoteRealm}' has been successfully established.\nThe command completed successfully.\n`);
    return EXIT_OK;
  }

  /** Parse les paramètres `/Clé:Valeur` (clé insensible à la casse, valeur préservée). */
  private parseOptions(args: string[]): Map<string, string> {
    const opts = new Map<string, string>();
    for (const arg of args) {
      const m = /^\/([a-z]+):(.*)$/i.exec(arg);
      if (m) opts.set(m[1].toLowerCase(), m[2]);
    }
    return opts;
  }
}
