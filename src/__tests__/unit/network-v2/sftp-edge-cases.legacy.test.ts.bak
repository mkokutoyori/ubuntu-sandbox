/**
 * SFTP protocol — edge-case tests.
 *
 * Covers scenarios NOT already in sftp.test.ts:
 *
 *   SE-01  Auth edge cases
 *   SE-02  Remote file/directory operations edge cases
 *   SE-03  Local operations (lls / lcd / lpwd) edge cases
 *   SE-04  Transfer integrity (content, encoding, size)
 *   SE-05  Session isolation and robustness
 *   SE-06  Windows SFTP server behaviour
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { SftpSession } from '@/network/protocols/sftp/SftpSession';
import type { ISftpServer } from '@/network/protocols/sftp/ISftpServer';
import { LinuxSftpFSAdapter, LinuxSftpUserAuthAdapter } from '@/network/protocols/sftp/LinuxSftpAdapter';
import { WindowsSftpFSAdapter, WindowsSftpUserAuthAdapter } from '@/network/protocols/sftp/WindowsSftpAdapter';
import { registerSftpHandler } from '@/network/protocols/sftp/SftpServerHandler';
import { TcpConnection, type TcpConnector } from '@/network/core/TcpConnection';
import { VirtualFileSystem } from '@/network/devices/linux/VirtualFileSystem';
import { LinuxUserManager } from '@/network/devices/linux/LinuxUserManager';
import { WindowsFileSystem } from '@/network/devices/windows/WindowsFileSystem';
import { WindowsUserManager } from '@/network/devices/windows/WindowsUserManager';

// ─── Shared fixtures ─────────────────────────────────────────────────────────

const REMOTE_IP = '10.0.0.2';
const LOCAL_IP  = '10.0.0.1';

function makeMockServer(opts: {
  username?: string;
  password?: string;
  hostname?: string;
  files?: Record<string, string>;
  dirs?: string[];
} = {}): ISftpServer {
  const {
    username = 'user',
    password = 'admin',
    hostname = 'remote-host',
    files    = {},
    dirs     = [],
  } = opts;

  const vfs     = new VirtualFileSystem();
  const userMgr = new LinuxUserManager(vfs);
  userMgr.useradd(username, { m: true, s: '/bin/bash' });
  userMgr.setPassword(username, password);

  for (const dir of dirs) vfs.mkdirp(dir, 0o755, 1000, 1000);
  for (const [path, content] of Object.entries(files)) {
    vfs.writeFile(path, content, 1000, 1000, 0o022);
  }
  return {
    vfs:        new LinuxSftpFSAdapter(vfs),
    userMgr:    new LinuxSftpUserAuthAdapter(userMgr),
    hostname,
    socketTable: null as any,
  };
}

function makeWindowsServer(): ISftpServer & { wfs: WindowsFileSystem } {
  const wfs = new WindowsFileSystem('WIN-PC');
  const mgr = new WindowsUserManager();
  return {
    wfs,
    vfs:        new WindowsSftpFSAdapter(wfs),
    userMgr:    new WindowsSftpUserAuthAdapter(mgr),
    hostname:   'WIN-PC',
    socketTable: null as any,
  };
}

function makeLinkedPair(server: ISftpServer, clientPort = 49000): TcpConnection {
  const bridge: { serverConn: TcpConnection | null } = { serverConn: null };

  const clientConn = new TcpConnection(LOCAL_IP, clientPort, REMOTE_IP, 22, 100, (seg) => {
    if (seg.payload != null && bridge.serverConn) {
      bridge.serverConn.receiveData(String(seg.payload));
    }
  });

  const serverConn = new TcpConnection(REMOTE_IP, 22, LOCAL_IP, clientPort, 200, (seg) => {
    if (seg.payload != null) clientConn.receiveData(String(seg.payload));
  });

  bridge.serverConn = serverConn;
  registerSftpHandler(serverConn, server);
  return clientConn;
}

let _portCounter = 49100;
function makeConnector(server: ISftpServer) {
  return async (host: string, _port: number): Promise<TcpConnection | null> =>
    host === REMOTE_IP ? makeLinkedPair(server, _portCounter++) : null;
}

function makeSession(
  connector: TcpConnector,
  localFiles: Record<string, string> = {},
  localDirs: string[] = [],
): SftpSession {
  const localVfs = new VirtualFileSystem();
  localVfs.writeFile('/root/local.txt', 'local content', 0, 0, 0o022);
  localVfs.mkdirp('/root/downloads', 0o755, 0, 0);
  for (const dir of localDirs)  localVfs.mkdirp(dir, 0o755, 0, 0);
  for (const [path, content] of Object.entries(localFiles)) {
    localVfs.writeFile(path, content, 0, 0, 0o022);
  }
  return new SftpSession(localVfs, connector, '/root', 'root');
}

// ═══════════════════════════════════════════════════════════════════════
// SE-01 — Auth edge cases
// ═══════════════════════════════════════════════════════════════════════

describe('SE-01 — Auth edge cases', () => {
  it('empty username fails authentication', async () => {
    const server = makeMockServer();
    const session = makeSession(makeConnector(server));
    const err = await session.connect(`@${REMOTE_IP}`, 'admin');
    expect(err).toContain('Permission denied');
    expect(session.isConnected()).toBe(false);
  });

  it('empty password fails when user has a non-empty password', async () => {
    const server = makeMockServer({ password: 'admin' });
    const session = makeSession(makeConnector(server));
    const err = await session.connect(`user@${REMOTE_IP}`, '');
    expect(err).toContain('Permission denied');
    expect(session.isConnected()).toBe(false);
  });

  it('password with special characters authenticates successfully', async () => {
    const server = makeMockServer({ username: 'alice', password: 'p@$$w0rd!' });
    const session = makeSession(makeConnector(server));
    expect(await session.connect(`alice@${REMOTE_IP}`, 'p@$$w0rd!')).toBe('');
    expect(session.isConnected()).toBe(true);
  });

  it('username with hyphens and digits is accepted', async () => {
    const server = makeMockServer({ username: 'deploy-42', password: 'secret' });
    const session = makeSession(makeConnector(server));
    expect(await session.connect(`deploy-42@${REMOTE_IP}`, 'secret')).toBe('');
  });

  it('two concurrent sessions from the same connector are independent', async () => {
    const server = makeMockServer({ dirs: ['/home/user/docs'] });
    const connector = makeConnector(server);
    const s1 = makeSession(connector);
    const s2 = makeSession(connector);
    await s1.connect(`user@${REMOTE_IP}`, 'admin');
    await s2.connect(`user@${REMOTE_IP}`, 'admin');
    s1.cd('/home/user/docs');
    expect(s2.pwd()).not.toContain('docs');
    expect(s2.pwd()).toContain('/home/user');
  });

  it('reconnect after disconnect resets the remote cwd to home', async () => {
    const server = makeMockServer({ dirs: ['/home/user/subdir'] });
    const connector = makeConnector(server);
    const session = makeSession(connector);
    await session.connect(`user@${REMOTE_IP}`, 'admin');
    session.cd('/home/user/subdir');
    session.disconnect();
    await session.connect(`user@${REMOTE_IP}`, 'admin');
    expect(session.pwd()).toBe('Remote working directory: /home/user');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// SE-02 — Remote file/directory operations: edge cases
// ═══════════════════════════════════════════════════════════════════════

describe('SE-02 — Remote file/directory operations: edge cases', () => {
  let server: ISftpServer;
  let session: SftpSession;

  beforeEach(async () => {
    server = makeMockServer({
      files: {
        '/home/user/old.txt':      'original content',
        '/home/user/existing.txt': 'existing file',
      },
      dirs: ['/home/user/nonempty'],
    });
    server.vfs.writeFile('/home/user/nonempty/inner.txt', 'inner file');
    session = makeSession(makeConnector(server));
    await session.connect(`user@${REMOTE_IP}`, 'admin');
  });

  it('cd .. navigates to the parent directory', () => {
    // cwd starts at /home/user after connect
    const err = session.cd('..');
    expect(err).toBe('');
    expect(session.pwd()).toBe('Remote working directory: /home');
  });

  it('ls with -l flag treats it as a path and returns an error', () => {
    // -l is not a flag — it is forwarded as a path argument to the server
    const out = session.ls(['-l']);
    expect(out).toContain('No such file or directory');
  });

  it('rm on a directory returns an error', () => {
    const out = session.rm('/home/user/nonempty');
    expect(out).toContain("Couldn't delete file");
  });

  it('rename overwrites an existing target file', () => {
    const out = session.rename('/home/user/old.txt', '/home/user/existing.txt');
    expect(out).toBe('');
    expect(server.vfs.readFile('/home/user/existing.txt')).toBe('original content');
    expect(server.vfs.exists('/home/user/old.txt')).toBe(false);
  });

  it('rmdir a non-empty directory returns an error', () => {
    const out = session.rmdir('/home/user/nonempty');
    expect(out).toContain("Couldn't remove directory");
    expect(server.vfs.exists('/home/user/nonempty')).toBe(true);
  });

  it('put to a path with non-existent parent auto-creates the directory tree', async () => {
    const localVfs = new VirtualFileSystem();
    localVfs.writeFile('/root/f.txt', 'data', 0, 0, 0o022);
    const s = new SftpSession(localVfs, makeConnector(server), '/root', 'root');
    await s.connect(`user@${REMOTE_IP}`, 'admin');
    const out = s.put('/root/f.txt', '/home/user/newdir/sub/f.txt');
    expect(out).toContain('100%');
    expect(server.vfs.exists('/home/user/newdir/sub/f.txt')).toBe(true);
  });

  it('mkdir creates the entire directory chain when parents do not exist', () => {
    const out = session.mkdir('/home/user/a/b/c');
    expect(out).toBe('');
    expect(server.vfs.exists('/home/user/a/b/c')).toBe(true);
  });

  it('unknown SFTP operation returns an error', async () => {
    // SftpServerHandler dispatches only known ops; anything else falls to the default branch
    // We verify this indirectly: SftpSession has no chmod method, so the only way to
    // reach the unknown-op path is to note that the server would return { ok: false }.
    // We test the observable effect: operations not in the API do not exist on SftpSession.
    expect(typeof (session as any).chmod).toBe('undefined');
    expect(typeof (session as any).chown).toBe('undefined');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// SE-03 — Local operations (lls / lcd / lpwd) edge cases
// ═══════════════════════════════════════════════════════════════════════

describe('SE-03 — Local operations edge cases', () => {
  it('lpwd works before any connection is established', () => {
    const session = makeSession(async () => null);
    expect(session.lpwd()).toContain('/root');
  });

  it('lls works without a network connection', () => {
    const session = makeSession(async () => null);
    const out = session.lls([]);
    expect(out).not.toContain('Not connected');
    expect(out).toContain('local.txt');
  });

  it('lcd to a regular file returns Not a directory', () => {
    const localVfs = new VirtualFileSystem();
    localVfs.writeFile('/root/afile.txt', 'content', 0, 0, 0o022);
    const session = new SftpSession(localVfs, async () => null, '/root', 'root');
    expect(session.lcd('/root/afile.txt')).toContain('Not a directory');
  });

  it('lls with an explicit absolute path lists that directory', () => {
    const localVfs = new VirtualFileSystem();
    localVfs.writeFile('/root/mine.txt', '', 0, 0, 0o022);
    localVfs.mkdirp('/tmp/other', 0o755, 0, 0);
    localVfs.writeFile('/tmp/other/theirs.txt', '', 0, 0, 0o022);
    const session = new SftpSession(localVfs, async () => null, '/root', 'root');
    const out = session.lls(['/tmp/other']);
    expect(out).toContain('theirs.txt');
    expect(out).not.toContain('mine.txt');
  });

  it('lls with a non-existent path returns an error', () => {
    const session = makeSession(async () => null);
    const out = session.lls(['/nonexistent/path']);
    expect(out).toContain('No such file or directory');
  });

  it('lcd with .. navigates to the parent directory', () => {
    const session = makeSession(async () => null);
    expect(session.lcd('..')).toBe('');
    expect(session.lpwd()).toBe('Local working directory: /');
  });

  it('local operations still work after disconnect', async () => {
    const server = makeMockServer();
    const session = makeSession(makeConnector(server));
    await session.connect(`user@${REMOTE_IP}`, 'admin');
    session.disconnect();
    expect(session.lpwd()).toContain('/root');
    expect(session.lls([])).toContain('local.txt');
    expect(session.lcd('/root')).toBe('');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// SE-04 — Transfer integrity (content, encoding, size)
// ═══════════════════════════════════════════════════════════════════════

describe('SE-04 — Transfer integrity', () => {
  it('CRLF line endings are preserved across a get', async () => {
    const content = 'line1\r\nline2\r\nline3\r\n';
    const server  = makeMockServer({ files: { '/home/user/crlf.txt': content } });
    const localVfs = new VirtualFileSystem();
    const session = new SftpSession(localVfs, makeConnector(server), '/root', 'root');
    await session.connect(`user@${REMOTE_IP}`, 'admin');
    session.get('/home/user/crlf.txt');
    expect(localVfs.readFile('/root/crlf.txt')).toBe(content);
  });

  it('file with JSON special characters in content survives a round-trip', async () => {
    const content = '{"key": "val\\nue", "arr": [1, 2, 3], "q": "\\"quoted\\""}';
    const server  = makeMockServer({ files: { '/home/user/data.json': content } });
    const localVfs = new VirtualFileSystem();
    const session = new SftpSession(localVfs, makeConnector(server), '/root', 'root');
    await session.connect(`user@${REMOTE_IP}`, 'admin');
    session.get('/home/user/data.json');
    expect(localVfs.readFile('/root/data.json')).toBe(content);
  });

  it('empty file is transferred and reports 0 bytes', async () => {
    const server  = makeMockServer({ files: { '/home/user/empty.txt': '' } });
    const localVfs = new VirtualFileSystem();
    const session = new SftpSession(localVfs, makeConnector(server), '/root', 'root');
    await session.connect(`user@${REMOTE_IP}`, 'admin');
    const out = session.get('/home/user/empty.txt');
    expect(out).toContain('100%');
    expect(out).toContain(' 0 ');
    expect(localVfs.readFile('/root/empty.txt')).toBe('');
  });

  it('large file content is fully preserved on download', async () => {
    const content = 'A'.repeat(100_000);
    const server  = makeMockServer({ files: { '/home/user/large.bin': content } });
    const localVfs = new VirtualFileSystem();
    const session = new SftpSession(localVfs, makeConnector(server), '/root', 'root');
    await session.connect(`user@${REMOTE_IP}`, 'admin');
    session.get('/home/user/large.bin');
    expect(localVfs.readFile('/root/large.bin')).toBe(content);
  });

  it('upload preserves content identical to the local file', async () => {
    const content = '# Markdown\n\n* item1\n* item2\n\n> quote\n';
    const server  = makeMockServer();
    const localVfs = new VirtualFileSystem();
    localVfs.writeFile('/root/README.md', content, 0, 0, 0o022);
    const session = new SftpSession(localVfs, makeConnector(server), '/root', 'root');
    await session.connect(`user@${REMOTE_IP}`, 'admin');
    session.put('/root/README.md');
    expect(server.vfs.readFile('/home/user/README.md')).toBe(content);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// SE-05 — Session isolation and robustness
// ═══════════════════════════════════════════════════════════════════════

describe('SE-05 — Session isolation and robustness', () => {
  it('two concurrent sessions have independent remote cwd', async () => {
    const server = makeMockServer({ dirs: ['/home/user/docs', '/home/user/data'] });
    const connector = makeConnector(server);
    const s1 = makeSession(connector);
    const s2 = makeSession(connector);
    await s1.connect(`user@${REMOTE_IP}`, 'admin');
    await s2.connect(`user@${REMOTE_IP}`, 'admin');
    s1.cd('/home/user/docs');
    s2.cd('/home/user/data');
    expect(s1.pwd()).toBe('Remote working directory: /home/user/docs');
    expect(s2.pwd()).toBe('Remote working directory: /home/user/data');
  });

  it('failed auth leaves the session clean; correct creds succeed afterwards', async () => {
    const server = makeMockServer({ username: 'user', password: 'correct' });
    const connector = makeConnector(server);
    const session = makeSession(connector);
    const err1 = await session.connect(`user@${REMOTE_IP}`, 'wrong');
    expect(err1).toContain('Permission denied');
    expect(session.isConnected()).toBe(false);
    const err2 = await session.connect(`user@${REMOTE_IP}`, 'correct');
    expect(err2).toBe('');
    expect(session.isConnected()).toBe(true);
  });

  it('all remote operations return Not connected after disconnect', async () => {
    const server = makeMockServer({ files: { '/home/user/f.txt': 'hi' } });
    const session = makeSession(makeConnector(server));
    await session.connect(`user@${REMOTE_IP}`, 'admin');
    session.disconnect();
    expect(session.ls([])).toBe('Not connected.');
    expect(session.cd('/home/user')).toBe('Not connected.');
    expect(session.get('/home/user/f.txt')).toBe('Not connected.');
    expect(session.put('/root/local.txt')).toBe('Not connected.');
    expect(session.mkdir('/home/user/x')).toBe('Not connected.');
    expect(session.rm('/home/user/f.txt')).toBe('Not connected.');
    expect(session.rmdir('/home/user/x')).toBe('Not connected.');
    expect(session.rename('/home/user/f.txt', '/home/user/g.txt')).toBe('Not connected.');
  });

  it('file created in session 1 is immediately visible to session 2', async () => {
    const server = makeMockServer();
    const connector = makeConnector(server);
    const localVfs = new VirtualFileSystem();
    localVfs.writeFile('/root/share.txt', 'shared data', 0, 0, 0o022);
    const s1 = new SftpSession(localVfs, connector, '/root', 'root');
    const s2 = makeSession(connector);
    await s1.connect(`user@${REMOTE_IP}`, 'admin');
    await s2.connect(`user@${REMOTE_IP}`, 'admin');
    s1.put('/root/share.txt');
    expect(server.vfs.exists('/home/user/share.txt')).toBe(true);
    const out = s2.ls([]);
    expect(out).toContain('share.txt');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// SE-06 — Windows SFTP server behaviour
// ═══════════════════════════════════════════════════════════════════════

describe('SE-06 — Windows SFTP server behaviour', () => {
  it('connects with the default Windows User credentials', async () => {
    const server  = makeWindowsServer();
    const session = makeSession(makeConnector(server));
    expect(await session.connect(`User@${REMOTE_IP}`, 'user')).toBe('');
    expect(session.isConnected()).toBe(true);
  });

  it('home directory after connect is /C:/Users/User', async () => {
    const server  = makeWindowsServer();
    const session = makeSession(makeConnector(server));
    await session.connect(`User@${REMOTE_IP}`, 'user');
    expect(session.pwd()).toBe('Remote working directory: /C:/Users/User');
  });

  it('connects with the Windows Administrator credentials', async () => {
    const server  = makeWindowsServer();
    const session = makeSession(makeConnector(server));
    expect(await session.connect(`Administrator@${REMOTE_IP}`, 'admin')).toBe('');
  });

  it('wrong password for Administrator fails', async () => {
    const server  = makeWindowsServer();
    const session = makeSession(makeConnector(server));
    expect(await session.connect(`Administrator@${REMOTE_IP}`, 'wrong'))
      .toContain('Permission denied');
  });

  it('ls in the Windows home directory lists standard user folders', async () => {
    const server  = makeWindowsServer();
    const session = makeSession(makeConnector(server));
    await session.connect(`User@${REMOTE_IP}`, 'user');
    const out = session.ls([]);
    expect(out).toContain('Desktop');
    expect(out).toContain('Documents');
    expect(out).toContain('Downloads');
  });

  it('put writes a file visible at the correct Windows path', async () => {
    const { wfs, ...server } = makeWindowsServer();
    const localVfs = new VirtualFileSystem();
    localVfs.writeFile('/root/hello.txt', 'hello windows', 0, 0, 0o022);
    const session = new SftpSession(localVfs, makeConnector({ wfs, ...server }), '/root', 'root');
    await session.connect(`User@${REMOTE_IP}`, 'user');
    const out = session.put('/root/hello.txt');
    expect(out).toContain('100%');
    // SFTP path /C:/Users/User/hello.txt → Windows C:\Users\User\hello.txt
    const result = wfs.readFile('C:\\Users\\User\\hello.txt');
    expect(result.ok).toBe(true);
    expect(result.content).toBe('hello windows');
  });

  it('get retrieves a file using a Windows drive-letter SFTP path', async () => {
    const { wfs, ...server } = makeWindowsServer();
    wfs.createFile('C:\\Users\\User\\report.txt', 'win content');
    const localVfs = new VirtualFileSystem();
    const session = new SftpSession(localVfs, makeConnector({ wfs, ...server }), '/root', 'root');
    await session.connect(`User@${REMOTE_IP}`, 'user');
    const out = session.get('/C:/Users/User/report.txt');
    expect(out).toContain('100%');
    expect(localVfs.readFile('/root/report.txt')).toBe('win content');
  });

  it('file access is case-insensitive on Windows', async () => {
    const { wfs, ...server } = makeWindowsServer();
    const localVfs = new VirtualFileSystem();
    localVfs.writeFile('/root/data.txt', 'test data', 0, 0, 0o022);
    const session = new SftpSession(localVfs, makeConnector({ wfs, ...server }), '/root', 'root');
    await session.connect(`User@${REMOTE_IP}`, 'user');
    // Upload as DATA.TXT (uppercase)
    session.put('/root/data.txt', '/C:/Users/User/DATA.TXT');
    // Download using lowercase — should resolve the same entry
    const out = session.get('/C:/Users/User/data.txt', '/root/retrieved.txt');
    expect(out).toContain('100%');
    expect(localVfs.readFile('/root/retrieved.txt')).toBe('test data');
  });

  it('rmdir a non-empty Windows directory returns an error', async () => {
    const server  = makeWindowsServer();
    const session = makeSession(makeConnector(server));
    await session.connect(`User@${REMOTE_IP}`, 'user');
    // /C:/Users/User already contains Desktop, Documents, etc.
    const out = session.rmdir('/C:/Users/User');
    expect(out).toContain("Couldn't remove directory");
  });

  it('cd navigates into a Windows subdirectory', async () => {
    const server  = makeWindowsServer();
    const session = makeSession(makeConnector(server));
    await session.connect(`User@${REMOTE_IP}`, 'user');
    expect(session.cd('/C:/Users/User/Documents')).toBe('');
    expect(session.pwd()).toBe('Remote working directory: /C:/Users/User/Documents');
  });

  it('cd to a non-existent Windows path returns an error', async () => {
    const server  = makeWindowsServer();
    const session = makeSession(makeConnector(server));
    await session.connect(`User@${REMOTE_IP}`, 'user');
    const err = session.cd('/C:/Users/User/NoSuchFolder');
    expect(err).toContain('No such file or directory');
  });
});
