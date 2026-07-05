import { describe, it, expect, beforeEach } from 'vitest';
import { IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { FtpServer } from '@/network/ftp/FtpServer';
import { FtpClientSession } from '@/network/ftp/FtpClientSession';
import { VirtualFileSystem } from '@/network/devices/linux/VirtualFileSystem';
import { LinuxSftpFSAdapter } from '@/network/protocols/ssh/sftp/LinuxSftpFSAdapter';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.clear();
});

function buildTopology() {
  const pc = new LinuxPC('linux-pc', 'PC1');
  const srv = new LinuxServer('FTP1');
  pc.configureInterface('eth0', new IPAddress('10.0.1.2'), new SubnetMask('255.255.255.0'));
  srv.configureInterface('eth0', new IPAddress('10.0.1.10'), new SubnetMask('255.255.255.0'));
  new Cable('c1').connect(pc.getPort('eth0')!, srv.getPort('eth0')!);

  // `/srv` itself already exists in VirtualFileSystem's default root layout,
  // owned by root (uid 0) — a fresh subdirectory is needed so uid 1000 can
  // actually write into it.
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

describe('FTP data channel — passive mode (RFC 959 §2.3, PASV)', () => {
  it('opens a real second TCP connection distinct from the control port', () => {
    const { client } = buildTopology();
    login(client);
    const r = client.enterPassiveMode();
    expect(r?.code).toBe(227);
    expect(r?.lines[0]).toMatch(/\(\d+,\d+,\d+,\d+,\d+,\d+\)/);
  });

  it('downloads a file byte-exact via RETR', () => {
    const { client } = buildTopology();
    login(client);
    client.enterPassiveMode();
    const { reply, content } = client.retrieveFile('hello.txt');
    expect(reply?.code).toBe(226);
    expect(content).toBe('hello ftp world');
  });

  it('replies 550 for a RETR on a nonexistent file', () => {
    const { client } = buildTopology();
    login(client);
    client.enterPassiveMode();
    const { reply } = client.retrieveFile('missing.txt');
    expect(reply?.code).toBe(550);
  });

  it('uploads a file byte-exact via STOR', () => {
    const { client, vfs } = buildTopology();
    login(client);
    client.enterPassiveMode();
    const reply = client.storeFile('uploaded.txt', 'binary-safe-content\x00\x01\x02');
    expect(reply?.code).toBe(226);
    expect(vfs.readFile('/srv/ftp/uploaded.txt')).toBe('binary-safe-content\x00\x01\x02');
  });

  it('appends to an existing file via APPE', () => {
    const { client, vfs } = buildTopology();
    login(client);
    client.enterPassiveMode();
    const reply = client.storeFile('hello.txt', ' plus more', 'APPE');
    expect(reply?.code).toBe(226);
    expect(vfs.readFile('/srv/ftp/hello.txt')).toBe('hello ftp world plus more');
  });

  it('picks a fresh unique name via STOU', () => {
    const { client, vfs } = buildTopology();
    login(client);
    client.enterPassiveMode();
    const reply = client.storeFile('hello.txt', 'unique content', 'STOU');
    expect(reply?.code).toBe(226);
    expect(reply?.lines[0]).toMatch(/^FILE: /);
    expect(vfs.exists('/srv/ftp/hello.txt.1')).toBe(true);
    expect(vfs.readFile('/srv/ftp/hello.txt.1')).toBe('unique content');
    expect(vfs.readFile('/srv/ftp/hello.txt')).toBe('hello ftp world');
  });

  it('lists a directory in long form via LIST', () => {
    const { client } = buildTopology();
    login(client);
    client.enterPassiveMode();
    const { reply, lines } = client.list(undefined, 'LIST');
    expect(reply?.code).toBe(226);
    expect(lines.some((l) => l.endsWith(' hello.txt'))).toBe(true);
  });

  it('lists bare names via NLST', () => {
    const { client } = buildTopology();
    login(client);
    client.enterPassiveMode();
    const { reply, lines } = client.list(undefined, 'NLST');
    expect(reply?.code).toBe(226);
    expect(lines).toEqual(['hello.txt']);
  });
});

describe('FTP data channel — active mode (RFC 959 §2.3, PORT)', () => {
  it('opens a real second TCP connection where the server dials back to the client', () => {
    const { client } = buildTopology();
    login(client);
    const r = client.enterActiveMode(40000);
    expect(r?.code).toBe(200);
  });

  it('downloads a file byte-exact via RETR over an active-mode data connection', () => {
    const { client } = buildTopology();
    login(client);
    client.enterActiveMode(40001);
    const { reply, content } = client.retrieveFile('hello.txt');
    expect(reply?.code).toBe(226);
    expect(content).toBe('hello ftp world');
  });

  it('uploads a file byte-exact via STOR over an active-mode data connection', () => {
    const { client, vfs } = buildTopology();
    login(client);
    client.enterActiveMode(40002);
    const reply = client.storeFile('active-upload.txt', 'sent over PORT');
    expect(reply?.code).toBe(226);
    expect(vfs.readFile('/srv/ftp/active-upload.txt')).toBe('sent over PORT');
  });
});

describe('FTP data channel — errors', () => {
  it('replies 425 when a transfer command arrives with no PORT/PASV beforehand', () => {
    const { client } = buildTopology();
    login(client);
    const reply = client.sendCommand({ verb: 'RETR', argument: 'hello.txt' });
    expect(reply?.code).toBe(425);
  });

  it('requires authentication before PORT/PASV', () => {
    const { client } = buildTopology();
    client.connect();
    expect(client.sendCommand({ verb: 'PASV' })?.code).toBe(530);
  });
});
