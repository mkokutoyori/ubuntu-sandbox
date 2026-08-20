/**
 * SCP real wire protocol (PRD-FTP-SFTP.md §2.1.19/P18) — `ScpWireCodec.ts`
 * is tested standalone (control-line/ack byte round-trips);
 * `ScpWireTransfer.ts` is tested against two real `ISftpFileSystem`s,
 * proving the C/D/E + ack sequence a real file/directory transfer
 * produces, and that acks reflect the actual write outcome.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters } from '@/network/core/types';
import { VirtualFileSystem } from '@/network/devices/linux/VirtualFileSystem';
import { LinuxSftpFSAdapter } from '@/network/protocols/ssh/sftp/LinuxSftpFSAdapter';
import {
  encodeScpControlLine, decodeScpControlLine, encodeScpAck, decodeScpAck, scpModeString, SCP_ACK,
  type ScpControlLine,
} from '@/network/protocols/ssh/scp/ScpWireCodec';
import { ScpWireTransfer } from '@/network/protocols/ssh/scp/ScpWireTransfer';

beforeEach(() => {
  resetCounters();
});

describe('ScpWireCodec — control-line round-trips (§2.1.19/P18)', () => {
  it('round-trips a C (file) control line', () => {
    const line: ScpControlLine = { kind: 'C', mode: '0644', size: 13, name: 'test.txt' };
    const encoded = encodeScpControlLine(line);
    expect(encoded).toBe('C0644 13 test.txt\n');
    expect(decodeScpControlLine(encoded)).toEqual(line);
  });

  it('round-trips a D (enter directory) control line', () => {
    const line: ScpControlLine = { kind: 'D', mode: '0755', name: 'subdir' };
    const encoded = encodeScpControlLine(line);
    expect(encoded).toBe('D0755 0 subdir\n');
    expect(decodeScpControlLine(encoded)).toEqual(line);
  });

  it('round-trips an E (leave directory) control line', () => {
    const line: ScpControlLine = { kind: 'E', mode: '', name: '' };
    const encoded = encodeScpControlLine(line);
    expect(encoded).toBe('E\n');
    expect(decodeScpControlLine(encoded)).toEqual(line);
  });

  it('decodes a control line whether or not the trailing newline is included', () => {
    expect(decodeScpControlLine('C0644 5 a.txt')).toEqual({ kind: 'C', mode: '0644', size: 5, name: 'a.txt' });
    expect(decodeScpControlLine('C0644 5 a.txt\n')).toEqual({ kind: 'C', mode: '0644', size: 5, name: 'a.txt' });
  });

  it('rejects malformed control lines', () => {
    expect(decodeScpControlLine('X0644 5 a.txt')).toBeNull();
    expect(decodeScpControlLine('C99 5 a.txt')).toBeNull();
    expect(decodeScpControlLine('garbage')).toBeNull();
  });

  it('scpModeString formats a numeric mode as a 4-digit octal string', () => {
    expect(scpModeString(0o644)).toBe('0644');
    expect(scpModeString(0o755)).toBe('0755');
    expect(scpModeString(0o600)).toBe('0600');
  });
});

describe('ScpWireCodec — ack byte round-trips', () => {
  it('round-trips SCP_ACK.OK as a single zero byte', () => {
    const bytes = encodeScpAck(SCP_ACK.OK);
    expect(Array.from(bytes)).toEqual([0]);
    expect(decodeScpAck(bytes)).toEqual({ ack: 0 });
  });

  it('round-trips a warning ack with a message', () => {
    const bytes = encodeScpAck(SCP_ACK.WARNING, 'partial transfer');
    expect(bytes[0]).toBe(1);
    expect(decodeScpAck(bytes)).toEqual({ ack: 1, message: 'partial transfer' });
  });

  it('round-trips a fatal ack with a message', () => {
    const bytes = encodeScpAck(SCP_ACK.FATAL, 'scp: /root/x: Permission denied');
    expect(bytes[0]).toBe(2);
    expect(decodeScpAck(bytes)).toEqual({ ack: 2, message: 'scp: /root/x: Permission denied' });
  });

  it('rejects an empty or out-of-range ack byte sequence', () => {
    expect(decodeScpAck(new Uint8Array([]))).toBeNull();
    expect(decodeScpAck(new Uint8Array([9]))).toBeNull();
  });
});

describe('ScpWireTransfer — real C/D/E + ack sequence against ISftpFileSystem', () => {
  function buildFsPair() {
    const localVfs = new VirtualFileSystem();
    localVfs.mkdirp('/home/alice', 0o755, 1000, 1000);
    const remoteVfs = new VirtualFileSystem();
    remoteVfs.mkdirp('/home/alice', 0o755, 1000, 1000);
    const local = new LinuxSftpFSAdapter(localVfs, 1000, 1000);
    const remote = new LinuxSftpFSAdapter(remoteVfs, 1000, 1000);
    return { localVfs, remoteVfs, local, remote };
  }

  it('a single-file push produces exactly one C line, streams the real bytes, and acks OK', () => {
    const { localVfs, remoteVfs, local, remote } = buildFsPair();
    localVfs.writeFile('/home/alice/hello.txt', 'hello scp wire', 1000, 1000, 0o022);

    const transfer = new ScpWireTransfer(local, remote);
    const result = transfer.push('/home/alice/hello.txt', '/home/alice', { recursive: false });

    expect(result.ok).toBe(true);
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0].line).toBe('C0644 14 hello.txt\n');
    expect(result.steps[0].dataLength).toBe(14);
    expect(result.steps[0].ack).toBe(SCP_ACK.OK);
    expect(result.filesTransferred).toBe(1);
    expect(result.bytesTransferred).toBe(14);
    expect(remoteVfs.readFile('/home/alice/hello.txt')).toBe('hello scp wire');
  });

  it('pushing a nonexistent path fails without emitting any control line', () => {
    const { local, remote } = buildFsPair();
    const transfer = new ScpWireTransfer(local, remote);
    const result = transfer.push('/home/alice/ghost.txt', '/home/alice', { recursive: false });
    expect(result.ok).toBe(false);
    expect(result.steps).toHaveLength(0);
    expect(result.error).toMatch(/No such file or directory/);
  });

  it('pushing a directory without -r fails', () => {
    const { localVfs, local, remote } = buildFsPair();
    localVfs.mkdirp('/home/alice/subdir', 0o755, 1000, 1000);
    const transfer = new ScpWireTransfer(local, remote);
    const result = transfer.push('/home/alice/subdir', '/home/alice', { recursive: false });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not a regular file/);
  });

  it('a recursive directory push produces the correct D.../C.../E sequence', () => {
    const { localVfs, remoteVfs, local, remote } = buildFsPair();
    localVfs.mkdirp('/home/alice/project', 0o755, 1000, 1000);
    localVfs.writeFile('/home/alice/project/a.txt', 'AAA', 1000, 1000, 0o022);
    localVfs.mkdirp('/home/alice/project/nested', 0o755, 1000, 1000);
    localVfs.writeFile('/home/alice/project/nested/b.txt', 'BBBB', 1000, 1000, 0o022);

    const transfer = new ScpWireTransfer(local, remote);
    const result = transfer.push('/home/alice/project', '/home/alice', { recursive: true });

    expect(result.ok).toBe(true);
    const kinds = result.steps.map((s) => s.line[0]);
    // D project, C a.txt, D nested, C b.txt, E (nested), E (project)
    expect(kinds).toEqual(['D', 'C', 'D', 'C', 'E', 'E']);
    expect(result.steps.every((s) => s.ack === SCP_ACK.OK)).toBe(true);
    expect(result.filesTransferred).toBe(2);
    expect(result.bytesTransferred).toBe(7);

    expect(remoteVfs.readFile('/home/alice/project/a.txt')).toBe('AAA');
    expect(remoteVfs.readFile('/home/alice/project/nested/b.txt')).toBe('BBBB');
  });

  it('recursing into an already-existing destination directory still succeeds (ack OK, no duplicate error)', () => {
    const { localVfs, remoteVfs, local, remote } = buildFsPair();
    localVfs.mkdirp('/home/alice/project', 0o755, 1000, 1000);
    localVfs.writeFile('/home/alice/project/a.txt', 'AAA', 1000, 1000, 0o022);
    remoteVfs.mkdirp('/home/alice/project', 0o755, 1000, 1000); // pre-existing on the sink side

    const transfer = new ScpWireTransfer(local, remote);
    const result = transfer.push('/home/alice/project', '/home/alice', { recursive: true });
    expect(result.ok).toBe(true);
    expect(result.steps.every((s) => s.ack === SCP_ACK.OK)).toBe(true);
  });

  it('a write failure on the sink side acks FATAL and stops the transfer', () => {
    const { localVfs, local } = buildFsPair();
    localVfs.writeFile('/home/alice/hello.txt', 'hello', 1000, 1000, 0o022);

    // A destination fs whose writeFile always fails, to exercise the FATAL-ack path.
    const failingRemote = {
      normalizePath: (p: string, cwd: string) => local.normalizePath(p, cwd),
      exists: () => false,
      getEntryType: () => null,
      readFile: () => ({ ok: false as const, error: { kind: 'IO_ERROR' as const, message: 'n/a' } }),
      listDirectory: () => ({ ok: false as const, error: { kind: 'IO_ERROR' as const, message: 'n/a' } }),
      stat: () => ({ ok: false as const, error: { kind: 'IO_ERROR' as const, message: 'n/a' } }),
      writeFile: () => ({ ok: false as const, error: { kind: 'IO_ERROR' as const, message: 'disk full' } }),
      mkdir: () => ({ ok: false as const, error: { kind: 'IO_ERROR' as const, message: 'n/a' } }),
      deleteFile: () => ({ ok: false as const, error: { kind: 'IO_ERROR' as const, message: 'n/a' } }),
      rmdir: () => ({ ok: false as const, error: { kind: 'IO_ERROR' as const, message: 'n/a' } }),
      rename: () => ({ ok: false as const, error: { kind: 'IO_ERROR' as const, message: 'n/a' } }),
      setPermissions: () => ({ ok: false as const, error: { kind: 'IO_ERROR' as const, message: 'n/a' } }),
      setOwner: () => ({ ok: false as const, error: { kind: 'IO_ERROR' as const, message: 'n/a' } }),
    };

    const transfer = new ScpWireTransfer(local, failingRemote);
    const result = transfer.push('/home/alice/hello.txt', '/home/alice', { recursive: false });
    expect(result.ok).toBe(false);
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0].ack).toBe(SCP_ACK.FATAL);
    expect(result.steps[0].ackMessage).toMatch(/cannot write/);
    expect(result.error).toMatch(/cannot write/);
  });
});
