import { BaseCommand } from '@/command-kernel/command/base-command';
import { CommandContext, CommandDescriptor, EXIT_OK, ExitCode } from '@/command-kernel/command/types';
import { DefaultPrivilegePolicy } from '@/command-kernel/session/privilege-policy';
import { PrivilegeLevel } from '@/command-kernel/session/types';
import { RdpSessionsApi } from '@/command-kernel/machine/types';

const QUERY_SESSION_HEADER = ' SESSIONNAME       USERNAME                 ID  STATE   TYPE';

/** Formate la table de sessions RDP, mise en page de `query session`/`qwinsta`. */
function formatSessions(rdp: RdpSessionsApi): string {
  const sessions = rdp.list();
  if (sessions.length === 0) return QUERY_SESSION_HEADER;
  const rows = sessions.map((s) =>
    ` rdp-tcp#${s.sessionId}          ${s.userName.padEnd(20)}     ${s.sessionId}  ${s.state.slice(0, 4)}    rdpwd`);
  return [QUERY_SESSION_HEADER, ...rows].join('\n');
}

/** Ferme une session RDP par ID (`logoff`/`rwinsta`) et formate le retour. */
async function runLogoff(ctx: CommandContext, rdp: RdpSessionsApi, args: string[]): Promise<ExitCode> {
  const idArg = args[0];
  const sessionId = Number(idArg);
  if (!idArg || Number.isNaN(sessionId)) {
    await ctx.io.stdout.write('Usage: logoff <sessionid> [/server:servername] [/v]\n');
    return 1;
  }
  if (!rdp.logoff(sessionId)) {
    await ctx.io.stdout.write(`No session exists for ID ${sessionId}.\n`);
    return 1;
  }
  return EXIT_OK;
}

const QUERY_HELP = `QUERY { PROCESS | SESSION | TERMSERVER | USER }

  query session [sessionname | username | sessionid]
                Display information about Remote Desktop Services sessions.`;

/**
 * `query session` (alias `qwinsta`) — introspection de la table de sessions
 * RDP. Le parsing et le formatage sont portés par la commande ; l'état des
 * sessions est la capacité device `machine.rdpSessions`.
 */
export class QueryCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'query',
    summary: 'Interroge les sessions Bureau à distance',
    usage: QUERY_HELP,
    args: [{ name: 'targets', type: 'string', required: false, variadic: true, description: 'session [sessionname|username|sessionid]' }],
    options: [],
    privileges: new DefaultPrivilegePolicy(PrivilegeLevel.ANY),
    category: 'système',
    lenientOptions: true,
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const args = ctx.args.has('targets') ? ctx.args.get<string[]>('targets') : [];
    const sub = (args[0] ?? '').toLowerCase();
    if (sub === 'session') {
      await ctx.io.stdout.write(formatSessions(ctx.machine.rdpSessions!) + '\n');
      return EXIT_OK;
    }
    await ctx.io.stdout.write(QUERY_HELP + '\n');
    return sub ? 1 : EXIT_OK;
  }
}

/** `qwinsta` — équivalent direct de `query session`. */
export class QwinstaCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'qwinsta',
    summary: 'Liste les sessions Bureau à distance (query session)',
    usage: 'qwinsta [sessionname | username | sessionid] [/server:servername]',
    args: [{ name: 'targets', type: 'string', required: false, variadic: true, description: '[sessionname|username|sessionid]' }],
    options: [],
    privileges: new DefaultPrivilegePolicy(PrivilegeLevel.ANY),
    category: 'système',
    lenientOptions: true,
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    await ctx.io.stdout.write(formatSessions(ctx.machine.rdpSessions!) + '\n');
    return EXIT_OK;
  }
}

/** `logoff <sessionid>` — ferme une session RDP. */
export class LogoffCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'logoff',
    summary: 'Ferme une session Bureau à distance',
    usage: 'logoff <sessionid> [/server:servername] [/v]',
    args: [{ name: 'targets', type: 'string', required: false, variadic: true, description: '<sessionid>' }],
    options: [],
    privileges: new DefaultPrivilegePolicy(PrivilegeLevel.ANY),
    category: 'système',
    lenientOptions: true,
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const args = ctx.args.has('targets') ? ctx.args.get<string[]>('targets') : [];
    return runLogoff(ctx, ctx.machine.rdpSessions!, args);
  }
}

/** `rwinsta <sessionid>` — équivalent direct de `logoff`. */
export class RwinstaCommand extends BaseCommand {
  readonly descriptor: CommandDescriptor = {
    name: 'rwinsta',
    summary: 'Réinitialise (ferme) une session Bureau à distance',
    usage: 'rwinsta <sessionid> [/server:servername] [/v]',
    args: [{ name: 'targets', type: 'string', required: false, variadic: true, description: '<sessionid>' }],
    options: [],
    privileges: new DefaultPrivilegePolicy(PrivilegeLevel.ANY),
    category: 'système',
    lenientOptions: true,
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const args = ctx.args.has('targets') ? ctx.args.get<string[]>('targets') : [];
    return runLogoff(ctx, ctx.machine.rdpSessions!, args);
  }
}
