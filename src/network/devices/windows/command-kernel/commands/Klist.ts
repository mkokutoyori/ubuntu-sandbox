import { BaseCommand } from '@/command-kernel/command/base-command';
import { CommandContext, CommandDescriptor, EXIT_OK, ExitCode } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import { KerberosCachedTicket } from '@/command-kernel/machine/types';

const KLIST_HELP = `Usage: klist [-lh <LogonId.HighPart>] [-li <LogonId.LowPart>]
             [tickets | tgt | purge | sessions | kcd_cache | get | add_bind |
              query_bind | purge_bind]

    tickets     - List all cached tickets (default)
    tgt         - List the initial Kerberos TGT
    purge       - Purge all cached tickets for the current logon session
    sessions    - List cached logon sessions
    kcd_cache   - Display the Kerberos constrained delegation cache
    get         - Get a ticket to the specified target
    add_bind    - Add a preferred DC binding for a domain
    query_bind  - Query the preferred DC binding cache
    purge_bind  - Purge the preferred DC binding cache

    -lh and -li together specify the LogonId of the session whose ticket
    cache is to be queried. If neither is specified, the current logon
    session's ticket cache is used.`;

/**
 * `klist` — affiche le cache de tickets Kerberos. L'état typé provient de
 * la primitive `machine.domain.kerberosTickets()` (alimentée par un vrai
 * échange AS/TGS lors du logon domaine) ; le formatage texte, calqué sur
 * l'outil réel, est porté ici. Cache vide tant qu'aucun logon domaine n'a
 * eu lieu — aucune fonctionnalité serveur exposée.
 */
export class KlistCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'klist',
    summary: 'Affiche le cache de tickets Kerberos',
    usage: KLIST_HELP,
    args: [{ name: 'targets', type: 'string', required: false, variadic: true, description: 'sous-commande/options klist' }],
    options: [],
    privileges: new DefaultPrivilegePolicy(PrivilegeLevel.ANY),
    category: 'système',
    lenientOptions: true,
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const args = ctx.args.has('targets') ? ctx.args.get<string[]>('targets') : [];
    if (args.some((a) => a === '/?' || a === '-?' || a.toLowerCase() === '/help')) {
      await ctx.io.stdout.write(KLIST_HELP + '\n');
      return EXIT_OK;
    }
    if (!ctx.machine.domain) {
      await ctx.io.stdout.write('klist : Kerberos is not supported on this device.\n');
      return 1;
    }

    const tickets = ctx.machine.domain.kerberosTickets();
    await ctx.io.stdout.write(this.formatTickets(tickets) + '\n');
    return EXIT_OK;
  }

  /** Reproduit la mise en page de `klist` (une entrée `#n>` par ticket). */
  private formatTickets(tickets: readonly KerberosCachedTicket[]): string {
    if (tickets.length === 0) {
      return 'Current LogonId is 0:0x3e7\n\nCached Tickets: (0)\n';
    }
    const lines = ['Current LogonId is 0:0x186a5', '', `Cached Tickets: (${tickets.length})`, ''];
    tickets.forEach((t, i) => {
      lines.push(
        `#${i}>     Client: ${t.clientPrincipal}`,
        `        Server: ${t.serverPrincipal}`,
        `        KerbTicket Encryption Type: AES-256-CTS-HMAC-SHA1-96`,
        `        Ticket Flags ${t.flagsHex} -> ${t.flagNames.join(' ')}`,
        `        Start Time: ${this.formatTime(t.startTime)}`,
        `        End Time:   ${this.formatTime(t.endTime)}`,
        `        Renew Time: ${t.renewTill !== null ? this.formatTime(t.renewTill) : 'none'}`,
        '        Session Key Type: AES-256-CTS-HMAC-SHA1-96',
        '',
      );
    });
    return lines.join('\n').trimEnd() + '\n';
  }

  private formatTime(epochSeconds: number): string {
    return new Date(epochSeconds * 1000).toUTCString();
  }
}
