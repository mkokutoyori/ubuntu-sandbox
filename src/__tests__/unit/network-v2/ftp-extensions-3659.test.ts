import { describe, it, expect, beforeEach } from 'vitest';
import { IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { WindowsServer } from '@/network/devices/WindowsServer';
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

// Linux client <-> Windows FTP server this time, for topology variety.
function buildTopology() {
  const pc = new LinuxPC('linux-pc', 'PC1');
  const srv = new WindowsServer('FTP1');
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

describe('FTP RFC 3659 extensions', () => {
  it('FEAT announces exactly the implemented extension set', () => {
    const { client } = buildTopology();
    client.connect();
    const r = client.sendCommand({ verb: 'FEAT' });
    expect(r?.code).toBe(211);
    expect(r?.lines).toEqual([
      'Extensions supported:', 'SIZE', 'MDTM', 'REST STREAM', 'MLST type*;size*;modify*;', 'EPRT', 'EPSV', 'END',
    ]);
  });

  it('FEAT does not require authentication', () => {
    const { client } = buildTopology();
    client.connect();
    expect(client.sendCommand({ verb: 'FEAT' })?.code).toBe(211);
  });

  it('SIZE reports the exact byte size of a file', () => {
    const { client } = buildTopology();
    login(client);
    const r = client.sendCommand({ verb: 'SIZE', argument: 'hello.txt' });
    expect(r?.code).toBe(213);
    expect(r?.lines[0]).toBe(String('hello ftp world'.length));
  });

  it('SIZE fails with 550 for a nonexistent file', () => {
    const { client } = buildTopology();
    login(client);
    expect(client.sendCommand({ verb: 'SIZE', argument: 'ghost.txt' })?.code).toBe(550);
  });

  it('MDTM reports a YYYYMMDDHHMMSS timestamp consistent with the filesystem', () => {
    const { client, vfs } = buildTopology();
    login(client);
    const r = client.sendCommand({ verb: 'MDTM', argument: 'hello.txt' });
    expect(r?.code).toBe(213);
    expect(r?.lines[0]).toMatch(/^\d{14}$/);

    const stat = vfs.lstat('/srv/ftp/hello.txt')!;
    const d = new Date(stat.mtime);
    const pad = (n: number) => String(n).padStart(2, '0');
    const expected = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
    expect(r?.lines[0]).toBe(expected);
  });

  it('MDTM fails with 550 for a nonexistent file', () => {
    const { client } = buildTopology();
    login(client);
    expect(client.sendCommand({ verb: 'MDTM', argument: 'ghost.txt' })?.code).toBe(550);
  });

  it('REST followed by RETR resumes at the requested offset', () => {
    const { client } = buildTopology();
    login(client);
    expect(client.sendCommand({ verb: 'REST', argument: '6' })?.code).toBe(350);
    client.enterPassiveMode();
    const { reply, content } = client.retrieveFile('hello.txt');
    expect(reply?.code).toBe(226);
    expect(content).toBe('ftp world');
  });

  it('REST followed by STOR resumes an upload at the requested offset', () => {
    const { client, vfs } = buildTopology();
    login(client);
    client.enterPassiveMode();
    expect(client.sendCommand({ verb: 'REST', argument: '6' })?.code).toBe(350);
    const reply = client.storeFile('hello.txt', 'REST WORLD!');
    expect(reply?.code).toBe(226);
    expect(vfs.readFile('/srv/ftp/hello.txt')).toBe('hello REST WORLD!');
  });

  it('REST is a one-shot marker: a second RETR without a fresh REST starts at offset 0', () => {
    const { client } = buildTopology();
    login(client);
    client.sendCommand({ verb: 'REST', argument: '6' });
    client.enterPassiveMode();
    client.retrieveFile('hello.txt');

    client.enterPassiveMode();
    const { content } = client.retrieveFile('hello.txt');
    expect(content).toBe('hello ftp world');
  });

  it('REST rejects a malformed offset with 501', () => {
    const { client } = buildTopology();
    login(client);
    expect(client.sendCommand({ verb: 'REST', argument: 'not-a-number' })?.code).toBe(501);
  });

  it('MLST reports type/size/modify facts for a file', () => {
    const { client } = buildTopology();
    login(client);
    const r = client.sendCommand({ verb: 'MLST', argument: 'hello.txt' });
    expect(r?.code).toBe(250);
    expect(r?.lines[1]).toMatch(/type=file;size=15;modify=\d{14}; \/srv\/ftp\/hello\.txt$/);
  });

  it('MLST fails with 550 for a nonexistent path', () => {
    const { client } = buildTopology();
    login(client);
    expect(client.sendCommand({ verb: 'MLST', argument: 'ghost.txt' })?.code).toBe(550);
  });

  it('MLSD produces machine-readable facts for every directory entry', () => {
    const { client } = buildTopology();
    login(client);
    client.enterPassiveMode();
    const { reply, lines } = client.list(undefined, 'MLSD');
    expect(reply?.code).toBe(226);
    const helloLine = lines.find((l) => l.endsWith(' hello.txt'));
    expect(helloLine).toMatch(/^type=file;size=15;modify=\d{14}; hello\.txt$/);
  });

  it('MLSD requires authentication', () => {
    const { client } = buildTopology();
    client.connect();
    expect(client.sendCommand({ verb: 'MLSD' })?.code).toBe(530);
  });
});
