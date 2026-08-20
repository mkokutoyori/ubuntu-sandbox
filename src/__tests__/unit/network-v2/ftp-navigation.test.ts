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
import type { FtpServerConfig } from '@/network/ftp/FtpServerSession';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.clear();
});

// Cross-platform on purpose (Windows client <-> Linux FTP server): FTP is a
// wire protocol, so nothing here should depend on the client's OS — this
// topology exercises that the client/server split doesn't secretly assume
// a Linux peer on both ends.
function buildTopology(configOverrides: Partial<FtpServerConfig> = {}) {
  const pc = new WindowsPC('windows-pc', 'PC1');
  const srv = new LinuxServer('linux-server', 'FTP1');
  pc.configureInterface('eth0', new IPAddress('10.0.1.2'), new SubnetMask('255.255.255.0'));
  srv.configureInterface('eth0', new IPAddress('10.0.1.10'), new SubnetMask('255.255.255.0'));
  new Cable('c1').connect(pc.getPort('eth0')!, srv.getPort('eth0')!);

  const vfs = new VirtualFileSystem();
  vfs.mkdirp('/srv/ftp', 0o755, 1000, 1000);
  vfs.mkdirp('/srv/ftp/sub', 0o755, 1000, 1000);
  vfs.writeFile('/srv/ftp/hello.txt', 'hello world', 1000, 1000, 0o022);
  const fs = new LinuxSftpFSAdapter(vfs, 1000, 1000);

  const users = new Map([['alice', 'wonderland'], ['bob', 'builder']]);
  const server = new FtpServer(srv.getTcpStack(), '10.0.1.10', {
    users, fs, rootPath: '/srv/ftp', ...configOverrides,
  });
  server.start();

  const client = new FtpClientSession(pc.getTcpStack(), '10.0.1.10', '10.0.1.2');
  return { pc, srv, server, client, vfs };
}

function login(client: FtpClientSession, user = 'alice', pass = 'wonderland') {
  client.connect();
  client.sendCommand({ verb: 'USER', argument: user });
  return client.sendCommand({ verb: 'PASS', argument: pass });
}

describe('FTP navigation and file management (RFC 959 §4)', () => {
  it('PWD reports the initial working directory', () => {
    const { client } = buildTopology();
    login(client);
    const r = client.sendCommand({ verb: 'PWD' });
    expect(r?.code).toBe(257);
    expect(r?.lines[0]).toContain('/srv/ftp');
  });

  it('CWD into an existing subdirectory updates PWD', () => {
    const { client } = buildTopology();
    login(client);
    expect(client.sendCommand({ verb: 'CWD', argument: 'sub' })?.code).toBe(250);
    const r = client.sendCommand({ verb: 'PWD' });
    expect(r?.lines[0]).toContain('/srv/ftp/sub');
  });

  it('CWD into a nonexistent path fails with 550', () => {
    const { client } = buildTopology();
    login(client);
    expect(client.sendCommand({ verb: 'CWD', argument: 'nope' })?.code).toBe(550);
  });

  it('CDUP goes to the parent directory', () => {
    const { client } = buildTopology();
    login(client);
    client.sendCommand({ verb: 'CWD', argument: 'sub' });
    expect(client.sendCommand({ verb: 'CDUP' })?.code).toBe(250);
    const r = client.sendCommand({ verb: 'PWD' });
    expect(r?.lines[0]).toContain('/srv/ftp"');
  });

  it('MKD creates a directory, verified via the underlying filesystem', () => {
    const { client, vfs } = buildTopology();
    login(client);
    const r = client.sendCommand({ verb: 'MKD', argument: 'newdir' });
    expect(r?.code).toBe(257);
    expect(vfs.exists('/srv/ftp/newdir')).toBe(true);
  });

  it('RMD removes an empty directory', () => {
    const { client, vfs } = buildTopology();
    login(client);
    client.sendCommand({ verb: 'MKD', argument: 'empty' });
    expect(client.sendCommand({ verb: 'RMD', argument: 'empty' })?.code).toBe(250);
    expect(vfs.exists('/srv/ftp/empty')).toBe(false);
  });

  it('RMD fails with 550 on a nonexistent directory', () => {
    const { client } = buildTopology();
    login(client);
    expect(client.sendCommand({ verb: 'RMD', argument: 'ghost' })?.code).toBe(550);
  });

  it('DELE removes a file', () => {
    const { client, vfs } = buildTopology();
    login(client);
    expect(client.sendCommand({ verb: 'DELE', argument: 'hello.txt' })?.code).toBe(250);
    expect(vfs.exists('/srv/ftp/hello.txt')).toBe(false);
  });

  it('DELE fails with 550 on a nonexistent file', () => {
    const { client } = buildTopology();
    login(client);
    expect(client.sendCommand({ verb: 'DELE', argument: 'ghost.txt' })?.code).toBe(550);
  });

  it('RNFR + RNTO renames a file successfully', () => {
    const { client, vfs } = buildTopology();
    login(client);
    expect(client.sendCommand({ verb: 'RNFR', argument: 'hello.txt' })?.code).toBe(350);
    expect(client.sendCommand({ verb: 'RNTO', argument: 'renamed.txt' })?.code).toBe(250);
    expect(vfs.exists('/srv/ftp/hello.txt')).toBe(false);
    expect(vfs.exists('/srv/ftp/renamed.txt')).toBe(true);
  });

  it('RNFR on a nonexistent source fails with 550 and does not arm RNTO', () => {
    const { client } = buildTopology();
    login(client);
    expect(client.sendCommand({ verb: 'RNFR', argument: 'ghost.txt' })?.code).toBe(550);
    expect(client.sendCommand({ verb: 'RNTO', argument: 'whatever.txt' })?.code).toBe(503);
  });

  it('RNTO without a prior RNFR fails with 503', () => {
    const { client } = buildTopology();
    login(client);
    expect(client.sendCommand({ verb: 'RNTO', argument: 'whatever.txt' })?.code).toBe(503);
  });

  it('navigation commands require authentication', () => {
    const { client } = buildTopology();
    client.connect();
    expect(client.sendCommand({ verb: 'PWD' })?.code).toBe(530);
    expect(client.sendCommand({ verb: 'CWD', argument: 'sub' })?.code).toBe(530);
    expect(client.sendCommand({ verb: 'MKD', argument: 'x' })?.code).toBe(530);
  });
});

describe('FTP per-user chroot confinement (§2.1.9)', () => {
  it("a chrooted user's PWD starts at / and cannot see outside the confined root", () => {
    const { client } = buildTopology({ chroots: new Map([['bob', '/srv/ftp']]) });
    login(client, 'bob', 'builder');

    const pwd = client.sendCommand({ verb: 'PWD' });
    expect(pwd?.lines[0]).toBe('"/" is the current directory.');

    expect(client.sendCommand({ verb: 'CWD', argument: 'sub' })?.code).toBe(250);
    expect(client.sendCommand({ verb: 'CWD', argument: '/etc' })?.code).toBe(550);

    // Escaping above the confined root clamps to it (chroot(2) semantics) rather than erroring.
    expect(client.sendCommand({ verb: 'CWD', argument: '../../../etc' })?.code).toBe(250);
    const pwdAfterEscape = client.sendCommand({ verb: 'PWD' });
    expect(pwdAfterEscape?.lines[0]).toBe('"/" is the current directory.');
  });

  it('a non-chrooted user is unaffected by another user\'s chroot config', () => {
    const { client } = buildTopology({ chroots: new Map([['bob', '/srv/ftp']]) });
    login(client, 'alice', 'wonderland');
    const pwd = client.sendCommand({ verb: 'PWD' });
    expect(pwd?.lines[0]).toContain('/srv/ftp');
  });
});
