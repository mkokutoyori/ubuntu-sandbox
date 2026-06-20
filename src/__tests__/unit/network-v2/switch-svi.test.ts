/**
 * Cisco L2 switch — SVI (Switched Virtual Interface) management plane.
 *
 * Validates that a Layer-2 switch's in-band management really travels over the
 * cable through its own L2 forwarding: SVI addressing, ARP, ICMP echo, echo
 * reply, and admin-state gating — exactly as a connected host would behave.
 */
import { describe, it, expect } from 'vitest';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';

function lan() {
  const sw = new CiscoSwitch('sw1', 'Switch', 24, 0, 0);
  const pc = new LinuxPC('PC1', 0, 0);
  const cable = new Cable('c1');
  cable.connect(pc.getPort('eth0')!, sw.getPort('FastEthernet0/2')!);
  return { sw, pc, cable };
}

async function configureSvi(sw: CiscoSwitch, ip = '10.0.0.100') {
  await sw.executeCommand('enable');
  await sw.executeCommand('configure terminal');
  await sw.executeCommand('interface Vlan1');
  await sw.executeCommand(`ip address ${ip} 255.255.255.0`);
  await sw.executeCommand('no shutdown');
  await sw.executeCommand('end');
}

describe('Switch SVI management plane', () => {
  it('configures an SVI IP and surfaces it in show ip interface brief', async () => {
    const { sw } = lan();
    await configureSvi(sw);
    const brief = await sw.executeCommand('show ip interface brief');
    expect(brief).toContain('Vlan1');
    expect(brief).toContain('10.0.0.100');
  });

  it('pings a connected host over the cable (real ARP + ICMP round-trip)', async () => {
    const { sw, pc } = lan();
    await configureSvi(sw);
    await pc.executeCommand('ifconfig eth0 10.0.0.1 netmask 255.255.255.0');

    const out = await sw.executeCommand('ping 10.0.0.1');
    expect(out).toContain('Success rate is 100 percent');
    // The reply genuinely traversed the wire, so the peer MAC is now learned.
    const arp = await sw.executeCommand('show ip arp');
    expect(arp).toContain('10.0.0.1');
  });

  it('answers ICMP echo from a connected host to the SVI address', async () => {
    const { sw, pc } = lan();
    await configureSvi(sw);
    await pc.executeCommand('ifconfig eth0 10.0.0.1 netmask 255.255.255.0');

    const out = await pc.executeCommand('ping -c 1 10.0.0.100');
    expect(out.toLowerCase()).toContain('bytes from');
  });

  it('reports 0% success when the target is unreachable', async () => {
    const { sw } = lan();
    await configureSvi(sw);
    const out = await sw.executeCommand('ping 10.0.0.99');
    expect(out).toContain('Success rate is 0 percent');
  });

  it('honours repeat and renders the matching probe count', async () => {
    const { sw, pc } = lan();
    await configureSvi(sw);
    await pc.executeCommand('ifconfig eth0 10.0.0.1 netmask 255.255.255.0');
    const out = await sw.executeCommand('ping 10.0.0.1 repeat 3');
    expect(out).toContain('(3/3)');
  });

  it('does not answer when the SVI is administratively down', async () => {
    const { sw, pc } = lan();
    await sw.executeCommand('enable');
    await sw.executeCommand('configure terminal');
    await sw.executeCommand('interface Vlan1');
    await sw.executeCommand('ip address 10.0.0.100 255.255.255.0');
    await sw.executeCommand('shutdown');
    await sw.executeCommand('end');
    await pc.executeCommand('ifconfig eth0 10.0.0.1 netmask 255.255.255.0');

    const out = await pc.executeCommand('ping -c 1 10.0.0.100');
    expect(out.toLowerCase()).not.toContain('bytes from');
  });

  it('rejects speed/duplex on a virtual SVI (physical-only commands)', async () => {
    const { sw } = lan();
    await sw.executeCommand('enable');
    await sw.executeCommand('configure terminal');
    await sw.executeCommand('interface Vlan1');
    expect((await sw.executeCommand('speed 100')).toLowerCase()).toContain('%');
    expect((await sw.executeCommand('duplex full')).toLowerCase()).toContain('%');
  });

  it('rejects an out-of-range SVI VLAN id', async () => {
    const { sw } = lan();
    await sw.executeCommand('enable');
    await sw.executeCommand('configure terminal');
    expect((await sw.executeCommand('interface Vlan9999')).toLowerCase()).toContain('%');
  });
});
