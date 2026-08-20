/**
 * SFTP version 6 as the primary target (draft-ietf-secsh-filexfer
 * versions 4-6, PRD-FTP-SFTP.md §2.1.17/P16): real INIT/VERSION
 * negotiation (ceiling 6, floor 3), ATTRS `type`/ACL/extended
 * attributes carried faithfully on the wire, `SSH_FXP_RENAME` with
 * `OVERWRITE`/`ATOMIC` flags, and `SSH_FXP_LINK` (hard link, v6).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters } from '@/network/core/types';
import { VirtualFileSystem } from '@/network/devices/linux/VirtualFileSystem';
import { LinuxSftpFSAdapter } from '@/network/protocols/ssh/sftp/LinuxSftpFSAdapter';
import { SshUserContext } from '@/network/protocols/ssh/SshUserContext';
import { SftpWireSession } from '@/network/protocols/ssh/sftp/SftpWireSession';
import {
  encodeSftpWirePacket, decodeSftpWirePacket, SFTP_RENAME_FLAG, type SftpWirePacket,
} from '@/network/protocols/ssh/sftp/SftpWireCodec';

beforeEach(() => {
  resetCounters();
});

function roundTrip(pkt: SftpWirePacket): SftpWirePacket | null {
  return decodeSftpWirePacket(encodeSftpWirePacket(pkt));
}

describe('SftpWireCodec — v4-v6 ATTRS/RENAME/LINK round-trips', () => {
  it('round-trips ATTRS with an explicit v4+ type field', () => {
    const pkt: SftpWirePacket = { type: 'ATTRS', requestId: 1, attrs: { size: 10, entryType: 'symlink' } };
    expect(roundTrip(pkt)).toEqual(pkt);
  });

  it('round-trips ATTRS with an ACL list (carried faithfully, not evaluated)', () => {
    const pkt: SftpWirePacket = {
      type: 'ATTRS', requestId: 2,
      attrs: {
        permissions: 0o640,
        acl: [
          { type: 'allow', subject: 'alice', permissions: 0o6 },
          { type: 'deny', subject: 'bob', permissions: 0o2 },
        ],
      },
    };
    expect(roundTrip(pkt)).toEqual(pkt);
  });

  it('round-trips ATTRS with named extended attributes', () => {
    const pkt: SftpWirePacket = {
      type: 'ATTRS', requestId: 3,
      attrs: { extended: [{ name: 'user.comment', value: 'hello' }, { name: 'user.tag', value: 'v6' }] },
    };
    expect(roundTrip(pkt)).toEqual(pkt);
  });

  it('round-trips a RENAME with OVERWRITE|ATOMIC flags', () => {
    const pkt: SftpWirePacket = {
      type: 'RENAME', requestId: 4, oldPath: '/a', newPath: '/b',
      flags: SFTP_RENAME_FLAG.OVERWRITE | SFTP_RENAME_FLAG.ATOMIC,
    };
    expect(roundTrip(pkt)).toEqual(pkt);
  });

  it('round-trips a RENAME without flags (v3/v4 shape, no trailing bytes)', () => {
    const pkt: SftpWirePacket = { type: 'RENAME', requestId: 5, oldPath: '/a', newPath: '/b' };
    expect(roundTrip(pkt)).toEqual(pkt);
  });

  it('round-trips a v6 LINK (hard link) packet', () => {
    const pkt: SftpWirePacket = { type: 'LINK', requestId: 6, newLinkPath: '/new', existingPath: '/existing' };
    expect(roundTrip(pkt)).toEqual(pkt);
  });
});

describe('SftpWireSession — real version negotiation (§2.1.16-17/P15-P16)', () => {
  function buildSession() {
    const vfs = new VirtualFileSystem();
    vfs.mkdirp('/home/alice', 0o755, 1000, 1000);
    vfs.writeFile('/home/alice/hello.txt', 'hello sftp v6', 1000, 1000, 0o022);
    const fs = new LinuxSftpFSAdapter(vfs, 1000, 1000);
    const userCtx = new SshUserContext('alice', 1000, 1000, [], '/home/alice');
    const session = new SftpWireSession({ vfs: fs, userCtx, rootPath: '/home/alice' });
    return { vfs, session };
  }

  it('negotiates version 6 when the peer proposes 6 (the real target, not just a bonus)', () => {
    const { session } = buildSession();
    expect(session.handle({ type: 'INIT', version: 6 })).toEqual({ type: 'VERSION', version: 6 });
    expect(session.version).toBe(6);
  });

  it('negotiates down to whatever a peer proposes below 6 (e.g. version 4)', () => {
    const { session } = buildSession();
    expect(session.handle({ type: 'INIT', version: 4 })).toEqual({ type: 'VERSION', version: 4 });
    expect(session.version).toBe(4);
  });

  it('falls back to version 3 for an OpenSSH-like peer that offers nothing newer', () => {
    const { session } = buildSession();
    expect(session.handle({ type: 'INIT', version: 3 })).toEqual({ type: 'VERSION', version: 3 });
    expect(session.version).toBe(3);
  });

  it('never negotiates above its own ceiling, even if the peer proposes more', () => {
    const { session } = buildSession();
    expect(session.handle({ type: 'INIT', version: 42 })).toEqual({ type: 'VERSION', version: 6 });
  });

  it('never negotiates below the v3 interoperability floor', () => {
    const { session } = buildSession();
    expect(session.handle({ type: 'INIT', version: 1 })).toEqual({ type: 'VERSION', version: 3 });
  });

  it('LSTAT ATTRS carries the v4+ type field for a real file', () => {
    const { session } = buildSession();
    const reply = session.handle({ type: 'LSTAT', requestId: 1, path: 'hello.txt' });
    expect(reply.type).toBe('ATTRS');
    expect((reply as { attrs: { entryType?: string } }).attrs.entryType).toBe('file');
  });

  it('LSTAT ATTRS carries the v4+ type field for a directory', () => {
    const { session } = buildSession();
    const reply = session.handle({ type: 'LSTAT', requestId: 1, path: '.' });
    expect(reply.type).toBe('ATTRS');
    expect((reply as { attrs: { entryType?: string } }).attrs.entryType).toBe('directory');
  });
});

describe('SftpWireSession — RENAME with v5+ flags', () => {
  function buildSession() {
    const vfs = new VirtualFileSystem();
    vfs.mkdirp('/home/alice', 0o755, 1000, 1000);
    vfs.writeFile('/home/alice/a.txt', 'AAA', 1000, 1000, 0o022);
    vfs.writeFile('/home/alice/b.txt', 'BBB', 1000, 1000, 0o022);
    const fs = new LinuxSftpFSAdapter(vfs, 1000, 1000);
    const userCtx = new SshUserContext('alice', 1000, 1000, [], '/home/alice');
    const session = new SftpWireSession({ vfs: fs, userCtx, rootPath: '/home/alice' });
    return { vfs, session };
  }

  it('without OVERWRITE, RENAME onto an existing destination still fails (no regression)', () => {
    const { session, vfs } = buildSession();
    const reply = session.handle({ type: 'RENAME', requestId: 1, oldPath: 'a.txt', newPath: 'b.txt' });
    expect(reply.type).toBe('STATUS');
    expect((reply as { code: number }).code).toBeGreaterThan(0);
    expect(vfs.readFile('/home/alice/b.txt')).toBe('BBB');
  });

  it('with OVERWRITE, RENAME replaces an existing destination', () => {
    const { session, vfs } = buildSession();
    const reply = session.handle({
      type: 'RENAME', requestId: 1, oldPath: 'a.txt', newPath: 'b.txt', flags: SFTP_RENAME_FLAG.OVERWRITE,
    });
    expect(reply).toEqual({ type: 'STATUS', requestId: 1, code: 0, message: 'OK' });
    expect(vfs.readFile('/home/alice/b.txt')).toBe('AAA');
    expect(vfs.exists('/home/alice/a.txt')).toBe(false);
  });

  it('the ATOMIC flag (combined with OVERWRITE) is accepted and still renames correctly', () => {
    const { session, vfs } = buildSession();
    const reply = session.handle({
      type: 'RENAME', requestId: 1, oldPath: 'a.txt', newPath: 'b.txt',
      flags: SFTP_RENAME_FLAG.OVERWRITE | SFTP_RENAME_FLAG.ATOMIC,
    });
    expect(reply).toEqual({ type: 'STATUS', requestId: 1, code: 0, message: 'OK' });
    expect(vfs.readFile('/home/alice/b.txt')).toBe('AAA');
  });
});

describe('SftpWireSession — v6 LINK (hard link)', () => {
  function buildSession() {
    const vfs = new VirtualFileSystem();
    vfs.mkdirp('/home/alice', 0o755, 1000, 1000);
    vfs.writeFile('/home/alice/original.txt', 'shared content', 1000, 1000, 0o022);
    const fs = new LinuxSftpFSAdapter(vfs, 1000, 1000);
    const userCtx = new SshUserContext('alice', 1000, 1000, [], '/home/alice');
    const session = new SftpWireSession({ vfs: fs, userCtx, rootPath: '/home/alice' });
    return { vfs, session };
  }

  it('LINK creates a real hard link sharing the same content', () => {
    const { session, vfs } = buildSession();
    const reply = session.handle({ type: 'LINK', requestId: 1, newLinkPath: 'linked.txt', existingPath: 'original.txt' });
    expect(reply).toEqual({ type: 'STATUS', requestId: 1, code: 0, message: 'OK' });
    expect(vfs.readFile('/home/alice/linked.txt')).toBe('shared content');
  });

  it('LINK onto an already-existing path fails', () => {
    const { session, vfs } = buildSession();
    vfs.writeFile('/home/alice/other.txt', 'unrelated', 1000, 1000, 0o022);
    const reply = session.handle({ type: 'LINK', requestId: 1, newLinkPath: 'other.txt', existingPath: 'original.txt' });
    expect(reply.type).toBe('STATUS');
    expect((reply as { code: number }).code).toBeGreaterThan(0);
  });

  it('LINK reply SSH_FX_OP_UNSUPPORTED on a backing filesystem without hard-link support', () => {
    const vfs = new VirtualFileSystem();
    vfs.mkdirp('/home/alice', 0o755, 1000, 1000);
    vfs.writeFile('/home/alice/original.txt', 'shared content', 1000, 1000, 0o022);
    const base = new LinuxSftpFSAdapter(vfs, 1000, 1000);
    const noHardlinkFs = {
      normalizePath: (p: string, cwd: string) => base.normalizePath(p, cwd),
      exists: (p: string) => base.exists(p),
      getEntryType: (p: string) => base.getEntryType(p),
      readFile: (p: string) => base.readFile(p),
      listDirectory: (p: string) => base.listDirectory(p),
      stat: (p: string) => base.stat(p),
      writeFile: (p: string, c: string) => base.writeFile(p, c),
      mkdir: (p: string) => base.mkdir(p),
      deleteFile: (p: string) => base.deleteFile(p),
      rmdir: (p: string) => base.rmdir(p),
      rename: (s: string, d: string) => base.rename(s, d),
      setPermissions: (p: string, m: number) => base.setPermissions(p, m),
      setOwner: (p: string, u: number, g: number) => base.setOwner(p, u, g),
    };
    const userCtx = new SshUserContext('alice', 1000, 1000, [], '/home/alice');
    const session = new SftpWireSession({ vfs: noHardlinkFs, userCtx, rootPath: '/home/alice' });

    const reply = session.handle({ type: 'LINK', requestId: 1, newLinkPath: 'linked.txt', existingPath: 'original.txt' });
    expect(reply.type).toBe('STATUS');
    expect((reply as { code: number }).code).toBe(8); // SSH_FX_OP_UNSUPPORTED
  });
});
