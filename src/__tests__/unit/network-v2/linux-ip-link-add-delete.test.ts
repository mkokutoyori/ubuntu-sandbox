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

describe('ip link add/delete: dummy, veth, vlan (PRD-ip.md P5)', () => {
  it('ip link add type dummy creates a real, always-up interface usable by ip addr', async () => {
    const pc = new LinuxPC('PC1', 0, 0);
    const addOut = await pc.executeCommand('ip link add dummy0 type dummy');
    expect(addOut).toBe('');

    const linkShow = await pc.executeCommand('ip link show dummy0');
    expect(linkShow).toContain('dummy0');
    expect(linkShow).toContain('UP');

    const addrAdd = await pc.executeCommand('ip addr add 172.16.0.1/24 dev dummy0');
    expect(addrAdd).toBe('');
    const addrShow = await pc.executeCommand('ip addr show dummy0');
    expect(addrShow).toContain('172.16.0.1/24');
  });

  it('ip link add type dummy on an existing name fails with a real RTNETLINK error', async () => {
    const pc = new LinuxPC('PC1', 0, 0);
    await pc.executeCommand('ip link add dummy0 type dummy');
    const output = await pc.executeCommand('ip link add dummy0 type dummy');
    expect(output).toContain('RTNETLINK answers: File exists');
  });

  it('ip link delete removes a dummy interface previously created via ip link add', async () => {
    const pc = new LinuxPC('PC1', 0, 0);
    await pc.executeCommand('ip link add dummy0 type dummy');
    const delOut = await pc.executeCommand('ip link delete dummy0');
    expect(delOut).toBe('');
    const show = await pc.executeCommand('ip link show dummy0');
    expect(show).toContain('does not exist');
  });

  it('ip link delete refuses to remove a real, profile-provisioned NIC', async () => {
    const pc = new LinuxPC('PC1', 0, 0);
    const output = await pc.executeCommand('ip link delete eth0');
    expect(output).toContain('RTNETLINK answers: Operation not permitted');
    const show = await pc.executeCommand('ip link show eth0');
    expect(show).toContain('eth0');
  });

  it('ip link add type veth creates a real connected pair: frames sent on one arrive on the other', async () => {
    const pc = new LinuxPC('PC1', 0, 0);
    const addOut = await pc.executeCommand('ip link add veth0 type veth peer name veth1');
    expect(addOut).toBe('');

    await pc.executeCommand('ip addr add 10.99.0.1/30 dev veth0');
    await pc.executeCommand('ip addr add 10.99.0.2/30 dev veth1');
    await pc.executeCommand('ip link set veth0 up');
    await pc.executeCommand('ip link set veth1 up');

    const ping = await pc.executeCommand('ping -c 1 10.99.0.2');
    expect(ping).toContain('1 packets transmitted, 1 received');
  });

  it('ip link add type vlan creates a real 802.1Q sub-interface usable with ip addr, sharing the parent MAC', async () => {
    const pc = new LinuxPC('PC1', 0, 0);
    await pc.executeCommand('ifconfig eth0 10.0.0.1 netmask 255.255.255.0');

    const addOut = await pc.executeCommand('ip link add link eth0 name eth0.100 type vlan id 100');
    expect(addOut).toBe('');

    const linkShow = await pc.executeCommand('ip link show eth0.100');
    expect(linkShow).toContain('eth0.100');

    const eth0Show = await pc.executeCommand('ip link show eth0');
    const parentMac = eth0Show.match(/link\/ether ([0-9a-f:]+)/)?.[1];
    const subMac = linkShow.match(/link\/ether ([0-9a-f:]+)/)?.[1];
    expect(subMac).toBe(parentMac);

    const addrAdd = await pc.executeCommand('ip addr add 192.168.100.1/24 dev eth0.100');
    expect(addrAdd).toBe('');
    const addrShow = await pc.executeCommand('ip addr show eth0.100');
    expect(addrShow).toContain('192.168.100.1/24');
  });

  it('ip link add vlan without "link DEV" fails with a real usage error', async () => {
    const pc = new LinuxPC('PC1', 0, 0);
    const output = await pc.executeCommand('ip link add name eth0.100 type vlan id 100');
    expect(output).toContain('vlan requires "link DEV"');
  });

  it('ip link add veth without "peer name" fails with a real usage error', async () => {
    const pc = new LinuxPC('PC1', 0, 0);
    const output = await pc.executeCommand('ip link add veth0 type veth');
    expect(output).toContain('veth requires "peer name');
  });
});
