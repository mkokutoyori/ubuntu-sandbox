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

describe('PRD-VLAN §5 — PVLAN, VACL and VTP pruning coexist in the flood path', () => {
  it('a PVLAN-permitted flow is still dropped by a VACL, and lifting the VACL restores it', async () => {
    const sw = new CiscoSwitch('switch-cisco', 'SW1', 8);
    const host = new LinuxPC('pc1', 'PC1', 0, 0);
    const gateway = new LinuxPC('pc2', 'GW', 0, 0);
    new Cable('c1').connect(host.getPorts()[0], sw.getPort('FastEthernet0/1')!);
    new Cable('c2').connect(gateway.getPorts()[0], sw.getPort('FastEthernet0/2')!);

    await sw.executeCommand('enable');
    await sw.executeCommand('configure terminal');
    await sw.executeCommand('vlan 100');
    await sw.executeCommand('private-vlan primary');
    await sw.executeCommand('vlan 101');
    await sw.executeCommand('private-vlan isolated');
    await sw.executeCommand('vlan 100');
    await sw.executeCommand('private-vlan association 101');
    await sw.executeCommand('exit');
    await sw.executeCommand('interface FastEthernet0/1');
    await sw.executeCommand('switchport mode private-vlan host');
    await sw.executeCommand('switchport private-vlan host-association 100 101');
    await sw.executeCommand('exit');
    await sw.executeCommand('interface FastEthernet0/2');
    await sw.executeCommand('switchport mode private-vlan promiscuous');
    await sw.executeCommand('switchport private-vlan mapping 100 101');
    await sw.executeCommand('end');

    await host.executeCommand('ifconfig eth0 10.0.0.1 netmask 255.255.255.0');
    await gateway.executeCommand('ifconfig eth0 10.0.0.254 netmask 255.255.255.0');

    const viaPvlan = await host.executeCommand('ping -c 1 10.0.0.254');
    expect(viaPvlan).toMatch(/1 packets transmitted, 1 received/);

    await sw.executeCommand('enable');
    await sw.executeCommand('configure terminal');
    await sw.executeCommand('ip access-list extended BLOCK-HOST');
    await sw.executeCommand('permit ip host 10.0.0.1 any');
    await sw.executeCommand('exit');
    await sw.executeCommand('vlan access-map SECURITY 10');
    await sw.executeCommand('match ip address BLOCK-HOST');
    await sw.executeCommand('action drop');
    await sw.executeCommand('exit');
    await sw.executeCommand('vlan access-map SECURITY 20');
    await sw.executeCommand('action forward');
    await sw.executeCommand('exit');
    await sw.executeCommand('vlan filter SECURITY vlan-list 101');
    await sw.executeCommand('end');

    const vaclBlocked = await host.executeCommand('ping -c 1 10.0.0.254');
    expect(vaclBlocked).toMatch(/0 received|100% packet loss/);

    await sw.executeCommand('enable');
    await sw.executeCommand('configure terminal');
    await sw.executeCommand('no vlan filter SECURITY vlan-list 101');
    await sw.executeCommand('end');

    const restored = await host.executeCommand('ping -c 1 10.0.0.254');
    expect(restored).toMatch(/1 packets transmitted, 1 received/);
  });

  it('a VACL-forwarded flow is still confined by PVLAN isolation (VACL cannot open a PVLAN path)', async () => {
    const sw = new CiscoSwitch('switch-cisco', 'SW1', 8);
    const iso1 = new LinuxPC('pc1', 'ISO1', 0, 0);
    const iso2 = new LinuxPC('pc2', 'ISO2', 0, 0);
    new Cable('c1').connect(iso1.getPorts()[0], sw.getPort('FastEthernet0/1')!);
    new Cable('c2').connect(iso2.getPorts()[0], sw.getPort('FastEthernet0/2')!);

    await sw.executeCommand('enable');
    await sw.executeCommand('configure terminal');
    await sw.executeCommand('vlan 100');
    await sw.executeCommand('private-vlan primary');
    await sw.executeCommand('vlan 101');
    await sw.executeCommand('private-vlan isolated');
    await sw.executeCommand('vlan 100');
    await sw.executeCommand('private-vlan association 101');
    await sw.executeCommand('exit');
    for (const p of ['FastEthernet0/1', 'FastEthernet0/2']) {
      await sw.executeCommand(`interface ${p}`);
      await sw.executeCommand('switchport mode private-vlan host');
      await sw.executeCommand('switchport private-vlan host-association 100 101');
      await sw.executeCommand('exit');
    }
    await sw.executeCommand('vlan access-map ALLOW-ALL 10');
    await sw.executeCommand('action forward');
    await sw.executeCommand('exit');
    await sw.executeCommand('vlan filter ALLOW-ALL vlan-list 101');
    await sw.executeCommand('end');

    await iso1.executeCommand('ifconfig eth0 10.0.0.1 netmask 255.255.255.0');
    await iso2.executeCommand('ifconfig eth0 10.0.0.2 netmask 255.255.255.0');

    const out = await iso1.executeCommand('ping -c 1 10.0.0.2');
    expect(out).toMatch(/0 received|100% packet loss/);
  });

  it('VTP pruning still trims a VACL-forwarded, PVLAN-free VLAN on uninterested trunks', async () => {
    const left = new CiscoSwitch('switch-cisco', 'SL', 8);
    const right = new CiscoSwitch('switch-cisco', 'SR', 8);
    for (const sw of [left, right]) {
      await sw.executeCommand('enable');
      await sw.executeCommand('configure terminal');
      await sw.executeCommand('vtp domain LAB');
      await sw.executeCommand('vtp pruning');
      await sw.executeCommand('vlan 10');
      await sw.executeCommand('exit');
      await sw.executeCommand('vlan access-map PASS 10');
      await sw.executeCommand('action forward');
      await sw.executeCommand('exit');
      await sw.executeCommand('vlan filter PASS vlan-list 10');
      await sw.executeCommand('interface FastEthernet0/8');
      await sw.executeCommand('switchport mode trunk');
      await sw.executeCommand('end');
    }
    const pc = new LinuxPC('pc1', 'PC1', 0, 0);
    new Cable('h').connect(pc.getPorts()[0], left.getPort('FastEthernet0/1')!);
    await left.executeCommand('enable');
    await left.executeCommand('configure terminal');
    await left.executeCommand('interface FastEthernet0/1');
    await left.executeCommand('switchport mode access');
    await left.executeCommand('switchport access vlan 10');
    await left.executeCommand('end');

    let crossed = 0;
    const cable = new Cable('lr');
    cable.connect(left.getPort('FastEthernet0/8')!, right.getPort('FastEthernet0/8')!);
    right.getPort('FastEthernet0/8');
    const bus = left.getBus();
    bus.subscribe('cable.frame.delivered', (evt) => {
      const p = evt.payload as { cableName?: string };
      if (p.cableName === 'lr') crossed++;
    });

    await pc.executeCommand('ifconfig eth0 10.0.0.1 netmask 255.255.255.0');
    crossed = 0;
    await pc.executeCommand('ping -c 1 -W 1 10.0.0.99');

    expect(crossed).toBe(0);
  });
});
