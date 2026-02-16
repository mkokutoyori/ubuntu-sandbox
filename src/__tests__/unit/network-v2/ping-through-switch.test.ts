/**
 * TDD Integration test: Ping between two PCs through a Switch
 *
 * This is the KEY test for the new architecture.
 * Communication is equipment-driven: PC → Port → Cable → Port → Switch → Port → Cable → Port → PC
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Hub } from '@/network/devices/Hub';
import { Cable } from '@/network/hardware/Cable';
import { MACAddress, resetCounters } from '@/network/core/types';
import { Logger } from '@/network/core/Logger';

describe('Ping through Switch (equipment-driven communication)', () => {
  beforeEach(() => {
    resetCounters();
    MACAddress.resetCounter();
    Logger.reset();
  });

  function setupLAN() {
    const pc1 = new LinuxPC('PC1', 100, 100);
    const pc2 = new LinuxPC('PC2', 400, 100);
    const sw = new CiscoSwitch('switch-cisco', 'Switch1', 24, 250, 250);

    // Connect PC1.eth0 ↔ Switch.GigabitEthernet0/0
    const cable1 = new Cable('cable-1');
    cable1.connect(pc1.getPort('eth0')!, sw.getPort('FastEthernet0/0')!);

    // Connect PC2.eth0 ↔ Switch.GigabitEthernet0/1
    const cable2 = new Cable('cable-2');
    cable2.connect(pc2.getPort('eth0')!, sw.getPort('FastEthernet0/1')!);

    return { pc1, pc2, sw, cable1, cable2 };
  }

  // ─── BASIC REACHABILITY ────────────────────────────────────────

  it('should ping between two PCs through a switch', async () => {
    const { pc1, pc2 } = setupLAN();

    await pc1.executeCommand('ifconfig eth0 192.168.1.10');
    await pc2.executeCommand('ifconfig eth0 192.168.1.20');

    const result = await pc1.executeCommand('ping -c 1 192.168.1.20');
    expect(result).toContain('1 packets transmitted');
    expect(result).toContain('1 received');
    expect(result).toContain('0% packet loss');
  });

  it('should ping with multiple packets', async () => {
    const { pc1, pc2 } = setupLAN();

    await pc1.executeCommand('ifconfig eth0 192.168.1.10');
    await pc2.executeCommand('ifconfig eth0 192.168.1.20');

    const result = await pc1.executeCommand('ping -c 4 192.168.1.20');
    expect(result).toContain('4 packets transmitted');
    expect(result).toContain('4 received');
    expect(result).toContain('0% packet loss');
  });

  it('should ping in reverse direction', async () => {
    const { pc1, pc2 } = setupLAN();

    await pc1.executeCommand('ifconfig eth0 192.168.1.10');
    await pc2.executeCommand('ifconfig eth0 192.168.1.20');

    const result = await pc2.executeCommand('ping -c 1 192.168.1.10');
    expect(result).toContain('1 received');
    expect(result).toContain('0% packet loss');
  });

  it('should populate ARP table after ping', async () => {
    const { pc1, pc2 } = setupLAN();

    await pc1.executeCommand('ifconfig eth0 192.168.1.10');
    await pc2.executeCommand('ifconfig eth0 192.168.1.20');

    await pc1.executeCommand('ping -c 1 192.168.1.20');

    const arp = await pc1.executeCommand('arp -a');
    expect(arp).toContain('192.168.1.20');
  });

  // ─── CABLE DISCONNECT ─────────────────────────────────────────

  it('should fail ping after cable disconnect', async () => {
    const { pc1, pc2, cable1 } = setupLAN();

    await pc1.executeCommand('ifconfig eth0 192.168.1.10');
    await pc2.executeCommand('ifconfig eth0 192.168.1.20');

    // Verify ping works first
    const before = await pc1.executeCommand('ping -c 1 192.168.1.20');
    expect(before).toContain('1 received');

    // Disconnect cable
    cable1.disconnect();

    // Ping should fail
    const after = await pc1.executeCommand('ping -c 1 192.168.1.20');
    expect(after).toContain('100% packet loss');
  });

  it('should fail ping after target cable disconnect', async () => {
    const { pc1, pc2, cable2 } = setupLAN();

    await pc1.executeCommand('ifconfig eth0 192.168.1.10');
    await pc2.executeCommand('ifconfig eth0 192.168.1.20');

    const before = await pc1.executeCommand('ping -c 1 192.168.1.20');
    expect(before).toContain('1 received');

    cable2.disconnect();

    const after = await pc1.executeCommand('ping -c 1 192.168.1.20');
    expect(after).toContain('100% packet loss');
  });

  it('should recover ping after cable reconnect', async () => {
    const { pc1, pc2, sw, cable1 } = setupLAN();

    await pc1.executeCommand('ifconfig eth0 192.168.1.10');
    await pc2.executeCommand('ifconfig eth0 192.168.1.20');

    cable1.disconnect();

    const disconnected = await pc1.executeCommand('ping -c 1 192.168.1.20');
    expect(disconnected).toContain('100% packet loss');

    // Reconnect
    const newCable = new Cable('cable-3');
    newCable.connect(pc1.getPort('eth0')!, sw.getPort('FastEthernet0/0')!);

    const reconnected = await pc1.executeCommand('ping -c 1 192.168.1.20');
    expect(reconnected).toContain('1 received');
    expect(reconnected).toContain('0% packet loss');
  });

  // ─── POWER OFF ─────────────────────────────────────────────────

  it('should fail ping when target is powered off', async () => {
    const { pc1, pc2 } = setupLAN();

    await pc1.executeCommand('ifconfig eth0 192.168.1.10');
    await pc2.executeCommand('ifconfig eth0 192.168.1.20');

    const before = await pc1.executeCommand('ping -c 1 192.168.1.20');
    expect(before).toContain('1 received');

    pc2.powerOff();

    const after = await pc1.executeCommand('ping -c 1 192.168.1.20');
    expect(after).toContain('100% packet loss');
  });

  it('should fail ping when switch is powered off', async () => {
    const { pc1, pc2, sw } = setupLAN();

    await pc1.executeCommand('ifconfig eth0 192.168.1.10');
    await pc2.executeCommand('ifconfig eth0 192.168.1.20');

    const before = await pc1.executeCommand('ping -c 1 192.168.1.20');
    expect(before).toContain('1 received');

    sw.powerOff();

    const after = await pc1.executeCommand('ping -c 1 192.168.1.20');
    expect(after).toContain('100% packet loss');
  });

  it('should recover ping after power back on', async () => {
    const { pc1, pc2 } = setupLAN();

    await pc1.executeCommand('ifconfig eth0 192.168.1.10');
    await pc2.executeCommand('ifconfig eth0 192.168.1.20');

    pc2.powerOff();
    const off = await pc1.executeCommand('ping -c 1 192.168.1.20');
    expect(off).toContain('100% packet loss');

    pc2.powerOn();
    const on = await pc1.executeCommand('ping -c 1 192.168.1.20');
    expect(on).toContain('1 received');
  });

  // ─── DIRECT CONNECTION (no switch) ─────────────────────────────

  it('should ping between two directly connected PCs', async () => {
    const pc1 = new LinuxPC('PC1');
    const pc2 = new LinuxPC('PC2');

    const cable = new Cable('cable-1');
    cable.connect(pc1.getPort('eth0')!, pc2.getPort('eth0')!);

    await pc1.executeCommand('ifconfig eth0 10.0.0.1');
    await pc2.executeCommand('ifconfig eth0 10.0.0.2');

    const result = await pc1.executeCommand('ping -c 1 10.0.0.2');
    expect(result).toContain('1 received');
    expect(result).toContain('0% packet loss');
  });

  it('should fail ping on direct connection after cable disconnect', async () => {
    const pc1 = new LinuxPC('PC1');
    const pc2 = new LinuxPC('PC2');

    const cable = new Cable('cable-1');
    cable.connect(pc1.getPort('eth0')!, pc2.getPort('eth0')!);

    await pc1.executeCommand('ifconfig eth0 10.0.0.1');
    await pc2.executeCommand('ifconfig eth0 10.0.0.2');

    const before = await pc1.executeCommand('ping -c 1 10.0.0.2');
    expect(before).toContain('1 received');

    cable.disconnect();

    const after = await pc1.executeCommand('ping -c 1 10.0.0.2');
    expect(after).toContain('100% packet loss');
  });

  // ─── HUB ───────────────────────────────────────────────────────

  it('should ping through a Hub', async () => {
    const pc1 = new LinuxPC('PC1');
    const pc2 = new LinuxPC('PC2');
    const hub = new Hub('Hub1', 8);

    const cable1 = new Cable('cable-1');
    cable1.connect(pc1.getPort('eth0')!, hub.getPort('eth0')!);

    const cable2 = new Cable('cable-2');
    cable2.connect(pc2.getPort('eth0')!, hub.getPort('eth1')!);

    await pc1.executeCommand('ifconfig eth0 172.16.0.1');
    await pc2.executeCommand('ifconfig eth0 172.16.0.2');

    const result = await pc1.executeCommand('ping -c 1 172.16.0.2');
    expect(result).toContain('1 received');
    expect(result).toContain('0% packet loss');
  });

  // ─── WINDOWS PC ────────────────────────────────────────────────

  it('should ping between Linux PC and Windows PC', async () => {
    const linux = new LinuxPC('Linux1');
    const win = new WindowsPC('Win1');
    const sw = new CiscoSwitch('switch-cisco', 'Sw1', 8);

    const cable1 = new Cable('cable-1');
    cable1.connect(linux.getPort('eth0')!, sw.getPort('FastEthernet0/0')!);

    const cable2 = new Cable('cable-2');
    cable2.connect(win.getPort('eth0')!, sw.getPort('FastEthernet0/1')!);

    await linux.executeCommand('ifconfig eth0 192.168.1.10');
    await win.executeCommand('netsh interface ip set address "Ethernet0" static 192.168.1.20 255.255.255.0');

    const result = await linux.executeCommand('ping -c 1 192.168.1.20');
    expect(result).toContain('1 received');
    expect(result).not.toContain('100% packet loss');
  });

  // ─── THREE PCs ─────────────────────────────────────────────────

  it('should ping across three PCs on the same LAN', async () => {
    const pc1 = new LinuxPC('PC1');
    const pc2 = new LinuxPC('PC2');
    const pc3 = new LinuxPC('PC3');
    const sw = new CiscoSwitch('switch-cisco', 'Sw1', 24);

    new Cable('c1').connect(pc1.getPort('eth0')!, sw.getPort('FastEthernet0/0')!);
    new Cable('c2').connect(pc2.getPort('eth0')!, sw.getPort('FastEthernet0/1')!);
    new Cable('c3').connect(pc3.getPort('eth0')!, sw.getPort('FastEthernet0/2')!);

    await pc1.executeCommand('ifconfig eth0 192.168.1.1');
    await pc2.executeCommand('ifconfig eth0 192.168.1.2');
    await pc3.executeCommand('ifconfig eth0 192.168.1.3');

    const ping12 = await pc1.executeCommand('ping -c 1 192.168.1.2');
    expect(ping12).toContain('1 received');

    const ping13 = await pc1.executeCommand('ping -c 1 192.168.1.3');
    expect(ping13).toContain('1 received');

    const ping32 = await pc3.executeCommand('ping -c 1 192.168.1.2');
    expect(ping32).toContain('1 received');
  });

  // ─── SWITCH MAC TABLE ──────────────────────────────────────────

  it('should learn MAC addresses in switch MAC table', async () => {
    const { pc1, pc2, sw } = setupLAN();

    await pc1.executeCommand('ifconfig eth0 192.168.1.10');
    await pc2.executeCommand('ifconfig eth0 192.168.1.20');

    // Before ping, MAC table should be empty
    expect(sw.getMACTable().length).toBe(0);

    await pc1.executeCommand('ping -c 1 192.168.1.20');

    // After ping, switch should have learned both MACs
    const macTable = sw.getMACTable();
    expect(macTable.length).toBeGreaterThanOrEqual(2);
  });

  // ─── SELF PING ─────────────────────────────────────────────────

  it('should ping itself (loopback)', async () => {
    const pc1 = new LinuxPC('PC1');
    await pc1.executeCommand('ifconfig eth0 192.168.1.10');

    const result = await pc1.executeCommand('ping -c 1 192.168.1.10');
    expect(result).toContain('1 received');
    expect(result).toContain('0% packet loss');
  });

  // ─── TRACEROUTE ────────────────────────────────────────────────

  it('should traceroute through switch', async () => {
    const { pc1, pc2 } = setupLAN();

    await pc1.executeCommand('ifconfig eth0 192.168.1.10');
    await pc2.executeCommand('ifconfig eth0 192.168.1.20');

    const result = await pc1.executeCommand('traceroute 192.168.1.20');
    expect(result).toContain('traceroute to 192.168.1.20');
    expect(result).toContain('192.168.1.20');
    expect(result).not.toContain('* * *');
  });

  // ─── LOGGER ────────────────────────────────────────────────────

  it('should emit log events during ping', async () => {
    const { pc1, pc2 } = setupLAN();

    await pc1.executeCommand('ifconfig eth0 192.168.1.10');
    await pc2.executeCommand('ifconfig eth0 192.168.1.20');

    const logs: string[] = [];
    Logger.subscribe((log) => { logs.push(`${log.event}: ${log.message}`); });

    await pc1.executeCommand('ping -c 1 192.168.1.20');

    // Should have logged frame sends and receives
    expect(logs.length).toBeGreaterThan(0);
    expect(logs.some(l => l.includes('port:send'))).toBe(true);
  });
});
