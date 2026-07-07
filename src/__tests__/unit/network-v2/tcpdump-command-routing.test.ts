import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { MACAddress, resetCounters } from '@/network/core/types';
import { Logger } from '@/network/core/Logger';

function setupLAN() {
  const pc1 = new LinuxPC('PC1', 0, 0);
  const pc2 = new LinuxPC('PC2', 100, 0);
  const sw = new CiscoSwitch('switch-cisco', 'SW1', 24, 50, 50);
  const cable1 = new Cable('c1');
  cable1.connect(pc1.getPort('eth0')!, sw.getPort('FastEthernet0/1')!);
  const cable2 = new Cable('c2');
  cable2.connect(pc2.getPort('eth0')!, sw.getPort('FastEthernet0/2')!);
  return { pc1, pc2, sw };
}

async function captureWithTraffic(capturer: LinuxPC, cmd: string, gen: () => Promise<void>): Promise<string> {
  const p = capturer.executeCommand(cmd);
  await new Promise((r) => setTimeout(r, 50));
  await gen();
  return await p;
}

describe('tcpdump — unified command routing (PRD-tcpdump.md P1)', () => {
  beforeEach(() => {
    resetCounters();
    MACAddress.resetCounter();
    Logger.reset();
  });

  it('a piped invocation sees ICMP traffic just like a bare invocation (rich engine, not the old TCP-only fallback)', async () => {
    const { pc1, pc2 } = setupLAN();
    await pc1.executeCommand('ifconfig eth0 10.0.0.1 netmask 255.255.255.0');
    await pc2.executeCommand('ifconfig eth0 10.0.0.2 netmask 255.255.255.0');

    const piped = await captureWithTraffic(pc1, 'tcpdump -c 1 -nn icmp | grep ICMP', async () => {
      await pc1.executeCommand('ping -c 1 10.0.0.2');
    });
    expect(piped).toContain('ICMP echo request');
  });

  it('a redirected/composite invocation reaches the same rich engine', async () => {
    const { pc1, pc2 } = setupLAN();
    await pc1.executeCommand('ifconfig eth0 10.0.0.1 netmask 255.255.255.0');
    await pc2.executeCommand('ifconfig eth0 10.0.0.2 netmask 255.255.255.0');

    const output = await captureWithTraffic(pc1, 'tcpdump -c 1 -nn icmp > /tmp/out.txt; cat /tmp/out.txt', async () => {
      await pc1.executeCommand('ping -c 1 10.0.0.2');
    });
    expect(output).toContain('ICMP echo request');
  });

  it('a quoted multi-word BPF filter still parses correctly through the registered-command dispatch', async () => {
    const { pc1, pc2 } = setupLAN();
    await pc1.executeCommand('ifconfig eth0 10.0.0.1 netmask 255.255.255.0');
    await pc2.executeCommand('ifconfig eth0 10.0.0.2 netmask 255.255.255.0');

    const output = await captureWithTraffic(pc1, 'tcpdump -c 1 "icmp and host 10.0.0.2"', async () => {
      await pc1.executeCommand('ping -c 1 10.0.0.2');
    });
    expect(output).toContain('ICMP echo request');
  });

  it('--help still renders real usage text mentioning -i and -c through the registered-command dispatch', async () => {
    const { pc1 } = setupLAN();
    const output = await pc1.executeCommand('tcpdump --help');
    expect(output).toContain('Usage: tcpdump');
    expect(output).toContain('-i');
    expect(output).toContain('-c');
  });
});
