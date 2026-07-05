import { describe, it, expect, beforeEach } from 'vitest';
import { IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { WindowsServer } from '@/network/devices/WindowsServer';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
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

const PC_IP = '10.0.3.2';
const SERVER_A_IP = '10.0.3.10';
const SERVER_B_IP = '10.0.3.20';

// FXP is inherently a 3-party topology: a client that only issues control
// commands, and two FTP servers (deliberately Linux + Windows, for OS
// variety) that transfer directly between themselves. All three sit on one
// switched LAN so server A <-> server B's data connection is directly
// routable without going through the client.
function buildTopology() {
  const pc = new LinuxPC('linux-pc', 'PC1');
  const srvA = new LinuxServer('FTP-A');
  const srvB = new WindowsServer('FTP-B');
  const sw = new GenericSwitch('switch-generic', 'sw1', 8, 0, 0);
  const mask = new SubnetMask('255.255.255.0');

  [pc, srvA, srvB].forEach((device, i) => {
    new Cable(`c${i}`).connect(device.getPorts()[0], sw.getPorts()[i]);
  });
  pc.getPorts()[0].configureIP(new IPAddress(PC_IP), mask);
  srvA.getPorts()[0].configureIP(new IPAddress(SERVER_A_IP), mask);
  srvB.getPorts()[0].configureIP(new IPAddress(SERVER_B_IP), mask);

  const vfsA = new VirtualFileSystem();
  vfsA.mkdirp('/srv/ftp', 0o755, 1000, 1000);
  vfsA.writeFile('/srv/ftp/source.txt', 'transferred directly between two FTP servers', 1000, 1000, 0o022);
  const fsA = new LinuxSftpFSAdapter(vfsA, 1000, 1000);
  const usersA = new Map([['alice', 'wonderland']]);
  const serverA = new FtpServer(srvA.getTcpStack(), SERVER_A_IP, { users: usersA, fs: fsA, rootPath: '/srv/ftp' });
  serverA.start();

  const vfsB = new VirtualFileSystem();
  vfsB.mkdirp('/srv/ftp', 0o755, 1000, 1000);
  const fsB = new LinuxSftpFSAdapter(vfsB, 1000, 1000);
  const usersB = new Map([['bob', 'builder']]);
  const serverB = new FtpServer(srvB.getTcpStack(), SERVER_B_IP, { users: usersB, fs: fsB, rootPath: '/srv/ftp' });
  serverB.start();

  const clientA = new FtpClientSession(pc.getTcpStack(), SERVER_A_IP, PC_IP);
  const clientB = new FtpClientSession(pc.getTcpStack(), SERVER_B_IP, PC_IP);
  return { pc, srvA, srvB, vfsA, vfsB, clientA, clientB };
}

function loginA(clientA: FtpClientSession): void {
  clientA.connect();
  clientA.sendCommand({ verb: 'USER', argument: 'alice' });
  clientA.sendCommand({ verb: 'PASS', argument: 'wonderland' });
}

function loginB(clientB: FtpClientSession): void {
  clientB.connect();
  clientB.sendCommand({ verb: 'USER', argument: 'bob' });
  clientB.sendCommand({ verb: 'PASS', argument: 'builder' });
}

describe('FTP FXP — third-party transfers (RFC 959, no dedicated command)', () => {
  it('transfers a file directly from server A to server B without the bytes passing through the client', () => {
    const { clientA, clientB, vfsB } = buildTopology();
    loginA(clientA);
    loginB(clientB);

    // A opens a passive listener; the client never connects to it itself.
    const pasv = clientA.sendCommand({ verb: 'PASV' });
    expect(pasv?.code).toBe(227);
    const match = /\(([\d,]+)\)/.exec(pasv!.lines[0]);
    expect(match).not.toBeNull();

    // The PORT argument for B names A's data-channel address — not B's
    // control peer (the client) — which is exactly what FXP relies on:
    // DataChannel.ts never checks the two against each other.
    const port = clientB.sendCommand({ verb: 'PORT', argument: match![1] });
    expect(port?.code).toBe(200);

    // B dials into A's passive listener and waits (150) for A to send.
    const stor = clientB.sendCommand({ verb: 'STOR', argument: 'received.txt' });
    expect(stor?.code).toBe(150);

    // A pushes the file straight onto the socket B just opened; this
    // cascades synchronously into B's transfer completing and pushing its
    // own unsolicited 226 onto its own (separate) control connection.
    const retr = clientA.sendCommand({ verb: 'RETR', argument: 'source.txt' });
    expect(retr?.code).toBe(226);
    expect(clientB.lastServerReply?.code).toBe(226);

    expect(vfsB.readFile('/srv/ftp/received.txt')).toBe('transferred directly between two FTP servers');
  });

  it('also works with EPRT/EPSV (RFC 2428) naming the third-party address', () => {
    const { clientA, clientB, vfsB } = buildTopology();
    loginA(clientA);
    loginB(clientB);

    const epsv = clientA.sendCommand({ verb: 'EPSV' });
    expect(epsv?.code).toBe(229);
    const portMatch = /\|\|\|(\d+)\|/.exec(epsv!.lines[0]);
    expect(portMatch).not.toBeNull();

    const eprt = clientB.sendCommand({ verb: 'EPRT', argument: `|1|${SERVER_A_IP}|${portMatch![1]}|` });
    expect(eprt?.code).toBe(200);

    const stor = clientB.sendCommand({ verb: 'STOR', argument: 'received-eprt.txt' });
    expect(stor?.code).toBe(150);

    const retr = clientA.sendCommand({ verb: 'RETR', argument: 'source.txt' });
    expect(retr?.code).toBe(226);
    expect(clientB.lastServerReply?.code).toBe(226);

    expect(vfsB.readFile('/srv/ftp/received-eprt.txt')).toBe('transferred directly between two FTP servers');
  });
});
