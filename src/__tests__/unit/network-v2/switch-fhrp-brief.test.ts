import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { HuaweiSwitch } from '@/network/devices/HuaweiSwitch';
import { Cable } from '@/network/hardware/Cable';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { IPAddress, MACAddress, resetCounters } from '@/network/core/types';
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

describe('Cisco brief views + FHRP timers CLI', () => {
  async function buildLan() {
    const sw = new CiscoSwitch('switch-cisco', 'L3SW', 24, 0, 0);
    const pc1 = new LinuxPC('pc1', 'PC1', 0, 0);
    new Cable('c1').connect(pc1.getPorts()[0], sw.getPort('FastEthernet0/1')!);
    for (const cmd of [
      'enable', 'configure terminal',
      'vlan 10', 'exit',
      'interface FastEthernet0/1',
      'switchport mode access', 'switchport access vlan 10', 'exit',
      'interface Vlan10',
      'ip address 10.0.10.2 255.255.255.0',
      'vrrp 1 ip 10.0.10.1',
      'vrrp 1 priority 200',
      'vrrp 1 timers advertise 3',
      'standby 5 ip 10.0.10.5',
      'standby 5 priority 150',
      'standby 5 preempt',
      'standby 5 timers 1 5',
      'standby 5 authentication text ubuntu',
      'glbp 7 ip 10.0.10.7',
      'glbp 7 priority 120',
      'no shutdown', 'exit', 'end',
    ]) await sw.executeCommand(cmd);
    return { sw, pc1 };
  }

  it('show vrrp brief : ligne d\'entête + colonne VIP', async () => {
    const { sw } = await buildLan();
    const out = await sw.executeCommand('show vrrp brief');
    expect(out).toMatch(/Interface\s+Grp\s+Pri\s+Time\s+Own\s+Pre\s+State/);
    expect(out).toMatch(/Vlan10\s+1\s+200\s+9000\s+N\s+Y\s+Master/);
    expect(out).toMatch(/10\.0\.10\.1/);
  });

  it('show standby brief : "P" pour preempt + Active address', async () => {
    const { sw } = await buildLan();
    const out = await sw.executeCommand('show standby brief');
    expect(out).toMatch(/Interface\s+Grp\s+Pri\s+P\s+State\s+Active/);
    expect(out).toMatch(/Vlan10\s+5\s+150\s+P\s+Active/);
    expect(out).toMatch(/10\.0\.10\.5/);
    const g = sw.getHsrpAgent().listGroups()[0];
    expect(g.helloSec).toBe(1);
    expect(g.holdSec).toBe(5);
    expect(g.authText).toBe('ubuntu');
  });

  it('show glbp brief : ligne AVG + vip 10.0.10.7', async () => {
    const { sw } = await buildLan();
    const out = await sw.executeCommand('show glbp brief');
    expect(out).toMatch(/Interface\s+Grp\s+Fwd\s+Pri\s+State/);
    expect(out).toMatch(/Vlan10\s+7\s+-\s+120\s+Active\s+10\.0\.10\.7/);
  });

  it('vrrp advertise timer se propage sur le wire (hello plus lent)', async () => {
    const { sw } = await buildLan();
    const g = sw.getVrrpAgent().listGroups()[0];
    expect(g.advertiseSec).toBe(3);
  });

  it('standby timers 0 refuse ; hold <= hello refuse', async () => {
    const { sw } = await buildLan();
    for (const cmd of [
      'enable', 'configure terminal',
      'interface Vlan10',
    ]) await sw.executeCommand(cmd);
    const bad = await sw.executeCommand('standby 5 timers 3 2');
    expect(bad).toMatch(/Invalid timers/);
    const g = sw.getHsrpAgent().listGroups()[0];
    expect(g.helloSec).toBe(1);
    expect(g.holdSec).toBe(5);
  });
});

describe('Huawei display vrrp brief + timer advertise', () => {
  async function buildLan() {
    const sw = new HuaweiSwitch('switch-huawei', 'L3SW', 8, 0, 0);
    const pc1 = new LinuxPC('pc1', 'PC1', 0, 0);
    new Cable('c1').connect(pc1.getPorts()[0], sw.getPort('GigabitEthernet0/0/1')!);
    for (const cmd of [
      'system-view',
      'vlan batch 10',
      'interface GigabitEthernet0/0/1',
      'port link-type access', 'port default vlan 10', 'quit',
      'interface Vlanif10',
      'ip address 10.0.10.2 255.255.255.0', 'undo shutdown',
      'vrrp vrid 1 virtual-ip 10.0.10.1',
      'vrrp vrid 1 priority 180',
      'vrrp vrid 1 timer advertise 5',
      'quit', 'quit',
    ]) await sw.executeCommand(cmd);
    return { sw };
  }

  it('display vrrp brief : Master + Virtual IP', async () => {
    const { sw } = await buildLan();
    const out = await sw.executeCommand('display vrrp brief');
    expect(out).toMatch(/VRID\s+State\s+Interface\s+Type\s+Virtual IP/);
    expect(out).toMatch(/1\s+Master\s+Vlanif10\s+Normal\s+10\.0\.10\.1/);
  });

  it('timer advertise 5 fixe advertiseSec sur le groupe', async () => {
    const { sw } = await buildLan();
    const g = sw.getVrrpAgent().listGroups()[0];
    expect(g.advertiseSec).toBe(5);
  });
});
