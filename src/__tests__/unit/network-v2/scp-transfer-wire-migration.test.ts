/**
 * ScpTransfer real wire migration (PRD-FTP-SFTP.md §2.1.20/P19).
 * `ScpTransfer.ts`'s public `run()`/`ScpTransferResult` surface is
 * unchanged — behavioral regression coverage for it already lives in
 * `scp-sftp-domain.test.ts`/`scp-flags-extended.test.ts` and stays
 * green unmodified. This file proves the copy now genuinely goes
 * through `ScpWireTransfer`'s real `C`/`D`/`E` + ack wire sequence
 * instead of calling `readFile`/`writeFile` directly.
 */
import { describe, it, expect, vi } from 'vitest';
import { resetCounters } from '@/network/core/types';
import { VirtualFileSystem } from '@/network/devices/linux/VirtualFileSystem';
import { LinuxSftpFSAdapter } from '@/network/protocols/ssh/sftp/LinuxSftpFSAdapter';
import { ScpTransfer } from '@/network/protocols/ssh/scp/ScpTransfer';
import { ScpWireTransfer } from '@/network/protocols/ssh/scp/ScpWireTransfer';

function buildFsPair() {
  const localVfs = new VirtualFileSystem();
  localVfs.mkdirp('/home/alice', 0o755, 1000, 1000);
  const remoteVfs = new VirtualFileSystem();
  remoteVfs.mkdirp('/home/alice', 0o755, 1000, 1000);
  return {
    localVfs, remoteVfs,
    local: new LinuxSftpFSAdapter(localVfs, 1000, 1000),
    remote: new LinuxSftpFSAdapter(remoteVfs, 1000, 1000),
  };
}

describe('ScpTransfer drives the real ScpWireTransfer underneath (§2.1.20/P19)', () => {
  it('a push calls ScpWireTransfer.push() exactly once, with the real recursive/preserve options', () => {
    resetCounters();
    const { localVfs, local, remote } = buildFsPair();
    localVfs.writeFile('/home/alice/hello.txt', 'hello scp migration', 1000, 1000, 0o022);
    const spy = vi.spyOn(ScpWireTransfer.prototype, 'push');

    const transfer = new ScpTransfer(
      { local, remote },
      { remote: false, path: '/home/alice/hello.txt' },
      { remote: true, host: 'h', path: '/home/alice/hello.txt' },
      { recursive: false, preserve: true, localCwd: '/', remoteCwd: '/' },
    );
    const result = transfer.run();

    expect(result.ok).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(
      '/home/alice/hello.txt', '/home/alice/hello.txt',
      { recursive: false, preserve: true },
    );
    spy.mockRestore();
  });

  it('bytesTransferred/filesTransferred in ScpTransferResult come straight from the real wire transfer result', () => {
    resetCounters();
    const { localVfs, remoteVfs, local, remote } = buildFsPair();
    localVfs.mkdirp('/home/alice/tree', 0o755, 1000, 1000);
    localVfs.writeFile('/home/alice/tree/a.txt', 'AAAA', 1000, 1000, 0o022);
    localVfs.writeFile('/home/alice/tree/b.txt', 'BB', 1000, 1000, 0o022);

    const transfer = new ScpTransfer(
      { local, remote },
      { remote: false, path: '/home/alice/tree' },
      { remote: true, host: 'h', path: '/home/alice' },
      { recursive: true, preserve: false, localCwd: '/', remoteCwd: '/' },
    );
    const result = transfer.run();

    expect(result.ok).toBe(true);
    expect(result.filesTransferred).toBe(2);
    expect(result.bytesTransferred).toBe(6);
    expect(remoteVfs.readFile('/home/alice/tree/a.txt')).toBe('AAAA');
    expect(remoteVfs.readFile('/home/alice/tree/b.txt')).toBe('BB');
  });

  it('a real write failure on the wire surfaces ScpWireTransfer\'s own error text through ScpTransferResult.error', () => {
    resetCounters();
    const { localVfs, local } = buildFsPair();
    localVfs.writeFile('/home/alice/hello.txt', 'x', 1000, 1000, 0o022);

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

    const transfer = new ScpTransfer(
      { local, remote: failingRemote },
      { remote: false, path: '/home/alice/hello.txt' },
      { remote: true, host: 'h', path: '/home/alice/hello.txt' },
      { recursive: false, preserve: false, localCwd: '/', remoteCwd: '/' },
    );
    const result = transfer.run();
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/cannot write/);
  });
});
