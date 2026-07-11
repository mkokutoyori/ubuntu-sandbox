/**
 * `net use` — SMB drive-letter mapping table.
 *
 * Gated on the Workstation (LanmanWorkstation) service: without it
 * the SMB client stack is down and the command refuses. The table is
 * backed by `ctx.netUseTable` — an instance-owned Map (PRD-Windows-Server.md
 * §7 risk 6) rather than the old hostname-keyed module store.
 *
 * The add form now really dials the target over the network (PRD §5 P3):
 * `ctx.resolveHostname` resolves the server name, `ctx.dialSmbShare` opens
 * a real TCP/445 connection and negotiates session-setup + tree-connect.
 * A mapping is only recorded on success — an unreachable server, a
 * stopped LanmanServer, a bad password, or a share without permission for
 * this user all fail exactly like real `net use`, with no cosmetic entry
 * left behind.
 *
 * Supported forms:
 *   net use                              — list current mappings
 *   net use Z: \\server\share [password] [/persistent:yes|no] [/user:NAME]
 *   net use Z: /delete
 *   net use * /delete                    — clear all mappings
 */

import type { WinCommandContext } from './WinCommandExecutor';
import { requireWindowsService } from './WinFeatureGate';
import type { SmbConnection } from './server/smb/SmbClient';

export type NetUseContext = Pick<WinCommandContext, 'isServiceRunning' | 'netUseTable' | 'resolveHostname' | 'dialSmbShare'>;

export interface NetUseEntry {
  local: string;
  remote: string;
  status: 'OK' | 'Disconnected' | 'Unavailable';
  user: string;
  persistent: boolean;
  /** Live SMB session backing this mapping — reused by `dir`/`copy`/`type` over `Z:\...`. */
  connection?: SmbConnection;
}

function listMappings(store: Map<string, NetUseEntry>): string {
  const header =
    `New connections will be remembered.\n\n` +
    `\nStatus       Local     Remote                    Network\n` +
    `-------------------------------------------------------------------------------\n`;
  if (store.size === 0) {
    return header + `There are no entries in the list.`;
  }
  const rows = Array.from(store.values()).map(e =>
    `${e.status.padEnd(13)}${e.local.padEnd(10)}${e.remote.padEnd(26)}Microsoft Windows Network`,
  );
  return header + rows.join('\n') + `\nThe command completed successfully.`;
}

/** Parse `\\server\share[\...]` into its server and share-name parts. */
function parseUnc(unc: string): { server: string; share: string } | null {
  const m = /^\\\\([^\\]+)\\([^\\]+)/.exec(unc);
  if (!m) return null;
  return { server: m[1], share: m[2] };
}

export async function cmdNetUse(ctx: NetUseContext, args: string[]): Promise<string> {
  const gate = requireWindowsService(ctx, 'LanmanWorkstation');
  if (!gate.ok) return gate.error;
  const store = ctx.netUseTable;

  if (args.length === 0) return listMappings(store);

  const first = args[0];
  const isDriveLetter = /^[A-Za-z]:$/.test(first);
  const isWildcard = first === '*';

  // Delete forms.
  const wantsDelete = args.some(a => a.toLowerCase() === '/delete' || a.toLowerCase() === '/d');
  if (wantsDelete) {
    if (isWildcard) {
      const n = store.size;
      for (const e of store.values()) e.connection?.disconnect();
      store.clear();
      return `${n} connections removed.\nThe command completed successfully.`;
    }
    const key = first.toUpperCase();
    const existing = store.get(key);
    if (!existing) return `The network connection could not be found.`;
    existing.connection?.disconnect();
    store.delete(key);
    return `${key} was deleted successfully.`;
  }

  // Add form: net use DRIVE \\server\share [password] [/user:NAME] [/persistent:yes|no]
  if (isDriveLetter && args[1]?.startsWith('\\\\')) {
    const unc = parseUnc(args[1]);
    if (!unc) {
      return 'The network path was not found.';
    }
    const userArg = args.find(a => a.toLowerCase().startsWith('/user:'));
    const persistArg = args.find(a => a.toLowerCase().startsWith('/persistent:'));
    // `/user:computername\name` (local) or `/user:DOMAIN\name`/`name@dns` (domain,
    // PRD-Windows-Server.md §5 P6) — kept verbatim; only the target SERVER
    // knows its own hostname, so distinguishing "this is me" from "this is
    // my domain" happens in `SmbServerHandler.session_setup`, not here.
    const username = userArg ? userArg.slice('/user:'.length) : 'Administrator';
    const password = args[2] && !args[2].startsWith('/') ? args[2] : '';

    const targetIp = await ctx.resolveHostname(unc.server);
    if (!targetIp) {
      return 'System error 53 has occurred.\n\nThe network path was not found.';
    }
    const dial = ctx.dialSmbShare(targetIp.toString(), unc.share, username, password);
    if (!dial.ok) {
      return dial.error ?? 'System error 53 has occurred.\n\nThe network path was not found.';
    }

    const entry: NetUseEntry = {
      local: first.toUpperCase(),
      remote: args[1],
      status: 'OK',
      user: username,
      persistent: persistArg ? persistArg.toLowerCase() === '/persistent:yes' : false,
      connection: dial.connection,
    };
    store.set(entry.local, entry);
    return `The command completed successfully.`;
  }

  return `The syntax of this command is:\n\nNET USE\n[devicename | *] [\\\\computername\\sharename[\\volume] [password | *]]\n      [/USER:[domainname\\]username]\n      [/PERSISTENT:{YES | NO} | /DELETE]`;
}
