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
