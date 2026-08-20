import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { MACAddress, resetCounters } from '@/network/core/types';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

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

describe('tcpdump live-capture dedup (PRD-tcpdump.md P5)', () => {
  it('a real TCP handshake produces exactly one captured frame per segment, not two', async () => {
    const pc1 = new LinuxPC('PC1', 0, 0);
    const pc2 = new LinuxPC('PC2', 100, 0);
    const sw = new CiscoSwitch('switch-cisco', 'SW1', 24, 50, 50);
    new Cable('c1').connect(pc1.getPort('eth0')!, sw.getPort('FastEthernet0/1')!);
    new Cable('c2').connect(pc2.getPort('eth0')!, sw.getPort('FastEthernet0/2')!);
    await pc1.executeCommand('ifconfig eth0 10.0.0.1 netmask 255.255.255.0');
    await pc2.executeCommand('ifconfig eth0 10.0.0.2 netmask 255.255.255.0');
    (pc2 as unknown as TcpConnector).getTcpStack().listen(9000, { onAccept: () => {} });

    const pending = pc1.executeCommand('tcpdump -c 3 -nn tcp');
    await new Promise((resolve) => setTimeout(resolve, 50));
    (pc1 as unknown as TcpConnector).getTcpStack().connect('10.0.0.2', 9000);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const output = await pending;

    const packetLines = output.split('\n').filter((l) => l.includes(' > ') && l.includes('Flags ['));
    expect(packetLines.length).toBe(3);
    expect(packetLines.filter((l) => l.includes('Flags [S]')).length).toBe(1);
    expect(packetLines.filter((l) => l.includes('Flags [S.]')).length).toBe(1);
    expect(packetLines.filter((l) => l.includes('Flags [.]')).length).toBe(1);
  });
});
