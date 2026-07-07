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

describe('ip netns (PRD-ip.md P7, PRD completion)', () => {
  it('ip netns add creates a real namespace visible in ip netns list', async () => {
    const pc = new LinuxPC('PC1', 0, 0);
    const addOut = await pc.executeCommand('ip netns add ns1');
    expect(addOut).toBe('');
    const list = await pc.executeCommand('ip netns list');
    expect(list).toContain('ns1');
  });

  it('ip netns add on an existing name fails with a real error', async () => {
    const pc = new LinuxPC('PC1', 0, 0);
    await pc.executeCommand('ip netns add ns1');
    const output = await pc.executeCommand('ip netns add ns1');
    expect(output).toContain('File exists');
  });

  it('ip netns delete removes a namespace', async () => {
    const pc = new LinuxPC('PC1', 0, 0);
    await pc.executeCommand('ip netns add ns1');
    const delOut = await pc.executeCommand('ip netns delete ns1');
    expect(delOut).toBe('');
    const list = await pc.executeCommand('ip netns list');
    expect(list).not.toContain('ns1');
  });

  it('ip netns delete on a nonexistent namespace fails with a real error', async () => {
    const pc = new LinuxPC('PC1', 0, 0);
    const output = await pc.executeCommand('ip netns delete does-not-exist');
    expect(output).toContain('No such file or directory');
  });

  it('ip netns exec runs a real command whose routing table is isolated from the default namespace', async () => {
    const pc = new LinuxPC('PC1', 0, 0);
    await pc.executeCommand('ifconfig eth0 10.0.0.1 netmask 255.255.255.0');
    await pc.executeCommand('ip netns add ns1');

    // Namespace ns1 gets a route the default namespace never sees.
    const inNsAdd = await pc.executeCommand('ip netns exec ns1 ip route add 172.20.0.0/16 via 10.0.0.254');
    expect(inNsAdd.trim()).toBe('');

    const defaultShow = await pc.executeCommand('ip route show');
    expect(defaultShow).not.toContain('172.20.0.0/16');

    const nsShow = await pc.executeCommand('ip netns exec ns1 ip route show');
    expect(nsShow).toContain('172.20.0.0/16 via 10.0.0.254');
  });

  it('two namespaces have fully independent routing tables from each other', async () => {
    const pc = new LinuxPC('PC1', 0, 0);
    await pc.executeCommand('ifconfig eth0 10.0.0.1 netmask 255.255.255.0');
    await pc.executeCommand('ip netns add ns1');
    await pc.executeCommand('ip netns add ns2');

    await pc.executeCommand('ip netns exec ns1 ip route add 192.168.10.0/24 via 10.0.0.253');
    await pc.executeCommand('ip netns exec ns2 ip route add 192.168.20.0/24 via 10.0.0.252');

    const ns1Show = await pc.executeCommand('ip netns exec ns1 ip route show');
    expect(ns1Show).toContain('192.168.10.0/24');
    expect(ns1Show).not.toContain('192.168.20.0/24');

    const ns2Show = await pc.executeCommand('ip netns exec ns2 ip route show');
    expect(ns2Show).toContain('192.168.20.0/24');
    expect(ns2Show).not.toContain('192.168.10.0/24');
  });

  it('a namespace\'s state survives across separate ip netns exec invocations', async () => {
    const pc = new LinuxPC('PC1', 0, 0);
    await pc.executeCommand('ifconfig eth0 10.0.0.1 netmask 255.255.255.0');
    await pc.executeCommand('ip netns add ns1');
    await pc.executeCommand('ip netns exec ns1 ip route add 10.5.0.0/16 via 10.0.0.254');

    const secondCall = await pc.executeCommand('ip netns exec ns1 ip route show');
    expect(secondCall).toContain('10.5.0.0/16');
  });

  it('ip netns exec on a nonexistent namespace fails with a real error', async () => {
    const pc = new LinuxPC('PC1', 0, 0);
    const output = await pc.executeCommand('ip netns exec does-not-exist ip route show');
    expect(output).toContain('No such file or directory');
  });

  it('exec inside a namespace never leaks into the default namespace\'s own routing table', async () => {
    const pc = new LinuxPC('PC1', 0, 0);
    await pc.executeCommand('ifconfig eth0 10.0.0.1 netmask 255.255.255.0');
    await pc.executeCommand('ip route add 203.0.113.0/24 via 10.0.0.1');
    await pc.executeCommand('ip netns add ns1');
    await pc.executeCommand('ip netns exec ns1 ip route add 198.51.100.0/24 via 10.0.0.254');

    const defaultShow = await pc.executeCommand('ip route show');
    expect(defaultShow).toContain('203.0.113.0/24');
    expect(defaultShow).not.toContain('198.51.100.0/24');
  });
});
