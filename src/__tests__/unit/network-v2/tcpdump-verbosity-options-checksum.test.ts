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

async function captureOneSyn(cmd: string): Promise<string> {
  const pc1 = new LinuxPC('PC1', 0, 0);
  const pc2 = new LinuxPC('PC2', 100, 0);
  const sw = new CiscoSwitch('sw-id', 'SW1', 24, 50, 50);
  new Cable('c1').connect(pc1.getPort('eth0')!, sw.getPort('FastEthernet0/1')!);
  new Cable('c2').connect(pc2.getPort('eth0')!, sw.getPort('FastEthernet0/2')!);
  await pc1.executeCommand('ifconfig eth0 10.0.0.1 netmask 255.255.255.0');
  await pc2.executeCommand('ifconfig eth0 10.0.0.2 netmask 255.255.255.0');
  (pc2 as unknown as TcpConnector).getTcpStack().listen(9000, { onAccept: () => {} });
  const pending = pc1.executeCommand(cmd);
  await new Promise((resolve) => setTimeout(resolve, 30));
  (pc1 as unknown as TcpConnector).getTcpStack().connect('10.0.0.2', 9000);
  await new Promise((resolve) => setTimeout(resolve, 50));
  return pending;
}

describe('tcpdump verbosity levels + TCP options + checksum display (PRD-tcpdump.md P6)', () => {
  it('a SYN carrying negotiated options shows them by default, without -v', async () => {
    const output = await captureOneSyn('tcpdump -c 1 -nn tcp');
    expect(output).toMatch(/options \[mss \d+,sackOK,TS val \d+ ecr \d+,wscale \d+\]/);
    expect(output).not.toContain('cksum');
    expect(output).not.toContain('proto TCP');
  });

  it('-v adds the IP header block and a correct TCP checksum, silent on a good IP checksum', async () => {
    const output = await captureOneSyn('tcpdump -c 1 -nn -v tcp');
    expect(output).toMatch(/proto TCP \(6\), length \d+\)/);
    expect(output).toMatch(/cksum 0x[0-9a-f]{4} \(correct\)/);
    expect(output).not.toContain('ip sum ok');
  });

  it('-vv additionally reports the IP header checksum explicitly as ok', async () => {
    const output = await captureOneSyn('tcpdump -c 1 -nn -vv tcp');
    expect(output).toContain('ip sum ok');
    expect(output).toMatch(/cksum 0x[0-9a-f]{4} \(correct\)/);
  });

  it('a real segment carries a correct seq/ack/window, not the old always-zero placeholders', async () => {
    const output = await captureOneSyn('tcpdump -c 1 -nn tcp');
    const match = output.match(/seq (\d+), win (\d+)/);
    expect(match).not.toBeNull();
    expect(Number(match![1])).toBeGreaterThan(0);
    expect(Number(match![2])).toBe(65535);
  });
});
