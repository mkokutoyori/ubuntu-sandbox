import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { MACAddress, resetCounters } from '@/network/core/types';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

beforeEach(() => {
  EquipmentRegistry.resetInstance();
  resetCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

describe('ip addr/route change|replace|append and -o[neline] (PRD-ip.md P2)', () => {
  it('ip addr add on an existing address fails with "File exists"', async () => {
    const pc = new LinuxPC('PC1', 0, 0);
    await pc.executeCommand('ip addr add 10.0.0.1/24 dev eth0');
    const output = await pc.executeCommand('ip addr add 10.0.0.1/24 dev eth0');
    expect(output).toContain('RTNETLINK answers: File exists');
  });

  it('ip addr replace on an existing address does not fail and updates the prefix', async () => {
    const pc = new LinuxPC('PC1', 0, 0);
    await pc.executeCommand('ip addr add 10.0.0.1/24 dev eth0');
    const output = await pc.executeCommand('ip addr replace 10.0.0.1/16 dev eth0');
    expect(output).not.toContain('File exists');
    const show = await pc.executeCommand('ip addr show dev eth0');
    expect(show).toContain('10.0.0.1/16');
  });

  it('ip addr replace on a brand-new address creates it (create-or-replace semantics)', async () => {
    const pc = new LinuxPC('PC1', 0, 0);
    const output = await pc.executeCommand('ip addr replace 10.0.0.5/24 dev eth0');
    expect(output).not.toContain('File exists');
    const show = await pc.executeCommand('ip addr show dev eth0');
    expect(show).toContain('10.0.0.5/24');
  });

  it('ip addr change on a nonexistent address fails (no create)', async () => {
    const pc = new LinuxPC('PC1', 0, 0);
    const output = await pc.executeCommand('ip addr change 10.0.0.9/24 dev eth0');
    expect(output).toContain('RTNETLINK answers: Cannot assign requested address');
    const show = await pc.executeCommand('ip addr show dev eth0');
    expect(show).not.toContain('10.0.0.9');
  });

  it('ip addr change on an existing address updates the prefix in place', async () => {
    const pc = new LinuxPC('PC1', 0, 0);
    await pc.executeCommand('ip addr add 10.0.0.1/24 dev eth0');
    const output = await pc.executeCommand('ip addr change 10.0.0.1/8 dev eth0');
    expect(output).not.toContain('Cannot assign requested address');
    const show = await pc.executeCommand('ip addr show dev eth0');
    expect(show).toContain('10.0.0.1/8');
  });

  it('ip route add on a duplicate exact route fails with "File exists"', async () => {
    const pc = new LinuxPC('PC1', 0, 0);
    await pc.executeCommand('ip addr add 10.0.0.1/24 dev eth0');
    await pc.executeCommand('ip route add 192.168.5.0/24 via 10.0.0.254');
    const output = await pc.executeCommand('ip route add 192.168.5.0/24 via 10.0.0.254');
    expect(output).toContain('RTNETLINK answers: File exists');
  });

  it('ip route replace on an existing prefix removes the old route and installs the new one', async () => {
    const pc = new LinuxPC('PC1', 0, 0);
    await pc.executeCommand('ip addr add 10.0.0.1/24 dev eth0');
    await pc.executeCommand('ip route add 192.168.5.0/24 via 10.0.0.254');
    const output = await pc.executeCommand('ip route replace 192.168.5.0/24 via 10.0.0.253');
    expect(output).not.toContain('File exists');
    const show = await pc.executeCommand('ip route show');
    expect(show).toContain('192.168.5.0/24 via 10.0.0.253');
    expect(show).not.toContain('192.168.5.0/24 via 10.0.0.254');
  });

  it('ip route change on a nonexistent prefix fails (no create)', async () => {
    const pc = new LinuxPC('PC1', 0, 0);
    await pc.executeCommand('ip addr add 10.0.0.1/24 dev eth0');
    const output = await pc.executeCommand('ip route change 172.16.0.0/16 via 10.0.0.254');
    expect(output).toContain('RTNETLINK answers: No such process');
  });

  it('ip route append adds a second route to the same prefix without failing (ECMP-like)', async () => {
    const pc = new LinuxPC('PC1', 0, 0);
    await pc.executeCommand('ip addr add 10.0.0.1/24 dev eth0');
    await pc.executeCommand('ip route add 192.168.5.0/24 via 10.0.0.254 metric 10');
    const output = await pc.executeCommand('ip route append 192.168.5.0/24 via 10.0.0.253 metric 20');
    expect(output).not.toContain('File exists');
    const show = await pc.executeCommand('ip route show');
    expect(show).toContain('192.168.5.0/24 via 10.0.0.254');
    expect(show).toContain('192.168.5.0/24 via 10.0.0.253');
  });

  it('ip -o addr show renders each interface as a single line', async () => {
    const pc = new LinuxPC('PC1', 0, 0);
    await pc.executeCommand('ip addr add 10.0.0.1/24 dev eth0');
    const output = await pc.executeCommand('ip -o addr show');
    const nonEmptyLines = output.split('\n').filter(l => l.trim() !== '');
    for (const line of nonEmptyLines) {
      expect(line).toMatch(/^\d+: /);
    }
    expect(output).toContain('inet 10.0.0.1/24');
  });

  it('ip -o link show renders each interface as a single line', async () => {
    const pc = new LinuxPC('PC1', 0, 0);
    const output = await pc.executeCommand('ip -o link show');
    const lines = output.split('\n').filter(l => l.trim() !== '');
    expect(lines.length).toBeGreaterThanOrEqual(2);
    for (const line of lines) {
      expect(line).toMatch(/^\d+: .*link\/(ether|loopback)/);
    }
  });
});

describe('ip addr change|replace via a LAN with a real duplicate-secondary scenario', () => {
  it('ip addr replace on an existing secondary IP updates its prefix without duplicating it', async () => {
    const pc1 = new LinuxPC('PC1', 0, 0);
    const pc2 = new LinuxPC('PC2', 100, 0);
    const sw = new CiscoSwitch('sw-change-replace', 'SW1', 24, 50, 50);
    new Cable('c1').connect(pc1.getPort('eth0')!, sw.getPort('FastEthernet0/1')!);
    new Cable('c2').connect(pc2.getPort('eth0')!, sw.getPort('FastEthernet0/2')!);

    await pc1.executeCommand('ip addr add 10.0.0.1/24 dev eth0');
    await pc1.executeCommand('ip addr add 10.0.0.2/24 dev eth0');
    const replaceOut = await pc1.executeCommand('ip addr replace 10.0.0.2/16 dev eth0');
    expect(replaceOut).not.toContain('File exists');

    const show = await pc1.executeCommand('ip addr show dev eth0');
    const secondaryMatches = show.match(/10\.0\.0\.2\/\d+/g) ?? [];
    expect(secondaryMatches.length).toBe(1);
    expect(show).toContain('10.0.0.2/16');
  });
});
