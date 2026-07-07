import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { MACAddress, resetCounters } from '@/network/core/types';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

beforeEach(() => {
  EquipmentRegistry.resetInstance();
  resetCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

describe('tcpdump background capture responds to kill (PRD-tcpdump.md P5)', () => {
  it('kill %1 stops an in-flight background capture and flushes the -w file immediately', async () => {
    const pc = new LinuxPC('PC1', 0, 0);
    await pc.executeCommand('ifconfig eth0 10.0.0.1 netmask 255.255.255.0');

    await pc.executeCommand('tcpdump -i eth0 -w /tmp/cap.pcap &');
    await pc.executeCommand('kill %1');

    const readBack = await pc.executeCommand('tcpdump -r /tmp/cap.pcap');
    expect(readBack).not.toContain('No such file or directory');
  });
});
