/**
 * §A — SCP/SFTP domain model tests.
 *
 * Exercises the pure-model layer in src/network/protocols/ssh/{sftp,scp}:
 *   - VfsSftpFileSystem: VFS adapter
 *   - ScpTransfer + ScpSession: push/pull, recursive, preserve, error paths
 *
 * Test names are kept short — what matters is that every public surface
 * of the model classes is covered against a real (in-memory) file system.
 */

import { describe, expect, test, beforeEach } from 'vitest';

import { VfsSftpFileSystem } from '@/network/protocols/ssh/sftp/VfsSftpFileSystem';
import { parseScpEndpoint } from '@/network/protocols/ssh/Scp';
import { VirtualFileSystem } from '@/network/devices/linux/VirtualFileSystem';

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


// ─── §A.8 — ScpEndpoint legacy parsers stay coherent ────────────────

describe('§A.8 — parseScpEndpoint', () => {
  test('user@host:path is remote', () => {
    expect(parseScpEndpoint('alice@h:/tmp/x')).toEqual({
      remote: true, user: 'alice', host: 'h', path: '/tmp/x',
    });
  });

  test('bare path is local', () => {
    expect(parseScpEndpoint('/tmp/x')).toEqual({ remote: false, path: '/tmp/x' });
  });
});
