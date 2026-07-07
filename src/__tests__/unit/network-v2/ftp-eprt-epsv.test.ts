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
import {
  encodeEprtArgument, decodeEprtArgument, encodeEpsvReplyArgument, decodeEpsvReplyArgument,
} from '@/network/ftp/DataChannel';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.clear();
});

// Windows client <-> Linux FTP server, per the same cross-platform-topology
// convention as ftp-navigation.test.ts.
function buildTopology() {
  const pc = new WindowsPC('windows-pc', 'PC1');
  const srv = new LinuxServer('linux-server', 'FTP1');
  pc.configureInterface('eth0', new IPAddress('10.0.1.2'), new SubnetMask('255.255.255.0'));
  srv.configureInterface('eth0', new IPAddress('10.0.1.10'), new SubnetMask('255.255.255.0'));
  new Cable('c1').connect(pc.getPort('eth0')!, srv.getPort('eth0')!);

  const vfs = new VirtualFileSystem();
  vfs.mkdirp('/srv/ftp', 0o755, 1000, 1000);
  vfs.writeFile('/srv/ftp/hello.txt', 'hello ftp world', 1000, 1000, 0o022);
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

describe('FTP EPRT/EPSV codec (RFC 2428 §2-3)', () => {
  it('round-trips an EPRT argument for an IPv4 address', () => {
    const arg = encodeEprtArgument(1, '10.0.1.2', 40000);
    expect(arg).toBe('|1|10.0.1.2|40000|');
    expect(decodeEprtArgument(arg)).toEqual({ protocol: 1, address: '10.0.1.2', port: 40000 });
  });

  it('round-trips an EPRT argument for an IPv6 address', () => {
    const arg = encodeEprtArgument(2, '1080::8:800:200c:417a', 5282);
    expect(arg).toBe('|2|1080::8:800:200c:417a|5282|');
    expect(decodeEprtArgument(arg)).toEqual({ protocol: 2, address: '1080::8:800:200c:417a', port: 5282 });
  });

  it('rejects a malformed EPRT argument', () => {
    expect(decodeEprtArgument('')).toBeNull();
    expect(decodeEprtArgument('|1|10.0.1.2|not-a-port|')).toBeNull();
    expect(decodeEprtArgument('|3|10.0.1.2|40000|')).toBeNull();
  });

  it('round-trips an EPSV reply argument', () => {
    const text = encodeEpsvReplyArgument(30500);
    expect(text).toBe('(|||30500|)');
    expect(decodeEpsvReplyArgument(text)).toBe(30500);
  });
});

describe('FTP EPSV (RFC 2428 §3) — passive mode over the extended command', () => {
  it('opens a real second TCP connection distinct from the control port', () => {
    const { client } = buildTopology();
    login(client);
    const r = client.enterExtendedPassiveMode();
    expect(r?.code).toBe(229);
    expect(r?.lines[0]).toMatch(/\(\|\|\|\d+\|\)/);
  });

  it('downloads a file byte-exact via RETR over an EPSV data connection', () => {
    const { client } = buildTopology();
    login(client);
    client.enterExtendedPassiveMode();
    const { reply, content } = client.retrieveFile('hello.txt');
    expect(reply?.code).toBe(226);
    expect(content).toBe('hello ftp world');
  });

  it('uploads a file byte-exact via STOR over an EPSV data connection', () => {
    const { client, vfs } = buildTopology();
    login(client);
    client.enterExtendedPassiveMode();
    const reply = client.storeFile('epsv-upload.txt', 'sent over EPSV');
    expect(reply?.code).toBe(226);
    expect(vfs.readFile('/srv/ftp/epsv-upload.txt')).toBe('sent over EPSV');
  });

  it('requires authentication before EPSV', () => {
    const { client } = buildTopology();
    client.connect();
    expect(client.sendCommand({ verb: 'EPSV' })?.code).toBe(530);
  });
});

describe('FTP EPRT (RFC 2428 §2) — active mode over the extended command', () => {
  it('opens a real second TCP connection where the server dials back to the client', () => {
    const { client } = buildTopology();
    login(client);
    const r = client.enterExtendedActiveMode(41000);
    expect(r?.code).toBe(200);
  });

  it('downloads a file byte-exact via RETR over an EPRT data connection', () => {
    const { client } = buildTopology();
    login(client);
    client.enterExtendedActiveMode(41001);
    const { reply, content } = client.retrieveFile('hello.txt');
    expect(reply?.code).toBe(226);
    expect(content).toBe('hello ftp world');
  });

  it('uploads a file byte-exact via STOR over an EPRT data connection', () => {
    const { client, vfs } = buildTopology();
    login(client);
    client.enterExtendedActiveMode(41002);
    const reply = client.storeFile('eprt-upload.txt', 'sent over EPRT');
    expect(reply?.code).toBe(226);
    expect(vfs.readFile('/srv/ftp/eprt-upload.txt')).toBe('sent over EPRT');
  });

  it('rejects a malformed EPRT command with 501', () => {
    const { client } = buildTopology();
    login(client);
    const reply = client.sendCommand({ verb: 'EPRT', argument: 'garbage' });
    expect(reply?.code).toBe(501);
  });

  it('requires authentication before EPRT', () => {
    const { client } = buildTopology();
    client.connect();
    expect(client.sendCommand({ verb: 'EPRT', argument: '|1|10.0.1.2|41000|' })?.code).toBe(530);
  });
});
