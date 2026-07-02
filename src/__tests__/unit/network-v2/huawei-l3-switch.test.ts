/**
 * Huawei L3 switch — inter-VLAN routing through SVIs (Vlanif).
 *
 * Real-world scenario : un seul switch Huawei agit comme passerelle
 * pour deux VLANs (10 et 20). Deux PC Linux, chacun dans un VLAN
 * différent, doivent pouvoir se joindre grâce au routage par SVI.
 * C'est l'essence du « L3 switching » : faire du routage sans avoir
 * besoin d'un routeur séparé.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { HuaweiSwitch } from '@/network/devices/HuaweiSwitch';
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

async function buildLan() {
  const sw = new HuaweiSwitch('hw-sw', 'L3SW', 8, 0, 0);
  const pc1 = new LinuxPC('pc1', 'PC1', 0, 0);
  const pc2 = new LinuxPC('pc2', 'PC2', 0, 0);

  new Cable('c1').connect(pc1.getPorts()[0], sw.getPort('GigabitEthernet0/0/1')!);
  new Cable('c2').connect(pc2.getPorts()[0], sw.getPort('GigabitEthernet0/0/2')!);

  // VLAN 10 → 10.0.10.0/24 (PC1)
  // VLAN 20 → 10.0.20.0/24 (PC2)
  pc1.getPorts()[0].configureIP(new IPAddress('10.0.10.10'), new SubnetMask('255.255.255.0'));
  pc2.getPorts()[0].configureIP(new IPAddress('10.0.20.10'), new SubnetMask('255.255.255.0'));
  pc1.setDefaultGateway(new IPAddress('10.0.10.1'));
  pc2.setDefaultGateway(new IPAddress('10.0.20.1'));

  for (const cmd of [
    'system-view',
    'vlan batch 10 20',
    'interface GigabitEthernet0/0/1', 'port link-type access', 'port default vlan 10', 'quit',
    'interface GigabitEthernet0/0/2', 'port link-type access', 'port default vlan 20', 'quit',
    'interface Vlanif10', 'ip address 10.0.10.1 255.255.255.0', 'undo shutdown', 'quit',
    'interface Vlanif20', 'ip address 10.0.20.1 255.255.255.0', 'undo shutdown', 'quit',
    'quit',
  ]) await sw.executeCommand(cmd);

  return { sw, pc1, pc2 };
}

describe('Huawei L3 switch — inter-VLAN routing', () => {
  it('display ip routing-table montre les deux sous-réseaux connectés', async () => {
    const { sw } = await buildLan();
    const out = await sw.executeCommand('display ip routing-table');
    expect(out).toMatch(/10\.0\.10\.0\/24.*Direct.*Vlanif10/);
    expect(out).toMatch(/10\.0\.20\.0\/24.*Direct.*Vlanif20/);
  });

  it('display interface Vlanif10 montre l\'IP et l\'état up', async () => {
    const { sw } = await buildLan();
    const out = await sw.executeCommand('display interface Vlanif10');
    expect(out).toMatch(/Vlanif10/);
    expect(out).toMatch(/10\.0\.10\.1/);
  });

  it('PC1 (VLAN 10) ping vers la SVI Vlanif10 (sa passerelle)', async () => {
    const { pc1 } = await buildLan();
    const out = await pc1.executeCommand('ping -c 1 10.0.10.1');
    expect(out).toMatch(/64 bytes from 10\.0\.10\.1/);
    expect(out).toMatch(/1 packets transmitted, 1 received/);
  });

  it('PC1 ping vers la SVI de l\'autre VLAN (10.0.20.1)', async () => {
    const { pc1 } = await buildLan();
    const out = await pc1.executeCommand('ping -c 1 10.0.20.1');
    expect(out).toMatch(/64 bytes from 10\.0\.20\.1/);
  });

  it('PC1 (VLAN 10) ping PC2 (VLAN 20) — inter-VLAN routing via le switch', async () => {
    const { pc1 } = await buildLan();
    const out = await pc1.executeCommand('ping -c 3 10.0.20.10');
    expect(out).toMatch(/64 bytes from 10\.0\.20\.10/);
    expect(out).toMatch(/3 packets transmitted, 3 received/);
  });

  it('PC2 (VLAN 20) ping PC1 (VLAN 10) — routage symétrique', async () => {
    const { pc2 } = await buildLan();
    const out = await pc2.executeCommand('ping -c 3 10.0.10.10');
    expect(out).toMatch(/64 bytes from 10\.0\.10\.10/);
    expect(out).toMatch(/3 packets transmitted, 3 received/);
  });

  it('interface Vlanif10 + display this rend ip address ...', async () => {
    const { sw } = await buildLan();
    for (const cmd of ['system-view', 'interface Vlanif10']) await sw.executeCommand(cmd);
    const out = await sw.executeCommand('display this');
    expect(out).toMatch(/interface Vlanif10/);
    expect(out).toMatch(/ ip address 10\.0\.10\.1 255\.255\.255\.0/);
  });

  it('display ip interface brief liste les Vlanif avec leur IP et état', async () => {
    const { sw } = await buildLan();
    const out = await sw.executeCommand('display ip interface brief');
    expect(out).toMatch(/Vlanif10\s+10\.0\.10\.1\/24\s+up\s+up/);
    expect(out).toMatch(/Vlanif20\s+10\.0\.20\.1\/24\s+up\s+up/);
  });

  it('display arp affiche les entrées apprises après un ping inter-VLAN', async () => {
    const { sw, pc1 } = await buildLan();
    await pc1.executeCommand('ping -c 1 10.0.20.10');
    const out = await sw.executeCommand('display arp');
    expect(out).toMatch(/10\.0\.10\.10.*dynamic/);
    expect(out).toMatch(/10\.0\.20\.10.*dynamic/);
  });

  it('ip route-static 0.0.0.0 0.0.0.0 <gw> apparaît comme route par défaut', async () => {
    const { sw } = await buildLan();
    for (const cmd of [
      'system-view',
      'ip route-static 0.0.0.0 0.0.0.0 10.0.20.99',
      'quit',
    ]) await sw.executeCommand(cmd);
    const out = await sw.executeCommand('display ip routing-table');
    expect(out).toMatch(/0\.0\.0\.0\/0.*Static.*10\.0\.20\.99/);
  });

  it('SVI Vlanif20 en shutdown : PC1 ne joint plus PC2', async () => {
    const { sw, pc1 } = await buildLan();
    for (const cmd of [
      'system-view', 'interface Vlanif20', 'shutdown', 'quit', 'quit',
    ]) await sw.executeCommand(cmd);
    const out = await pc1.executeCommand('ping -c 2 10.0.20.10');
    expect(out).toMatch(/100% packet loss/);
  });
});

describe('Huawei L3 switch — serveur DHCP intégré (deployment "collapsed core")', () => {
  async function buildDhcpLan() {
    const sw = new HuaweiSwitch('hw-sw', 'L3SW', 8, 0, 0);
    const pc1 = new LinuxPC('pc1', 'PC1', 0, 0);
    const pc2 = new LinuxPC('pc2', 'PC2', 0, 0);
    new Cable('c1').connect(pc1.getPorts()[0], sw.getPort('GigabitEthernet0/0/1')!);
    new Cable('c2').connect(pc2.getPorts()[0], sw.getPort('GigabitEthernet0/0/2')!);

    // No static IP on the PCs — they will request via DHCP.
    for (const cmd of [
      'system-view',
      'dhcp enable',
      'vlan batch 10',
      'interface GigabitEthernet0/0/1', 'port link-type access', 'port default vlan 10', 'quit',
      'interface GigabitEthernet0/0/2', 'port link-type access', 'port default vlan 10', 'quit',
      'interface Vlanif10', 'ip address 10.0.10.1 255.255.255.0', 'undo shutdown',
      'dhcp select global', 'quit',
      'ip pool LAN10',
      'network 10.0.10.0 mask 255.255.255.0',
      'gateway-list 10.0.10.1',
      'dns-list 8.8.8.8 1.1.1.1',
      'lease day 1',
      'excluded-ip-address 10.0.10.1 10.0.10.99',
      'quit', 'quit',
    ]) await sw.executeCommand(cmd);

    return { sw, pc1, pc2 };
  }

  it('PC1 obtient un bail DHCP du switch (DORA complet)', async () => {
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

  it('PC1 et PC2 obtiennent des baux distincts', async () => {
    const { pc1, pc2 } = await buildDhcpLan();
    await pc1.executeCommand('dhclient eth0');
    await pc2.executeCommand('dhclient eth0');
    const ip1 = /inet (10\.0\.10\.\d+)/.exec(await pc1.executeCommand('ip addr show eth0'))?.[1];
    const ip2 = /inet (10\.0\.10\.\d+)/.exec(await pc2.executeCommand('ip addr show eth0'))?.[1];
    expect(ip1).toBeDefined();
    expect(ip2).toBeDefined();
    expect(ip1).not.toBe(ip2);
  });

  it('PC1 (bail DHCP) peut pinger sa passerelle Vlanif10', async () => {
    const { pc1 } = await buildDhcpLan();
    await pc1.executeCommand('dhclient eth0');
    const out = await pc1.executeCommand('ping -c 1 10.0.10.1');
    expect(out).toMatch(/64 bytes from 10\.0\.10\.1/);
  });

  it('PC1 ↔ PC2 (tous deux en DHCP) communiquent dans le même VLAN', async () => {
    const { pc1, pc2 } = await buildDhcpLan();
    await pc1.executeCommand('dhclient eth0');
    await pc2.executeCommand('dhclient eth0');
    const ip2 = /inet (10\.0\.10\.\d+)/.exec(await pc2.executeCommand('ip addr show eth0'))![1];
    const out = await pc1.executeCommand(`ping -c 2 ${ip2}`);
    expect(out).toMatch(/2 packets transmitted, 2 received/);
  });

  it('display this dans le pool view rend la config réinjectable', async () => {
    const { sw } = await buildDhcpLan();
    await sw.executeCommand('system-view');
    await sw.executeCommand('ip pool LAN10');
    const out = await sw.executeCommand('display this');
    expect(out).toMatch(/ip pool LAN10/);
    expect(out).toMatch(/network 10\.0\.10\.0 mask 255\.255\.255\.0/);
    expect(out).toMatch(/gateway-list 10\.0\.10\.1/);
  });
});
