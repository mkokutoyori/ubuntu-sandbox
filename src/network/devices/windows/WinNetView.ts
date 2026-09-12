import type { WinCommandContext } from './WinCommandExecutor';
import { requireWindowsService } from './WinFeatureGate';

const SYNTAX = `The syntax of this command is:\n\nNET VIEW\n[\\\\computername [/CACHE] | [/ALL] | /DOMAIN[:domainname]]`;

/**
 * No browser service here — and none on a modern Windows either, where
 * this is the answer an operator actually gets.
 */
const NO_BROWSER = 'System error 6118 has occurred.\n\nThe list of servers for this workgroup is not currently available.';

const ERROR_53 = 'System error 53 has occurred.\n\nThe network path was not found.';

export async function cmdNetView(ctx: WinCommandContext, args: string[]): Promise<string> {
  const gate = requireWindowsService(ctx, 'LanmanWorkstation');
  if (!gate.ok) return gate.error;

  const all = args.some(a => a.toLowerCase() === '/all');
  const target = args.find(a => a.startsWith('\\\\'));
  if (!target) {
    if (args.some(a => a.toLowerCase().startsWith('/domain'))) return NO_BROWSER;
    if (args.length === 0) return NO_BROWSER;
    return SYNTAX;
  }

  const server = target.replace(/^\\\\+/, '').split('\\')[0];
  const address = await ctx.resolveHostname(server);
  if (!address) return ERROR_53;

  const identity = ctx.signedInIdentity?.() ?? 'Administrator';
  const enumerated = ctx.requestShareEnum?.(address.toString(), identity, ctx.secretFor?.(identity) ?? '');
  if (!enumerated || !enumerated.ok) return enumerated?.error ?? ERROR_53;

  const offered = (enumerated.shares ?? []).filter(s => all || !s.special);
  const header =
    `Shared resources at ${target}\n\n\n` +
    `Share name  Type  Used as  Comment\n` +
    `-------------------------------------------------------------------------------\n`;
  if (offered.length === 0) {
    return header + 'There are no entries in the list.';
  }

  // `Used as` names the local letter when this machine already holds the
  // share — read from the one mapping table `net use`, `Get-PSDrive` and
  // `Get-SmbMapping` also read.
  const mountedAs = (shareName: string): string => {
    for (const entry of ctx.netUseTable.values()) {
      const parsed = /^\\\\[^\\]+\\([^\\]+)/.exec(entry.remote);
      if (parsed && parsed[1].toLowerCase() === shareName.toLowerCase()) return entry.local;
    }
    return '';
  };

  const rows = offered.map(s =>
    `${s.name.padEnd(12)}${s.type.padEnd(6)}${mountedAs(s.name).padEnd(9)}${s.comment}`.trimEnd(),
  );
  return header + rows.join('\n') + '\nThe command completed successfully.';
}
