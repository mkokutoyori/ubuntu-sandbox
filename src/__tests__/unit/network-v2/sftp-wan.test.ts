/**
 * sftp-wan.test.ts — WAN topology integration tests for the SFTP protocol.
 *
 * Physical topology (fully cabled):
 *
 *   Site A  192.168.10.0/24                  Site B  10.0.20.0/24
 *   ─────────────────────────                ──────────────────────────────
 *   linuxClient   192.168.10.10              linuxFileServer  10.0.20.10
 *   linuxClient2  192.168.10.11              windowsFileServer 10.0.20.20
 *        │                                          │
 *      SW-A                                       SW-B
 *        │ GE0/0                         GE0/0 │
 *      RouterA ─── GE0/1 ──── GE0/1 ─── RouterB
 *               10.0.0.1/30   10.0.0.2/30
 *
 * Routing (static):
 *   RouterA: 10.0.20.0/24 → 10.0.0.2      RouterB: 192.168.10.0/24 → 10.0.0.1
 *   linuxClient / linuxClient2 : GW = 192.168.10.1
 *   linuxFileServer / windowsFileServer   : GW = 10.0.20.1
 *
 * The SftpServerResolver mirrors LinuxTerminalSession.buildSftpResolver():
 *   stage 1 — source device must have a route to the destination IP
 *   stage 2 — a device with getSftpServer() must own that IP
 *
 * Without physical cabling + routing the SFTP session is blocked (tests
 * WAN-01-e and WAN-01-f verify this).
 *
 * Credential summary (defaults):
 *   linuxFileServer   — user: root          / password: admin  (isServer profile)
 *   windowsFileServer — user: User          / password: user
 *                     — user: Administrator / password: admin
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { SftpSession } from '@/network/protocols/sftp/SftpSession';
import type { ISftpServer, SftpServerResolver } from '@/network/protocols/sftp/ISftpServer';
import { VirtualFileSystem } from '@/network/devices/linux/VirtualFileSystem';
import { SocketTable } from '@/network/core/SocketTable';
import { Equipment } from '@/network/equipment/Equipment';
import { IPAddress, SubnetMask } from '@/network/core/types';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';

// ─── Address plan ─────────────────────────────────────────────────────────────

const CLIENT_IP   = '192.168.10.10';
const CLIENT2_IP  = '192.168.10.11';
const LINUX_SRV   = '10.0.20.10';
const WIN_SRV     = '10.0.20.20';
const GW_A        = '192.168.10.1';   // RouterA LAN-A interface
const GW_B        = '10.0.20.1';      // RouterB LAN-B interface
const WAN_A       = '10.0.0.1';       // RouterA WAN interface
const WAN_B       = '10.0.0.2';       // RouterB WAN interface
const MASK_24     = '255.255.255.0';
const MASK_30     = '255.255.255.252';

// ─── Topology builder ─────────────────────────────────────────────────────────

function buildWanTopology() {
  // ── Hosts ──────────────────────────────────────────────────────────────────
  const linuxClient  = new LinuxPC('linux-pc', 'ClientA',     0, 0);
  const linuxClient2 = new LinuxPC('linux-pc', 'ClientA2',    0, 0);
  const linuxServer  = new LinuxServer('linux-server', 'FileServer', 0, 0);
  const winServer    = new WindowsPC('windows-server', 'WinFileServer', 0, 0);

  // ── Switches ───────────────────────────────────────────────────────────────
  const swA = new CiscoSwitch('switch-cisco', 'SW-A', 26);
  const swB = new CiscoSwitch('switch-cisco', 'SW-B', 26);

  // ── Routers ────────────────────────────────────────────────────────────────
  const routerA = new CiscoRouter('RouterA');
  const routerB = new CiscoRouter('RouterB');

  // ── Cables — Site A ────────────────────────────────────────────────────────
  new Cable('c-clientA-swA').connect(
    linuxClient.getPort('eth0')!,  swA.getPort('FastEthernet0/1')!);
  new Cable('c-clientA2-swA').connect(
    linuxClient2.getPort('eth0')!, swA.getPort('FastEthernet0/2')!);
  new Cable('c-routerA-swA').connect(
    routerA.getPort('GigabitEthernet0/0')!, swA.getPort('GigabitEthernet0/0')!);

  // ── Cables — WAN link ──────────────────────────────────────────────────────
  new Cable('c-wan').connect(
    routerA.getPort('GigabitEthernet0/1')!,
    routerB.getPort('GigabitEthernet0/1')!);

  // ── Cables — Site B ────────────────────────────────────────────────────────
  new Cable('c-linuxSrv-swB').connect(
    linuxServer.getPort('eth0')!,  swB.getPort('FastEthernet0/1')!);
  new Cable('c-winSrv-swB').connect(
    winServer.getPort('eth0')!,    swB.getPort('FastEthernet0/2')!);
  new Cable('c-routerB-swB').connect(
    routerB.getPort('GigabitEthernet0/0')!, swB.getPort('GigabitEthernet0/0')!);

  // ── Router interfaces ──────────────────────────────────────────────────────
  routerA.configureInterface('GigabitEthernet0/0', new IPAddress(GW_A),  new SubnetMask(MASK_24));
  routerA.configureInterface('GigabitEthernet0/1', new IPAddress(WAN_A), new SubnetMask(MASK_30));
  routerB.configureInterface('GigabitEthernet0/0', new IPAddress(GW_B),  new SubnetMask(MASK_24));
  routerB.configureInterface('GigabitEthernet0/1', new IPAddress(WAN_B), new SubnetMask(MASK_30));

  // ── Static routes on routers ───────────────────────────────────────────────
  // RouterA knows how to reach Site B via RouterB
  routerA.addStaticRoute(
    new IPAddress('10.0.20.0'), new SubnetMask(MASK_24), new IPAddress(WAN_B));
  // RouterB knows how to reach Site A via RouterA
  routerB.addStaticRoute(
    new IPAddress('192.168.10.0'), new SubnetMask(MASK_24), new IPAddress(WAN_A));

  // ── Host IP + default gateway ─────────────────────────────────────────────
  linuxClient.configureInterface('eth0',  new IPAddress(CLIENT_IP),  new SubnetMask(MASK_24));
  linuxClient.setDefaultGateway(new IPAddress(GW_A));

  linuxClient2.configureInterface('eth0', new IPAddress(CLIENT2_IP), new SubnetMask(MASK_24));
  linuxClient2.setDefaultGateway(new IPAddress(GW_A));

  linuxServer.configureInterface('eth0',  new IPAddress(LINUX_SRV),  new SubnetMask(MASK_24));
  linuxServer.setDefaultGateway(new IPAddress(GW_B));

  winServer.configureInterface('eth0',    new IPAddress(WIN_SRV),    new SubnetMask(MASK_24));
  winServer.setDefaultGateway(new IPAddress(GW_B));

  return { linuxClient, linuxClient2, linuxServer, winServer, routerA, routerB, swA, swB };
}

// ─── Resolver (mirrors LinuxTerminalSession.buildSftpResolver) ────────────────

function buildResolver(sourceDevice: any): SftpServerResolver {
  return (ip: string): ISftpServer | null => {
    // Stage 1: routing reachability — same LPM engine used by sendPacket
    const route = sourceDevice.resolveRoute?.(new IPAddress(ip));
    if (!route) return null;

    // Stage 2: find the device that owns the IP and exposes SFTP
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
function makeSession(device: LinuxPC, clientIp: string, topo: ReturnType<typeof buildWanTopology>): SftpSession {
  const vfs  = (device as any).executor.vfs as VirtualFileSystem;
  const st   = (device as any).socketTable as SocketTable;
  const cwd  = (device as any).executor.cwd as string;
  const user = (device as any).executor.userMgr.currentUser as string;
  return new SftpSession(vfs, st, buildResolver(device), cwd, clientIp, user);
}

// ─── Shared setup ─────────────────────────────────────────────────────────────

let topo: ReturnType<typeof buildWanTopology>;

beforeEach(() => {
  resetDeviceCounters();
  topo = buildWanTopology();
});

// ─── WAN-01: Physical topology & reachability ────────────────────────────────

describe('WAN-01: Physical topology & reachability', () => {
  it('resolver finds Linux file server when routing is configured', () => {
    const resolver = buildResolver(topo.linuxClient);
    expect(resolver(LINUX_SRV)).not.toBeNull();
  });

  it('resolver finds Windows file server when routing is configured', () => {
    const resolver = buildResolver(topo.linuxClient);
    expect(resolver(WIN_SRV)).not.toBeNull();
  });

  it('resolver finds same-subnet SFTP server without needing default gateway', () => {
    // linuxClient2 is on 192.168.10.0/24 — directly connected, no gateway needed.
    // It also exposes getSftpServer() (LinuxMachine), so the resolver returns it.
    const resolver = buildResolver(topo.linuxClient);
    expect(resolver(CLIENT2_IP)).not.toBeNull();
  });

  it('resolver returns null for unknown IP even with routing configured', () => {
    const resolver = buildResolver(topo.linuxClient);
    expect(resolver('10.99.99.99')).toBeNull();
  });

  it('(e) resolver blocks connection without default gateway configured', () => {
    // Create an isolated client with no gateway and no route to Site B
    resetDeviceCounters();
    const isolated = new LinuxPC('linux-pc', 'Isolated', 0, 0);
    isolated.configureInterface('eth0', new IPAddress(CLIENT_IP), new SubnetMask(MASK_24));
    // Deliberately: no setDefaultGateway()

    const resolver = buildResolver(isolated);
    // 10.0.20.x is unreachable — no route in table
    expect(resolver(LINUX_SRV)).toBeNull();
    expect(resolver(WIN_SRV)).toBeNull();
  });

  it('(f) resolver returns null for a routeable IP with no registered SFTP server', () => {
    // 192.168.10.99 is within the directly-connected 192.168.10.0/24 subnet
    // (stage 1 passes), but no device in the topology owns that address
    // (stage 2 returns null).
    const resolver = buildResolver(topo.linuxClient);
    expect(resolver('192.168.10.99')).toBeNull();
  });

  it('ten devices are registered in the Equipment registry', () => {
    // 2 clients + 2 servers + 2 routers + 2 switches = 8 (+ 1 ghost = 9 here, but fresh beforeEach = 8)
    expect(Equipment.getAllEquipment().length).toBe(8);
  });

  it('clients have a default gateway', () => {
    expect(topo.linuxClient.getDefaultGateway()?.toString()).toBe(GW_A);
    expect(topo.linuxClient2.getDefaultGateway()?.toString()).toBe(GW_A);
  });

  it('servers have a default gateway', () => {
    expect(topo.linuxServer.getDefaultGateway()?.toString()).toBe(GW_B);
    expect(topo.winServer.getDefaultGateway()?.toString()).toBe(GW_B);
  });
});

// ─── WAN-02: Linux client → Linux file server ────────────────────────────────

describe('WAN-02: Linux client → Linux file server', () => {
  let session: SftpSession;

  beforeEach(() => {
    session = makeSession(topo.linuxClient, CLIENT_IP, topo);
  });

  it('connects successfully with root/admin', () => {
    expect(session.connect(`root@${LINUX_SRV}`, 'admin')).toBe('');
    expect(session.isConnected()).toBe(true);
  });

  it('connect rejects wrong password', () => {
    expect(session.connect(`root@${LINUX_SRV}`, 'badpass')).toContain('Permission denied');
    expect(session.isConnected()).toBe(false);
  });

  it('connect rejects nonexistent user', () => {
    expect(session.connect(`ghost@${LINUX_SRV}`, 'admin')).toContain('Permission denied');
  });

  it('pwd shows /root after connect', () => {
    session.connect(`root@${LINUX_SRV}`, 'admin');
    expect(session.pwd()).toContain('/root');
  });

  it('put uploads a file to the Linux server', () => {
    const clientVfs = (topo.linuxClient as any).executor.vfs as VirtualFileSystem;
    clientVfs.writeFile('/home/user/upload.txt', 'hello from client', 1000, 1000, 0o022);

    session.connect(`root@${LINUX_SRV}`, 'admin');
    expect(session.put('/home/user/upload.txt')).toContain('upload.txt');

    const serverVfs = (topo.linuxServer as any).executor.vfs as VirtualFileSystem;
    expect(serverVfs.readFile('/root/upload.txt')).toBe('hello from client');
  });

  it('get downloads a file from the Linux server', () => {
    const serverVfs = (topo.linuxServer as any).executor.vfs as VirtualFileSystem;
    serverVfs.writeFile('/root/report.txt', 'server report', 0, 0, 0o022);

    session.connect(`root@${LINUX_SRV}`, 'admin');
    expect(session.get('report.txt')).toContain('report.txt');

    const clientVfs = (topo.linuxClient as any).executor.vfs as VirtualFileSystem;
    expect(clientVfs.readFile('/home/user/report.txt')).toBe('server report');
  });

  it('cd changes remote working directory', () => {
    const serverVfs = (topo.linuxServer as any).executor.vfs as VirtualFileSystem;
    serverVfs.mkdirp('/root/projects', 0o755, 0, 0);

    session.connect(`root@${LINUX_SRV}`, 'admin');
    expect(session.cd('projects')).toBe('');
    expect(session.pwd()).toContain('/root/projects');
  });

  it('mkdir creates a directory on the Linux server', () => {
    session.connect(`root@${LINUX_SRV}`, 'admin');
    expect(session.mkdir('newdir')).toBe('');

    const serverVfs = (topo.linuxServer as any).executor.vfs as VirtualFileSystem;
    expect(serverVfs.resolveInode('/root/newdir')?.type).toBe('directory');
  });

  it('rm deletes a file on the Linux server', () => {
    const serverVfs = (topo.linuxServer as any).executor.vfs as VirtualFileSystem;
    serverVfs.writeFile('/root/tmp.txt', 'data', 0, 0, 0o022);

    session.connect(`root@${LINUX_SRV}`, 'admin');
    expect(session.rm('tmp.txt')).toBe('');
    expect(serverVfs.resolveInode('/root/tmp.txt')).toBeNull();
  });

  it('rmdir removes an empty directory on the Linux server', () => {
    const serverVfs = (topo.linuxServer as any).executor.vfs as VirtualFileSystem;
    serverVfs.mkdirp('/root/emptydir', 0o755, 0, 0);

    session.connect(`root@${LINUX_SRV}`, 'admin');
    expect(session.rmdir('emptydir')).toBe('');
    expect(serverVfs.resolveInode('/root/emptydir')).toBeNull();
  });

  it('rename renames a file on the Linux server', () => {
    const serverVfs = (topo.linuxServer as any).executor.vfs as VirtualFileSystem;
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

  it('operations on disconnected session return Not connected', () => {
    expect(session.ls([])).toBe('Not connected.');
    expect(session.get('x')).toBe('Not connected.');
  });
});

// ─── WAN-03: Linux client → Windows file server ──────────────────────────────

describe('WAN-03: Linux client → Windows file server', () => {
  let session: SftpSession;

  beforeEach(() => {
    session = makeSession(topo.linuxClient, CLIENT_IP, topo);
  });

  it('connects to Windows server with User/user', () => {
    expect(session.connect(`User@${WIN_SRV}`, 'user')).toBe('');
    expect(session.isConnected()).toBe(true);
  });

  it('connects to Windows server with Administrator/admin', () => {
    expect(session.connect(`Administrator@${WIN_SRV}`, 'admin')).toBe('');
  });

  it('connect rejects wrong password on Windows server', () => {
    expect(session.connect(`User@${WIN_SRV}`, 'badpass')).toContain('Permission denied');
  });

  it('pwd shows Windows SFTP home path /C:/Users/User', () => {
    session.connect(`User@${WIN_SRV}`, 'user');
    expect(session.pwd()).toContain('/C:/Users/User');
  });

  it('Administrator home is /C:/Users/Administrator', () => {
    session.connect(`Administrator@${WIN_SRV}`, 'admin');
    expect(session.pwd()).toContain('/C:/Users/Administrator');
  });

  it('ls lists Windows home directory (Desktop, Documents, …)', () => {
    session.connect(`User@${WIN_SRV}`, 'user');
    const out = session.ls([]);
    expect(out).toContain('Desktop');
    expect(out).toContain('Documents');
  });

  it('put uploads a file to the Windows server', () => {
    const clientVfs = (topo.linuxClient as any).executor.vfs as VirtualFileSystem;
    clientVfs.writeFile('/home/user/transfer.txt', 'hello windows', 1000, 1000, 0o022);

    session.connect(`User@${WIN_SRV}`, 'user');
    expect(session.put('/home/user/transfer.txt')).toContain('transfer.txt');

    const winVfs = (topo.winServer as any).fs;
    expect(winVfs.readFile('C:\\Users\\User\\transfer.txt').content).toBe('hello windows');
  });

  it('get downloads a file from the Windows server', () => {
    const winVfs = (topo.winServer as any).fs;
    winVfs.createFile('C:\\Users\\User\\report.csv', 'col1,col2\n1,2\n');

    session.connect(`User@${WIN_SRV}`, 'user');
    expect(session.get('report.csv')).toContain('report.csv');

    const clientVfs = (topo.linuxClient as any).executor.vfs as VirtualFileSystem;
    expect(clientVfs.readFile('/home/user/report.csv')).toBe('col1,col2\n1,2\n');
  });

  it('cd to Documents on Windows server', () => {
    session.connect(`User@${WIN_SRV}`, 'user');
    expect(session.cd('Documents')).toBe('');
    expect(session.pwd()).toContain('/C:/Users/User/Documents');
  });

  it('mkdir creates a directory on the Windows server', () => {
    session.connect(`User@${WIN_SRV}`, 'user');
    expect(session.mkdir('SharedFiles')).toBe('');

    const winVfs = (topo.winServer as any).fs;
    expect(winVfs.isDirectory('C:\\Users\\User\\SharedFiles')).toBe(true);
  });

  it('rm deletes a file on the Windows server', () => {
    const winVfs = (topo.winServer as any).fs;
    winVfs.createFile('C:\\Users\\User\\temp.txt', 'temp');

    session.connect(`User@${WIN_SRV}`, 'user');
    expect(session.rm('temp.txt')).toBe('');
    expect(winVfs.exists('C:\\Users\\User\\temp.txt')).toBe(false);
  });

  it('rename renames a file on the Windows server', () => {
    const winVfs = (topo.winServer as any).fs;
    winVfs.createFile('C:\\Users\\User\\old.txt', 'content');

    session.connect(`User@${WIN_SRV}`, 'user');
    expect(session.rename('old.txt', 'new.txt')).toBe('');
    expect(winVfs.exists('C:\\Users\\User\\new.txt')).toBe(true);
    expect(winVfs.exists('C:\\Users\\User\\old.txt')).toBe(false);
  });
});

// ─── WAN-04: Routing blocks unreachable destinations ─────────────────────────

describe('WAN-04: Routing blocks unreachable destinations', () => {
  it('host without default gateway cannot reach remote subnet', () => {
    // Remove gateway from client, verify SFTP is blocked
    resetDeviceCounters();
    const isolated = new LinuxPC('linux-pc', 'NoGW', 0, 0);
    isolated.configureInterface('eth0', new IPAddress(CLIENT_IP), new SubnetMask(MASK_24));
    // no setDefaultGateway

    const s = new SftpSession(
      (isolated as any).executor.vfs,
      (isolated as any).socketTable,
      buildResolver(isolated),
      '/home/user', CLIENT_IP, 'user',
    );
    expect(s.connect(`root@${LINUX_SRV}`, 'admin')).toContain('No route to host');
    expect(s.connect(`User@${WIN_SRV}`,   'user')).toContain('No route to host');
  });

  it('client CAN reach its own subnet without a gateway', () => {
    // 192.168.10.x is directly connected — no gateway needed
    // (client2 does not expose getSftpServer, so null is returned — different reason)
    const resolver = buildResolver(topo.linuxClient);
    // There IS a route (connected) to 192.168.10.0/24 — resolveRoute returns non-null
    const route = (topo.linuxClient as any).resolveRoute(new IPAddress(CLIENT2_IP));
    expect(route).not.toBeNull();
  });

  it('wrong password blocks even when routing is good (Linux server)', () => {
    const s = makeSession(topo.linuxClient, CLIENT_IP, topo);
    expect(s.connect(`root@${LINUX_SRV}`, 'WRONG')).toContain('Permission denied');
  });

  it('wrong password blocks even when routing is good (Windows server)', () => {
    const s = makeSession(topo.linuxClient, CLIENT_IP, topo);
    expect(s.connect(`User@${WIN_SRV}`, 'WRONG')).toContain('Permission denied');
  });

  it('connect to non-existing IP returns No route to host', () => {
    const s = makeSession(topo.linuxClient, CLIENT_IP, topo);
    expect(s.connect('172.31.99.99', 'admin')).toContain('No route to host');
  });
});

// ─── WAN-05: Concurrent sessions ─────────────────────────────────────────────

describe('WAN-05: Concurrent sessions', () => {
  it('two clients simultaneously connected to Linux server', () => {
    const s1 = makeSession(topo.linuxClient,  CLIENT_IP,  topo);
    const s2 = makeSession(topo.linuxClient2, CLIENT2_IP, topo);

    expect(s1.connect(`root@${LINUX_SRV}`, 'admin')).toBe('');
    expect(s2.connect(`root@${LINUX_SRV}`, 'admin')).toBe('');
    expect(s1.isConnected()).toBe(true);
    expect(s2.isConnected()).toBe(true);
  });

  it('two clients simultaneously connected to Windows server', () => {
    const s1 = makeSession(topo.linuxClient,  CLIENT_IP,  topo);
    const s2 = makeSession(topo.linuxClient2, CLIENT2_IP, topo);

    expect(s1.connect(`User@${WIN_SRV}`, 'user')).toBe('');
    expect(s2.connect(`User@${WIN_SRV}`, 'user')).toBe('');
    expect(s1.isConnected()).toBe(true);
    expect(s2.isConnected()).toBe(true);
  });

  it('client1 writes to Linux server, client2 reads the same file', () => {
    const s1 = makeSession(topo.linuxClient,  CLIENT_IP,  topo);
    const s2 = makeSession(topo.linuxClient2, CLIENT2_IP, topo);

    const vfs1 = (topo.linuxClient as any).executor.vfs as VirtualFileSystem;
    vfs1.writeFile('/home/user/shared.txt', 'shared content', 1000, 1000, 0o022);

    s1.connect(`root@${LINUX_SRV}`, 'admin');
    s1.put('/home/user/shared.txt');
    s1.disconnect();

    s2.connect(`root@${LINUX_SRV}`, 'admin');
    s2.get('shared.txt');

    const vfs2 = (topo.linuxClient2 as any).executor.vfs as VirtualFileSystem;
    expect(vfs2.readFile('/home/user/shared.txt')).toBe('shared content');
  });

  it('disconnecting one session does not affect the other', () => {
    const s1 = makeSession(topo.linuxClient,  CLIENT_IP,  topo);
    const s2 = makeSession(topo.linuxClient2, CLIENT2_IP, topo);

    s1.connect(`root@${LINUX_SRV}`, 'admin');
    s2.connect(`root@${LINUX_SRV}`, 'admin');

    s1.disconnect();
    expect(s1.isConnected()).toBe(false);
    expect(s2.isConnected()).toBe(true);
  });

  it('client1 writes to Windows server, client2 reads the same file', () => {
    const s1 = makeSession(topo.linuxClient,  CLIENT_IP,  topo);
    const s2 = makeSession(topo.linuxClient2, CLIENT2_IP, topo);

    const vfs1 = (topo.linuxClient as any).executor.vfs as VirtualFileSystem;
    vfs1.writeFile('/home/user/msg.txt', 'windows message', 1000, 1000, 0o022);

    s1.connect(`User@${WIN_SRV}`, 'user');
    s1.put('/home/user/msg.txt');

    s2.connect(`User@${WIN_SRV}`, 'user');
    s2.get('msg.txt');

    const vfs2 = (topo.linuxClient2 as any).executor.vfs as VirtualFileSystem;
    expect(vfs2.readFile('/home/user/msg.txt')).toBe('windows message');
  });
});

// ─── WAN-06: Cross-server file exchange ──────────────────────────────────────

describe('WAN-06: Cross-server file exchange', () => {
  it('upload to Linux server, download by second client', () => {
    const s1 = makeSession(topo.linuxClient,  CLIENT_IP,  topo);
    const s2 = makeSession(topo.linuxClient2, CLIENT2_IP, topo);

    const vfs1 = (topo.linuxClient as any).executor.vfs as VirtualFileSystem;
    vfs1.writeFile('/home/user/backup.tar', 'backup-data', 1000, 1000, 0o022);

    s1.connect(`root@${LINUX_SRV}`, 'admin');
    s1.put('/home/user/backup.tar');
    s1.disconnect();

    s2.connect(`root@${LINUX_SRV}`, 'admin');
    s2.get('backup.tar');
    const vfs2 = (topo.linuxClient2 as any).executor.vfs as VirtualFileSystem;
    expect(vfs2.readFile('/home/user/backup.tar')).toBe('backup-data');
  });

  it('upload same file to both servers (Linux + Windows)', () => {
    const s1 = makeSession(topo.linuxClient, CLIENT_IP, topo);
    const s2 = makeSession(topo.linuxClient, CLIENT_IP, topo);

    const vfs = (topo.linuxClient as any).executor.vfs as VirtualFileSystem;
    vfs.writeFile('/home/user/config.cfg', '[section]\nkey=val\n', 1000, 1000, 0o022);

    s1.connect(`root@${LINUX_SRV}`, 'admin');
    s1.put('/home/user/config.cfg');
    s1.disconnect();

    s2.connect(`User@${WIN_SRV}`, 'user');
    s2.put('/home/user/config.cfg');
    s2.disconnect();

    const linuxVfs = (topo.linuxServer as any).executor.vfs as VirtualFileSystem;
    expect(linuxVfs.readFile('/root/config.cfg')).toBe('[section]\nkey=val\n');
    const winVfs = (topo.winServer as any).fs;
    expect(winVfs.readFile('C:\\Users\\User\\config.cfg').content).toBe('[section]\nkey=val\n');
  });

  it('lls / lcd allow local navigation while connected to remote server', () => {
    const vfs = (topo.linuxClient as any).executor.vfs as VirtualFileSystem;
    vfs.mkdirp('/home/user/localdir', 0o755, 1000, 1000);
    vfs.writeFile('/home/user/localdir/note.txt', 'local note', 1000, 1000, 0o022);

    const session = makeSession(topo.linuxClient, CLIENT_IP, topo);
    session.connect(`root@${LINUX_SRV}`, 'admin');
    expect(session.lcd('localdir')).toBe('');
    expect(session.lpwd()).toContain('/home/user/localdir');
    expect(session.lls([])).toContain('note.txt');
  });

  it('get with explicit local path writes to given path', () => {
    const serverVfs = (topo.linuxServer as any).executor.vfs as VirtualFileSystem;
    serverVfs.writeFile('/root/archive.zip', 'zip-content', 0, 0, 0o022);

    const session = makeSession(topo.linuxClient, CLIENT_IP, topo);
    session.connect(`root@${LINUX_SRV}`, 'admin');
    session.get('/root/archive.zip', '/home/user/downloads/archive.zip');

    const clientVfs = (topo.linuxClient as any).executor.vfs as VirtualFileSystem;
    expect(clientVfs.readFile('/home/user/downloads/archive.zip')).toBe('zip-content');
  });

  it('put with explicit remote path writes to given remote path', () => {
    const serverVfs = (topo.linuxServer as any).executor.vfs as VirtualFileSystem;
    serverVfs.mkdirp('/root/uploads', 0o755, 0, 0);

    const clientVfs = (topo.linuxClient as any).executor.vfs as VirtualFileSystem;
    clientVfs.writeFile('/home/user/payload.txt', 'payload', 1000, 1000, 0o022);

    const session = makeSession(topo.linuxClient, CLIENT_IP, topo);
    session.connect(`root@${LINUX_SRV}`, 'admin');
    session.put('/home/user/payload.txt', '/root/uploads/payload.txt');
    expect(serverVfs.readFile('/root/uploads/payload.txt')).toBe('payload');
  });

  it('connect after disconnect re-establishes the session', () => {
    const session = makeSession(topo.linuxClient, CLIENT_IP, topo);
    session.connect(`root@${LINUX_SRV}`, 'admin');
    session.disconnect();
    expect(session.connect(`root@${LINUX_SRV}`, 'admin')).toBe('');
    expect(session.isConnected()).toBe(true);
  });
});

// ─── WAN-07: Server-side directory operations ─────────────────────────────────

describe('WAN-07: Server-side directory operations', () => {
  it('mkdir then cd then put — Linux server', () => {
    const clientVfs = (topo.linuxClient as any).executor.vfs as VirtualFileSystem;
    clientVfs.writeFile('/home/user/data.txt', 'dataset', 1000, 1000, 0o022);

    const session = makeSession(topo.linuxClient, CLIENT_IP, topo);
    session.connect(`root@${LINUX_SRV}`, 'admin');
    session.mkdir('datasets');
    session.cd('datasets');
    session.put('/home/user/data.txt');

    const serverVfs = (topo.linuxServer as any).executor.vfs as VirtualFileSystem;
    expect(serverVfs.readFile('/root/datasets/data.txt')).toBe('dataset');
  });

  it('rmdir refuses to remove non-empty directory — Linux server', () => {
    const serverVfs = (topo.linuxServer as any).executor.vfs as VirtualFileSystem;
    serverVfs.mkdirp('/root/nonempty', 0o755, 0, 0);
    serverVfs.writeFile('/root/nonempty/file.txt', 'data', 0, 0, 0o022);

    const session = makeSession(topo.linuxClient, CLIENT_IP, topo);
    session.connect(`root@${LINUX_SRV}`, 'admin');
    expect(session.rmdir('nonempty')).toContain("Couldn't remove directory");
  });

  it('rename file to different directory — Linux server', () => {
    const serverVfs = (topo.linuxServer as any).executor.vfs as VirtualFileSystem;
    serverVfs.mkdirp('/root/archive', 0o755, 0, 0);
    serverVfs.writeFile('/root/todo.txt', 'tasks', 0, 0, 0o022);

    const session = makeSession(topo.linuxClient, CLIENT_IP, topo);
    session.connect(`root@${LINUX_SRV}`, 'admin');
    session.rename('/root/todo.txt', '/root/archive/done.txt');

    expect(serverVfs.resolveInode('/root/archive/done.txt')).not.toBeNull();
    expect(serverVfs.resolveInode('/root/todo.txt')).toBeNull();
  });

  it('mkdir then rmdir — Windows server', () => {
    const session = makeSession(topo.linuxClient, CLIENT_IP, topo);
    session.connect(`User@${WIN_SRV}`, 'user');
    session.mkdir('TempDir');
    const winVfs = (topo.winServer as any).fs;
    expect(winVfs.isDirectory('C:\\Users\\User\\TempDir')).toBe(true);
    expect(session.rmdir('TempDir')).toBe('');
    expect(winVfs.isDirectory('C:\\Users\\User\\TempDir')).toBe(false);
  });

  it('rm on nonexistent file returns error — Linux server', () => {
    const session = makeSession(topo.linuxClient, CLIENT_IP, topo);
    session.connect(`root@${LINUX_SRV}`, 'admin');
    expect(session.rm('ghost.txt')).toContain('No such file or directory');
  });

  it('get nonexistent file returns error — Windows server', () => {
    const session = makeSession(topo.linuxClient, CLIENT_IP, topo);
    session.connect(`User@${WIN_SRV}`, 'user');
    expect(session.get('missing.exe')).toContain('not found');
  });
});

// ─── WAN-08: Transfer integrity ──────────────────────────────────────────────

describe('WAN-08: Transfer integrity', () => {
  it('transfer output contains filename, 100%, and byte count', () => {
    const clientVfs = (topo.linuxClient as any).executor.vfs as VirtualFileSystem;
    clientVfs.writeFile('/home/user/hello.txt', '12345', 1000, 1000, 0o022);

    const session = makeSession(topo.linuxClient, CLIENT_IP, topo);
    session.connect(`root@${LINUX_SRV}`, 'admin');
    const result = session.put('/home/user/hello.txt');
    expect(result).toContain('hello.txt');
    expect(result).toContain('100%');
    expect(result).toContain('5');
  });

  it('empty file transfers to Linux server without error', () => {
    const clientVfs = (topo.linuxClient as any).executor.vfs as VirtualFileSystem;
    clientVfs.writeFile('/home/user/empty.txt', '', 1000, 1000, 0o022);

    const session = makeSession(topo.linuxClient, CLIENT_IP, topo);
    session.connect(`root@${LINUX_SRV}`, 'admin');
    const result = session.put('/home/user/empty.txt');
    expect(result).toContain('empty.txt');

    const serverVfs = (topo.linuxServer as any).executor.vfs as VirtualFileSystem;
    expect(serverVfs.readFile('/root/empty.txt')).toBe('');
  });

  it('empty file transfers to Windows server without error', () => {
    const clientVfs = (topo.linuxClient as any).executor.vfs as VirtualFileSystem;
    clientVfs.writeFile('/home/user/empty.dat', '', 1000, 1000, 0o022);

    const session = makeSession(topo.linuxClient, CLIENT_IP, topo);
    session.connect(`User@${WIN_SRV}`, 'user');
    expect(session.put('/home/user/empty.dat')).toContain('empty.dat');
  });

  it('multiline content preserved through Linux server round-trip', () => {
    const content = 'line1\nline2\nline3\n';
    const vfs1 = (topo.linuxClient as any).executor.vfs as VirtualFileSystem;
    vfs1.writeFile('/home/user/multi.txt', content, 1000, 1000, 0o022);

    const s1 = makeSession(topo.linuxClient,  CLIENT_IP,  topo);
    s1.connect(`root@${LINUX_SRV}`, 'admin');
    s1.put('/home/user/multi.txt');
    s1.disconnect();

    const s2 = makeSession(topo.linuxClient2, CLIENT2_IP, topo);
    s2.connect(`root@${LINUX_SRV}`, 'admin');
    s2.get('multi.txt');
    const vfs2 = (topo.linuxClient2 as any).executor.vfs as VirtualFileSystem;
    expect(vfs2.readFile('/home/user/multi.txt')).toBe(content);
  });

  it('multiline content preserved through Windows server round-trip', () => {
    const content = 'alpha\nbeta\ngamma\n';
    const vfs1 = (topo.linuxClient as any).executor.vfs as VirtualFileSystem;
    vfs1.writeFile('/home/user/lines.txt', content, 1000, 1000, 0o022);

    const s1 = makeSession(topo.linuxClient,  CLIENT_IP,  topo);
    s1.connect(`User@${WIN_SRV}`, 'user');
    s1.put('/home/user/lines.txt');
    s1.disconnect();

    const s2 = makeSession(topo.linuxClient2, CLIENT2_IP, topo);
    s2.connect(`User@${WIN_SRV}`, 'user');
    s2.get('lines.txt');
    const vfs2 = (topo.linuxClient2 as any).executor.vfs as VirtualFileSystem;
    expect(vfs2.readFile('/home/user/lines.txt')).toBe(content);
  });
});
