/**
 * `net share` — SMB server-side share table.
 *
 * Gated on the Server (LanmanServer) service: without it the SMB
 * server is down, and `net share` refuses every form. The table seeds
 * the default administrative shares (ADMIN$, C$, IPC$) on first use.
 *
 * Supported forms:
 *   net share                            — list current shares
 *   net share NAME=path [/GRANT:USER,*]  — add a share
 *   net share NAME /delete               — remove a share
 */

import type { WinCommandContext } from './WinCommandExecutor';
import { requireWindowsService } from './WinFeatureGate';

export interface NetShareEntry {
  name: string;
  resource: string;
  remark: string;
  type: 'Disk' | 'IPC' | 'Print';
  admin: boolean;
}

const STORES = new Map<string, Map<string, NetShareEntry>>();

function getStore(ctx: WinCommandContext): Map<string, NetShareEntry> {
  let s = STORES.get(ctx.hostname);
  if (!s) {
    s = new Map();
    s.set('ADMIN$', { name: 'ADMIN$', resource: 'C:\\Windows', remark: 'Remote Admin', type: 'Disk', admin: true });
    s.set('C$',     { name: 'C$',     resource: 'C:\\',         remark: 'Default share', type: 'Disk', admin: true });
    s.set('IPC$',   { name: 'IPC$',   resource: '',             remark: 'Remote IPC',    type: 'IPC',  admin: true });
    STORES.set(ctx.hostname, s);
  }
  return s;
}

function listShares(store: Map<string, NetShareEntry>): string {
  const lines: string[] = [];
  lines.push('');
  lines.push('Share name   Resource                        Remark');
  lines.push('');
  lines.push('-------------------------------------------------------------------------------');
  for (const e of store.values()) {
    lines.push(`${e.name.padEnd(13)}${e.resource.padEnd(32)}${e.remark}`);
  }
  lines.push('The command completed successfully.');
  return lines.join('\n');
}

export function cmdNetShare(ctx: WinCommandContext, args: string[]): string {
  const gate = requireWindowsService(ctx, 'LanmanServer');
  if (!gate.ok) return gate.error;
  const store = getStore(ctx);

  if (args.length === 0) return listShares(store);

  // Delete form: net share NAME /delete
  const wantsDelete = args.some(a => /^\/(delete|d)$/i.test(a));
  if (wantsDelete) {
    const name = args[0];
    const key = Array.from(store.keys()).find(k => k.toLowerCase() === name.toLowerCase());
    if (!key) return `This shared resource does not exist.`;
    store.delete(key);
    return `${name} was deleted successfully.`;
  }

  // Add form: net share NAME=PATH ...
  const m = /^([A-Za-z][\w$]*)=(.+)$/.exec(args[0]);
  if (m) {
    const [, name, resource] = m;
    const remarkArg = args.find(a => a.toLowerCase().startsWith('/remark:'));
    const remark = remarkArg ? remarkArg.slice('/remark:'.length).replace(/^"|"$/g, '') : '';
    store.set(name, { name, resource, remark, type: 'Disk', admin: false });
    return `${name} was shared successfully.`;
  }

  return `The syntax of this command is:\n\nNET SHARE\nsharename\nsharename=drive:path [/USERS:number | /UNLIMITED]\n                     [/REMARK:"text"]\nsharename [/USERS:number | /UNLIMITED] [/REMARK:"text"]\n{sharename | devicename | drive:path} /DELETE`;
}
