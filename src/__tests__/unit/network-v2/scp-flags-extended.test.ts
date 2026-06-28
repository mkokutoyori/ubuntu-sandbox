import { describe, it, expect, beforeEach } from 'vitest';
import { parseScpArgs } from '@/network/protocols/ssh/Scp';
import { ScpSession } from '@/network/protocols/ssh/scp/ScpSession';
import { VirtualFileSystem } from '@/network/devices/linux/VirtualFileSystem';
import { VfsSftpFileSystem } from '@/network/protocols/ssh/sftp/VfsSftpFileSystem';
import { MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  MACAddress.resetCounter();
  resetDeviceCounters();
  Logger.reset();
});

describe('parseScpArgs — extended OpenSSH flags', () => {
  it('parses -q -v -C -T -p flags', () => {
    const r = parseScpArgs(['-q', '-v', '-C', '-T', '-p', '/a', 'u@h:/b'])!;
    expect(r.quiet).toBe(true);
    expect(r.verbose).toBe(true);
    expect(r.compression).toBe(true);
    expect(r.skipFilenameCheck).toBe(true);
    expect(r.preserve).toBe(true);
  });

  it('parses -l bandwidth-limit and -J jumphost', () => {
    const r = parseScpArgs(['-l', '500', '-J', 'bastion@10.0.0.99', '/a', 'u@h:/b'])!;
    expect(r.bandwidthLimitKbps).toBe(500);
    expect(r.jumpHost).toBe('bastion@10.0.0.99');
  });

  it('parses -o key=value options into a map', () => {
    const r = parseScpArgs([
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'UserKnownHostsFile=/dev/null',
      '/a', 'u@h:/b',
    ])!;
    expect(r.options.get('StrictHostKeyChecking')).toBe('no');
    expect(r.options.get('UserKnownHostsFile')).toBe('/dev/null');
  });

  it('rejects -l with invalid value gracefully (left as null)', () => {
    const r = parseScpArgs(['-l', 'abc', '/a', 'u@h:/b'])!;
    expect(r.bandwidthLimitKbps).toBeNull();
  });

  it('preserve flag is parsed (was previously checked via args.includes)', () => {
    const r1 = parseScpArgs(['-p', '/a', 'u@h:/b'])!;
    const r2 = parseScpArgs(['/a', 'u@h:/b'])!;
    expect(r1.preserve).toBe(true);
    expect(r2.preserve).toBe(false);
  });
});

describe('ScpSession — quiet and summary formatting', () => {
  function makeSession(args: string[]) {
    const localVfs = new VirtualFileSystem();
    const remoteVfs = new VirtualFileSystem();
    localVfs.writeFile('/tmp/payload.txt', 'hello-scp-world', 0, 0, 0o022);
    const local = new VfsSftpFileSystem(localVfs, { uid: 0, gid: 0, umask: 0o022 });
    const remote = new VfsSftpFileSystem(remoteVfs, { uid: 0, gid: 0, umask: 0o022 });
    return new ScpSession({
      args,
      local: { fs: local, cwd: '/' },
      resolveRemote: () => remote,
    });
  }

  it('-q suppresses the progress summary line', () => {
    const r = makeSession(['-q', '/tmp/payload.txt', 'u@h:/tmp/payload.txt']).run();
    expect(r.exitCode).toBe(0);
    expect(r.output).toBe('');
  });

  it('default (no -q) renders a properly scaled progress line', () => {
    const r = makeSession(['/tmp/payload.txt', 'u@h:/tmp/payload.txt']).run();
    expect(r.exitCode).toBe(0);
    expect(r.output).toMatch(/^payload\.txt\s+100%\s+15\s+15B\/s\s+00:00$/);
  });
});
