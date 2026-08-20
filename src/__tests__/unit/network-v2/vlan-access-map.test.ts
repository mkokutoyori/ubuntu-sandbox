import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

async function vaclLan() {
  const sw = new CiscoSwitch('switch-cisco', 'SW1', 8);
  const pc1 = new LinuxPC('pc1', 'PC1', 0, 0);
  const pc2 = new LinuxPC('pc2', 'PC2', 0, 0);
  const pc3 = new LinuxPC('pc3', 'PC3', 0, 0);
  new Cable('c1').connect(pc1.getPorts()[0], sw.getPort('FastEthernet0/1')!);
  new Cable('c2').connect(pc2.getPorts()[0], sw.getPort('FastEthernet0/2')!);
  new Cable('c3').connect(pc3.getPorts()[0], sw.getPort('FastEthernet0/3')!);

  await sw.executeCommand('enable');
  await sw.executeCommand('configure terminal');
  await sw.executeCommand('vlan 10');
  await sw.executeCommand('exit');
  for (const p of ['FastEthernet0/1', 'FastEthernet0/2', 'FastEthernet0/3']) {
    await sw.executeCommand(`interface ${p}`);
    await sw.executeCommand('switchport mode access');
    await sw.executeCommand('switchport access vlan 10');
    await sw.executeCommand('exit');
  }
  await sw.executeCommand('end');

  await pc1.executeCommand('ifconfig eth0 10.0.0.1 netmask 255.255.255.0');
  await pc2.executeCommand('ifconfig eth0 10.0.0.2 netmask 255.255.255.0');
  await pc3.executeCommand('ifconfig eth0 10.0.0.3 netmask 255.255.255.0');
  return { sw, pc1, pc2, pc3 };
}

describe('Cisco VACL — vlan access-map / vlan filter CLI', () => {
  it('builds an access map with match/action and binds it via vlan filter', async () => {
    const sw = new CiscoSwitch('switch-cisco', 'SW1', 8);
    await sw.executeCommand('enable');
    await sw.executeCommand('configure terminal');
    await sw.executeCommand('ip access-list extended BLOCK-HOST');
    await sw.executeCommand('permit ip host 10.0.0.1 any');
    await sw.executeCommand('exit');
    await sw.executeCommand('vlan access-map VMAP 10');
    await sw.executeCommand('match ip address BLOCK-HOST');
    await sw.executeCommand('action drop');
    await sw.executeCommand('exit');
    await sw.executeCommand('vlan access-map VMAP 20');
    await sw.executeCommand('action forward');
    await sw.executeCommand('exit');
    await sw.executeCommand('vlan filter VMAP vlan-list 10');
    await sw.executeCommand('end');

    const rules = sw.getVlanAccessMap('VMAP');
    expect(rules).toBeDefined();
    expect(rules!.length).toBe(2);
    expect(rules![0]).toMatchObject({ sequence: 10, matchIpAcl: 'BLOCK-HOST', action: 'drop' });
    expect(rules![1]).toMatchObject({ sequence: 20, action: 'forward' });
    expect(sw.getVlanFilter(10)).toBe('VMAP');
    expect(sw.getVlanFilter(20)).toBeUndefined();
  });

  it('no vlan access-map removes the map and its filter bindings', async () => {
    const sw = new CiscoSwitch('switch-cisco', 'SW1', 8);
    await sw.executeCommand('enable');
    await sw.executeCommand('configure terminal');
    await sw.executeCommand('vlan access-map VMAP 10');
    await sw.executeCommand('action forward');
    await sw.executeCommand('exit');
    await sw.executeCommand('vlan filter VMAP vlan-list 10');
    await sw.executeCommand('no vlan access-map VMAP');
    await sw.executeCommand('end');
    expect(sw.getVlanAccessMap('VMAP')).toBeUndefined();
    expect(sw.getVlanFilter(10)).toBeUndefined();
  });
});

describe('Cisco VACL — real intra-VLAN filtering in the data plane', () => {
  it('traffic matching a drop entry stops flowing once the filter is applied, while other hosts keep working', async () => {
    const { sw, pc1, pc2, pc3 } = await vaclLan();

    const before = await pc1.executeCommand('ping -c 1 10.0.0.2');
    expect(before).toMatch(/1 packets transmitted, 1 received/);

    await sw.executeCommand('enable');
    await sw.executeCommand('configure terminal');
    await sw.executeCommand('ip access-list extended BLOCK-PC1');
    await sw.executeCommand('permit ip host 10.0.0.1 any');
    await sw.executeCommand('exit');
    await sw.executeCommand('vlan access-map VMAP 10');
    await sw.executeCommand('match ip address BLOCK-PC1');
    await sw.executeCommand('action drop');
    await sw.executeCommand('exit');
    await sw.executeCommand('vlan access-map VMAP 20');
    await sw.executeCommand('action forward');
    await sw.executeCommand('exit');
    await sw.executeCommand('vlan filter VMAP vlan-list 10');
    await sw.executeCommand('end');

    const blocked = await pc1.executeCommand('ping -c 1 10.0.0.2');
    expect(blocked).toMatch(/0 received|100% packet loss/);

    const others = await pc2.executeCommand('ping -c 1 10.0.0.3');
    expect(others).toMatch(/1 packets transmitted, 1 received/);
  });

  it('a VACL with only forward entries leaves traffic untouched', async () => {
    const { sw, pc1, pc2 } = await vaclLan();
    await sw.executeCommand('enable');
    await sw.executeCommand('configure terminal');
    await sw.executeCommand('vlan access-map PASS 10');
    await sw.executeCommand('action forward');
    await sw.executeCommand('exit');
    await sw.executeCommand('vlan filter PASS vlan-list 10');
    await sw.executeCommand('end');

    const out = await pc1.executeCommand('ping -c 1 10.0.0.2');
    expect(out).toMatch(/1 packets transmitted, 1 received/);
  });

  it('the implicit deny at the end of an access map drops IP traffic matching no entry', async () => {
    const { sw, pc1, pc2, pc3 } = await vaclLan();
    await sw.executeCommand('enable');
    await sw.executeCommand('configure terminal');
    await sw.executeCommand('ip access-list extended ONLY-PC3');
    await sw.executeCommand('permit ip host 10.0.0.3 any');
    await sw.executeCommand('permit ip any host 10.0.0.3');
    await sw.executeCommand('exit');
    await sw.executeCommand('vlan access-map STRICT 10');
    await sw.executeCommand('match ip address ONLY-PC3');
    await sw.executeCommand('action forward');
    await sw.executeCommand('exit');
    await sw.executeCommand('vlan filter STRICT vlan-list 10');
    await sw.executeCommand('end');

    const denied = await pc1.executeCommand('ping -c 1 10.0.0.2');
    expect(denied).toMatch(/0 received|100% packet loss/);

    const allowed = await pc1.executeCommand('ping -c 1 10.0.0.3');
    expect(allowed).toMatch(/1 packets transmitted, 1 received/);
  });
});
