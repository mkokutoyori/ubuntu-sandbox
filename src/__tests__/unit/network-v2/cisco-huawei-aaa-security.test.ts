import { describe, beforeEach, expect, test } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

interface Lab {
  linux1: LinuxPC;
  ciscoR1: CiscoRouter;
  hwR1: HuaweiRouter;
  sw: GenericSwitch;
}

async function buildLab(): Promise<Lab> {
  EquipmentRegistry.getInstance().clear();
  const linux1 = new LinuxPC('linux-pc', 'linux1', 0, 0);
  const ciscoR1 = new CiscoRouter('ciscoR1', 0, 0);
  const hwR1 = new HuaweiRouter('hwR1', 0, 0);
  const sw = new GenericSwitch('switch-generic', 'core-sw', 8, 0, 0);
  const all = [linux1, ciscoR1, hwR1];
  all.forEach((d, i) => { const c = new Cable(`c${i}`); c.connect(d.getPorts()[0], sw.getPorts()[i]); });
  const m = new SubnetMask('255.255.255.0');
  linux1.getPorts()[0].configureIP(new IPAddress('10.0.0.1'), m);
  await ciscoR1.executeCommand('enable');
  await ciscoR1.executeCommand('configure terminal');
  await ciscoR1.executeCommand('interface GigabitEthernet0/0');
  await ciscoR1.executeCommand('ip address 10.0.0.6 255.255.255.0');
  await ciscoR1.executeCommand('no shutdown');
  await ciscoR1.executeCommand('end');
  await hwR1.executeCommand('system-view');
  await hwR1.executeCommand('interface GigabitEthernet0/0/0');
  await hwR1.executeCommand('ip address 10.0.0.8 255.255.255.0');
  await hwR1.executeCommand('undo shutdown');
  await hwR1.executeCommand('quit');
  await hwR1.executeCommand('quit');
  return { linux1, ciscoR1, hwR1, sw };
}

describe('§A — Cisco local-user database is queryable and persistent', () => {
  let lab: Lab;
  beforeEach(async () => { lab = await buildLab(); });

  test('username admin secret stores the account with privilege', async () => {
    await lab.ciscoR1.executeCommand('configure terminal');
    await lab.ciscoR1.executeCommand('username admin privilege 15 secret Admin@123');
    await lab.ciscoR1.executeCommand('end');
    const u = lab.ciscoR1._getLocalUser('admin');
    expect(u?.privilege).toBe(15);
    expect(u?.secret).toBe('Admin@123');
  });

  test('a second username adds a separate account', async () => {
    await lab.ciscoR1.executeCommand('configure terminal');
    await lab.ciscoR1.executeCommand('username admin privilege 15 secret a');
    await lab.ciscoR1.executeCommand('username readonly privilege 1 secret b');
    await lab.ciscoR1.executeCommand('end');
    expect(lab.ciscoR1._listLocalUsers().map(u => u.name).sort()).toEqual(['admin', 'readonly']);
  });

  test('no username admin removes the account', async () => {
    await lab.ciscoR1.executeCommand('configure terminal');
    await lab.ciscoR1.executeCommand('username admin privilege 15 secret a');
    await lab.ciscoR1.executeCommand('no username admin');
    await lab.ciscoR1.executeCommand('end');
    expect(lab.ciscoR1._getLocalUser('admin')).toBeUndefined();
  });
});

describe('§B — Huawei local-user database is queryable and persistent', () => {
  let lab: Lab;
  beforeEach(async () => { lab = await buildLab(); });

  test('local-user admin password creates the account', async () => {
    await lab.hwR1.executeCommand('system-view');
    await lab.hwR1.executeCommand('aaa');
    await lab.hwR1.executeCommand('local-user admin password cipher Admin@123');
    await lab.hwR1.executeCommand('local-user admin privilege level 15');
    await lab.hwR1.executeCommand('local-user admin service-type ssh');
    await lab.hwR1.executeCommand('quit');
    await lab.hwR1.executeCommand('quit');
    const u = lab.hwR1._getLocalUser('admin');
    expect(u?.privilege).toBe(15);
    expect(u?.secret).toBe('Admin@123');
  });

  test('multiple local-users are stored', async () => {
    await lab.hwR1.executeCommand('system-view');
    await lab.hwR1.executeCommand('aaa');
    await lab.hwR1.executeCommand('local-user admin password cipher a');
    await lab.hwR1.executeCommand('local-user readonly password cipher b');
    await lab.hwR1.executeCommand('local-user readonly privilege level 1');
    await lab.hwR1.executeCommand('quit');
    await lab.hwR1.executeCommand('quit');
    expect(lab.hwR1._listLocalUsers().map(u => u.name).sort()).toEqual(['admin', 'readonly']);
  });

  test('undo local-user admin removes the account', async () => {
    await lab.hwR1.executeCommand('system-view');
    await lab.hwR1.executeCommand('aaa');
    await lab.hwR1.executeCommand('local-user admin password cipher a');
    await lab.hwR1.executeCommand('undo local-user admin');
    await lab.hwR1.executeCommand('quit');
    await lab.hwR1.executeCommand('quit');
    expect(lab.hwR1._getLocalUser('admin')).toBeUndefined();
  });
});
