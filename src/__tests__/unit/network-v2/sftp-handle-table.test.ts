/**
 * SFTP real handle model (draft-ietf-secsh-filexfer §6.4-6.7) —
 * PRD-FTP-SFTP.md §2.1.15/P14. `SftpHandleTable.ts` is tested directly;
 * `SftpWireSession.ts`'s OPEN/READ/WRITE/CLOSE are tested against a real
 * `ISftpFileSystem`, proving handle-based, offset+length file transfer
 * works as a logical cursor over the same atomic `get`/`put` commands.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters } from '@/network/core/types';
import { VirtualFileSystem } from '@/network/devices/linux/VirtualFileSystem';
import { LinuxSftpFSAdapter } from '@/network/protocols/ssh/sftp/LinuxSftpFSAdapter';
import { SshUserContext } from '@/network/protocols/ssh/SshUserContext';
import { SftpWireSession } from '@/network/protocols/ssh/sftp/SftpWireSession';
import { SftpHandleTable } from '@/network/protocols/ssh/sftp/SftpHandleTable';
import type { SftpWirePacket } from '@/network/protocols/ssh/sftp/SftpWireCodec';

beforeEach(() => {
  resetCounters();
});

function bytesToString(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += String.fromCharCode(b);
  return out;
}

function stringToBytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

describe('SftpHandleTable', () => {
  it('opens, retrieves, and closes a handle', () => {
    const table = new SftpHandleTable();
    const handle = table.open({ kind: 'dir', path: '/tmp', drained: false });
    expect(table.get(handle)).toEqual({ kind: 'dir', path: '/tmp', drained: false });
    expect(table.openCount).toBe(1);
    expect(table.close(handle)).toBe(true);
    expect(table.get(handle)).toBeUndefined();
    expect(table.openCount).toBe(0);
  });

  it('issues distinct handles for concurrent opens', () => {
    const table = new SftpHandleTable();
    const h1 = table.open({ kind: 'file-read', path: '/a', content: '' });
    const h2 = table.open({ kind: 'file-read', path: '/b', content: '' });
    expect(h1).not.toBe(h2);
    expect(table.openCount).toBe(2);
  });

  it('close on an unknown handle returns false', () => {
    const table = new SftpHandleTable();
    expect(table.close('nonexistent')).toBe(false);
  });
});

describe('SftpWireSession — real OPEN/READ/WRITE/CLOSE handle model', () => {
  function buildSession() {
    const vfs = new VirtualFileSystem();
    vfs.mkdirp('/home/alice', 0o755, 1000, 1000);
    vfs.writeFile('/home/alice/hello.txt', 'hello sftp handles', 1000, 1000, 0o022);
    const fs = new LinuxSftpFSAdapter(vfs, 1000, 1000);
    const userCtx = new SshUserContext('alice', 1000, 1000, [], '/home/alice');
    const session = new SftpWireSession({ vfs: fs, userCtx, rootPath: '/home/alice' });
    return { vfs, session };
  }

  const SSH_FXF_READ = 0x01;
  const SSH_FXF_WRITE = 0x02;
  const SSH_FXF_APPEND = 0x04;

  it('OPEN(read)+READ+CLOSE downloads a file byte-exact', () => {
    const { session } = buildSession();
    const openReply = session.handle({ type: 'OPEN', requestId: 1, filename: 'hello.txt', pflags: SSH_FXF_READ, attrs: {} });
    expect(openReply.type).toBe('HANDLE');
    const handle = (openReply as { handle: string }).handle;

    const readReply = session.handle({ type: 'READ', requestId: 2, handle, offset: 0, length: 512 });
    expect(readReply.type).toBe('DATA');
    expect(bytesToString((readReply as { data: Uint8Array }).data)).toBe('hello sftp handles');

    const eofReply = session.handle({ type: 'READ', requestId: 3, handle, offset: 'hello sftp handles'.length, length: 512 });
    expect(eofReply).toEqual({ type: 'STATUS', requestId: 3, code: 1, message: 'End of file.' });

    expect(session.handle({ type: 'CLOSE', requestId: 4, handle })).toEqual({ type: 'STATUS', requestId: 4, code: 0, message: 'OK' });
  });

  it('READ at an arbitrary offset returns only the requested slice', () => {
    const { session } = buildSession();
    const openReply = session.handle({ type: 'OPEN', requestId: 1, filename: 'hello.txt', pflags: SSH_FXF_READ, attrs: {} });
    const handle = (openReply as { handle: string }).handle;
    const reply = session.handle({ type: 'READ', requestId: 2, handle, offset: 6, length: 4 });
    expect(bytesToString((reply as { data: Uint8Array }).data)).toBe('sftp');
  });

  it('OPEN(write)+WRITE+CLOSE uploads a file byte-exact', () => {
    const { session, vfs } = buildSession();
    const openReply = session.handle({ type: 'OPEN', requestId: 1, filename: 'uploaded.txt', pflags: SSH_FXF_WRITE, attrs: {} });
    expect(openReply.type).toBe('HANDLE');
    const handle = (openReply as { handle: string }).handle;

    const writeReply = session.handle({ type: 'WRITE', requestId: 2, handle, offset: 0, data: stringToBytes('uploaded via real handles') });
    expect(writeReply).toEqual({ type: 'STATUS', requestId: 2, code: 0, message: 'OK' });

    session.handle({ type: 'CLOSE', requestId: 3, handle });
    expect(vfs.readFile('/home/alice/uploaded.txt')).toBe('uploaded via real handles');
  });

  it('multiple WRITE chunks at increasing offsets assemble into one file', () => {
    const { session, vfs } = buildSession();
    const openReply = session.handle({ type: 'OPEN', requestId: 1, filename: 'chunked.txt', pflags: SSH_FXF_WRITE, attrs: {} });
    const handle = (openReply as { handle: string }).handle;

    session.handle({ type: 'WRITE', requestId: 2, handle, offset: 0, data: stringToBytes('AAAA') });
    session.handle({ type: 'WRITE', requestId: 3, handle, offset: 4, data: stringToBytes('BBBB') });
    session.handle({ type: 'WRITE', requestId: 4, handle, offset: 8, data: stringToBytes('CCCC') });
    session.handle({ type: 'CLOSE', requestId: 5, handle });

    expect(vfs.readFile('/home/alice/chunked.txt')).toBe('AAAABBBBCCCC');
  });

  it('a sparse WRITE (gap beyond current length) zero-pads the gap', () => {
    const { session, vfs } = buildSession();
    const openReply = session.handle({ type: 'OPEN', requestId: 1, filename: 'sparse.txt', pflags: SSH_FXF_WRITE, attrs: {} });
    const handle = (openReply as { handle: string }).handle;

    session.handle({ type: 'WRITE', requestId: 2, handle, offset: 5, data: stringToBytes('END') });
    session.handle({ type: 'CLOSE', requestId: 3, handle });

    expect(vfs.readFile('/home/alice/sparse.txt')).toBe('\x00\x00\x00\x00\x00END');
  });

  it('OPEN with WRITE|APPEND preserves the existing content and appends after it', () => {
    const { session, vfs } = buildSession();
    const openReply = session.handle({
      type: 'OPEN', requestId: 1, filename: 'hello.txt', pflags: SSH_FXF_WRITE | SSH_FXF_APPEND, attrs: {},
    });
    const handle = (openReply as { handle: string }).handle;
    const existingLen = 'hello sftp handles'.length;
    session.handle({ type: 'WRITE', requestId: 2, handle, offset: existingLen, data: stringToBytes(' plus more') });
    session.handle({ type: 'CLOSE', requestId: 3, handle });

    expect(vfs.readFile('/home/alice/hello.txt')).toBe('hello sftp handles plus more');
  });

  it('a full multi-block round trip: write in chunks, then read back in chunks', () => {
    const { session } = buildSession();
    const content = 'ABCDEFGHIJ'.repeat(20); // 200 bytes

    const writeOpen = session.handle({ type: 'OPEN', requestId: 1, filename: 'multi.txt', pflags: SSH_FXF_WRITE, attrs: {} });
    const writeHandle = (writeOpen as { handle: string }).handle;
    const chunkSize = 16;
    for (let offset = 0; offset < content.length; offset += chunkSize) {
      const chunk = content.slice(offset, offset + chunkSize);
      session.handle({ type: 'WRITE', requestId: 2, handle: writeHandle, offset, data: stringToBytes(chunk) });
    }
    session.handle({ type: 'CLOSE', requestId: 3, handle: writeHandle });

    const readOpen = session.handle({ type: 'OPEN', requestId: 4, filename: 'multi.txt', pflags: SSH_FXF_READ, attrs: {} });
    const readHandle = (readOpen as { handle: string }).handle;
    let reassembled = '';
    let offset = 0;
    for (;;) {
      const reply = session.handle({ type: 'READ', requestId: 5, handle: readHandle, offset, length: chunkSize }) as SftpWirePacket;
      if (reply.type === 'STATUS') { expect(reply.code).toBe(1); break; }
      expect(reply.type).toBe('DATA');
      const data = (reply as { data: Uint8Array }).data;
      reassembled += bytesToString(data);
      offset += data.length;
    }
    session.handle({ type: 'CLOSE', requestId: 6, handle: readHandle });

    expect(reassembled).toBe(content);
  });

  it('two concurrently open handles are fully isolated', () => {
    const { session, vfs } = buildSession();
    vfs.writeFile('/home/alice/second.txt', 'second file', 1000, 1000, 0o022);

    const h1 = (session.handle({ type: 'OPEN', requestId: 1, filename: 'hello.txt', pflags: SSH_FXF_READ, attrs: {} }) as { handle: string }).handle;
    const h2 = (session.handle({ type: 'OPEN', requestId: 2, filename: 'second.txt', pflags: SSH_FXF_READ, attrs: {} }) as { handle: string }).handle;
    expect(h1).not.toBe(h2);

    const r1 = session.handle({ type: 'READ', requestId: 3, handle: h1, offset: 0, length: 512 });
    const r2 = session.handle({ type: 'READ', requestId: 4, handle: h2, offset: 0, length: 512 });
    expect(bytesToString((r1 as { data: Uint8Array }).data)).toBe('hello sftp handles');
    expect(bytesToString((r2 as { data: Uint8Array }).data)).toBe('second file');
  });

  it('READ/WRITE/CLOSE on an unknown handle reply SSH_FX_FAILURE', () => {
    const { session } = buildSession();
    expect(session.handle({ type: 'READ', requestId: 1, handle: 'ghost', offset: 0, length: 10 }))
      .toEqual({ type: 'STATUS', requestId: 1, code: 4, message: 'Invalid handle.' });
    expect(session.handle({ type: 'WRITE', requestId: 2, handle: 'ghost', offset: 0, data: new Uint8Array() }))
      .toEqual({ type: 'STATUS', requestId: 2, code: 4, message: 'Invalid handle.' });
    expect(session.handle({ type: 'CLOSE', requestId: 3, handle: 'ghost' }))
      .toEqual({ type: 'STATUS', requestId: 3, code: 4, message: 'Invalid handle.' });
  });

  it('OPEN(read) on a nonexistent file fails without allocating a handle', () => {
    const { session } = buildSession();
    const reply = session.handle({ type: 'OPEN', requestId: 1, filename: 'ghost.txt', pflags: SSH_FXF_READ, attrs: {} });
    expect(reply.type).toBe('STATUS');
    expect((reply as { code: number }).code).toBeGreaterThan(0);
  });
});
