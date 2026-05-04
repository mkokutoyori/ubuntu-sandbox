/**
 * sftp-wan.test.ts — WAN topology integration tests for the SFTP protocol.
 *
 * Simulated topology:
 *
 *   Site A (192.168.10.0/24)           Site B (10.0.10.0/24)
 *   ─────────────────────────          ──────────────────────────────
 *   linuxClient   192.168.10.10        linuxFileServer  10.0.10.10
 *   linuxClient2  192.168.10.11        windowsFileServer 10.0.10.20
 *
 * The SftpServerResolver duck-types Equipment instances, matching the
 * production implementation in LinuxTerminalSession.buildSftpResolver().
 *
 * Credential summary (defaults):
 *   linuxFileServer   — user: root          / password: admin  (isServer profile)
 *   windowsFileServer — user: User          / password: user
 *                     — user: Administrator / password: admin
 *   linuxClient       — user: user          / password: admin
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { SftpSession } from '@/network/protocols/sftp/SftpSession';
import type { ISftpServer, SftpServerResolver } from '@/network/protocols/sftp/ISftpServer';
import { VirtualFileSystem } from '@/network/devices/linux/VirtualFileSystem';
import { SocketTable } from '@/network/core/SocketTable';
import { Equipment } from '@/network/equipment/Equipment';
import { IPAddress } from '@/network/core/types';
import { SubnetMask } from '@/network/core/types';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';

// ─── Topology constants ───────────────────────────────────────────────────────

const CLIENT_IP   = '192.168.10.10';
const CLIENT2_IP  = '192.168.10.11';
const LINUX_SRV   = '10.0.10.10';
const WIN_SRV     = '10.0.10.20';
const MASK_24     = '255.255.255.0';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Build a resolver that mirrors LinuxTerminalSession.buildSftpResolver(). */
function buildResolver(): SftpServerResolver {
  return (ip: string): ISftpServer | null => {
    for (const device of Equipment.getAllEquipment()) {
      if (!('getSftpServer' in device)) continue;
      const ports = 'getInterfaces' in device ? (device as any).getInterfaces() : [];
      const matches = ports.some((p: any) => p.getIPAddress()?.toString() === ip);
      if (matches) return (device as any).getSftpServer() as ISftpServer;
    }
    return null;
  };
}

/** Build an SftpSession for a LinuxPC client. */
function makeClientSession(device: LinuxPC, clientIp: string, resolver: SftpServerResolver): SftpSession {
  const vfs  = (device as any).executor.vfs as VirtualFileSystem;
  const st   = (device as any).socketTable as SocketTable;
  const cwd  = (device as any).executor.cwd as string;
  const user = (device as any).executor.userMgr.currentUser as string;
  return new SftpSession(vfs, st, resolver, cwd, clientIp, user);
}

// ─── Shared setup ─────────────────────────────────────────────────────────────

let linuxClient:  LinuxPC;
let linuxClient2: LinuxPC;
let linuxServer:  LinuxServer;
let winServer:    WindowsPC;
let resolver:     SftpServerResolver;

beforeEach(() => {
  resetDeviceCounters();

  linuxClient  = new LinuxPC('linux-pc', 'ClientA',  0, 0);
  linuxClient2 = new LinuxPC('linux-pc', 'ClientA2', 0, 0);
  linuxServer  = new LinuxServer('linux-server', 'FileServer', 0, 0);
  winServer    = new WindowsPC('windows-server', 'WinServer', 0, 0);

  linuxClient.configureInterface('eth0',  new IPAddress(CLIENT_IP),  new SubnetMask(MASK_24));
  linuxClient2.configureInterface('eth0', new IPAddress(CLIENT2_IP), new SubnetMask(MASK_24));
  linuxServer.configureInterface('eth0',  new IPAddress(LINUX_SRV),  new SubnetMask(MASK_24));
  winServer.configureInterface('eth0',    new IPAddress(WIN_SRV),    new SubnetMask(MASK_24));

  resolver = buildResolver();
});

// ─── WAN-01: Topology & resolver ─────────────────────────────────────────────

describe('WAN-01: Topology & resolver', () => {
  it('resolves linuxFileServer by IP', () => {
    expect(resolver(LINUX_SRV)).not.toBeNull();
  });

  it('resolves windowsFileServer by IP', () => {
    expect(resolver(WIN_SRV)).not.toBeNull();
  });

  it('returns null for unknown WAN IP', () => {
    expect(resolver('172.16.0.1')).toBeNull();
  });

  it('returns null for unknown site-A IP', () => {
    expect(resolver('192.168.10.99')).toBeNull();
  });

  it('linuxFileServer hostname is exposed', () => {
    expect(resolver(LINUX_SRV)?.hostname).toBe('linux-server');
  });

  it('windowsFileServer hostname is exposed', () => {
    expect(resolver(WIN_SRV)?.hostname).toBeDefined();
  });

  it('linuxClient IP is registered in Equipment', () => {
    const ip = linuxClient.getInterfaces()[0].getIPAddress()?.toString();
    expect(ip).toBe(CLIENT_IP);
  });

  it('four devices are registered in the Equipment registry', () => {
    expect(Equipment.getAllEquipment().length).toBe(4);
  });
});

// ─── WAN-02: Linux client → Linux file server ────────────────────────────────

describe('WAN-02: Linux client → Linux file server', () => {
  let session: SftpSession;

  beforeEach(() => {
    session = makeClientSession(linuxClient, CLIENT_IP, resolver);
  });

  it('connects successfully with root/admin', () => {
    expect(session.connect(`root@${LINUX_SRV}`, 'admin')).toBe('');
    expect(session.isConnected()).toBe(true);
  });

  it('connect rejects wrong password', () => {
    const err = session.connect(`root@${LINUX_SRV}`, 'wrongpassword');
    expect(err).toContain('Permission denied');
    expect(session.isConnected()).toBe(false);
  });

  it('connect rejects unknown host', () => {
    const err = session.connect('10.99.99.99', 'admin');
    expect(err).toContain('No route to host');
  });

  it('pwd shows remote home directory after connect', () => {
    session.connect(`root@${LINUX_SRV}`, 'admin');
    expect(session.pwd()).toContain('/root');
  });

  it('ls lists remote home directory', () => {
    session.connect(`root@${LINUX_SRV}`, 'admin');
    const out = session.ls([]);
    expect(typeof out).toBe('string');
  });

  it('put uploads a file to the Linux server', () => {
    // Create a local file on the client
    const clientVfs = (linuxClient as any).executor.vfs as VirtualFileSystem;
    clientVfs.writeFile('/home/user/upload.txt', 'hello from client', 1000, 1000, 0o022);

    session.connect(`root@${LINUX_SRV}`, 'admin');
    const result = session.put('/home/user/upload.txt');
    expect(result).toContain('upload.txt');

    const serverVfs = (linuxServer as any).executor.vfs as VirtualFileSystem;
    const content = serverVfs.readFile('/root/upload.txt');
    expect(content).toBe('hello from client');
  });

  it('get downloads a file from the Linux server', () => {
    const serverVfs = (linuxServer as any).executor.vfs as VirtualFileSystem;
    serverVfs.writeFile('/root/report.txt', 'server report data', 0, 0, 0o022);

    session.connect(`root@${LINUX_SRV}`, 'admin');
    const result = session.get('report.txt');
    expect(result).toContain('report.txt');

    const clientVfs = (linuxClient as any).executor.vfs as VirtualFileSystem;
    expect(clientVfs.readFile('/home/user/report.txt')).toBe('server report data');
  });

  it('cd changes remote working directory', () => {
    const serverVfs = (linuxServer as any).executor.vfs as VirtualFileSystem;
    serverVfs.mkdirp('/root/projects', 0o755, 0, 0);

    session.connect(`root@${LINUX_SRV}`, 'admin');
    expect(session.cd('projects')).toBe('');
    expect(session.pwd()).toContain('/root/projects');
  });

  it('cd to a nonexistent directory returns error', () => {
    session.connect(`root@${LINUX_SRV}`, 'admin');
    expect(session.cd('nonexistent')).toContain('No such file or directory');
  });

  it('mkdir creates a directory on the Linux server', () => {
    session.connect(`root@${LINUX_SRV}`, 'admin');
    expect(session.mkdir('newdir')).toBe('');

    const serverVfs = (linuxServer as any).executor.vfs as VirtualFileSystem;
    const inode = serverVfs.resolveInode('/root/newdir');
    expect(inode?.type).toBe('directory');
  });

  it('rm deletes a file on the Linux server', () => {
    const serverVfs = (linuxServer as any).executor.vfs as VirtualFileSystem;
    serverVfs.writeFile('/root/tmp.txt', 'temporary', 0, 0, 0o022);

    session.connect(`root@${LINUX_SRV}`, 'admin');
    expect(session.rm('tmp.txt')).toBe('');
    expect(serverVfs.resolveInode('/root/tmp.txt')).toBeNull();
  });

  it('rmdir removes an empty directory on the Linux server', () => {
    const serverVfs = (linuxServer as any).executor.vfs as VirtualFileSystem;
    serverVfs.mkdirp('/root/emptydir', 0o755, 0, 0);

    session.connect(`root@${LINUX_SRV}`, 'admin');
    expect(session.rmdir('emptydir')).toBe('');
    expect(serverVfs.resolveInode('/root/emptydir')).toBeNull();
  });

  it('rename renames a file on the Linux server', () => {
    const serverVfs = (linuxServer as any).executor.vfs as VirtualFileSystem;
    serverVfs.writeFile('/root/original.txt', 'data', 0, 0, 0o022);

    session.connect(`root@${LINUX_SRV}`, 'admin');
    expect(session.rename('original.txt', 'renamed.txt')).toBe('');
    expect(serverVfs.resolveInode('/root/renamed.txt')).not.toBeNull();
    expect(serverVfs.resolveInode('/root/original.txt')).toBeNull();
  });

  it('disconnect closes the session', () => {
    session.connect(`root@${LINUX_SRV}`, 'admin');
    session.disconnect();
    expect(session.isConnected()).toBe(false);
  });

  it('operations after disconnect return not-connected error', () => {
    session.connect(`root@${LINUX_SRV}`, 'admin');
    session.disconnect();
    expect(session.ls([])).toBe('Not connected.');
  });
});

// ─── WAN-03: Linux client → Windows file server ──────────────────────────────

describe('WAN-03: Linux client → Windows file server', () => {
  let session: SftpSession;

  beforeEach(() => {
    session = makeClientSession(linuxClient, CLIENT_IP, resolver);
  });

  it('connects to Windows server with User/user', () => {
    expect(session.connect(`User@${WIN_SRV}`, 'user')).toBe('');
    expect(session.isConnected()).toBe(true);
  });

  it('connects to Windows server with Administrator/admin', () => {
    expect(session.connect(`Administrator@${WIN_SRV}`, 'admin')).toBe('');
    expect(session.isConnected()).toBe(true);
  });

  it('connect rejects wrong password on Windows server', () => {
    const err = session.connect(`User@${WIN_SRV}`, 'wrongpass');
    expect(err).toContain('Permission denied');
  });

  it('pwd shows Windows-style SFTP home path', () => {
    session.connect(`User@${WIN_SRV}`, 'user');
    expect(session.pwd()).toContain('/C:/Users/User');
  });

  it('ls lists Windows home directory entries', () => {
    session.connect(`User@${WIN_SRV}`, 'user');
    const out = session.ls([]);
    expect(out).toContain('Desktop');
    expect(out).toContain('Documents');
  });

  it('put uploads a file to the Windows server', () => {
    const clientVfs = (linuxClient as any).executor.vfs as VirtualFileSystem;
    clientVfs.writeFile('/home/user/transfer.txt', 'hello windows', 1000, 1000, 0o022);

    session.connect(`User@${WIN_SRV}`, 'user');
    const result = session.put('/home/user/transfer.txt');
    expect(result).toContain('transfer.txt');

    const winVfs = (winServer as any).fs;
    const readResult = winVfs.readFile('C:\\Users\\User\\transfer.txt');
    expect(readResult.ok).toBe(true);
    expect(readResult.content).toBe('hello windows');
  });

  it('get downloads a file from the Windows server', () => {
    const winVfs = (winServer as any).fs;
    winVfs.createFile('C:\\Users\\User\\report.csv', 'col1,col2\n1,2\n');

    session.connect(`User@${WIN_SRV}`, 'user');
    const result = session.get('report.csv');
    expect(result).toContain('report.csv');

    const clientVfs = (linuxClient as any).executor.vfs as VirtualFileSystem;
    expect(clientVfs.readFile('/home/user/report.csv')).toBe('col1,col2\n1,2\n');
  });

  it('cd to Documents on Windows server', () => {
    session.connect(`User@${WIN_SRV}`, 'user');
    expect(session.cd('Documents')).toBe('');
    expect(session.pwd()).toContain('/C:/Users/User/Documents');
  });

  it('ls with explicit path lists Desktop contents', () => {
    const winVfs = (winServer as any).fs;
    winVfs.createFile('C:\\Users\\User\\Desktop\\shortcut.lnk', '');

    session.connect(`User@${WIN_SRV}`, 'user');
    const out = session.ls(['/C:/Users/User/Desktop']);
    expect(out).toContain('shortcut.lnk');
  });

  it('mkdir creates a directory on the Windows server', () => {
    session.connect(`User@${WIN_SRV}`, 'user');
    expect(session.mkdir('SharedFiles')).toBe('');

    const winVfs = (winServer as any).fs;
    expect(winVfs.isDirectory('C:\\Users\\User\\SharedFiles')).toBe(true);
  });

  it('rm deletes a file on the Windows server', () => {
    const winVfs = (winServer as any).fs;
    winVfs.createFile('C:\\Users\\User\\temp.txt', 'temp data');

    session.connect(`User@${WIN_SRV}`, 'user');
    expect(session.rm('temp.txt')).toBe('');
    expect(winVfs.exists('C:\\Users\\User\\temp.txt')).toBe(false);
  });

  it('rename renames a file on the Windows server', () => {
    const winVfs = (winServer as any).fs;
    winVfs.createFile('C:\\Users\\User\\old.txt', 'content');

    session.connect(`User@${WIN_SRV}`, 'user');
    expect(session.rename('old.txt', 'new.txt')).toBe('');
    expect(winVfs.exists('C:\\Users\\User\\new.txt')).toBe(true);
    expect(winVfs.exists('C:\\Users\\User\\old.txt')).toBe(false);
  });
});

// ─── WAN-04: Authentication failures ─────────────────────────────────────────

describe('WAN-04: Authentication failures', () => {
  it('wrong password for Linux server', () => {
    const session = makeClientSession(linuxClient, CLIENT_IP, resolver);
    const err = session.connect(`root@${LINUX_SRV}`, 'badpass');
    expect(err).toContain('Permission denied');
    expect(session.isConnected()).toBe(false);
  });

  it('wrong password for Windows server', () => {
    const session = makeClientSession(linuxClient, CLIENT_IP, resolver);
    const err = session.connect(`User@${WIN_SRV}`, 'badpass');
    expect(err).toContain('Permission denied');
  });

  it('nonexistent user on Linux server', () => {
    const session = makeClientSession(linuxClient, CLIENT_IP, resolver);
    const err = session.connect(`nobody@${LINUX_SRV}`, 'pass');
    expect(err).toContain('Permission denied');
  });

  it('nonexistent user on Windows server', () => {
    const session = makeClientSession(linuxClient, CLIENT_IP, resolver);
    const err = session.connect(`ghost@${WIN_SRV}`, 'pass');
    expect(err).toContain('Permission denied');
  });

  it('WAN IP not found returns No route to host', () => {
    const session = makeClientSession(linuxClient, CLIENT_IP, resolver);
    const err = session.connect('172.16.0.99', 'admin');
    expect(err).toContain('No route to host');
  });

  it('operations on unconnected session return Not connected', () => {
    const session = makeClientSession(linuxClient, CLIENT_IP, resolver);
    expect(session.pwd()).toBe('Remote working directory: /');
    expect(session.ls([])).toBe('Not connected.');
    expect(session.get('file.txt')).toBe('Not connected.');
    expect(session.put('/home/user/file.txt')).toBe('Not connected.');
  });

  it('connect after disconnect re-establishes session', () => {
    const session = makeClientSession(linuxClient, CLIENT_IP, resolver);
    session.connect(`root@${LINUX_SRV}`, 'admin');
    session.disconnect();
    expect(session.connect(`root@${LINUX_SRV}`, 'admin')).toBe('');
    expect(session.isConnected()).toBe(true);
  });

  it('Administrator can connect to Windows server', () => {
    const session = makeClientSession(linuxClient, CLIENT_IP, resolver);
    expect(session.connect(`Administrator@${WIN_SRV}`, 'admin')).toBe('');
    expect(session.pwd()).toContain('/C:/Users/Administrator');
  });
});

// ─── WAN-05: Concurrent sessions ─────────────────────────────────────────────

describe('WAN-05: Concurrent sessions (multiple clients)', () => {
  it('two clients can independently connect to the Linux server', () => {
    const s1 = makeClientSession(linuxClient,  CLIENT_IP,  resolver);
    const s2 = makeClientSession(linuxClient2, CLIENT2_IP, resolver);

    expect(s1.connect(`root@${LINUX_SRV}`, 'admin')).toBe('');
    expect(s2.connect(`root@${LINUX_SRV}`, 'admin')).toBe('');

    expect(s1.isConnected()).toBe(true);
    expect(s2.isConnected()).toBe(true);
  });

  it('two clients can independently connect to the Windows server', () => {
    const s1 = makeClientSession(linuxClient,  CLIENT_IP,  resolver);
    const s2 = makeClientSession(linuxClient2, CLIENT2_IP, resolver);

    expect(s1.connect(`User@${WIN_SRV}`, 'user')).toBe('');
    expect(s2.connect(`User@${WIN_SRV}`, 'user')).toBe('');

    expect(s1.isConnected()).toBe(true);
    expect(s2.isConnected()).toBe(true);
  });

  it('client1 and client2 see the same file written to Linux server', () => {
    const s1 = makeClientSession(linuxClient,  CLIENT_IP,  resolver);
    const s2 = makeClientSession(linuxClient2, CLIENT2_IP, resolver);

    s1.connect(`root@${LINUX_SRV}`, 'admin');
    s2.connect(`root@${LINUX_SRV}`, 'admin');

    const vfs1 = (linuxClient as any).executor.vfs as VirtualFileSystem;
    vfs1.writeFile('/home/user/shared.txt', 'shared content', 1000, 1000, 0o022);
    s1.put('/home/user/shared.txt');

    // client2 downloads the same file
    const result = s2.get('shared.txt');
    expect(result).toContain('shared.txt');
    const vfs2 = (linuxClient2 as any).executor.vfs as VirtualFileSystem;
    expect(vfs2.readFile('/home/user/shared.txt')).toBe('shared content');
  });

  it('disconnecting one session does not affect the other', () => {
    const s1 = makeClientSession(linuxClient,  CLIENT_IP,  resolver);
    const s2 = makeClientSession(linuxClient2, CLIENT2_IP, resolver);

    s1.connect(`root@${LINUX_SRV}`, 'admin');
    s2.connect(`root@${LINUX_SRV}`, 'admin');

    s1.disconnect();
    expect(s1.isConnected()).toBe(false);
    expect(s2.isConnected()).toBe(true);
  });

  it('client1 writes, client2 reads from Windows server concurrently', () => {
    const s1 = makeClientSession(linuxClient,  CLIENT_IP,  resolver);
    const s2 = makeClientSession(linuxClient2, CLIENT2_IP, resolver);

    s1.connect(`User@${WIN_SRV}`, 'user');
    s2.connect(`User@${WIN_SRV}`, 'user');

    const vfs1 = (linuxClient as any).executor.vfs as VirtualFileSystem;
    vfs1.writeFile('/home/user/msg.txt', 'concurrent message', 1000, 1000, 0o022);
    s1.put('/home/user/msg.txt');

    const result = s2.get('msg.txt');
    expect(result).toContain('msg.txt');

    const vfs2 = (linuxClient2 as any).executor.vfs as VirtualFileSystem;
    expect(vfs2.readFile('/home/user/msg.txt')).toBe('concurrent message');
  });
});

// ─── WAN-06: Cross-server file exchange ──────────────────────────────────────

describe('WAN-06: Cross-server file exchange', () => {
  it('client uploads to Linux server then downloads via second session', () => {
    const s1 = makeClientSession(linuxClient, CLIENT_IP, resolver);
    const s2 = makeClientSession(linuxClient, CLIENT_IP, resolver);

    const vfs = (linuxClient as any).executor.vfs as VirtualFileSystem;
    vfs.writeFile('/home/user/data.json', '{"key":"value"}', 1000, 1000, 0o022);

    s1.connect(`root@${LINUX_SRV}`, 'admin');
    s1.put('/home/user/data.json');
    s1.disconnect();

    s2.connect(`root@${LINUX_SRV}`, 'admin');
    s2.get('data.json', '/home/user/data_downloaded.json');
    s2.disconnect();

    expect(vfs.readFile('/home/user/data_downloaded.json')).toBe('{"key":"value"}');
  });

  it('client uploads to Linux server, different client downloads', () => {
    const s1 = makeClientSession(linuxClient,  CLIENT_IP,  resolver);
    const s2 = makeClientSession(linuxClient2, CLIENT2_IP, resolver);

    const vfs1 = (linuxClient as any).executor.vfs as VirtualFileSystem;
    vfs1.writeFile('/home/user/backup.tar', 'binary-data-sim', 1000, 1000, 0o022);

    s1.connect(`root@${LINUX_SRV}`, 'admin');
    s1.put('/home/user/backup.tar');
    s1.disconnect();

    s2.connect(`root@${LINUX_SRV}`, 'admin');
    s2.get('backup.tar');
    s2.disconnect();

    const vfs2 = (linuxClient2 as any).executor.vfs as VirtualFileSystem;
    expect(vfs2.readFile('/home/user/backup.tar')).toBe('binary-data-sim');
  });

  it('upload same file to both Linux and Windows servers', () => {
    const s1 = makeClientSession(linuxClient, CLIENT_IP, resolver);
    const s2 = makeClientSession(linuxClient, CLIENT_IP, resolver);

    const vfs = (linuxClient as any).executor.vfs as VirtualFileSystem;
    vfs.writeFile('/home/user/config.cfg', '[section]\nkey=val\n', 1000, 1000, 0o022);

    s1.connect(`root@${LINUX_SRV}`, 'admin');
    s1.put('/home/user/config.cfg');
    s1.disconnect();

    s2.connect(`User@${WIN_SRV}`, 'user');
    s2.put('/home/user/config.cfg');
    s2.disconnect();

    const linuxVfs = (linuxServer as any).executor.vfs as VirtualFileSystem;
    expect(linuxVfs.readFile('/root/config.cfg')).toBe('[section]\nkey=val\n');

    const winVfs = (winServer as any).fs;
    expect(winVfs.readFile('C:\\Users\\User\\config.cfg').content).toBe('[section]\nkey=val\n');
  });

  it('lls and lcd allow client to navigate locally while connected remotely', () => {
    const session = makeClientSession(linuxClient, CLIENT_IP, resolver);
    const vfs = (linuxClient as any).executor.vfs as VirtualFileSystem;
    vfs.mkdirp('/home/user/localdir', 0o755, 1000, 1000);
    vfs.writeFile('/home/user/localdir/note.txt', 'local note', 1000, 1000, 0o022);

    session.connect(`root@${LINUX_SRV}`, 'admin');
    expect(session.lcd('localdir')).toBe('');
    expect(session.lpwd()).toContain('/home/user/localdir');
    expect(session.lls([])).toContain('note.txt');
  });

  it('get with explicit local path stores file at given path', () => {
    const serverVfs = (linuxServer as any).executor.vfs as VirtualFileSystem;
    serverVfs.writeFile('/root/archive.zip', 'zip-content', 0, 0, 0o022);

    const session = makeClientSession(linuxClient, CLIENT_IP, resolver);
    session.connect(`root@${LINUX_SRV}`, 'admin');
    session.get('/root/archive.zip', '/home/user/downloads/archive.zip');

    const clientVfs = (linuxClient as any).executor.vfs as VirtualFileSystem;
    expect(clientVfs.readFile('/home/user/downloads/archive.zip')).toBe('zip-content');
  });

  it('put with explicit remote path stores file at given remote path', () => {
    const serverVfs = (linuxServer as any).executor.vfs as VirtualFileSystem;
    serverVfs.mkdirp('/root/uploads', 0o755, 0, 0);

    const clientVfs = (linuxClient as any).executor.vfs as VirtualFileSystem;
    clientVfs.writeFile('/home/user/payload.txt', 'payload', 1000, 1000, 0o022);

    const session = makeClientSession(linuxClient, CLIENT_IP, resolver);
    session.connect(`root@${LINUX_SRV}`, 'admin');
    session.put('/home/user/payload.txt', '/root/uploads/payload.txt');

    expect(serverVfs.readFile('/root/uploads/payload.txt')).toBe('payload');
  });
});

// ─── WAN-07: Server-side directory operations ─────────────────────────────────

describe('WAN-07: Server-side directory operations', () => {
  it('mkdir then ls shows new directory on Linux server', () => {
    const session = makeClientSession(linuxClient, CLIENT_IP, resolver);
    session.connect(`root@${LINUX_SRV}`, 'admin');
    session.mkdir('share');
    const out = session.ls([]);
    expect(out).toContain('share');
  });

  it('mkdir then cd then put on Linux server', () => {
    const clientVfs = (linuxClient as any).executor.vfs as VirtualFileSystem;
    clientVfs.writeFile('/home/user/data.txt', 'dataset', 1000, 1000, 0o022);

    const session = makeClientSession(linuxClient, CLIENT_IP, resolver);
    session.connect(`root@${LINUX_SRV}`, 'admin');
    session.mkdir('datasets');
    session.cd('datasets');
    session.put('/home/user/data.txt');

    const serverVfs = (linuxServer as any).executor.vfs as VirtualFileSystem;
    expect(serverVfs.readFile('/root/datasets/data.txt')).toBe('dataset');
  });

  it('rmdir refuses to remove non-empty directory on Linux server', () => {
    const serverVfs = (linuxServer as any).executor.vfs as VirtualFileSystem;
    serverVfs.mkdirp('/root/nonempty', 0o755, 0, 0);
    serverVfs.writeFile('/root/nonempty/file.txt', 'data', 0, 0, 0o022);

    const session = makeClientSession(linuxClient, CLIENT_IP, resolver);
    session.connect(`root@${LINUX_SRV}`, 'admin');
    const err = session.rmdir('nonempty');
    expect(err).toContain("Couldn't remove directory");
  });

  it('mkdir then rmdir on Windows server', () => {
    const session = makeClientSession(linuxClient, CLIENT_IP, resolver);
    session.connect(`User@${WIN_SRV}`, 'user');
    session.mkdir('TempDir');
    const winVfs = (winServer as any).fs;
    expect(winVfs.isDirectory('C:\\Users\\User\\TempDir')).toBe(true);
    expect(session.rmdir('TempDir')).toBe('');
    expect(winVfs.isDirectory('C:\\Users\\User\\TempDir')).toBe(false);
  });

  it('put then rm on Windows server', () => {
    const clientVfs = (linuxClient as any).executor.vfs as VirtualFileSystem;
    clientVfs.writeFile('/home/user/toremove.txt', 'gone', 1000, 1000, 0o022);

    const session = makeClientSession(linuxClient, CLIENT_IP, resolver);
    session.connect(`User@${WIN_SRV}`, 'user');
    session.put('/home/user/toremove.txt');

    const winVfs = (winServer as any).fs;
    expect(winVfs.exists('C:\\Users\\User\\toremove.txt')).toBe(true);
    expect(session.rm('toremove.txt')).toBe('');
    expect(winVfs.exists('C:\\Users\\User\\toremove.txt')).toBe(false);
  });

  it('rename file across paths on Linux server', () => {
    const serverVfs = (linuxServer as any).executor.vfs as VirtualFileSystem;
    serverVfs.mkdirp('/root/archive', 0o755, 0, 0);
    serverVfs.writeFile('/root/todo.txt', 'tasks', 0, 0, 0o022);

    const session = makeClientSession(linuxClient, CLIENT_IP, resolver);
    session.connect(`root@${LINUX_SRV}`, 'admin');
    session.rename('/root/todo.txt', '/root/archive/done.txt');

    expect(serverVfs.resolveInode('/root/archive/done.txt')).not.toBeNull();
    expect(serverVfs.resolveInode('/root/todo.txt')).toBeNull();
  });

  it('rm on nonexistent file returns error on Linux server', () => {
    const session = makeClientSession(linuxClient, CLIENT_IP, resolver);
    session.connect(`root@${LINUX_SRV}`, 'admin');
    expect(session.rm('ghost.txt')).toContain('No such file or directory');
  });

  it('get nonexistent file returns error on Windows server', () => {
    const session = makeClientSession(linuxClient, CLIENT_IP, resolver);
    session.connect(`User@${WIN_SRV}`, 'user');
    expect(session.get('missing.exe')).toContain('not found');
  });
});

// ─── WAN-08: Transfer integrity ──────────────────────────────────────────────

describe('WAN-08: Transfer integrity', () => {
  it('transfer format includes filename and size', () => {
    const clientVfs = (linuxClient as any).executor.vfs as VirtualFileSystem;
    clientVfs.writeFile('/home/user/hello.txt', '12345', 1000, 1000, 0o022);

    const session = makeClientSession(linuxClient, CLIENT_IP, resolver);
    session.connect(`root@${LINUX_SRV}`, 'admin');
    const result = session.put('/home/user/hello.txt');
    expect(result).toContain('hello.txt');
    expect(result).toContain('100%');
    expect(result).toContain('5');
  });

  it('empty file transfers without error to Linux server', () => {
    const clientVfs = (linuxClient as any).executor.vfs as VirtualFileSystem;
    clientVfs.writeFile('/home/user/empty.txt', '', 1000, 1000, 0o022);

    const session = makeClientSession(linuxClient, CLIENT_IP, resolver);
    session.connect(`root@${LINUX_SRV}`, 'admin');
    const result = session.put('/home/user/empty.txt');
    expect(result).toContain('empty.txt');

    const serverVfs = (linuxServer as any).executor.vfs as VirtualFileSystem;
    expect(serverVfs.readFile('/root/empty.txt')).toBe('');
  });

  it('empty file transfers without error to Windows server', () => {
    const clientVfs = (linuxClient as any).executor.vfs as VirtualFileSystem;
    clientVfs.writeFile('/home/user/empty.dat', '', 1000, 1000, 0o022);

    const session = makeClientSession(linuxClient, CLIENT_IP, resolver);
    session.connect(`User@${WIN_SRV}`, 'user');
    const result = session.put('/home/user/empty.dat');
    expect(result).toContain('empty.dat');
  });

  it('multiline content preserves newlines through Linux server', () => {
    const content = 'line1\nline2\nline3\n';
    const clientVfs = (linuxClient as any).executor.vfs as VirtualFileSystem;
    clientVfs.writeFile('/home/user/multi.txt', content, 1000, 1000, 0o022);

    const session = makeClientSession(linuxClient2, CLIENT2_IP, resolver);
    const serverVfs = (linuxServer as any).executor.vfs as VirtualFileSystem;

    // client uploads
    const s1 = makeClientSession(linuxClient, CLIENT_IP, resolver);
    s1.connect(`root@${LINUX_SRV}`, 'admin');
    s1.put('/home/user/multi.txt');
    s1.disconnect();

    // client2 downloads
    session.connect(`root@${LINUX_SRV}`, 'admin');
    session.get('multi.txt');
    const vfs2 = (linuxClient2 as any).executor.vfs as VirtualFileSystem;
    expect(vfs2.readFile('/home/user/multi.txt')).toBe(content);
  });

  it('multiline content preserves newlines through Windows server', () => {
    const content = 'alpha\nbeta\ngamma\n';
    const clientVfs = (linuxClient as any).executor.vfs as VirtualFileSystem;
    clientVfs.writeFile('/home/user/lines.txt', content, 1000, 1000, 0o022);

    const session = makeClientSession(linuxClient, CLIENT_IP, resolver);
    session.connect(`User@${WIN_SRV}`, 'user');
    session.put('/home/user/lines.txt');
    session.disconnect();

    const session2 = makeClientSession(linuxClient2, CLIENT2_IP, resolver);
    session2.connect(`User@${WIN_SRV}`, 'user');
    session2.get('lines.txt');

    const vfs2 = (linuxClient2 as any).executor.vfs as VirtualFileSystem;
    expect(vfs2.readFile('/home/user/lines.txt')).toBe(content);
  });

  it('get nonexistent file from Linux server returns error', () => {
    const session = makeClientSession(linuxClient, CLIENT_IP, resolver);
    session.connect(`root@${LINUX_SRV}`, 'admin');
    expect(session.get('nosuchfile.txt')).toContain('not found');
  });
});
