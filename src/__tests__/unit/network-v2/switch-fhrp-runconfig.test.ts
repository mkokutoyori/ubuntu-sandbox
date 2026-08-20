import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { HuaweiSwitch } from '@/network/devices/HuaweiSwitch';
import { Cable } from '@/network/hardware/Cable';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { MACAddress, resetCounters } from '@/network/core/types';
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

describe('Cisco show running-config rend le bloc FHRP sur SVI', () => {
  async function build() {
    const sw = new CiscoSwitch('switch-cisco', 'L3SW', 26, 0, 0);
    const pc1 = new LinuxPC('pc1', 'PC1', 0, 0);
    const stub = new LinuxPC('stub', 'STUB', 0, 0);
    new Cable('c1').connect(pc1.getPorts()[0], sw.getPort('FastEthernet0/1')!);
    new Cable('up').connect(stub.getPorts()[0], sw.getPort('GigabitEthernet0/2')!);
    for (const cmd of [
      'enable', 'configure terminal',
      'vlan 10', 'exit',
      'interface FastEthernet0/1',
      'switchport mode access', 'switchport access vlan 10', 'exit',
      'interface Vlan10',
      'ip address 10.0.10.2 255.255.255.0',
      'ip helper-address 10.0.99.10',
      'vrrp 1 ip 10.0.10.1',
      'vrrp 1 priority 200',
      'vrrp 1 preempt',
      'vrrp 1 timers advertise 5',
      'vrrp 1 track GigabitEthernet0/2 decrement 80',
      'standby version 2',
      'standby 300 ip 10.0.10.11',
      'standby 300 priority 150',
      'standby 300 preempt',
      'standby 300 timers 1 5',
      'standby 300 authentication text ubuntu',
      'glbp 7 ip 10.0.10.7',
      'glbp 7 priority 120',
      'glbp 7 weighting 150',
      'glbp 7 load-balancing weighted',
      'no shutdown', 'exit', 'end',
    ]) await sw.executeCommand(cmd);
    return { sw };
  }

  it('running-config contient toutes les lignes FHRP configurées', async () => {
    const { sw } = await build();
    const out = await sw.executeCommand('show running-config');
    expect(out).toMatch(/interface Vlan10/);
    expect(out).toMatch(/ ip address 10\.0\.10\.2/);
    expect(out).toMatch(/ ip helper-address 10\.0\.99\.10/);

    expect(out).toMatch(/ vrrp 1 ip 10\.0\.10\.1/);
    expect(out).toMatch(/ vrrp 1 priority 200/);
    expect(out).toMatch(/ vrrp 1 preempt/);
    expect(out).toMatch(/ vrrp 1 timers advertise 5/);
    expect(out).toMatch(/ vrrp 1 track GigabitEthernet0\/2 decrement 80/);

    expect(out).toMatch(/ standby version 2/);
    expect(out).toMatch(/ standby 300 ip 10\.0\.10\.11/);
    expect(out).toMatch(/ standby 300 priority 150/);
    expect(out).toMatch(/ standby 300 preempt/);
    expect(out).toMatch(/ standby 300 timers 1 5/);
    expect(out).toMatch(/ standby 300 authentication text ubuntu/);

    expect(out).toMatch(/ glbp 7 ip 10\.0\.10\.7/);
    expect(out).toMatch(/ glbp 7 priority 120/);
    expect(out).toMatch(/ glbp 7 weighting 150/);
    expect(out).toMatch(/ glbp 7 load-balancing weighted/);
  });

  it('rejouer le running-config sur un switch vierge restaure l\'état FHRP', async () => {
    const { sw } = await build();
    const runcfg = await sw.executeCommand('show running-config');
    const cfgLines = runcfg.split('\n')
      .filter((l) => l && !l.startsWith('!') && !l.startsWith('Building') && !l.startsWith('Current') && l !== 'end');

    const sw2 = new CiscoSwitch('switch-cisco', 'L3SW-B', 26, 0, 0);
    await sw2.executeCommand('enable');
    await sw2.executeCommand('configure terminal');
    for (const raw of cfgLines) {
      const line = raw.replace(/^ +/, '');
      await sw2.executeCommand(line);
    }
    await sw2.executeCommand('end');

    const v = sw2.getVrrpAgent().listGroups()[0];
    expect(v.priority).toBe(200);
    expect(v.advertiseSec).toBe(5);
    expect(v.tracks[0].target).toBe('GigabitEthernet0/2');

    const h = sw2.getHsrpAgent().listGroups()[0];
    expect(h.group).toBe(300);
    expect(h.version).toBe(2);
    expect(h.authText).toBe('ubuntu');

    const g = sw2.getGlbpAgent().listGroups()[0];
    expect(g.weighting).toBe(150);
    expect(g.loadBalancing).toBe('weighted');
  });
});

describe('Huawei display current-configuration rend VRRP sur Vlanif', () => {
  async function build() {
    const sw = new HuaweiSwitch('switch-huawei', 'L3SW', 8, 0, 0);
    const pc1 = new LinuxPC('pc1', 'PC1', 0, 0);
    const stub = new LinuxPC('stub', 'STUB', 0, 0);
    new Cable('c1').connect(pc1.getPorts()[0], sw.getPort('GigabitEthernet0/0/1')!);
    new Cable('up').connect(stub.getPorts()[0], sw.getPort('GigabitEthernet0/0/3')!);
    for (const cmd of [
      'system-view',
      'vlan batch 10',
      'interface GigabitEthernet0/0/1',
      'port link-type access', 'port default vlan 10', 'quit',
      'interface Vlanif10',
      'ip address 10.0.10.2 255.255.255.0', 'undo shutdown',
      'vrrp vrid 1 virtual-ip 10.0.10.1',
      'vrrp vrid 1 priority 200',
      'vrrp vrid 1 preempt-mode',
      'vrrp vrid 1 timer advertise 3',
      'vrrp vrid 1 track interface GigabitEthernet0/0/3 reduced 60',
      'quit', 'quit',
    ]) await sw.executeCommand(cmd);
    return { sw };
  }

  it('display current-configuration rend vrrp vrid + track', async () => {
    const { sw } = await build();
    const out = await sw.executeCommand('display current-configuration');
    expect(out).toMatch(/interface Vlanif10/);
    expect(out).toMatch(/ vrrp vrid 1 virtual-ip 10\.0\.10\.1/);
    expect(out).toMatch(/ vrrp vrid 1 priority 200/);
    expect(out).toMatch(/ vrrp vrid 1 preempt-mode/);
    expect(out).toMatch(/ vrrp vrid 1 timer advertise 3/);
    expect(out).toMatch(/ vrrp vrid 1 track interface GigabitEthernet0\/0\/3 reduced 60/);
  });
});
