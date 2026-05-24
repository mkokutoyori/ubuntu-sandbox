/**
 * §A — SCP/SFTP domain model tests.
 *
 * Exercises the pure-model layer in src/network/protocols/ssh/{sftp,scp}:
 *   - parseSftpLine + SftpCommandScript: REPL grammar
 *   - VfsSftpFileSystem + WindowsSftpFileSystem: VFS adapters
 *   - SftpInteractiveSession: end-to-end batch execution
 *   - ScpTransfer + ScpSession: push/pull, recursive, preserve, error paths
 *
 * Test names are kept short — what matters is that every public surface
 * of the model classes is covered against a real (in-memory) file system.
 */

import { describe, expect, test, beforeEach } from 'vitest';

import { parseSftpLine } from '@/network/protocols/ssh/sftp/SftpCommand';
import { SftpCommandScript } from '@/network/protocols/ssh/sftp/SftpCommandScript';
import { VfsSftpFileSystem } from '@/network/protocols/ssh/sftp/VfsSftpFileSystem';
import { WindowsSftpFileSystem } from '@/network/protocols/ssh/sftp/WindowsSftpFileSystem';
import { SftpInteractiveSession } from '@/network/protocols/ssh/sftp/SftpInteractiveSession';
import { ScpTransfer } from '@/network/protocols/ssh/scp/ScpTransfer';
import { ScpSession } from '@/network/protocols/ssh/scp/ScpSession';
import { parseScpEndpoint, parseScpArgs } from '@/network/protocols/ssh/Scp';
import { VirtualFileSystem } from '@/network/devices/linux/VirtualFileSystem';
import { WindowsFileSystem } from '@/network/devices/windows/WindowsFileSystem';

// ─── §A.1 — SftpCommand parser ──────────────────────────────────────

describe('§A.1 — parseSftpLine', () => {
  test('blank + comment lines yield null', () => {
    expect(parseSftpLine('')).toBeNull();
    expect(parseSftpLine('   ')).toBeNull();
    expect(parseSftpLine('# only a comment')).toBeNull();
  });

  test('put with explicit + implicit destination', () => {
    expect(parseSftpLine('put /tmp/a')).toEqual({ verb: 'put', local: '/tmp/a', remote: '/tmp/a' });
    expect(parseSftpLine('put /tmp/a /tmp/b')).toEqual({ verb: 'put', local: '/tmp/a', remote: '/tmp/b' });
  });

  test('get with explicit + implicit destination', () => {
    expect(parseSftpLine('get /etc/hostname')).toEqual({
      verb: 'get', remote: '/etc/hostname', local: '/etc/hostname',
    });
  });

  test('chmod parses octal mode', () => {
    expect(parseSftpLine('chmod 600 /tmp/secret')).toEqual({
      verb: 'chmod', mode: 0o600, path: '/tmp/secret',
    });
  });

  test('chmod with invalid mode reports parse error', () => {
    const r = parseSftpLine('chmod xx /tmp/x');
    expect(r).toMatchObject({ kind: 'parse', reason: expect.stringContaining('chmod') });
  });

  test('rename and rm aliases work', () => {
    expect(parseSftpLine('rename /a /b')).toEqual({ verb: 'rename', src: '/a', dst: '/b' });
    expect(parseSftpLine('mv /a /b')).toEqual({ verb: 'rename', src: '/a', dst: '/b' });
    expect(parseSftpLine('delete /tmp/x')).toEqual({ verb: 'rm', path: '/tmp/x' });
  });

  test('bye/quit/exit collapse to bye', () => {
    for (const v of ['bye', 'quit', 'exit']) {
      expect(parseSftpLine(v)).toEqual({ verb: 'bye' });
    }
  });

  test('unknown verb yields parse error, not throw', () => {
    expect(parseSftpLine('fubar /a')).toMatchObject({ kind: 'parse' });
  });
});

// ─── §A.2 — SftpCommandScript ───────────────────────────────────────

describe('§A.2 — SftpCommandScript', () => {
  test('parse() keeps only meaningful lines and tags errors', () => {
    const s = SftpCommandScript.parse(
      '# header\nput /tmp/a\nchmod xx /tmp/a\nbye\n',
    );
    const entries = s.commands;
    expect(entries.map(e => e.command?.verb ?? 'err')).toEqual(['put', 'err', 'bye']);
    expect(s.hasErrors).toBe(true);
  });

  test('effective() stops at the first bye', () => {
    const s = SftpCommandScript.parse('put a\nbye\nput b\n');
    const verbs = s.effective().map(e => e.command?.verb);
    expect(verbs).toEqual(['put', 'bye']);
  });
});

// ─── §A.3 — VfsSftpFileSystem adapter ───────────────────────────────

describe('§A.3 — VfsSftpFileSystem', () => {
  let vfs: VirtualFileSystem;
  let adapter: VfsSftpFileSystem;
  beforeEach(() => {
    vfs = new VirtualFileSystem();
    adapter = new VfsSftpFileSystem(vfs, { uid: 0, gid: 0, umask: 0o022 });
    vfs.writeFile('/etc/hostname', 'lab', 0, 0, 0o022);
  });

  test('readFile/stat/writeFile round-trip', () => {
    const rf = adapter.readFile('/etc/hostname');
    expect(rf.ok && rf.value).toBe('lab');
    const w = adapter.writeFile('/tmp/x', 'data');
    expect(w.ok).toBe(true);
    const stat = adapter.stat('/tmp/x');
    expect(stat.ok && stat.value.size).toBeGreaterThan(0);
  });

  test('getEntryType distinguishes file vs directory', () => {
    expect(adapter.getEntryType('/etc')).toBe('directory');
    expect(adapter.getEntryType('/etc/hostname')).toBe('file');
    expect(adapter.getEntryType('/missing')).toBeNull();
  });

  test('listDirectory enumerates children with types', () => {
    vfs.writeFile('/d/a', 'a', 0, 0, 0o022);
    vfs.writeFile('/d/b', 'b', 0, 0, 0o022);
    const r = adapter.listDirectory('/d');
    expect(r.ok).toBe(true);
    if (r.ok) {
      const names = r.value.map(e => e.name).sort();
      expect(names).toEqual(['a', 'b']);
    }
  });

  test('setPermissions changes the inode mode', () => {
    adapter.writeFile('/tmp/secret', 'ok');
    expect(adapter.setPermissions('/tmp/secret', 0o600).ok).toBe(true);
    const s = adapter.stat('/tmp/secret');
    expect(s.ok && s.value.mode).toBe(0o600);
  });

  test('readFile of missing returns IO_ERROR', () => {
    const r = adapter.readFile('/missing');
    expect(r.ok).toBe(false);
  });
});

// ─── §A.4 — WindowsSftpFileSystem adapter ───────────────────────────

describe('§A.4 — WindowsSftpFileSystem', () => {
  test('translates POSIX path with drive letter prefix to NTFS', () => {
    const wfs = new WindowsFileSystem('PC1');
    const adapter = new WindowsSftpFileSystem(wfs);
    expect(adapter.writeFile('/C:/Users/User/payload.txt', 'win-payload').ok).toBe(true);
    const r = adapter.readFile('/C:/Users/User/payload.txt');
    expect(r.ok && r.value).toBe('win-payload');
  });
});

// ─── §A.5 — SftpInteractiveSession ──────────────────────────────────

describe('§A.5 — SftpInteractiveSession', () => {
  let localVfs: VirtualFileSystem;
  let remoteVfs: VirtualFileSystem;
  let session: SftpInteractiveSession;
  beforeEach(() => {
    localVfs  = new VirtualFileSystem();
    remoteVfs = new VirtualFileSystem();
    localVfs.writeFile('/tmp/payload', 'hello', 0, 0, 0o022);
    session = new SftpInteractiveSession({
      local:  new VfsSftpFileSystem(localVfs,  { uid: 0, gid: 0, umask: 0o022 }),
      remote: new VfsSftpFileSystem(remoteVfs, { uid: 0, gid: 0, umask: 0o022 }),
    });
  });

  test('put → get round-trips a file between local and remote', () => {
    session.run(SftpCommandScript.parse(
      'put /tmp/payload /tmp/payload\nget /tmp/payload /tmp/copy\nbye\n',
    ));
    expect(remoteVfs.readFile('/tmp/payload')).toBe('hello');
    expect(localVfs.readFile('/tmp/copy')).toBe('hello');
  });

  test('cd + pwd update the remote working directory', () => {
    remoteVfs.mkdir('/var/tmp', 0o755, 0, 0);
    session.run(SftpCommandScript.parse('cd /var/tmp\npwd\nbye\n'));
    expect(session.transcript).toContain('Remote working directory: /var/tmp');
  });

  test('ls lists remote entries', () => {
    remoteVfs.writeFile('/srv/a', 'A', 0, 0, 0o022);
    remoteVfs.writeFile('/srv/b', 'B', 0, 0, 0o022);
    session.run(SftpCommandScript.parse('ls /srv\nbye\n'));
    expect(session.transcript).toContain('a');
    expect(session.transcript).toContain('b');
  });

  test('chmod via session changes the remote mode', () => {
    session.run(SftpCommandScript.parse(
      'put /tmp/payload /tmp/p\nchmod 600 /tmp/p\nbye\n',
    ));
    expect(remoteVfs.resolveInode('/tmp/p')?.permissions).toBe(0o600);
  });

  test('unknown command produces a transcript error but continues', () => {
    session.run(SftpCommandScript.parse(
      'fubar /tmp\nput /tmp/payload /tmp/payload\nbye\n',
    ));
    expect(session.lastError).not.toBeNull();
    expect(remoteVfs.readFile('/tmp/payload')).toBe('hello');
  });
});

// ─── §A.6 — ScpTransfer ─────────────────────────────────────────────

describe('§A.6 — ScpTransfer', () => {
  let localVfs: VirtualFileSystem;
  let remoteVfs: VirtualFileSystem;
  let local: VfsSftpFileSystem;
  let remote: VfsSftpFileSystem;
  beforeEach(() => {
    localVfs  = new VirtualFileSystem();
    remoteVfs = new VirtualFileSystem();
    local  = new VfsSftpFileSystem(localVfs,  { uid: 0, gid: 0, umask: 0o022 });
    remote = new VfsSftpFileSystem(remoteVfs, { uid: 0, gid: 0, umask: 0o022 });
  });

  test('push copies a regular file', () => {
    localVfs.writeFile('/src.txt', 'payload', 0, 0, 0o022);
    const t = new ScpTransfer(
      { local, remote },
      { remote: false, path: '/src.txt' },
      { remote: true, host: 'h', path: '/dst.txt' },
      { recursive: false, preserve: false, localCwd: '/', remoteCwd: '/' },
    );
    const r = t.run();
    expect(r.ok).toBe(true);
    expect(remoteVfs.readFile('/dst.txt')).toBe('payload');
  });

  test('pull copies a remote file onto local', () => {
    remoteVfs.writeFile('/remote.txt', 'fetched', 0, 0, 0o022);
    const t = new ScpTransfer(
      { local, remote },
      { remote: true, host: 'h', path: '/remote.txt' },
      { remote: false, path: '/local.txt' },
      { recursive: false, preserve: false, localCwd: '/', remoteCwd: '/' },
    );
    const r = t.run();
    expect(r.ok).toBe(true);
    expect(localVfs.readFile('/local.txt')).toBe('fetched');
  });

  test('non-recursive directory source returns "not a regular file"', () => {
    localVfs.mkdir('/dir', 0o755, 0, 0);
    const t = new ScpTransfer(
      { local, remote },
      { remote: false, path: '/dir' },
      { remote: true, host: 'h', path: '/dir' },
      { recursive: false, preserve: false, localCwd: '/', remoteCwd: '/' },
    );
    expect(t.run().ok).toBe(false);
  });

  test('-r recurses into directories', () => {
    localVfs.mkdir('/box', 0o755, 0, 0);
    localVfs.writeFile('/box/a', 'A', 0, 0, 0o022);
    localVfs.writeFile('/box/b', 'B', 0, 0, 0o022);
    const t = new ScpTransfer(
      { local, remote },
      { remote: false, path: '/box' },
      { remote: true, host: 'h', path: '/box' },
      { recursive: true, preserve: false, localCwd: '/', remoteCwd: '/' },
    );
    const r = t.run();
    expect(r.ok).toBe(true);
    expect(remoteVfs.readFile('/box/a')).toBe('A');
    expect(remoteVfs.readFile('/box/b')).toBe('B');
  });

  test('-p preserves mode across push', () => {
    localVfs.writeFile('/secret', 'shh', 0, 0, 0o022);
    localVfs.chmod('/secret', 0o600);
    const t = new ScpTransfer(
      { local, remote },
      { remote: false, path: '/secret' },
      { remote: true, host: 'h', path: '/secret' },
      { recursive: false, preserve: true, localCwd: '/', remoteCwd: '/' },
    );
    t.run();
    expect(remoteVfs.resolveInode('/secret')?.permissions).toBe(0o600);
  });

  test('local-to-local refuses (use cp)', () => {
    const t = new ScpTransfer(
      { local, remote },
      { remote: false, path: '/a' },
      { remote: false, path: '/b' },
      { recursive: false, preserve: false, localCwd: '/', remoteCwd: '/' },
    );
    expect(t.run().ok).toBe(false);
  });

  test('missing source fails fast', () => {
    const t = new ScpTransfer(
      { local, remote },
      { remote: false, path: '/missing' },
      { remote: true, host: 'h', path: '/d' },
      { recursive: false, preserve: false, localCwd: '/', remoteCwd: '/' },
    );
    expect(t.run().ok).toBe(false);
  });
});

// ─── §A.7 — ScpSession orchestrator ─────────────────────────────────

describe('§A.7 — ScpSession', () => {
  test('argv parse → push transfer → exit 0 + summary', () => {
    const localVfs  = new VirtualFileSystem();
    const remoteVfs = new VirtualFileSystem();
    localVfs.writeFile('/tmp/x.txt', 'orchestrated', 0, 0, 0o022);
    const remote = new VfsSftpFileSystem(remoteVfs, { uid: 0, gid: 0, umask: 0o022 });
    const s = new ScpSession({
      args: ['/tmp/x.txt', 'alice@h2:/tmp/x.txt'],
      local: { fs: new VfsSftpFileSystem(localVfs, { uid: 0, gid: 0, umask: 0o022 }), cwd: '/' },
      resolveRemote: () => remote,
    });
    const r = s.run();
    expect(r.exitCode).toBe(0);
    expect(remoteVfs.readFile('/tmp/x.txt')).toBe('orchestrated');
  });

  test('unresolved remote host yields exit 1 + scp: error', () => {
    const localVfs  = new VirtualFileSystem();
    const s = new ScpSession({
      args: ['/tmp/x.txt', 'alice@nope:/tmp/x'],
      local: { fs: new VfsSftpFileSystem(localVfs, { uid: 0, gid: 0, umask: 0o022 }), cwd: '/' },
      resolveRemote: () => null,
    });
    const r = s.run();
    expect(r.exitCode).toBe(1);
    expect(r.output).toMatch(/^scp:/);
  });

  test('missing argv prints usage with exit 1', () => {
    const localVfs  = new VirtualFileSystem();
    const s = new ScpSession({
      args: ['/only-one'],
      local: { fs: new VfsSftpFileSystem(localVfs, { uid: 0, gid: 0, umask: 0o022 }), cwd: '/' },
      resolveRemote: () => null,
    });
    expect(s.run()).toMatchObject({ exitCode: 1, output: expect.stringContaining('usage') });
  });
});

// ─── §A.8 — ScpEndpoint legacy parsers stay coherent ────────────────

describe('§A.8 — parseScpEndpoint / parseScpArgs', () => {
  test('user@host:path is remote', () => {
    expect(parseScpEndpoint('alice@h:/tmp/x')).toEqual({
      remote: true, user: 'alice', host: 'h', path: '/tmp/x',
    });
  });

  test('bare path is local', () => {
    expect(parseScpEndpoint('/tmp/x')).toEqual({ remote: false, path: '/tmp/x' });
  });

  test('argv extraction picks first source + last destination', () => {
    const r = parseScpArgs(['-r', '-P', '2222', '/a', 'u@h:/b']);
    expect(r?.recursive).toBe(true);
    expect(r?.port).toBe(2222);
    expect(r?.source.path).toBe('/a');
    expect(r?.destination.remote).toBe(true);
  });
});
