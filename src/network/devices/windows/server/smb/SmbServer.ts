/**
 * SmbServerHandler — server-side endpoint registered on TCP port 445
 * (PRD-Windows-Server.md §5 P3). Mirrors `SshServerHandler`'s shape: a
 * fresh handler per accepted connection (`WindowsPC.getSmbServerHandler()`),
 * dispatching JSON ops over the real `TcpConnection`. Session bookkeeping
 * that must survive across connections lives in the shared
 * `SmbSessionTable` passed in via the context, not on this handler.
 */

import type { TcpStream as TcpConnection } from '@/network/tcp/types';
import type { WindowsFileSystem, WinFSEntry } from '../../WindowsFileSystem';
import type { WindowsUserManager } from '../../WindowsUserManager';
import type { SmbShareTable } from './SmbShareTable';
import type { SmbSessionTable } from './SmbSessionTable';
import type { SharePermission, SmbListEntry, SmbShare } from './SmbTypes';
import { SMB_STATUS_MESSAGE, type SmbStatus } from './SmbStatus';
import { shareTarget } from './SmbSharePath';

export interface SmbServerContext {
  fs: WindowsFileSystem;
  userMgr: WindowsUserManager;
  shares: SmbShareTable;
  sessions: SmbSessionTable;
  now(): number;
  /** This server's own hostname — `/user:<hostname>\name` is a local-SAM reference and gets its qualifier stripped; any other qualifier is treated as a domain reference (PRD §5 P6). */
  hostname: string;
  /**
   * Domain-account fallback (PRD-Windows-Server.md §5 P6): tried when the
   * local SAM has no match. Null/undefined on a machine that isn't
   * domain-joined. A real LDAP bind against the DC — not a topology
   * shortcut — so a bad password or an unreachable DC fails exactly like
   * local auth would.
   */
  domainAuth?: (username: string, password: string) => { ok: boolean; sam: string; groups: string[] } | null;
  /** DFS Namespaces role, when this server hosts one — answers `dfs_referral`. Absent on a server that hosts no namespace, which then refuses the referral. */
  dfsNamespaces?: () => import('../dfs/DfsNamespace').DfsNamespaceRegistry | null;
}

interface TreeInfo { shareName: string }

interface OpenTree { share: SmbShare; user: string; groups: string[]; canWrite: boolean }

interface Located { abs: string; parent: string; root: boolean }

const ATTRIBUTE_NAMES = new Set(['archive', 'hidden', 'system', 'readonly']);

const relativeTo = (sharePath: string, abs: string): string => abs.slice(sharePath.replace(/\\+$/, '').length).replace(/^\\+/, '');

const nodeOf = (name: string, entry: WinFSEntry): SmbListEntry => ({
  name,
  isDirectory: entry.type === 'directory',
  size: entry.size,
  modified: entry.mtime.getTime(),
  created: entry.ctime.getTime(),
  attributes: [...entry.attributes],
});

/**
 * `\\domain\namespace` names a root; `\\domain\namespace\folder` names a
 * link below it. A real referral answers with the shares the path actually
 * lives on, most-preferred first — here, the order an admin declared.
 */
function referralTargetsFor(
  namespaces: import('../dfs/DfsNamespace').DfsNamespaceRegistry, path: string,
): string[] {
  const trimmed = path.replace(/\\+$/, '');
  const segments = trimmed.replace(/^\\\\/, '').split('\\').filter(Boolean);
  if (segments.length < 2) return [];
  const namespacePath = `\\\\${segments[0]}\\${segments[1]}`;
  const asTarget = (t: { serverAddress: string; shareName: string }): string =>
    `\\\\${t.serverAddress}\\${t.shareName}`;
  if (segments.length === 2) {
    return (namespaces.getRoot(namespacePath)?.targets ?? []).map(asTarget);
  }
  const folder = segments.slice(2).join('\\');
  return (namespaces.resolve(namespacePath, folder) ?? []).map(asTarget);
}

/** Strips a `<hostname>\name` qualifier that refers to THIS server; leaves any other qualifier (a domain reference) or a bare name untouched. */
function stripLocalQualifier(raw: string, hostname: string): string {
  const backslash = raw.indexOf('\\');
  if (backslash === -1) return raw;
  const prefix = raw.slice(0, backslash);
  return prefix.toLowerCase() === hostname.toLowerCase() ? raw.slice(backslash + 1) : raw;
}

export class SmbServerHandler {
  constructor(private readonly ctx: SmbServerContext) {}

  register(conn: TcpConnection, clientIp: string, clientComputerName: string): void {
    let user: string | null = null;
    /** Set only when `user` authenticated as a domain account — its domain groups, since they aren't in the local SAM (PRD §5 P6). */
    let domainGroups: string[] | null = null;
    let sessionId: number | null = null;
    let nextTreeId = 1;
    const trees = new Map<number, TreeInfo>();

    const reply = (msg: Record<string, unknown>) => conn.write(JSON.stringify(msg));
    const refuse = (status: SmbStatus, message: string = SMB_STATUS_MESSAGE[status]): void =>
      reply({ ok: false, status, message });
    const denyAccess = (): void => refuse('STATUS_ACCESS_DENIED');

    conn.onClose?.(() => {
      if (sessionId !== null) this.ctx.sessions.close(sessionId);
    });

    const groupsFor = (username: string): string[] =>
      domainGroups ?? this.ctx.userMgr.getGroupsForUser(username).map(g => g.name);

    const permissionFor = (shareName: string): SharePermission | null => {
      const share = this.ctx.shares.get(shareName);
      if (!share || !user) return null;
      return this.ctx.shares.permissionFor(share, user, groupsFor(user));
    };

    const openTree = (parsed: Record<string, unknown>): OpenTree | null => {
      if (!user) { denyAccess(); return null; }
      const tree = trees.get(Number(parsed.treeId));
      if (!tree) { refuse('STATUS_NETWORK_NAME_DELETED'); return null; }
      const share = this.ctx.shares.get(tree.shareName)!;
      const perm = permissionFor(share.name);
      if (!perm) { denyAccess(); return null; }
      return { share, user, groups: groupsFor(user), canWrite: perm !== 'Read' };
    };

    const openWritableTree = (parsed: Record<string, unknown>): OpenTree | null => {
      const tree = openTree(parsed);
      if (tree && !tree.canWrite) { denyAccess(); return null; }
      return tree;
    };

    const locate = (tree: OpenTree, requested: unknown): Located | null => {
      const target = shareTarget(tree.share.path, requested);
      if (target.ok === false) { refuse(target.status); return null; }
      return target;
    };

    const absentStatus = (located: Located): SmbStatus => {
      const parent = this.ctx.fs.resolve(located.parent);
      return parent && parent.type === 'directory' ? 'STATUS_OBJECT_NAME_NOT_FOUND' : 'STATUS_OBJECT_PATH_NOT_FOUND';
    };

    const existing = (located: Located): WinFSEntry | null => {
      const entry = this.ctx.fs.resolve(located.abs);
      if (!entry) refuse(absentStatus(located));
      return entry;
    };

    const parentDirectory = (located: Located): boolean => {
      const parent = this.ctx.fs.resolve(located.parent);
      if (parent && parent.type === 'directory') return true;
      refuse('STATUS_OBJECT_PATH_NOT_FOUND');
      return false;
    };

    const mayWrite = (tree: OpenTree, abs: string): boolean => this.ctx.fs.checkAccess(abs, tree.user, tree.groups, 'write');

    conn.onData((data) => {
      let parsed: Record<string, unknown>;
      try { parsed = JSON.parse(String(data)) as Record<string, unknown>; } catch { return; }
      const op = parsed.op as string | undefined;
      if (!op) return;

      switch (op) {
        case 'negotiate': {
          reply({ ok: true, dialect: 'SMB 3.1.1' });
          break;
        }

        case 'session_setup': {
          const rawUsername = String(parsed.username ?? '');
          const password = String(parsed.password ?? '');
          const username = stripLocalQualifier(rawUsername, this.ctx.hostname);
          const account = this.ctx.userMgr.getUser(username);
          let authedUser: string | null = null;
          let authedGroups: string[] | null = null;
          if (account && account.enabled && this.ctx.userMgr.checkPassword(username, password)) {
            authedUser = username;
          } else {
            const domain = this.ctx.domainAuth?.(rawUsername, password);
            if (domain?.ok) { authedUser = domain.sam; authedGroups = domain.groups; }
          }
          if (!authedUser) {
            reply({ ok: false, status: 'STATUS_LOGON_FAILURE', message: 'The user name or password is incorrect.' });
            return;
          }
          user = authedUser;
          domainGroups = authedGroups;
          sessionId = this.ctx.sessions.open(clientComputerName, clientIp, user, this.ctx.now());
          reply({ ok: true, sessionId });
          break;
        }

        case 'tree_connect': {
          if (!user) { denyAccess(); return; }
          const shareName = String(parsed.share ?? '');
          const share = this.ctx.shares.get(shareName);
          if (!share) {
            reply({ ok: false, status: 'STATUS_BAD_NETWORK_NAME', message: 'The network name cannot be found.' });
            return;
          }
          const perm = permissionFor(share.name);
          if (!perm) { denyAccess(); return; }
          const treeId = nextTreeId++;
          trees.set(treeId, { shareName: share.name });
          if (sessionId !== null) {
            this.ctx.sessions.addShare(sessionId, share.name);
            this.ctx.sessions.recordOpen(sessionId);
          }
          reply({ ok: true, treeId });
          break;
        }

        case 'tree_disconnect': {
          const treeId = Number(parsed.treeId);
          const tree = trees.get(treeId);
          if (tree && sessionId !== null) this.ctx.sessions.removeShare(sessionId, tree.shareName);
          trees.delete(treeId);
          reply({ ok: true });
          break;
        }

        case 'logoff': {
          if (sessionId !== null) { this.ctx.sessions.close(sessionId); sessionId = null; }
          user = null;
          reply({ ok: true });
          break;
        }

        case 'share_enum': {
          if (!user) { denyAccess(); return; }
          const offered = this.ctx.shares.list().map(share => {
            const view = this.ctx.shares.toView(share);
            return {
              name: view.name,
              type: view.name.toUpperCase() === 'IPC$' ? 'IPC' : 'Disk',
              comment: view.description,
              special: view.special,
            };
          });
          reply({ ok: true, shares: offered });
          break;
        }

        case 'dfs_referral': {
          const namespaces = this.ctx.dfsNamespaces?.();
          const asked = String(parsed.path ?? '');
          const targets = namespaces ? referralTargetsFor(namespaces, asked) : [];
          if (targets.length === 0) {
            reply({ ok: false, status: 'STATUS_NOT_FOUND', message: 'The object was not found.' });
            return;
          }
          reply({ ok: true, targets });
          break;
        }

        case 'read': {
          const tree = openTree(parsed); if (!tree) return;
          const located = locate(tree, parsed.path); if (!located) return;
          const entry = existing(located); if (!entry) return;
          if (entry.type === 'directory') { refuse('STATUS_FILE_IS_A_DIRECTORY'); return; }
          if (!this.ctx.fs.checkAccess(located.abs, tree.user, tree.groups, 'read')) { denyAccess(); return; }
          reply({ ok: true, content: entry.content });
          break;
        }

        case 'write': {
          const tree = openWritableTree(parsed); if (!tree) return;
          const located = locate(tree, parsed.path); if (!located) return;
          if (located.root) { refuse('STATUS_FILE_IS_A_DIRECTORY'); return; }
          const current = this.ctx.fs.resolve(located.abs);
          if (current) {
            if (current.type === 'directory') { refuse('STATUS_FILE_IS_A_DIRECTORY'); return; }
            if (current.attributes.has('readonly') || !mayWrite(tree, located.abs)) { denyAccess(); return; }
          } else {
            if (!parentDirectory(located)) return;
            if (!mayWrite(tree, located.parent)) { denyAccess(); return; }
          }
          const result = this.ctx.fs.createFile(located.abs, String(parsed.content ?? ''));
          if (!result.ok) { refuse('STATUS_INVALID_PARAMETER', result.error); return; }
          reply({ ok: true });
          break;
        }

        case 'list': {
          const tree = openTree(parsed); if (!tree) return;
          const located = locate(tree, parsed.path); if (!located) return;
          const entry = existing(located); if (!entry) return;
          if (entry.type !== 'directory') { refuse('STATUS_NOT_A_DIRECTORY'); return; }
          if (!this.ctx.fs.checkAccess(located.abs, tree.user, tree.groups, 'read')) { denyAccess(); return; }
          reply({ ok: true, entries: this.ctx.fs.listDirectory(located.abs).map(({ name, entry: child }) => nodeOf(name, child)) });
          break;
        }

        case 'stat': {
          const tree = openTree(parsed); if (!tree) return;
          const located = locate(tree, parsed.path); if (!located) return;
          const entry = existing(located); if (!entry) return;
          if (!this.ctx.fs.checkAccess(located.abs, tree.user, tree.groups, 'read')) { denyAccess(); return; }
          reply({ ok: true, node: nodeOf(located.root ? '' : entry.name, entry), canonical: relativeTo(tree.share.path, this.ctx.fs.canonicalPath(located.abs)) });
          break;
        }

        case 'mkdir': {
          const tree = openWritableTree(parsed); if (!tree) return;
          const located = locate(tree, parsed.path); if (!located) return;
          if (located.root) { refuse(located.abs.length <= 3 ? 'STATUS_ACCESS_DENIED' : 'STATUS_OBJECT_NAME_COLLISION'); return; }
          if (!parentDirectory(located)) return;
          if (this.ctx.fs.resolve(located.abs)) { refuse('STATUS_OBJECT_NAME_COLLISION'); return; }
          if (!mayWrite(tree, located.parent)) { denyAccess(); return; }
          const result = this.ctx.fs.mkdir(located.abs);
          if (!result.ok) { refuse('STATUS_INVALID_PARAMETER', result.error); return; }
          reply({ ok: true });
          break;
        }

        case 'delete': {
          const tree = openWritableTree(parsed); if (!tree) return;
          const located = locate(tree, parsed.path); if (!located) return;
          if (located.root) { refuse('STATUS_FILE_IS_A_DIRECTORY'); return; }
          const entry = existing(located); if (!entry) return;
          if (entry.type === 'directory') { refuse('STATUS_FILE_IS_A_DIRECTORY'); return; }
          if (!mayWrite(tree, located.parent) && !mayWrite(tree, located.abs)) { denyAccess(); return; }
          if (entry.attributes.has('readonly')) { refuse('STATUS_CANNOT_DELETE'); return; }
          const result = this.ctx.fs.deleteFile(located.abs);
          if (!result.ok) { refuse('STATUS_INVALID_PARAMETER', result.error); return; }
          reply({ ok: true });
          break;
        }

        case 'rmdir': {
          const tree = openWritableTree(parsed); if (!tree) return;
          const located = locate(tree, parsed.path); if (!located) return;
          if (located.root) { denyAccess(); return; }
          const entry = existing(located); if (!entry) return;
          if (entry.type !== 'directory') { refuse('STATUS_NOT_A_DIRECTORY'); return; }
          if (!mayWrite(tree, located.parent) && !mayWrite(tree, located.abs)) { denyAccess(); return; }
          if (entry.children.size > 0) { refuse('STATUS_DIRECTORY_NOT_EMPTY'); return; }
          if (this.ctx.fs.isDirectoryInUse(located.abs)) { refuse('STATUS_SHARING_VIOLATION'); return; }
          const result = this.ctx.fs.rmdir(located.abs);
          if (!result.ok) { refuse('STATUS_INVALID_PARAMETER', result.error); return; }
          reply({ ok: true });
          break;
        }

        case 'rename': {
          const tree = openWritableTree(parsed); if (!tree) return;
          const source = locate(tree, parsed.path); if (!source) return;
          if (source.root) { denyAccess(); return; }
          const entry = existing(source); if (!entry) return;
          const destination = locate(tree, parsed.target); if (!destination) return;
          if (destination.root) { denyAccess(); return; }
          if (!parentDirectory(destination)) return;
          const occupant = this.ctx.fs.resolve(destination.abs);
          const replaces = occupant !== null && occupant !== entry;
          if (replaces && parsed.replace !== true) { refuse('STATUS_OBJECT_NAME_COLLISION'); return; }
          if (replaces && (occupant.type === 'directory' || entry.type === 'directory' || occupant.attributes.has('readonly'))) { denyAccess(); return; }
          const into = `${source.abs.toLowerCase()}\\`;
          if (entry.type === 'directory' && `${destination.abs.toLowerCase()}\\`.startsWith(into)) { refuse('STATUS_INVALID_PARAMETER'); return; }
          if (!mayWrite(tree, source.parent) || !mayWrite(tree, destination.parent)) { denyAccess(); return; }
          if (entry.type === 'directory' && this.ctx.fs.isDirectoryInUse(source.abs)) { refuse('STATUS_SHARING_VIOLATION'); return; }
          if (replaces) this.ctx.fs.deleteFile(destination.abs);
          const leaf = destination.abs.slice(destination.abs.lastIndexOf('\\') + 1);
          const result = occupant === entry
            ? this.ctx.fs.renameEntry(source.abs, leaf)
            : this.ctx.fs.moveFile(source.abs, destination.abs);
          if (!result.ok) { refuse('STATUS_INVALID_PARAMETER', result.error); return; }
          reply({ ok: true });
          break;
        }

        case 'set_attributes': {
          const tree = openWritableTree(parsed); if (!tree) return;
          const located = locate(tree, parsed.path); if (!located) return;
          const entry = existing(located); if (!entry) return;
          if (!mayWrite(tree, located.abs)) { denyAccess(); return; }
          const asked = Array.isArray(parsed.attributes) ? parsed.attributes.map(String) : [];
          if (asked.some(name => !ATTRIBUTE_NAMES.has(name))) { refuse('STATUS_INVALID_PARAMETER'); return; }
          entry.attributes = new Set(asked);
          reply({ ok: true });
          break;
        }

        case 'set_times': {
          const tree = openWritableTree(parsed); if (!tree) return;
          const located = locate(tree, parsed.path); if (!located) return;
          const entry = existing(located); if (!entry) return;
          if (!mayWrite(tree, located.abs)) { denyAccess(); return; }
          const modified = Number(parsed.modified);
          if (!Number.isFinite(modified)) { refuse('STATUS_INVALID_PARAMETER'); return; }
          entry.mtime = new Date(modified);
          reply({ ok: true });
          break;
        }

        case 'volume_info': {
          const tree = openTree(parsed); if (!tree) return;
          if (tree.share.path === '') { refuse('STATUS_OBJECT_NAME_NOT_FOUND'); return; }
          const drive = tree.share.path.charAt(0);
          reply({
            ok: true,
            volume: {
              label: this.ctx.fs.getVolumeLabel(drive),
              serial: this.ctx.fs.getVolumeSerialNumber(drive),
              capacity: this.ctx.fs.getDriveCapacity(drive),
              free: this.ctx.fs.getFreeDiskSpace(drive),
            },
          });
          break;
        }

        default:
          break;
      }
    });
  }
}
