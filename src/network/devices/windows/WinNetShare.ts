/**
 * `net share` — SMB server-side share table.
 *
 * Gated on the Server (LanmanServer) service: without it the SMB
 * server is down, and `net share` refuses every form. Backed by
 * `ctx.smbShares` (an instance-owned `SmbShareTable`, PRD-Windows-Server.md
 * §7 risk 6) so a share added here is immediately visible to
 * `Get-SmbShare`/`New-SmbShare` and to `SmbServerHandler`'s tree-connect
 * checks — one shared table, three front-ends.
 *
 * Supported forms:
 *   net share                            — list current shares
 *   net share NAME=path [/GRANT:USER,*]  — add a share
 *   net share NAME /delete               — remove a share
 */

import type { WinCommandContext } from './WinCommandExecutor';
import { requireWindowsService } from './WinFeatureGate';
import type { SmbShare } from './server/smb/SmbShareTable';

function listShares(shares: SmbShare[]): string {
  const lines: string[] = [];
  lines.push('');
  lines.push('Share name   Resource                        Remark');
  lines.push('');
  lines.push('-------------------------------------------------------------------------------');
  for (const e of shares) {
    lines.push(`${e.name.padEnd(13)}${e.path.padEnd(32)}${e.description}`);
  }
  lines.push('The command completed successfully.');
  return lines.join('\n');
}

export function cmdNetShare(ctx: WinCommandContext, args: string[]): string {
  const gate = requireWindowsService(ctx, 'LanmanServer');
  if (!gate.ok) return gate.error;
  const table = ctx.smbShares;

  if (args.length === 0) return listShares(table.list());

  // Delete form: net share NAME /delete
  const wantsDelete = args.some(a => /^\/(delete|d)$/i.test(a));
  if (wantsDelete) {
    const name = args[0];
    const result = table.remove(name);
    if (!result.ok) return result.message;
    return `${name} was deleted successfully.`;
  }

  // Add form: net share NAME=PATH ...
  // Classic net.exe defaults an ad-hoc share to Everyone:Full (unlike the
  // modern New-SmbShare cmdlet, which defaults to Everyone:Read).
  const m = /^([A-Za-z][\w$]*)=(.+)$/.exec(args[0]);
  if (m) {
    const [, name, resource] = m;
    const remarkArg = args.find(a => a.toLowerCase().startsWith('/remark:'));
    const remark = remarkArg ? remarkArg.slice('/remark:'.length).replace(/^"|"$/g, '') : '';
    const result = table.add(name, resource, {
      description: remark,
      permissions: new Map([['Everyone', 'Full']]),
    });
    if (!result.ok) return result.message;
    return `${name} was shared successfully.`;
  }

  return `The syntax of this command is:\n\nNET SHARE\nsharename\nsharename=drive:path [/USERS:number | /UNLIMITED]\n                     [/REMARK:"text"]\nsharename [/USERS:number | /UNLIMITED] [/REMARK:"text"]\n{sharename | devicename | drive:path} /DELETE`;
}
