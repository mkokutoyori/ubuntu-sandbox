/**
 * SFTP real wire codec (draft-ietf-secsh-filexfer §4) — PRD-FTP-SFTP.md
 * §2.1.14/P13. `SftpWireCodec.ts` is tested standalone (pure byte
 * encode/decode round-trips for every packet type); `SftpWireSession.ts`
 * is tested against a real `ISftpFileSystem`, proving the codec is
 * genuinely usable against the existing dispatcher without modifying it.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters } from '@/network/core/types';
import { VirtualFileSystem } from '@/network/devices/linux/VirtualFileSystem';
import { LinuxSftpFSAdapter } from '@/network/protocols/ssh/sftp/LinuxSftpFSAdapter';
import type { ISftpFileSystem } from '@/network/protocols/ssh/sftp/ISftpFileSystem';
import { SshUserContext } from '@/network/protocols/ssh/SshUserContext';
import {
  encodeSftpWirePacket, decodeSftpWirePacket, SFTP_TYPE, type SftpWirePacket,
} from '@/network/protocols/ssh/sftp/SftpWireCodec';
import { SftpWireSession } from '@/network/protocols/ssh/sftp/SftpWireSession';

beforeEach(() => {
  resetCounters();
});

function roundTrip(pkt: SftpWirePacket): SftpWirePacket | null {
  return decodeSftpWirePacket(encodeSftpWirePacket(pkt));
}

describe('SftpWireCodec — byte-level round-trips (draft-ietf-secsh-filexfer §4)', () => {
  it('round-trips INIT/VERSION (no request-id, per the handshake)', () => {
    expect(roundTrip({ type: 'INIT', version: 3 })).toEqual({ type: 'INIT', version: 3 });
    expect(roundTrip({ type: 'VERSION', version: 6 })).toEqual({ type: 'VERSION', version: 6 });
  });

  it('round-trips OPEN with full ATTRS', () => {
    const pkt: SftpWirePacket = {
      type: 'OPEN', requestId: 7, filename: '/tmp/a.txt', pflags: 0x01,
      attrs: { size: 1234, uid: 1000, gid: 1000, permissions: 0o644, atime: 111, mtime: 222 },
    };
    expect(roundTrip(pkt)).toEqual(pkt);
  });

  it('round-trips CLOSE/READ/WRITE with an opaque handle', () => {
    expect(roundTrip({ type: 'CLOSE', requestId: 1, handle: 'h-1' })).toEqual({ type: 'CLOSE', requestId: 1, handle: 'h-1' });
    expect(roundTrip({ type: 'READ', requestId: 2, handle: 'h-2', offset: 4096, length: 512 }))
      .toEqual({ type: 'READ', requestId: 2, handle: 'h-2', offset: 4096, length: 512 });
    const data = new Uint8Array([0, 1, 2, 255, 254, 10, 13]);
    expect(roundTrip({ type: 'WRITE', requestId: 3, handle: 'h-3', offset: 0, data }))
      .toEqual({ type: 'WRITE', requestId: 3, handle: 'h-3', offset: 0, data });
  });

  it('round-trips a large uint64 offset (beyond 32 bits)', () => {
    const bigOffset = 5_000_000_000; // > 2^32
    const pkt: SftpWirePacket = { type: 'READ', requestId: 1, handle: 'h', offset: bigOffset, length: 100 };
    expect(roundTrip(pkt)).toEqual(pkt);
  });

  it('round-trips LSTAT/FSTAT/STAT/OPENDIR/RMDIR/REALPATH/READLINK (path-or-handle + request-id only)', () => {
    expect(roundTrip({ type: 'LSTAT', requestId: 1, path: '/a' })).toEqual({ type: 'LSTAT', requestId: 1, path: '/a' });
    expect(roundTrip({ type: 'FSTAT', requestId: 2, handle: 'h' })).toEqual({ type: 'FSTAT', requestId: 2, handle: 'h' });
    expect(roundTrip({ type: 'STAT', requestId: 3, path: '/b' })).toEqual({ type: 'STAT', requestId: 3, path: '/b' });
    expect(roundTrip({ type: 'OPENDIR', requestId: 4, path: '/c' })).toEqual({ type: 'OPENDIR', requestId: 4, path: '/c' });
    expect(roundTrip({ type: 'RMDIR', requestId: 5, path: '/d' })).toEqual({ type: 'RMDIR', requestId: 5, path: '/d' });
    expect(roundTrip({ type: 'REALPATH', requestId: 6, path: '/e' })).toEqual({ type: 'REALPATH', requestId: 6, path: '/e' });
    expect(roundTrip({ type: 'READLINK', requestId: 7, path: '/f' })).toEqual({ type: 'READLINK', requestId: 7, path: '/f' });
  });

  it('round-trips SETSTAT/FSETSTAT/MKDIR with ATTRS', () => {
    const attrs = { permissions: 0o755 };
    expect(roundTrip({ type: 'SETSTAT', requestId: 1, path: '/a', attrs })).toEqual({ type: 'SETSTAT', requestId: 1, path: '/a', attrs });
    expect(roundTrip({ type: 'FSETSTAT', requestId: 2, handle: 'h', attrs })).toEqual({ type: 'FSETSTAT', requestId: 2, handle: 'h', attrs });
    expect(roundTrip({ type: 'MKDIR', requestId: 3, path: '/b', attrs })).toEqual({ type: 'MKDIR', requestId: 3, path: '/b', attrs });
  });

  it('round-trips READDIR/REMOVE/RENAME/SYMLINK', () => {
    expect(roundTrip({ type: 'READDIR', requestId: 1, handle: 'h' })).toEqual({ type: 'READDIR', requestId: 1, handle: 'h' });
    expect(roundTrip({ type: 'REMOVE', requestId: 2, filename: '/a' })).toEqual({ type: 'REMOVE', requestId: 2, filename: '/a' });
    expect(roundTrip({ type: 'RENAME', requestId: 3, oldPath: '/a', newPath: '/b' })).toEqual({ type: 'RENAME', requestId: 3, oldPath: '/a', newPath: '/b' });
    expect(roundTrip({ type: 'SYMLINK', requestId: 4, linkpath: '/l', targetpath: '/t' })).toEqual({ type: 'SYMLINK', requestId: 4, linkpath: '/l', targetpath: '/t' });
  });

  it('round-trips STATUS/HANDLE/DATA/ATTRS responses', () => {
    expect(roundTrip({ type: 'STATUS', requestId: 1, code: 2, message: 'No such file.', languageTag: 'en' }))
      .toEqual({ type: 'STATUS', requestId: 1, code: 2, message: 'No such file.', languageTag: 'en' });
    expect(roundTrip({ type: 'HANDLE', requestId: 2, handle: 'opaque-handle' })).toEqual({ type: 'HANDLE', requestId: 2, handle: 'opaque-handle' });
    const data = new Uint8Array([1, 2, 3]);
    expect(roundTrip({ type: 'DATA', requestId: 3, data })).toEqual({ type: 'DATA', requestId: 3, data });
    expect(roundTrip({ type: 'ATTRS', requestId: 4, attrs: { size: 42 } })).toEqual({ type: 'ATTRS', requestId: 4, attrs: { size: 42 } });
  });

  it('round-trips a NAME response with multiple entries', () => {
    const pkt: SftpWirePacket = {
      type: 'NAME', requestId: 1,
      entries: [
        { filename: 'a.txt', longname: '-rw-r--r-- ...', attrs: { size: 10 } },
        { filename: 'sub', longname: 'drwxr-xr-x ...', attrs: { permissions: 0o755 } },
      ],
    };
    expect(roundTrip(pkt)).toEqual(pkt);
  });

  it('produces real numbered opcodes on the wire (not just a codec-internal convention)', () => {
    const bytes = encodeSftpWirePacket({ type: 'INIT', version: 3 });
    // 4-byte length prefix, then the type byte.
    expect(bytes[4]).toBe(SFTP_TYPE.INIT);
    const status = encodeSftpWirePacket({ type: 'STATUS', requestId: 1, code: 0, message: 'OK' });
    expect(status[4]).toBe(SFTP_TYPE.STATUS);
  });

  it('rejects a truncated packet', () => {
    expect(decodeSftpWirePacket(new Uint8Array([0, 0, 0, 10, 1]))).toBeNull();
  });

  it('rejects an unknown packet type', () => {
    const bytes = new Uint8Array([0, 0, 0, 1, 250]);
    expect(decodeSftpWirePacket(bytes)).toBeNull();
  });
});

describe('SftpWireSession — bridges the codec to a real ISftpFileSystem/SftpCommandDispatcher', () => {
  function buildSession() {
    const vfs = new VirtualFileSystem();
    vfs.mkdirp('/home/alice', 0o755, 1000, 1000);
    vfs.writeFile('/home/alice/hello.txt', 'hello sftp wire', 1000, 1000, 0o022);
    const fs = new LinuxSftpFSAdapter(vfs, 1000, 1000);
    const userCtx = new SshUserContext('alice', 1000, 1000, [], '/home/alice');
    const session = new SftpWireSession({ vfs: fs, userCtx, rootPath: '/home/alice' });
    return { vfs, session };
  }

  it('negotiates a real INIT/VERSION handshake', () => {
    const { session } = buildSession();
    const reply = session.handle({ type: 'INIT', version: 3 });
    expect(reply).toEqual({ type: 'VERSION', version: 3 });
  });

  it('REALPATH resolves a relative path against the session cwd', () => {
    const { session } = buildSession();
    const reply = session.handle({ type: 'REALPATH', requestId: 1, path: 'hello.txt' });
    expect(reply.type).toBe('NAME');
    expect((reply as { entries: { filename: string }[] }).entries[0].filename).toBe('/home/alice/hello.txt');
  });

  it('LSTAT reports real ATTRS for an existing file', () => {
    const { session } = buildSession();
    const reply = session.handle({ type: 'LSTAT', requestId: 1, path: 'hello.txt' });
    expect(reply.type).toBe('ATTRS');
    expect((reply as { attrs: { size: number } }).attrs.size).toBe('hello sftp wire'.length);
  });

  it('LSTAT on a nonexistent file replies STATUS with SSH_FX_NO_SUCH_FILE-ish failure', () => {
    const { session } = buildSession();
    const reply = session.handle({ type: 'LSTAT', requestId: 1, path: 'ghost.txt' });
    expect(reply.type).toBe('STATUS');
    expect((reply as { code: number }).code).toBeGreaterThan(0);
  });

  it('MKDIR then OPENDIR+READDIR lists the new directory as empty, then EOF', () => {
    const { session } = buildSession();
    expect(session.handle({ type: 'MKDIR', requestId: 1, path: 'sub', attrs: {} })).toEqual({ type: 'STATUS', requestId: 1, code: 0, message: 'OK' });

    const openReply = session.handle({ type: 'OPENDIR', requestId: 2, path: 'sub' });
    expect(openReply.type).toBe('HANDLE');
    const handle = (openReply as { handle: string }).handle;

    const first = session.handle({ type: 'READDIR', requestId: 3, handle });
    expect(first.type).toBe('NAME');
    // Real sftp-server behavior: an "empty" directory still lists `.`/`..`.
    const names = (first as { entries: { filename: string }[] }).entries.map((e) => e.filename);
    expect(names.sort()).toEqual(['.', '..']);

    const second = session.handle({ type: 'READDIR', requestId: 4, handle });
    expect(second.type).toBe('STATUS');
    expect((second as { code: number }).code).toBe(1); // SSH_FX_EOF
  });

  it('OPENDIR lists a directory with an existing file via READDIR', () => {
    const { session } = buildSession();
    const openReply = session.handle({ type: 'OPENDIR', requestId: 1, path: '.' });
    const handle = (openReply as { handle: string }).handle;
    const reply = session.handle({ type: 'READDIR', requestId: 2, handle });
    expect(reply.type).toBe('NAME');
    const names = (reply as { entries: { filename: string }[] }).entries.map((e) => e.filename);
    expect(names).toContain('hello.txt');
  });

  it('REMOVE deletes a real file', () => {
    const { session, vfs } = buildSession();
    const reply = session.handle({ type: 'REMOVE', requestId: 1, filename: 'hello.txt' });
    expect(reply).toEqual({ type: 'STATUS', requestId: 1, code: 0, message: 'OK' });
    expect(vfs.exists('/home/alice/hello.txt')).toBe(false);
  });

  it('RENAME renames a real file', () => {
    const { session, vfs } = buildSession();
    const reply = session.handle({ type: 'RENAME', requestId: 1, oldPath: 'hello.txt', newPath: 'renamed.txt' });
    expect(reply).toEqual({ type: 'STATUS', requestId: 1, code: 0, message: 'OK' });
    expect(vfs.exists('/home/alice/renamed.txt')).toBe(true);
  });

  it('RMDIR removes a real empty directory', () => {
    const { session, vfs } = buildSession();
    session.handle({ type: 'MKDIR', requestId: 1, path: 'empty', attrs: {} });
    const reply = session.handle({ type: 'RMDIR', requestId: 2, path: 'empty' });
    expect(reply).toEqual({ type: 'STATUS', requestId: 2, code: 0, message: 'OK' });
    expect(vfs.exists('/home/alice/empty')).toBe(false);
  });

  it('SYMLINK creates a real symlink, then READLINK reads its target back', () => {
    const { session, vfs } = buildSession();
    const symlinkReply = session.handle({ type: 'SYMLINK', requestId: 1, linkpath: 'link', targetpath: 'hello.txt' });
    expect(symlinkReply).toEqual({ type: 'STATUS', requestId: 1, code: 0, message: 'OK' });
    expect(vfs.getType('/home/alice/link', false)).toBe('symlink');

    const readlinkReply = session.handle({ type: 'READLINK', requestId: 2, path: 'link' });
    expect(readlinkReply.type).toBe('NAME');
    expect((readlinkReply as { entries: { filename: string }[] }).entries[0].filename).toBe('hello.txt');
  });

  it('SYMLINK on an already-existing path fails without creating anything', () => {
    const { session } = buildSession();
    const reply = session.handle({ type: 'SYMLINK', requestId: 1, linkpath: 'hello.txt', targetpath: 'irrelevant' });
    expect(reply.type).toBe('STATUS');
    expect((reply as { code: number }).code).toBeGreaterThan(0);
  });

  it('READLINK on a non-symlink path fails', () => {
    const { session } = buildSession();
    const reply = session.handle({ type: 'READLINK', requestId: 1, path: 'hello.txt' });
    expect(reply.type).toBe('STATUS');
    expect((reply as { code: number }).code).toBeGreaterThan(0);
  });

  it('SYMLINK/READLINK reply SSH_FX_OP_UNSUPPORTED on a backing filesystem without symlink support', () => {
    const vfs = new VirtualFileSystem();
    vfs.mkdirp('/home/alice', 0o755, 1000, 1000);
    vfs.writeFile('/home/alice/hello.txt', 'hello sftp wire', 1000, 1000, 0o022);
    const base = new LinuxSftpFSAdapter(vfs, 1000, 1000);
    // Simulate a backing ISftpFileSystem that doesn't implement the optional symlink capability
    // (e.g. WindowsSftpFSAdapter/RouterSftpFileSystem today) — must degrade gracefully, not throw.
    const noSymlinkFs: ISftpFileSystem = {
      normalizePath: (p, cwd) => base.normalizePath(p, cwd),
      exists: (p) => base.exists(p),
      getEntryType: (p) => base.getEntryType(p),
      readFile: (p) => base.readFile(p),
      listDirectory: (p) => base.listDirectory(p),
      stat: (p) => base.stat(p),
      writeFile: (p, c) => base.writeFile(p, c),
      mkdir: (p) => base.mkdir(p),
      deleteFile: (p) => base.deleteFile(p),
      rmdir: (p) => base.rmdir(p),
      rename: (s, d) => base.rename(s, d),
      setPermissions: (p, m) => base.setPermissions(p, m),
      setOwner: (p, u, g) => base.setOwner(p, u, g),
    };
    const userCtx = new SshUserContext('alice', 1000, 1000, [], '/home/alice');
    const session = new SftpWireSession({ vfs: noSymlinkFs, userCtx, rootPath: '/home/alice' });

    const symlinkReply = session.handle({ type: 'SYMLINK', requestId: 1, linkpath: 'link', targetpath: 'hello.txt' });
    expect(symlinkReply.type).toBe('STATUS');
    expect((symlinkReply as { code: number }).code).toBe(8); // SSH_FX_OP_UNSUPPORTED

    const readlinkReply = session.handle({ type: 'READLINK', requestId: 2, path: 'hello.txt' });
    expect(readlinkReply.type).toBe('STATUS');
    expect((readlinkReply as { code: number }).code).toBe(8);
  });
});
