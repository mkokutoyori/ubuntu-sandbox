/**
 * SftpServerHandler — JSON-over-TCP SFTP server handler.
 *
 * Registers an SFTP session handler on an EndHost's TCP port 22.
 * Each incoming connection gets its own state (authenticated flag, cwd).
 * Requests and responses are JSON-encoded:
 *
 *   Request:  { op: 'auth', user: 'root', password: 'root' }
 *   Response: { ok: true, cwd: '/root' }
 *
 *   Request:  { op: 'get', path: 'report.txt' }
 *   Response: { ok: true, content: '...' }
 *
 * Because the simulator's cable/switch/router delivery is synchronous,
 * conn.write(request) returns only AFTER the server's onData fires and the
 * server has already written the response — which means the client's onData
 * fires before write() returns.  Hence sendRequest() can be synchronous.
 */

import type { TcpConnection } from '@/network/core/TcpConnection';
import type { ISftpServer } from './ISftpServer';

interface SftpReq { op: string; [key: string]: unknown }
interface SftpResp { ok: boolean; [key: string]: unknown }

/** Register a per-connection SFTP handler on the given TcpConnection (server side). */
export function registerSftpHandler(conn: TcpConnection, server: ISftpServer): void {
  let authenticated = false;
  let cwd = '/';

  conn.onData((data: string) => {
    let req: SftpReq;
    try {
      req = JSON.parse(data) as SftpReq;
    } catch {
      conn.write(JSON.stringify({ ok: false, error: 'parse error' }));
      return;
    }

    const resp = dispatchSftp(req, server, authenticated, cwd);

    if (req.op === 'auth' && resp.ok) {
      authenticated = true;
      if (typeof resp.cwd === 'string') cwd = resp.cwd;
    }
    if (req.op === 'cd' && resp.ok && typeof resp.cwd === 'string') cwd = resp.cwd;

    conn.write(JSON.stringify(resp));
  });
}

function dispatchSftp(
  req: SftpReq,
  server: ISftpServer,
  authenticated: boolean,
  cwd: string,
): SftpResp {
  const { op } = req;

  // ── Authentication ─────────────────────────────────────────────
  if (op === 'auth') {
    const user     = String(req.user ?? '');
    const password = String(req.password ?? '');
    if (!server.userMgr.checkPassword(user, password)) {
      return { ok: false, error: 'Permission denied' };
    }
    return { ok: true, cwd: server.userMgr.getHomeDirectory(user) };
  }

  if (!authenticated) return { ok: false, error: 'Not authenticated' };

  // ── File-system operations ─────────────────────────────────────
  switch (op) {
    case 'ls': {
      const path = req.path != null
        ? server.vfs.normalizePath(String(req.path), cwd)
        : cwd;
      const entries = server.vfs.listDirectory(path);
      if (!entries) return { ok: false, error: `${path}: No such file or directory` };
      return { ok: true, entries: entries.map(e => e.name) };
    }

    case 'cd': {
      const abs  = server.vfs.normalizePath(String(req.path ?? ''), cwd);
      const type = server.vfs.getEntryType(abs);
      if (!type)               return { ok: false, error: 'No such file or directory' };
      if (type !== 'directory') return { ok: false, error: 'Not a directory' };
      return { ok: true, cwd: abs };
    }

    case 'pwd':
      return { ok: true, cwd };

    case 'get': {
      const abs  = server.vfs.normalizePath(String(req.path ?? ''), cwd);
      const type = server.vfs.getEntryType(abs);
      if (!type)               return { ok: false, error: `${abs}: No such file or directory` };
      if (type !== 'file')     return { ok: false, error: `${abs}: not a regular file` };
      return { ok: true, content: server.vfs.readFile(abs) ?? '' };
    }

    case 'put': {
      const abs     = server.vfs.normalizePath(String(req.path ?? ''), cwd);
      const content = String(req.content ?? '');
      server.vfs.writeFile(abs, content);
      return { ok: true };
    }

    case 'mkdir': {
      const abs = server.vfs.normalizePath(String(req.path ?? ''), cwd);
      if (server.vfs.exists(abs)) return { ok: false, error: 'File exists' };
      server.vfs.mkdirp(abs);
      return { ok: true };
    }

    case 'rm': {
      const abs  = server.vfs.normalizePath(String(req.path ?? ''), cwd);
      const type = server.vfs.getEntryType(abs);
      if (!type) return { ok: false, error: `${abs}: No such file or directory` };
      if (!server.vfs.deleteFile(abs)) return { ok: false, error: `Couldn't delete file` };
      return { ok: true };
    }

    case 'rmdir': {
      const abs  = server.vfs.normalizePath(String(req.path ?? ''), cwd);
      const type = server.vfs.getEntryType(abs);
      if (!type)               return { ok: false, error: `${abs}: No such file or directory` };
      if (type !== 'directory') return { ok: false, error: `${abs}: Not a directory` };
      if (!server.vfs.rmdir(abs)) return { ok: false, error: `Couldn't remove directory` };
      return { ok: true };
    }

    case 'rename': {
      const absOld = server.vfs.normalizePath(String(req.old ?? ''), cwd);
      const absNew = server.vfs.normalizePath(String(req.new ?? ''), cwd);
      const type   = server.vfs.getEntryType(absOld);
      if (!type) return { ok: false, error: `${absOld}: No such file or directory` };
      if (!server.vfs.rename(absOld, absNew)) return { ok: false, error: `Couldn't rename file` };
      return { ok: true };
    }

    default:
      return { ok: false, error: `Unknown op: ${op}` };
  }
}
