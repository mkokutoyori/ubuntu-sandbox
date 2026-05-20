/**
 * `net use` — SMB drive-letter mapping table.
 *
 * Gated on the Workstation (LanmanWorkstation) service: without it
 * the SMB client stack is down and the command refuses. The table is
 * per-machine and lives only in memory — sufficient for the simulator.
 *
 * Supported forms:
 *   net use                              — list current mappings
 *   net use Z: \\server\share [/persistent:yes|no] [/user:NAME]
 *   net use Z: /delete
 *   net use * /delete                    — clear all mappings
 */

import type { WinCommandContext } from './WinCommandExecutor';
import { requireWindowsService } from './WinFeatureGate';

export interface NetUseEntry {
  local: string;
  remote: string;
  status: 'OK' | 'Disconnected' | 'Unavailable';
  user: string;
  persistent: boolean;
}

/** Per-PC in-memory mapping store — keyed by hostname (the context is rebuilt per call). */
const STORES = new Map<string, Map<string, NetUseEntry>>();

function getStore(ctx: WinCommandContext): Map<string, NetUseEntry> {
  let s = STORES.get(ctx.hostname);
  if (!s) { s = new Map(); STORES.set(ctx.hostname, s); }
  return s;
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

export function cmdNetUse(ctx: WinCommandContext, args: string[]): string {
  const gate = requireWindowsService(ctx, 'LanmanWorkstation');
  if (!gate.ok) return gate.error;
  const store = getStore(ctx);

  if (args.length === 0) return listMappings(store);

  const first = args[0];
  const isDriveLetter = /^[A-Za-z]:$/.test(first);
  const isWildcard = first === '*';

  // Delete forms.
  const wantsDelete = args.some(a => a.toLowerCase() === '/delete' || a.toLowerCase() === '/d');
  if (wantsDelete) {
    if (isWildcard) {
      const n = store.size; store.clear();
      return `${n} connections removed.\nThe command completed successfully.`;
    }
    const key = first.toUpperCase();
    if (!store.has(key)) return `The network connection could not be found.`;
    store.delete(key);
    return `${key} was deleted successfully.`;
  }

  // Add form: net use DRIVE \\server\share
  if (isDriveLetter && args[1]?.startsWith('\\\\')) {
    const userArg = args.find(a => a.toLowerCase().startsWith('/user:'));
    const persistArg = args.find(a => a.toLowerCase().startsWith('/persistent:'));
    const entry: NetUseEntry = {
      local: first.toUpperCase(),
      remote: args[1],
      status: 'OK',
      user: userArg ? userArg.slice('/user:'.length) : 'Administrator',
      persistent: persistArg ? persistArg.toLowerCase() === '/persistent:yes' : false,
    };
    store.set(entry.local, entry);
    return `The command completed successfully.`;
  }

  return `The syntax of this command is:\n\nNET USE\n[devicename | *] [\\\\computername\\sharename[\\volume] [password | *]]\n      [/USER:[domainname\\]username]\n      [/PERSISTENT:{YES | NO} | /DELETE]`;
}
