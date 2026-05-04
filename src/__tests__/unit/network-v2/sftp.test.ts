/**
 * SFTP protocol — TDD tests.
 *
 * Covers:
 *   SF-01  SftpSession — connect / disconnect
 *   SF-02  SftpSession — remote navigation (pwd / ls / cd)
 *   SF-03  SftpSession — local navigation  (lpwd / lls / lcd)
 *   SF-04  SftpSession — get (download)
 *   SF-05  SftpSession — put  (upload)
 *   SF-06  SftpSession — remote file operations (mkdir / rm / rmdir / rename)
 *   SF-07  sftp command — non-interactive batch transfer
 *   SF-08  SftpSession — socket table integration
 *   SF-09  SftpSubShell — processLine (interactive sub-shell commands)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { SftpSession } from '@/network/protocols/sftp/SftpSession';
import type { ISftpServer, SftpServerResolver } from '@/network/protocols/sftp/ISftpServer';
import { LinuxSftpFSAdapter, LinuxSftpUserAuthAdapter } from '@/network/protocols/sftp/LinuxSftpAdapter';
import { SftpSubShell } from '@/terminal/subshells/SftpSubShell';
import { VirtualFileSystem } from '@/network/devices/linux/VirtualFileSystem';
import { LinuxUserManager } from '@/network/devices/linux/LinuxUserManager';
import { SocketTable } from '@/network/core/SocketTable';

// ─── Test fixtures ───────────────────────────────────────────────────────────

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

  for (const dir of dirs) {
    vfs.mkdirp(dir, 0o755, 1000, 1000);
  }
  for (const [path, content] of Object.entries(files)) {
    vfs.writeFile(path, content, 1000, 1000, 0o022);
  }
  return {
    vfs:         new LinuxSftpFSAdapter(vfs),
    userMgr:     new LinuxSftpUserAuthAdapter(userMgr),
    hostname,
    socketTable: new SocketTable(),
  };
}

/** Build a resolver that returns `server` for `REMOTE_IP`, null otherwise. */
function makeResolver(server: ISftpServer): SftpServerResolver {
  return (ip: string) => (ip === REMOTE_IP ? server : null);
}

function makeSession(
  resolver: SftpServerResolver,
  localFiles: Record<string, string> = {},
  localDirs: string[] = [],
): SftpSession {
  const localVfs = new VirtualFileSystem();
  localVfs.writeFile('/root/local.txt', 'local content', 0, 0, 0o022);
  localVfs.mkdirp('/root/downloads', 0o755, 0, 0);
  for (const dir of localDirs) {
    localVfs.mkdirp(dir, 0o755, 0, 0);
  }
  for (const [path, content] of Object.entries(localFiles)) {
    localVfs.writeFile(path, content, 0, 0, 0o022);
  }
  const socketTable = new SocketTable();
  return new SftpSession(localVfs, socketTable, resolver, '/root', LOCAL_IP, 'root');
}

// ═══════════════════════════════════════════════════════════════════════
// SF-01 — SftpSession: connect / disconnect
// ═══════════════════════════════════════════════════════════════════════

describe('SF-01 — SftpSession: connect / disconnect', () => {

  it('connects to a known host with correct credentials', () => {
    const server = makeMockServer({ username: 'user', password: 'admin' });
    const session = makeSession(makeResolver(server));
    const err = session.connect(`user@${REMOTE_IP}`, 'admin');
    expect(err).toBe('');
    expect(session.isConnected()).toBe(true);
  });

  it('returns an error for an unknown host', () => {
    const server = makeMockServer();
    const session = makeSession(makeResolver(server));
    const err = session.connect('user@10.0.0.99', 'admin');
    expect(err).toContain('No route to host');
    expect(session.isConnected()).toBe(false);
  });

  it('returns an error for wrong password', () => {
    const server = makeMockServer({ username: 'user', password: 'admin' });
    const session = makeSession(makeResolver(server));
    const err = session.connect(`user@${REMOTE_IP}`, 'wrong');
    expect(err).toContain('Permission denied');
    expect(session.isConnected()).toBe(false);
  });

  it('returns an error for unknown user', () => {
    const server = makeMockServer({ username: 'user', password: 'admin' });
    const session = makeSession(makeResolver(server));
    const err = session.connect(`nobody@${REMOTE_IP}`, 'admin');
    expect(err).toContain('Permission denied');
    expect(session.isConnected()).toBe(false);
  });

  it('disconnect clears the connected state', () => {
    const server = makeMockServer();
    const session = makeSession(makeResolver(server));
    session.connect(`user@${REMOTE_IP}`, 'admin');
    expect(session.isConnected()).toBe(true);
    session.disconnect();
    expect(session.isConnected()).toBe(false);
  });

  it('disconnect when already disconnected is a no-op', () => {
    const session = makeSession(() => null);
    expect(() => session.disconnect()).not.toThrow();
    expect(session.isConnected()).toBe(false);
  });

  it('getPrompt returns "sftp> " when connected', () => {
    const server = makeMockServer();
    const session = makeSession(makeResolver(server));
    session.connect(`user@${REMOTE_IP}`, 'admin');
    expect(session.getPrompt()).toBe('sftp> ');
  });

  it('uses localUser when host-only address is given', () => {
    // makeMockServer already creates 'root' with password 'admin'
    const server = makeMockServer({ username: 'root', password: 'admin' });
    const session = makeSession(makeResolver(server));
    const err = session.connect(REMOTE_IP, 'admin');
    expect(err).toBe('');
    expect(session.isConnected()).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// SF-02 — SftpSession: remote navigation
// ═══════════════════════════════════════════════════════════════════════

describe('SF-02 — SftpSession: remote navigation', () => {
  let session: SftpSession;

  beforeEach(() => {
    const server = makeMockServer({
      files: {
        '/home/user/readme.txt': 'hello',
        '/home/user/data.csv':   'a,b,c',
      },
      dirs: ['/home/user/subdir'],
    });
    session = makeSession(makeResolver(server));
    session.connect(`user@${REMOTE_IP}`, 'admin');
  });

  it('pwd returns the remote home directory after connect', () => {
    const output = session.pwd();
    expect(output).toContain('/home/user');
  });

  it('ls lists files in the remote current directory', () => {
    const output = session.ls([]);
    expect(output).toContain('readme.txt');
    expect(output).toContain('data.csv');
    expect(output).toContain('subdir');
  });

  it('ls with an explicit path lists that directory', () => {
    const output = session.ls(['/home/user/subdir']);
    expect(output).not.toContain('readme.txt');
  });

  it('cd changes the remote current directory', () => {
    const err = session.cd('/home/user/subdir');
    expect(err).toBe('');
    expect(session.pwd()).toContain('/home/user/subdir');
  });

  it('cd to a non-existent directory returns an error', () => {
    const err = session.cd('/home/user/doesnotexist');
    expect(err).toContain('No such file or directory');
  });

  it('cd to a file (not a directory) returns an error', () => {
    const err = session.cd('/home/user/readme.txt');
    expect(err).toContain('Not a directory');
  });

  it('pwd reflects the new path after a cd', () => {
    session.cd('/home/user/subdir');
    expect(session.pwd()).toBe('Remote working directory: /home/user/subdir');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// SF-03 — SftpSession: local navigation
// ═══════════════════════════════════════════════════════════════════════

describe('SF-03 — SftpSession: local navigation', () => {
  let session: SftpSession;

  beforeEach(() => {
    const server = makeMockServer();
    session = makeSession(makeResolver(server), {
      '/root/notes.txt': 'notes',
    }, ['/root/subdir']);
    session.connect(`user@${REMOTE_IP}`, 'admin');
  });

  it('lpwd returns the local working directory', () => {
    const output = session.lpwd();
    expect(output).toContain('/root');
  });

  it('lls lists files in the local current directory', () => {
    const output = session.lls([]);
    expect(output).toContain('local.txt');
    expect(output).toContain('notes.txt');
  });

  it('lcd changes the local working directory', () => {
    const err = session.lcd('/root/subdir');
    expect(err).toBe('');
    expect(session.lpwd()).toContain('/root/subdir');
  });

  it('lcd to a non-existent directory returns an error', () => {
    const err = session.lcd('/root/doesnotexist');
    expect(err).toContain('No such file or directory');
  });

  it('lpwd reflects the new path after lcd', () => {
    session.lcd('/root/subdir');
    const output = session.lpwd();
    expect(output).toContain('/root/subdir');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// SF-04 — SftpSession: get (download)
// ═══════════════════════════════════════════════════════════════════════

describe('SF-04 — SftpSession: get (download)', () => {
  let session: SftpSession;
  let localVfs: VirtualFileSystem;
  let server: ISftpServer;

  beforeEach(() => {
    server = makeMockServer({
      files: {
        '/home/user/report.txt': 'report content',
        '/home/user/data.bin':   'binary data',
      },
    });
    localVfs = new VirtualFileSystem();
    localVfs.mkdirp('/root/downloads', 0o755, 0, 0);
    const socketTable = new SocketTable();
    session = new SftpSession(localVfs, socketTable, makeResolver(server), '/root', LOCAL_IP, 'root');
    session.connect(`user@${REMOTE_IP}`, 'admin');
  });

  it('get downloads a remote file to the local cwd', () => {
    const output = session.get('/home/user/report.txt');
    expect(output).toContain('report.txt');
    expect(output).toContain('100%');
    expect(localVfs.exists('/root/report.txt')).toBe(true);
    expect(localVfs.readFile('/root/report.txt')).toBe('report content');
  });

  it('get with a local path argument saves to the specified location', () => {
    const output = session.get('/home/user/report.txt', '/root/downloads/my-report.txt');
    expect(output).toContain('100%');
    expect(localVfs.exists('/root/downloads/my-report.txt')).toBe(true);
    expect(localVfs.readFile('/root/downloads/my-report.txt')).toBe('report content');
  });

  it('get a relative remote path resolves against remote cwd', () => {
    const output = session.get('report.txt');
    expect(output).toContain('100%');
    expect(localVfs.exists('/root/report.txt')).toBe(true);
  });

  it('get a non-existent remote file returns an error', () => {
    const output = session.get('/home/user/missing.txt');
    expect(output).toContain('No such file or directory');
    expect(localVfs.exists('/root/missing.txt')).toBe(false);
  });

  it('get a directory instead of a file returns an error', () => {
    server.vfs.mkdirp('/home/user/subdir');
    const output = session.get('/home/user/subdir');
    expect(output).toContain('not a regular file');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// SF-05 — SftpSession: put (upload)
// ═══════════════════════════════════════════════════════════════════════

describe('SF-05 — SftpSession: put (upload)', () => {
  let session: SftpSession;
  let localVfs: VirtualFileSystem;
  let server: ISftpServer;

  beforeEach(() => {
    server = makeMockServer({ dirs: ['/home/user/incoming'] });
    localVfs = new VirtualFileSystem();
    localVfs.writeFile('/root/upload.txt', 'upload content', 0, 0, 0o022);
    localVfs.writeFile('/root/data.csv',   'col1,col2\n1,2', 0, 0, 0o022);
    const socketTable = new SocketTable();
    session = new SftpSession(localVfs, socketTable, makeResolver(server), '/root', LOCAL_IP, 'root');
    session.connect(`user@${REMOTE_IP}`, 'admin');
  });

  it('put uploads a local file to the remote cwd', () => {
    const output = session.put('/root/upload.txt');
    expect(output).toContain('upload.txt');
    expect(output).toContain('100%');
    expect(server.vfs.exists('/home/user/upload.txt')).toBe(true);
    expect(server.vfs.readFile('/home/user/upload.txt')).toBe('upload content');
  });

  it('put with a remote path uploads to that location', () => {
    const output = session.put('/root/upload.txt', '/home/user/incoming/file.txt');
    expect(output).toContain('100%');
    expect(server.vfs.exists('/home/user/incoming/file.txt')).toBe(true);
    expect(server.vfs.readFile('/home/user/incoming/file.txt')).toBe('upload content');
  });

  it('put a relative local path resolves against local cwd', () => {
    const output = session.put('upload.txt');
    expect(output).toContain('100%');
    expect(server.vfs.exists('/home/user/upload.txt')).toBe(true);
  });

  it('put a non-existent local file returns an error', () => {
    const output = session.put('/root/missing.txt');
    expect(output).toContain('No such file or directory');
    expect(server.vfs.exists('/home/user/missing.txt')).toBe(false);
  });

  it('put a directory instead of a file returns an error', () => {
    localVfs.mkdirp('/root/mydir', 0o755, 0, 0);
    const output = session.put('/root/mydir');
    expect(output).toContain('not a regular file');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// SF-06 — SftpSession: remote file operations
// ═══════════════════════════════════════════════════════════════════════

describe('SF-06 — SftpSession: remote file operations', () => {
  let session: SftpSession;
  let server: ISftpServer;

  beforeEach(() => {
    server = makeMockServer({
      files: {
        '/home/user/old.txt': 'rename me',
        '/home/user/delete.txt': 'delete me',
      },
      dirs: ['/home/user/emptydir'],
    });
    session = makeSession(makeResolver(server));
    session.connect(`user@${REMOTE_IP}`, 'admin');
  });

  it('mkdir creates a remote directory', () => {
    const output = session.mkdir('/home/user/newdir');
    expect(output).toBe('');
    expect(server.vfs.exists('/home/user/newdir')).toBe(true);
  });

  it('mkdir on an existing path returns an error', () => {
    const output = session.mkdir('/home/user/emptydir');
    expect(output).toContain('File exists');
  });

  it('rm removes a remote file', () => {
    const output = session.rm('/home/user/delete.txt');
    expect(output).toBe('');
    expect(server.vfs.exists('/home/user/delete.txt')).toBe(false);
  });

  it('rm a non-existent file returns an error', () => {
    const output = session.rm('/home/user/missing.txt');
    expect(output).toContain('No such file or directory');
  });

  it('rmdir removes an empty remote directory', () => {
    const output = session.rmdir('/home/user/emptydir');
    expect(output).toBe('');
    expect(server.vfs.exists('/home/user/emptydir')).toBe(false);
  });

  it('rmdir a non-existent directory returns an error', () => {
    const output = session.rmdir('/home/user/missing');
    expect(output).toContain('No such file or directory');
  });

  it('rename moves a remote file', () => {
    const output = session.rename('/home/user/old.txt', '/home/user/new.txt');
    expect(output).toBe('');
    expect(server.vfs.exists('/home/user/old.txt')).toBe(false);
    expect(server.vfs.exists('/home/user/new.txt')).toBe(true);
    expect(server.vfs.readFile('/home/user/new.txt')).toBe('rename me');
  });

  it('rename a non-existent file returns an error', () => {
    const output = session.rename('/home/user/missing.txt', '/home/user/other.txt');
    expect(output).toContain('No such file or directory');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// SF-07 — sftp command: non-interactive batch transfer
// ═══════════════════════════════════════════════════════════════════════

describe('SF-07 — sftp command: non-interactive batch transfer', () => {
  it('sftp user@host:/remote/file /local downloads the file', () => {
    const server = makeMockServer({
      files: { '/home/user/remote.txt': 'remote data' },
    });

    const localVfs = new VirtualFileSystem();
    const socketTable = new SocketTable();
    const resolver: SftpServerResolver = (ip) => (ip === REMOTE_IP ? server : null);

    const session = new SftpSession(localVfs, socketTable, resolver, '/root', LOCAL_IP, 'root');
    // Simulate the batch-mode: connect + get
    const err = session.connect(`user@${REMOTE_IP}`, 'admin');
    expect(err).toBe('');
    const output = session.get('/home/user/remote.txt', '/root/remote.txt');
    expect(output).toContain('100%');
    expect(localVfs.exists('/root/remote.txt')).toBe(true);
    expect(localVfs.readFile('/root/remote.txt')).toBe('remote data');
  });

  it('sftp user@host:/remote/file /local returns error for unknown host', () => {
    const session = makeSession(() => null);
    const err = session.connect(`user@99.99.99.99`, 'admin');
    expect(err).toContain('No route to host');
    expect(session.isConnected()).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// SF-08 — SftpSession: socket table integration
// ═══════════════════════════════════════════════════════════════════════

describe('SF-08 — SftpSession: socket table integration', () => {
  it('connect creates an ESTABLISHED TCP entry in the client socket table', () => {
    const server = makeMockServer();
    const localVfs = new VirtualFileSystem();
    const socketTable = new SocketTable();
    const session = new SftpSession(localVfs, socketTable, makeResolver(server), '/root', LOCAL_IP, 'root');

    session.connect(`user@${REMOTE_IP}`, 'admin');

    const established = socketTable.getEstablished();
    expect(established.length).toBe(1);
    const entry = established[0];
    expect(entry.protocol).toBe('tcp');
    expect(entry.remoteAddress).toBe(REMOTE_IP);
    expect(entry.remotePort).toBe(22);
    expect(entry.localAddress).toBe(LOCAL_IP);
  });

  it('disconnect removes the socket entry from the client socket table', () => {
    const server = makeMockServer();
    const localVfs = new VirtualFileSystem();
    const socketTable = new SocketTable();
    const session = new SftpSession(localVfs, socketTable, makeResolver(server), '/root', LOCAL_IP, 'root');

    session.connect(`user@${REMOTE_IP}`, 'admin');
    expect(socketTable.getEstablished().length).toBe(1);

    session.disconnect();
    expect(socketTable.getEstablished().length).toBe(0);
  });

  it('failed connect does not add any socket entry', () => {
    const localVfs = new VirtualFileSystem();
    const socketTable = new SocketTable();
    const session = new SftpSession(localVfs, socketTable, () => null, '/root', LOCAL_IP, 'root');

    session.connect(`user@${REMOTE_IP}`, 'admin');
    expect(socketTable.getEstablished().length).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// SF-09 — SftpSubShell: processLine
// ═══════════════════════════════════════════════════════════════════════

describe('SF-09 — SftpSubShell: processLine', () => {
  let subShell: SftpSubShell;
  let server: ISftpServer;

  beforeEach(() => {
    server = makeMockServer({
      files: { '/home/user/readme.txt': 'hello' },
      dirs:  ['/home/user/docs'],
    });
    const localVfs = new VirtualFileSystem();
    localVfs.writeFile('/root/upload.txt', 'upload content', 0, 0, 0o022);
    const socketTable = new SocketTable();
    const session = new SftpSession(localVfs, socketTable, makeResolver(server), '/root', LOCAL_IP, 'root');
    session.connect(`user@${REMOTE_IP}`, 'admin');
    subShell = new SftpSubShell(session);
  });

  it('getPrompt returns "sftp> "', () => {
    expect(subShell.getPrompt()).toBe('sftp> ');
  });

  it('"quit" exits the sub-shell', () => {
    const result = subShell.processLine('quit');
    expect(result.exit).toBe(true);
  });

  it('"exit" exits the sub-shell', () => {
    const result = subShell.processLine('exit');
    expect(result.exit).toBe(true);
  });

  it('"bye" exits the sub-shell', () => {
    const result = subShell.processLine('bye');
    expect(result.exit).toBe(true);
  });

  it('"help" lists available sftp commands', () => {
    const result = subShell.processLine('help');
    expect(result.exit).toBe(false);
    const combined = result.output.join('\n');
    expect(combined).toContain('get');
    expect(combined).toContain('put');
    expect(combined).toContain('ls');
    expect(combined).toContain('cd');
    expect(combined).toContain('quit');
  });

  it('"pwd" shows the remote working directory', () => {
    const result = subShell.processLine('pwd');
    expect(result.exit).toBe(false);
    expect(result.output.join('\n')).toContain('/home/user');
  });

  it('"lpwd" shows the local working directory', () => {
    const result = subShell.processLine('lpwd');
    expect(result.exit).toBe(false);
    expect(result.output.join('\n')).toContain('/root');
  });

  it('"ls" lists remote files', () => {
    const result = subShell.processLine('ls');
    expect(result.exit).toBe(false);
    expect(result.output.join('\n')).toContain('readme.txt');
  });

  it('"ls <path>" lists the given remote directory', () => {
    const result = subShell.processLine('ls /home/user/docs');
    expect(result.exit).toBe(false);
    expect(result.output.join('\n')).not.toContain('readme.txt');
  });

  it('"lls" lists local files', () => {
    const result = subShell.processLine('lls');
    expect(result.exit).toBe(false);
    expect(result.output.join('\n')).toContain('upload.txt');
  });

  it('"cd <dir>" changes the remote directory', () => {
    const result = subShell.processLine('cd /home/user/docs');
    expect(result.exit).toBe(false);
    const pwdResult = subShell.processLine('pwd');
    expect(pwdResult.output.join('\n')).toContain('/home/user/docs');
  });

  it('"cd <invalid>" shows an error', () => {
    const result = subShell.processLine('cd /home/user/doesnotexist');
    expect(result.exit).toBe(false);
    expect(result.output.join('\n')).toContain('No such file or directory');
  });

  it('"get <file>" downloads a remote file', () => {
    const result = subShell.processLine('get readme.txt');
    expect(result.exit).toBe(false);
    expect(result.output.join('\n')).toContain('100%');
  });

  it('"put <file>" uploads a local file', () => {
    const result = subShell.processLine('put /root/upload.txt');
    expect(result.exit).toBe(false);
    expect(result.output.join('\n')).toContain('100%');
    expect(server.vfs.exists('/home/user/upload.txt')).toBe(true);
  });

  it('"mkdir <dir>" creates a remote directory', () => {
    const result = subShell.processLine('mkdir /home/user/newdir');
    expect(result.exit).toBe(false);
    expect(server.vfs.exists('/home/user/newdir')).toBe(true);
  });

  it('"rm <file>" removes a remote file', () => {
    const result = subShell.processLine('rm readme.txt');
    expect(result.exit).toBe(false);
    expect(server.vfs.exists('/home/user/readme.txt')).toBe(false);
  });

  it('"rename <old> <new>" renames a remote file', () => {
    const result = subShell.processLine('rename readme.txt renamed.txt');
    expect(result.exit).toBe(false);
    expect(server.vfs.exists('/home/user/readme.txt')).toBe(false);
    expect(server.vfs.exists('/home/user/renamed.txt')).toBe(true);
  });

  it('unknown command shows an error message', () => {
    const result = subShell.processLine('frobnicate');
    expect(result.exit).toBe(false);
    expect(result.output.join('\n')).toContain('Invalid command');
  });

  it('empty line produces no output and does not exit', () => {
    const result = subShell.processLine('');
    expect(result.exit).toBe(false);
    expect(result.output.every(l => l === '')).toBe(true);
  });

  it('handleKey returns false (keys go to text input)', () => {
    const consumed = subShell.handleKey({ key: 'a', ctrlKey: false, shiftKey: false });
    expect(consumed).toBe(false);
  });

  it('handleKey Ctrl+D does not throw', () => {
    expect(() => subShell.handleKey({ key: 'd', ctrlKey: true, shiftKey: false })).not.toThrow();
  });

  it('dispose does not throw', () => {
    expect(() => subShell.dispose()).not.toThrow();
    expect(subShell.getPrompt()).toBe('sftp> ');
  });
});
