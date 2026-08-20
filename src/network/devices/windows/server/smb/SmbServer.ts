/**
 * SmbServerHandler — server-side endpoint registered on TCP port 445
 * (PRD-Windows-Server.md §5 P3). Mirrors `SshServerHandler`'s shape: a
 * fresh handler per accepted connection (`WindowsPC.getSmbServerHandler()`),
 * dispatching JSON ops over the real `TcpConnection`. Session bookkeeping
 * that must survive across connections lives in the shared
 * `SmbSessionTable` passed in via the context, not on this handler.
 */

import type { TcpStream as TcpConnection } from '@/network/tcp/types';
import type { WindowsFileSystem } from '../../WindowsFileSystem';
import type { WindowsUserManager } from '../../WindowsUserManager';
import type { SmbShareTable } from './SmbShareTable';
import type { SmbSessionTable } from './SmbSessionTable';
import type { SharePermission } from './SmbTypes';

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
}

interface TreeInfo { shareName: string }

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
    const denyAccess = () => reply({ ok: false, status: 'STATUS_ACCESS_DENIED', message: 'Access is denied.' });

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

        case 'read': {
          if (!user) { denyAccess(); return; }
          const tree = trees.get(Number(parsed.treeId));
          if (!tree) {
            reply({ ok: false, status: 'STATUS_NETWORK_NAME_DELETED', message: 'The specified network name is no longer available.' });
            return;
          }
          const share = this.ctx.shares.get(tree.shareName)!;
          const perm = permissionFor(share.name);
          if (!perm) { denyAccess(); return; }
          const absPath = this.ctx.fs.normalizePath(String(parsed.path ?? ''), share.path);
          const groups = groupsFor(user);
          if (!this.ctx.fs.checkAccess(absPath, user, groups, 'read')) { denyAccess(); return; }
          const result = this.ctx.fs.readFile(absPath);
          if (!result.ok) {
            reply({ ok: false, status: 'STATUS_OBJECT_NAME_NOT_FOUND', message: result.error ?? 'The system cannot find the file specified.' });
            return;
          }
          reply({ ok: true, content: result.content ?? '' });
          break;
        }

        case 'write': {
          if (!user) { denyAccess(); return; }
          const tree = trees.get(Number(parsed.treeId));
          if (!tree) {
            reply({ ok: false, status: 'STATUS_NETWORK_NAME_DELETED', message: 'The specified network name is no longer available.' });
            return;
          }
          const share = this.ctx.shares.get(tree.shareName)!;
          const perm = permissionFor(share.name);
          if (!perm || perm === 'Read') { denyAccess(); return; }
          const absPath = this.ctx.fs.normalizePath(String(parsed.path ?? ''), share.path);
          const groups = groupsFor(user);
          if (!this.ctx.fs.checkAccess(absPath, user, groups, 'write')) { denyAccess(); return; }
          const result = this.ctx.fs.createFile(absPath, String(parsed.content ?? ''));
          if (!result.ok) {
            reply({ ok: false, status: 'STATUS_OBJECT_PATH_NOT_FOUND', message: result.error ?? 'The system cannot find the path specified.' });
            return;
          }
          reply({ ok: true });
          break;
        }

        case 'list': {
          if (!user) { denyAccess(); return; }
          const tree = trees.get(Number(parsed.treeId));
          if (!tree) {
            reply({ ok: false, status: 'STATUS_NETWORK_NAME_DELETED', message: 'The specified network name is no longer available.' });
            return;
          }
          const share = this.ctx.shares.get(tree.shareName)!;
          const perm = permissionFor(share.name);
          if (!perm) { denyAccess(); return; }
          const rawPath = String(parsed.path ?? '');
          const absPath = rawPath ? this.ctx.fs.normalizePath(rawPath, share.path) : share.path;
          const groups = groupsFor(user);
          if (!this.ctx.fs.checkAccess(absPath, user, groups, 'read')) { denyAccess(); return; }
          const entries = this.ctx.fs.listDirectory(absPath).map(({ name, entry }) => ({
            name, isDirectory: entry.type === 'directory', size: entry.size,
          }));
          reply({ ok: true, entries });
          break;
        }

        default:
          break;
      }
    });
  }
}
