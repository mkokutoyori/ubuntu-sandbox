/**
 * `net use` — SMB drive-letter mapping table.
 *
 * Gated on the Workstation (LanmanWorkstation) service: without it
 * the SMB client stack is down and the command refuses. The table is
 * backed by `ctx.netUseTable` — an instance-owned Map (PRD-Windows-Server.md
 * §7 risk 6) rather than the old hostname-keyed module store.
 *
 * The add form really dials the target over the network (PRD §5 P3):
 * `ctx.resolveHostname` resolves the server name, `ctx.dialSmbShare` opens
 * a real TCP/445 connection and negotiates session-setup + tree-connect.
 * A mapping is only recorded on success — an unreachable server, a
 * stopped LanmanServer, a bad password, or a share without permission for
 * this user all fail exactly like real `net use`, with no cosmetic entry
 * left behind.
 *
 * Supported forms:
 *   net use                              — list current connections
 *   net use <device>                     — detail of one connection
 *   net use {<device> | *} \\server\share [password] [/user:NAME] [/savecred] [/persistent:yes|no]
 *   net use \\server\share [...]         — deviceless connection
 *   net use {<device> | \\server\share} /delete
 *   net use * /delete                    — clear every connection
 *   net use /persistent:{yes | no}       — set the reconnect-at-logon default
 */

import type { WinCommandContext } from './WinCommandExecutor';
import { requireWindowsService } from './WinFeatureGate';
import type { SmbConnection } from './server/smb/SmbClient';

export interface NetUseEntry {
  /** Drive letter (`Z:`), or empty for a deviceless connection. */
  local: string;
  remote: string;
  status: 'OK' | 'Disconnected' | 'Unavailable';
  user: string;
  persistent: boolean;
  /** Live SMB session backing this mapping — reused by `dir`/`copy`/`type` over `Z:\...`. */
  connection?: SmbConnection;
}

const PERSISTENCE_KEY = 'HKCU\\Software\\Microsoft\\Windows NT\\CurrentVersion\\Network\\Persistent Connections';
const PERSISTENCE_VALUE = 'SaveConnections';
const MAPPING_KEY = 'HKCU\\Network';

const SYNTAX = `The syntax of this command is:\n\nNET USE\n[devicename | *] [\\\\computername\\sharename[\\volume] [password | *]]\n      [/USER:[domainname\\]username]\n      [/PERSISTENT:{YES | NO} | /DELETE]`;

const ERROR_85 = 'System error 85 has occurred.\n\nThe local device name is already in use.';
const ERROR_1219 = 'System error 1219 has occurred.\n\nMultiple connections to a server or shared resource by the same user, using more than one user name, are not allowed. Disconnect all previous connections to the server or shared resource and try again.';
const ERROR_53 = 'System error 53 has occurred.\n\nThe network path was not found.';

function savesConnections(ctx: WinCommandContext): boolean {
  const stored = ctx.registry?.getItemPropertyValues(PERSISTENCE_KEY)?.[PERSISTENCE_VALUE];
  return stored === undefined ? true : String(stored).toLowerCase() === 'yes';
}

function rememberDefault(ctx: WinCommandContext, save: boolean): void {
  ctx.registry?.applyGpoRegistryValue(PERSISTENCE_KEY, PERSISTENCE_VALUE, save ? 'Yes' : 'No', 'String');
}

function rememberMapping(ctx: WinCommandContext, entry: NetUseEntry): void {
  if (!entry.persistent || !entry.local) return;
  ctx.registry?.applyGpoRegistryValue(`${MAPPING_KEY}\\${entry.local[0]}`, 'RemotePath', entry.remote, 'String');
}

function forgetMapping(ctx: WinCommandContext, entry: NetUseEntry): void {
  if (!entry.local) return;
  ctx.registry?.removeItem(`${MAPPING_KEY}\\${entry.local[0]}`, true);
}

function keyOf(entry: { local: string; remote: string }): string {
  return entry.local ? entry.local.toUpperCase() : entry.remote.toUpperCase();
}

/**
 * The status column reports the link as it is NOW, not as it was when the
 * mapping was made: a session whose peer or cable has gone reads
 * `Disconnected`, which is what an operator looks at to know whether the
 * share still answers.
 */
function observedStatus(entry: NetUseEntry): NetUseEntry['status'] {
  if (entry.status !== 'OK') return entry.status;
  if (!entry.connection) return 'Unavailable';
  return entry.connection.isConnected() ? 'OK' : 'Disconnected';
}

function listConnections(ctx: WinCommandContext, store: Map<string, NetUseEntry>): string {
  const header =
    `New connections will ${savesConnections(ctx) ? '' : 'not '}be remembered.\n\n` +
    `\nStatus       Local     Remote                    Network\n` +
    `-------------------------------------------------------------------------------\n`;
  if (store.size === 0) {
    return header + `There are no entries in the list.`;
  }
  const rows = Array.from(store.values()).map(e =>
    `${observedStatus(e).padEnd(13)}${e.local.padEnd(10)}${e.remote.padEnd(26)}Microsoft Windows Network`,
  );
  return header + rows.join('\n') + `\nThe command completed successfully.`;
}

function detailOf(entry: NetUseEntry): string {
  return [
    `Local name        ${entry.local}`,
    `Remote name       ${entry.remote}`,
    `Resource type     Disk`,
    `Status            ${observedStatus(entry)}`,
    `# Opens           0`,
    `# Connections     1`,
    `The command completed successfully.`,
  ].join('\n');
}

/** Parse `\\server\share[\...]` into its server and share-name parts. */
function parseUnc(unc: string): { server: string; share: string } | null {
  const m = /^\\\\([^\\]+)\\([^\\]+)/.exec(unc);
  if (!m) return null;
  return { server: m[1], share: m[2] };
}

function serverOf(remote: string): string {
  return parseUnc(remote)?.server.toLowerCase() ?? '';
}

/**
 * `net use *` takes the highest free letter, starting at Z: — the order a
 * captured transcript shows (`drive Y: was connected` on a machine whose
 * only prior mapping was Z:), which the vendor's own "next available
 * drive letter" wording leaves open.
 */
function nextFreeDrive(ctx: WinCommandContext, store: Map<string, NetUseEntry>): string | null {
  const taken = new Set<string>([
    ...Array.from(store.values()).map(e => e.local.toUpperCase()).filter(Boolean),
    ...(ctx.localDrives?.() ?? []).map(d => d.toUpperCase()),
  ]);
  for (let code = 'Z'.charCodeAt(0); code >= 'C'.charCodeAt(0); code--) {
    const letter = `${String.fromCharCode(code)}:`;
    if (!taken.has(letter)) return letter;
  }
  return null;
}

function findByRemote(store: Map<string, NetUseEntry>, remote: string): NetUseEntry | null {
  const wanted = remote.toUpperCase();
  for (const entry of store.values()) if (entry.remote.toUpperCase() === wanted) return entry;
  return null;
}

function disconnect(ctx: WinCommandContext, store: Map<string, NetUseEntry>, entry: NetUseEntry): void {
  entry.connection?.disconnect();
  forgetMapping(ctx, entry);
  store.delete(keyOf(entry));
}

export async function cmdNetUse(ctx: WinCommandContext, args: string[]): Promise<string> {
  const gate = requireWindowsService(ctx, 'LanmanWorkstation');
  if (!gate.ok) return gate.error;
  const store = ctx.netUseTable;

  if (args.length === 0) return listConnections(ctx, store);

  const flag = (prefix: string): string | undefined =>
    args.find(a => a.toLowerCase().startsWith(prefix))?.slice(prefix.length);
  const persistArg = flag('/persistent:');
  const wantsDelete = args.some(a => a.toLowerCase() === '/delete' || a.toLowerCase() === '/d');

  const first = args[0];
  const isDriveLetter = /^[A-Za-z]:$/.test(first);
  const isWildcard = first === '*';
  const isUnc = first.startsWith('\\\\');

  // `net use /persistent:{yes|no}` on its own sets the reconnect-at-logon default.
  if (persistArg !== undefined && !isDriveLetter && !isWildcard && !isUnc) {
    const wanted = persistArg.toLowerCase();
    if (wanted !== 'yes' && wanted !== 'no') return SYNTAX;
    rememberDefault(ctx, wanted === 'yes');
    return 'The command completed successfully.';
  }

  if (wantsDelete) {
    if (isWildcard) {
      const n = store.size;
      for (const entry of Array.from(store.values())) disconnect(ctx, store, entry);
      return `${n} connections removed.\nThe command completed successfully.`;
    }
    if (isUnc) {
      const entry = findByRemote(store, first);
      if (!entry) return `The network connection could not be found.`;
      disconnect(ctx, store, entry);
      return `${first} was deleted successfully.`;
    }
    const key = first.toUpperCase();
    const existing = store.get(key);
    if (!existing) return `The network connection could not be found.`;
    disconnect(ctx, store, existing);
    return `${key} was deleted successfully.`;
  }

  // `net use <device>` alone reports that one connection in detail.
  if (isDriveLetter && args.length === 1) {
    const entry = store.get(first.toUpperCase());
    if (!entry) return `The network connection could not be found.`;
    return detailOf(entry);
  }

  const uncArg = isUnc ? first : args[1];
  if ((isDriveLetter || isWildcard || isUnc) && uncArg?.startsWith('\\\\')) {
    const unc = parseUnc(uncArg);
    if (!unc) return 'The network path was not found.';

    let local = '';
    if (isDriveLetter) {
      local = first.toUpperCase();
      const takenLocally = (ctx.localDrives?.() ?? []).some(d => d.toUpperCase() === local);
      if (store.has(local) || takenLocally) return ERROR_85;
    } else if (isWildcard) {
      const free = nextFreeDrive(ctx, store);
      if (!free) return ERROR_85;
      local = free;
    }

    const userArg = flag('/user:');
    // `/user:computername\name` (local) or `/user:DOMAIN\name`/`name@dns` (domain,
    // PRD-Windows-Server.md §5 P6) — kept verbatim; only the target SERVER
    // knows its own hostname, so distinguishing "this is me" from "this is
    // my domain" happens in `SmbServerHandler.session_setup`, not here.
    // Named nobody, the connection carries the identity that is signed in,
    // as a real client does.
    const username = userArg ?? ctx.signedInIdentity?.() ?? 'Administrator';
    const passwordArg = args[isUnc ? 1 : 2];
    const typedPassword = passwordArg && !passwordArg.startsWith('/') ? passwordArg : '';
    const password = typedPassword || (ctx.secretFor?.(username) ?? '');

    const alreadyThere = Array.from(store.values())
      .find(e => serverOf(e.remote) === unc.server.toLowerCase() && e.user !== username);
    if (alreadyThere) return ERROR_1219;

    const targetIp = await ctx.resolveHostname(unc.server);
    if (!targetIp) return ERROR_53;

    let dial = ctx.dialSmbShare(targetIp.toString(), unc.share, username, password);
    // `\\domain\namespace` is not a share on the machine that answers for the
    // domain — it is a DFS root. A real client asks that machine for a
    // referral and dials the share it names instead of giving up.
    if (!dial.ok && dial.systemErrorCode === 67) {
      const referred = ctx.requestDfsReferral?.(targetIp.toString(), uncArg, username, password) ?? [];
      for (const target of referred) {
        const parsed = parseUnc(target);
        if (!parsed) continue;
        const targetAddress = await ctx.resolveHostname(parsed.server);
        if (!targetAddress) continue;
        const viaDfs = ctx.dialSmbShare(targetAddress.toString(), parsed.share, username, password);
        if (viaDfs.ok) { dial = viaDfs; break; }
      }
    }
    if (!dial.ok) return dial.error ?? ERROR_53;

    const entry: NetUseEntry = {
      local,
      remote: uncArg,
      status: 'OK',
      user: username,
      persistent: persistArg !== undefined ? persistArg.toLowerCase() === 'yes' : (local !== '' && savesConnections(ctx)),
      connection: dial.connection,
    };
    store.set(keyOf(entry), entry);
    rememberMapping(ctx, entry);
    if (args.some(a => a.toLowerCase() === '/savecred') && typedPassword) {
      ctx.rememberSecret?.(username, typedPassword);
    }
    return isWildcard
      ? `Drive ${local} is now connected to ${uncArg}.\n\nThe command completed successfully.`
      : `The command completed successfully.`;
  }

  return SYNTAX;
}
