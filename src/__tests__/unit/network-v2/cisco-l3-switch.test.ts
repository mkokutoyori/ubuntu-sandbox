/**
 * Cisco L3 switch — inter-VLAN routing on SVIs + integrated DHCP server.
 *
 * Mirror of huawei-l3-switch.test.ts but driven through Cisco IOS
 * commands (interface Vlan N / ip address / ip routing / ip dhcp pool
 * / show ip route / show arp), so the same "collapsed core" deployment
 * works identically on Cisco hardware.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

beforeEach(() => {
  resetCounters();
  MACAddress.resetCounter();
  resetDeviceCounters();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

async function buildInterVlanLan() {
  const sw = new CiscoSwitch('cs', 'L3SW', 24, 0, 0);
  const pc1 = new LinuxPC('pc1', 'PC1', 0, 0);
  const pc2 = new LinuxPC('pc2', 'PC2', 0, 0);

  new Cable('c1').connect(pc1.getPorts()[0], sw.getPort('FastEthernet0/1')!);
  new Cable('c2').connect(pc2.getPorts()[0], sw.getPort('FastEthernet0/2')!);

  pc1.getPorts()[0].configureIP(new IPAddress('10.0.10.10'), new SubnetMask('255.255.255.0'));
  pc2.getPorts()[0].configureIP(new IPAddress('10.0.20.10'), new SubnetMask('255.255.255.0'));
  pc1.setDefaultGateway(new IPAddress('10.0.10.1'));
  pc2.setDefaultGateway(new IPAddress('10.0.20.1'));

  for (const cmd of [
    'enable', 'configure terminal',
    'ip routing',
    'vlan 10', 'exit',
    'vlan 20', 'exit',
    'interface FastEthernet0/1', 'switchport mode access', 'switchport access vlan 10', 'exit',
    'interface FastEthernet0/2', 'switchport mode access', 'switchport access vlan 20', 'exit',
    'interface Vlan10', 'ip address 10.0.10.1 255.255.255.0', 'no shutdown', 'exit',
    'interface Vlan20', 'ip address 10.0.20.1 255.255.255.0', 'no shutdown', 'exit',
    'end',
  ]) await sw.executeCommand(cmd);

  return { sw, pc1, pc2 };
}

describe('Cisco L3 switch — inter-VLAN routing', () => {
  it('show ip interface brief liste les SVI Vlan10/Vlan20 up/up', async () => {
    const { sw } = await buildInterVlanLan();
    const out = await sw.executeCommand('show ip interface brief');
    expect(out).toMatch(/Vlan10\s+10\.0\.10\.1\s+YES\s+manual\s+up\s+up/);
    expect(out).toMatch(/Vlan20\s+10\.0\.20\.1\s+YES\s+manual\s+up\s+up/);
  });

  it('show ip route montre les deux sous-réseaux comme directly connected', async () => {
    const { sw } = await buildInterVlanLan();
    const out = await sw.executeCommand('show ip route');
    expect(out).toMatch(/C\s+10\.0\.10\.0\/24.*Vlan10/);
    expect(out).toMatch(/C\s+10\.0\.20\.0\/24.*Vlan20/);
  });

  it('PC1 (VLAN 10) ping sa SVI passerelle 10.0.10.1', async () => {
    const { pc1 } = await buildInterVlanLan();
    const out = await pc1.executeCommand('ping -c 1 10.0.10.1');
    expect(out).toMatch(/64 bytes from 10\.0\.10\.1/);
  });

  it('PC1 (VLAN 10) ↔ PC2 (VLAN 20) : inter-VLAN routing via le switch', async () => {
    const { pc1 } = await buildInterVlanLan();
    const out = await pc1.executeCommand('ping -c 3 10.0.20.10');
    expect(out).toMatch(/64 bytes from 10\.0\.20\.10/);
    expect(out).toMatch(/3 packets transmitted, 3 received/);
  });

  it('PC2 (VLAN 20) ping PC1 (VLAN 10) : routage symétrique', async () => {
    const { pc2 } = await buildInterVlanLan();
    const out = await pc2.executeCommand('ping -c 3 10.0.10.10');
    expect(out).toMatch(/64 bytes from 10\.0\.10\.10/);
  });

  it('show arp liste les voisins appris après un ping inter-VLAN', async () => {
    const { sw, pc1 } = await buildInterVlanLan();
    await pc1.executeCommand('ping -c 1 10.0.20.10');
    const out = await sw.executeCommand('show arp');
    expect(out).toMatch(/10\.0\.10\.10/);
    expect(out).toMatch(/10\.0\.20\.10/);
  });

  it('shutdown sur Vlan20 : PC1 ne joint plus PC2', async () => {
    const { sw, pc1 } = await buildInterVlanLan();
    for (const cmd of [
      'enable', 'configure terminal', 'interface Vlan20', 'shutdown', 'end',
    ]) await sw.executeCommand(cmd);
    const out = await pc1.executeCommand('ping -c 2 10.0.20.10');
    expect(out).toMatch(/100% packet loss/);
  });

  it('ip route 0.0.0.0 0.0.0.0 <gw> : route par défaut apparaît dans show ip route', async () => {
    const { sw } = await buildInterVlanLan();
    for (const cmd of [
      'enable', 'configure terminal', 'ip route 0.0.0.0 0.0.0.0 10.0.20.99', 'end',
    ]) await sw.executeCommand(cmd);
    const out = await sw.executeCommand('show ip route');
    expect(out).toMatch(/S\*?\s+0\.0\.0\.0\/0.*10\.0\.20\.99/);
  });
});

describe('Cisco L3 switch — serveur DHCP intégré', () => {
  async function buildDhcpLan() {
    const sw = new CiscoSwitch('cs', 'L3SW', 24, 0, 0);
    const pc1 = new LinuxPC('pc1', 'PC1', 0, 0);
    const pc2 = new LinuxPC('pc2', 'PC2', 0, 0);
    new Cable('c1').connect(pc1.getPorts()[0], sw.getPort('FastEthernet0/1')!);
    new Cable('c2').connect(pc2.getPorts()[0], sw.getPort('FastEthernet0/2')!);

    for (const cmd of [
      'enable', 'configure terminal',
      'ip routing',
      'vlan 10', 'exit',
      'interface FastEthernet0/1', 'switchport mode access', 'switchport access vlan 10', 'exit',
      'interface FastEthernet0/2', 'switchport mode access', 'switchport access vlan 10', 'exit',
      'interface Vlan10', 'ip address 10.0.10.1 255.255.255.0', 'no shutdown', 'exit',
      'ip dhcp excluded-address 10.0.10.1 10.0.10.99',
      'ip dhcp pool LAN10',
      'network 10.0.10.0 255.255.255.0',
      'default-router 10.0.10.1',
      'dns-server 8.8.8.8 1.1.1.1',
      'lease 1',
      'exit',
      'end',
    ]) await sw.executeCommand(cmd);

    return { sw, pc1, pc2 };
  }

  it('PC1 dhclient -v eth0 : DORA complet via le switch', async () => {
    const { pc1 } = await buildDhcpLan();
    const out = await pc1.executeCommand('dhclient -v eth0');
    expect(out).toMatch(/DHCPDISCOVER/);
    expect(out).toMatch(/DHCPOFFER of 10\.0\.10\.\d+/);
    expect(out).toMatch(/DHCPACK of 10\.0\.10\.\d+/);
    expect(out).toMatch(/bound to 10\.0\.10\.\d+/);
  });

  it('PC1 reçoit une IP dans la plage non exclue (>= .100)', async () => {
    const { pc1 } = await buildDhcpLan();
    await pc1.executeCommand('dhclient eth0');
    const out = await pc1.executeCommand('ip addr show eth0');
    const m = /inet (10\.0\.10\.\d+)/.exec(out);
    expect(m).not.toBeNull();
    const octet = parseInt(m![1].split('.')[3], 10);
    expect(octet).toBeGreaterThanOrEqual(100);
  });

  it('show ip dhcp binding liste les baux distribués', async () => {
    const { sw, pc1, pc2 } = await buildDhcpLan();
    await pc1.executeCommand('dhclient eth0');
    await pc2.executeCommand('dhclient eth0');
    const out = await sw.executeCommand('show ip dhcp binding');
    const leases = (out.match(/10\.0\.10\.1\d{2}/g) ?? []);
    expect(leases.length).toBeGreaterThanOrEqual(2);
  });

  it('PC1 et PC2 (tous deux en DHCP) communiquent dans le même VLAN', async () => {
    const { pc1, pc2 } = await buildDhcpLan();
    await pc1.executeCommand('dhclient eth0');
    await pc2.executeCommand('dhclient eth0');
    const ip2 = /inet (10\.0\.10\.\d+)/.exec(await pc2.executeCommand('ip addr show eth0'))![1];
    const out = await pc1.executeCommand(`ping -c 2 ${ip2}`);
    expect(out).toMatch(/2 packets transmitted, 2 received/);
  });
});
