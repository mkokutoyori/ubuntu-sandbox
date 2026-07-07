import { describe, it, expect, beforeEach } from 'vitest';
import { IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { FtpServer } from '@/network/ftp/FtpServer';
import { FtpClientSession } from '@/network/ftp/FtpClientSession';
import { VirtualFileSystem } from '@/network/devices/linux/VirtualFileSystem';
import { LinuxSftpFSAdapter } from '@/network/protocols/ssh/sftp/LinuxSftpFSAdapter';
import { encodeCompressedMode, decodeCompressedMode } from '@/network/ftp/compressedMode';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.clear();
});

function buildTopology() {
  const pc = new WindowsPC('windows-pc', 'PC1');
  const srv = new LinuxServer('linux-server', 'FTP1');
  pc.configureInterface('eth0', new IPAddress('10.0.1.2'), new SubnetMask('255.255.255.0'));
  srv.configureInterface('eth0', new IPAddress('10.0.1.10'), new SubnetMask('255.255.255.0'));
  new Cable('c1').connect(pc.getPort('eth0')!, srv.getPort('eth0')!);

  const vfs = new VirtualFileSystem();
  vfs.mkdirp('/srv/ftp', 0o755, 1000, 1000);
  const fs = new LinuxSftpFSAdapter(vfs, 1000, 1000);

  const users = new Map([['alice', 'wonderland']]);
  const server = new FtpServer(srv.getTcpStack(), '10.0.1.10', { users, fs, rootPath: '/srv/ftp' });
  server.start();

  const client = new FtpClientSession(pc.getTcpStack(), '10.0.1.10', '10.0.1.2');
  return { pc, srv, vfs, client };
}

function login(client: FtpClientSession): void {
  client.connect();
  client.sendCommand({ verb: 'USER', argument: 'alice' });
  client.sendCommand({ verb: 'PASS', argument: 'wonderland' });
}

describe('FTP MODE C codec (RFC 959 §3.4.2)', () => {
  it('round-trips a file mixing repetitive and non-repetitive sequences, bit-exact', () => {
    const original = 'AAAAAAAAAAAAAAAAAAAAAAAAAA' + 'The quick brown fox jumps over the lazy dog.' + '\x00\x00\x00\x00\x00' + 'xyz123!@#';
    const encoded = encodeCompressedMode(original);
    expect(decodeCompressedMode(encoded)).toBe(original);
  });

  it('actually compresses a long repeated run (uses fewer bytes than the input)', () => {
    const original = 'B'.repeat(200);
    const encoded = encodeCompressedMode(original);
    expect(encoded.length).toBeLessThan(original.length);
    expect(decodeCompressedMode(encoded)).toBe(original);
  });

  it('round-trips binary content with embedded nulls', () => {
    const original = 'binary-safe-content\x00\x01\x02\x02\x02\x02';
    const encoded = encodeCompressedMode(original);
    expect(decodeCompressedMode(encoded)).toBe(original);
  });

  it('round-trips the empty string', () => {
    expect(decodeCompressedMode(encodeCompressedMode(''))).toBe('');
  });

  it('decodes an explicit filler segment (descriptor 10cccccc)', () => {
    const descriptor = String.fromCharCode((0b10 << 6) | 5);
    expect(decodeCompressedMode(descriptor)).toBe('\x00\x00\x00\x00\x00');
  });

  it('rejects a reserved descriptor (11cccccc)', () => {
    const descriptor = String.fromCharCode((0b11 << 6) | 1);
    expect(decodeCompressedMode(descriptor)).toBeNull();
  });

  it('rejects a truncated regular segment', () => {
    const descriptor = String.fromCharCode((0b00 << 6) | 10) + 'short';
    expect(decodeCompressedMode(descriptor)).toBeNull();
  });

  it('rejects a truncated replicated segment (missing value byte)', () => {
    const descriptor = String.fromCharCode((0b01 << 6) | 5);
    expect(decodeCompressedMode(descriptor)).toBeNull();
  });
});

describe('FTP MODE C end-to-end transfer', () => {
  it('MODE C negotiates successfully and MODE S remains the default otherwise', () => {
    const { client } = buildTopology();
    login(client);
    expect(client.setTransferMode('C')?.code).toBe(200);
  });

  it('rejects an unsupported MODE parameter with 504', () => {
    const { client } = buildTopology();
    login(client);
    expect(client.sendCommand({ verb: 'MODE', argument: 'Z' })?.code).toBe(504);
  });

  it('uploads then downloads a file byte-exact under MODE C', () => {
    const { client, vfs } = buildTopology();
    login(client);
    client.setTransferMode('C');

    const content = 'AAAAAAAAAAAAAAAAAAAA' + 'mixed content here!' + 'BBBBBBBBBBBBBBBBBBBBBBBBBB';
    client.enterPassiveMode();
    const storReply = client.storeFile('modec.txt', content);
    expect(storReply?.code).toBe(226);
    // On disk, the server always keeps the plain (decompressed) bytes.
    expect(vfs.readFile('/srv/ftp/modec.txt')).toBe(content);

    client.enterPassiveMode();
    const { reply, content: downloaded } = client.retrieveFile('modec.txt');
    expect(reply?.code).toBe(226);
    expect(downloaded).toBe(content);
  });

  it('a plain (non-MODE-C) client reading the same file back under MODE S still gets valid bytes', () => {
    const { client, vfs } = buildTopology();
    login(client);
    client.setTransferMode('C');
    client.enterPassiveMode();
    client.storeFile('shared.txt', 'CCCCCCCCCCCCCCCCCCCCplain tail');
    expect(vfs.readFile('/srv/ftp/shared.txt')).toBe('CCCCCCCCCCCCCCCCCCCCplain tail');

    client.setTransferMode('S');
    client.enterPassiveMode();
    const { reply, content } = client.retrieveFile('shared.txt');
    expect(reply?.code).toBe(226);
    expect(content).toBe('CCCCCCCCCCCCCCCCCCCCplain tail');
  });
});
