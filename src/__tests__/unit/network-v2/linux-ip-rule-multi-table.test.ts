import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { MACAddress, resetCounters } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  EquipmentRegistry.resetInstance();
  resetCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

describe('ip rule + multiple routing tables (PRD-ip.md P6)', () => {
  it('ip rule show lists the real default rules (local/main/default)', async () => {
    const pc = new LinuxPC('PC1', 0, 0);
    const output = await pc.executeCommand('ip rule show');
    expect(output).toContain('0:\tfrom all lookup local');
    expect(output).toContain('32766:\tfrom all lookup main');
    expect(output).toContain('32767:\tfrom all lookup default');
  });

  it('ip route add ... table 100 does not appear in the main table, and vice versa', async () => {
    const pc = new LinuxPC('PC1', 0, 0);
    await pc.executeCommand('ifconfig eth0 10.0.0.1 netmask 255.255.255.0');
    await pc.executeCommand('ip route add 192.168.50.0/24 via 10.0.0.254 table 100');

    const mainShow = await pc.executeCommand('ip route show');
    expect(mainShow).not.toContain('192.168.50.0/24');

    const table100Show = await pc.executeCommand('ip route show table 100');
    expect(table100Show).toContain('192.168.50.0/24 via 10.0.0.254');
  });

  it('two distinct tables stay fully isolated from each other', async () => {
    const pc = new LinuxPC('PC1', 0, 0);
    await pc.executeCommand('ifconfig eth0 10.0.0.1 netmask 255.255.255.0');
    await pc.executeCommand('ip route add 172.16.1.0/24 via 10.0.0.253 table 100');
    await pc.executeCommand('ip route add 172.16.2.0/24 via 10.0.0.252 table 200');

    const table100 = await pc.executeCommand('ip route show table 100');
    expect(table100).toContain('172.16.1.0/24');
    expect(table100).not.toContain('172.16.2.0/24');

    const table200 = await pc.executeCommand('ip route show table 200');
    expect(table200).toContain('172.16.2.0/24');
    expect(table200).not.toContain('172.16.1.0/24');
  });

  it('ip route del ... table 100 removes only from that table', async () => {
    const pc = new LinuxPC('PC1', 0, 0);
    await pc.executeCommand('ifconfig eth0 10.0.0.1 netmask 255.255.255.0');
    await pc.executeCommand('ip route add 10.10.0.0/16 via 10.0.0.254 table 100');
    const delOut = await pc.executeCommand('ip route del 10.10.0.0/16 table 100');
    expect(delOut).toBe('');
    const show = await pc.executeCommand('ip route show table 100');
    expect(show).not.toContain('10.10.0.0/16');
  });

  it('ip rule add + ip route get from directs matching traffic to the rule\'s table', async () => {
    const pc = new LinuxPC('PC1', 0, 0);
    await pc.executeCommand('ifconfig eth0 10.0.0.1 netmask 255.255.255.0');
    await pc.executeCommand('ifconfig eth1 10.0.1.1 netmask 255.255.255.0');

    // Table 100: everything sourced from 10.0.1.0/24 goes out via a different gateway.
    await pc.executeCommand('ip route add 8.8.8.0/24 via 10.0.1.254 table 100');
    await pc.executeCommand('ip route add 8.8.8.0/24 via 10.0.0.254');
    await pc.executeCommand('ip rule add from 10.0.1.0/24 table 100 priority 100');

    const mainLookup = await pc.executeCommand('ip route get 8.8.8.1 from 10.0.0.1');
    expect(mainLookup).toContain('via 10.0.0.254');

    const ruleLookup = await pc.executeCommand('ip route get 8.8.8.1 from 10.0.1.1');
    expect(ruleLookup).toContain('via 10.0.1.254');
    expect(ruleLookup).toContain('table 100');
  });

  it('ip rule del removes a real rule so traffic falls back to the main table', async () => {
    const pc = new LinuxPC('PC1', 0, 0);
    await pc.executeCommand('ifconfig eth0 10.0.0.1 netmask 255.255.255.0');
    await pc.executeCommand('ifconfig eth1 10.0.1.1 netmask 255.255.255.0');
    await pc.executeCommand('ip route add 8.8.8.0/24 via 10.0.1.254 table 100');
    await pc.executeCommand('ip route add 8.8.8.0/24 via 10.0.0.254');
    await pc.executeCommand('ip rule add from 10.0.1.0/24 table 100 priority 100');

    const before = await pc.executeCommand('ip route get 8.8.8.1 from 10.0.1.1');
    expect(before).toContain('via 10.0.1.254');

    const delOut = await pc.executeCommand('ip rule del priority 100');
    expect(delOut).toBe('');

    const after = await pc.executeCommand('ip route get 8.8.8.1 from 10.0.1.1');
    expect(after).toContain('via 10.0.0.254');
  });

  it('ip rule del on a nonexistent priority fails with a real RTNETLINK error', async () => {
    const pc = new LinuxPC('PC1', 0, 0);
    const output = await pc.executeCommand('ip rule del priority 12345');
    expect(output).toContain('RTNETLINK answers: No such file or directory');
  });

  it('ip rule show reflects an added rule with real from/table fields', async () => {
    const pc = new LinuxPC('PC1', 0, 0);
    await pc.executeCommand('ip rule add from 10.0.1.0/24 table 100 priority 100');
    const show = await pc.executeCommand('ip rule show');
    expect(show).toContain('100:\tfrom 10.0.1.0/24 lookup 100');
  });
});
