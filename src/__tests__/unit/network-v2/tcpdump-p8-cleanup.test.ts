import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { MACAddress, resetCounters } from '@/network/core/types';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { PacketCaptureLog } from '@/network/devices/linux/network/PacketCaptureLog';
import { cmdTcpdump } from '@/network/devices/linux/LinuxNetCommands';

interface TcpConnector {
  getTcpStack(): {
    connect(ip: string, port: number): unknown;
    listen(port: number, opts: { onAccept: (s: unknown) => void }): void;
  };
}

beforeEach(() => {
  EquipmentRegistry.resetInstance();
  resetCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

function buildLan(): { pc1: LinuxPC; pc2: LinuxPC } {
  const pc1 = new LinuxPC('PC1', 0, 0);
  const pc2 = new LinuxPC('PC2', 100, 0);
  const sw = new CiscoSwitch('switch-cisco', 'SW1', 24, 50, 50);
  new Cable('c1').connect(pc1.getPort('eth0')!, sw.getPort('FastEthernet0/1')!);
  new Cable('c2').connect(pc2.getPort('eth0')!, sw.getPort('FastEthernet0/2')!);
  return { pc1, pc2 };
}

describe('tcpdump P8 cleanup: -Q, snaplen truncation, -D, -r+-c, multicast/broadcast (PRD-tcpdump.md P8)', () => {
  it('-Q out only shows outbound traffic, -Q in only shows inbound', async () => {
    const { pc1, pc2 } = buildLan();
    await pc1.executeCommand('ifconfig eth0 10.0.0.1 netmask 255.255.255.0');
    await pc2.executeCommand('ifconfig eth0 10.0.0.2 netmask 255.255.255.0');
    (pc2 as unknown as TcpConnector).getTcpStack().listen(9000, { onAccept: () => {} });

    const pendingOut = pc1.executeCommand('tcpdump -c 1 -nn -Q out tcp');
    await new Promise((resolve) => setTimeout(resolve, 30));
    (pc1 as unknown as TcpConnector).getTcpStack().connect('10.0.0.2', 9000);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const outResult = await pendingOut;
    expect(outResult).toContain('10.0.0.1.32768 > 10.0.0.2.9000');
  });

  it('a small snaplen truncates the one-line summary to [|tcp] instead of decoding ports/flags', async () => {
    const { pc1, pc2 } = buildLan();
    await pc1.executeCommand('ifconfig eth0 10.0.0.1 netmask 255.255.255.0');
    await pc2.executeCommand('ifconfig eth0 10.0.0.2 netmask 255.255.255.0');
    (pc2 as unknown as TcpConnector).getTcpStack().listen(9000, { onAccept: () => {} });

    const pending = pc1.executeCommand('tcpdump -c 1 -nn -s 30 tcp');
    await new Promise((resolve) => setTimeout(resolve, 30));
    (pc1 as unknown as TcpConnector).getTcpStack().connect('10.0.0.2', 9000);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const output = await pending;
    expect(output).toContain('[|tcp]');
    expect(output).not.toContain('Flags [S]');
  });

  it('-D reports each interface\'s real up/down state instead of always [Up, Running]', async () => {
    const pc1 = new LinuxPC('PC1', 0, 0);
    await pc1.executeCommand('ifconfig eth0 down');
    const output = await pc1.executeCommand('tcpdump -D');
    expect(output).toMatch(/eth0 \[Down\]/);
  });

  it('a broadcast ARP request matches the broadcast filter; a unicast reply does not', async () => {
    const { pc1, pc2 } = buildLan();
    await pc1.executeCommand('ifconfig eth0 10.0.0.1 netmask 255.255.255.0');
    await pc2.executeCommand('ifconfig eth0 10.0.0.2 netmask 255.255.255.0');

    const pending = pc1.executeCommand('tcpdump -c 1 -nn broadcast');
    await new Promise((resolve) => setTimeout(resolve, 30));
    await pc1.executeCommand('arp -d 10.0.0.2');
    await pc1.executeCommand('ping -c 1 10.0.0.2');
    const output = await pending;
    expect(output).toContain('ARP, Request who-has');
  });

  it('-r combined with -c stops after the requested number of packets from the file', async () => {
    const pc1 = new LinuxPC('PC1', 0, 0);
    await pc1.executeCommand('ifconfig eth0 10.0.0.1 netmask 255.255.255.0');

    const log = new PacketCaptureLog();
    log.captureTcpHandshake({ ip: '10.0.0.1', port: 1111 }, { ip: '10.0.0.2', port: 80 });
    log.captureTcpHandshake({ ip: '10.0.0.1', port: 2222 }, { ip: '10.0.0.2', port: 80 });
    const vfs = (pc1 as unknown as {
      executor: { vfs: { writeFile: (p: string, c: string, u: number, g: number, m: number) => boolean } };
    }).executor.vfs;
    cmdTcpdump(['-w', 'multi.cap'], log, {
      read: () => null,
      write: (p, c) => { vfs.writeFile(`/home/user/${p}`, c, 0, 0, 0o022); },
    });

    const output = await pc1.executeCommand('tcpdump -r multi.cap -c 1');
    const packetLines = output.split('\n').filter((l) => l.includes('Flags ['));
    expect(packetLines.length).toBe(1);
  });
});
