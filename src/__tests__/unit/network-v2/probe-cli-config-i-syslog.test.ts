import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

async function enabled(device: CiscoRouter | CiscoSwitch) {
  await device.executeCommand('enable');
  return device;
}

describe('%SYS-5-CONFIG_I is written on leaving configuration mode', () => {
  it('end from global config logs it once', async () => {
    const r = await enabled(new CiscoRouter('R1'));
    await r.executeCommand('configure terminal');
    await r.executeCommand('hostname R-TEST');
    await r.executeCommand('end');

    const log = await r.executeCommand('show logging');
    expect(log).toContain('%SYS-5-CONFIG_I: Configured from console by console');
    expect(log.split('\n').filter((l) => l.includes('CONFIG_I'))).toHaveLength(1);
  });

  it('exit from global config logs it too', async () => {
    const r = await enabled(new CiscoRouter('R1'));
    await r.executeCommand('configure terminal');
    await r.executeCommand('exit');

    expect(await r.executeCommand('show logging')).toContain('%SYS-5-CONFIG_I');
  });

  it('leaving a SUB-mode for another config mode logs nothing', async () => {
    const r = await enabled(new CiscoRouter('R1'));
    await r.executeCommand('configure terminal');
    await r.executeCommand('interface GigabitEthernet0/0');
    await r.executeCommand('exit');

    const log = await r.executeCommand('show logging');
    expect(log).not.toContain('CONFIG_I');
  });

  it('end from a sub-mode logs exactly one message, not one per level', async () => {
    const r = await enabled(new CiscoRouter('R1'));
    await r.executeCommand('configure terminal');
    await r.executeCommand('interface GigabitEthernet0/0');
    await r.executeCommand('end');

    const log = await r.executeCommand('show logging');
    expect(log.split('\n').filter((l) => l.includes('CONFIG_I'))).toHaveLength(1);
  });

  it('leaving privileged EXEC logs nothing', async () => {
    const r = await enabled(new CiscoRouter('R1'));
    await r.executeCommand('exit');
    expect(await r.executeCommand('show logging')).not.toContain('CONFIG_I');
  });

  it('a switch announces it the same way', async () => {
    const sw = await enabled(new CiscoSwitch('SW1'));
    await sw.executeCommand('configure terminal');
    await sw.executeCommand('vlan 10');
    await sw.executeCommand('end');

    expect(await sw.executeCommand('show logging'))
      .toContain('%SYS-5-CONFIG_I: Configured from console by console');
  });

  it('a vty session is attributed to its own user, in the DEVICE log', async () => {
    const r = await enabled(new CiscoRouter('R1'));
    await r.executeCommand('configure terminal');
    await r.executeCommand('username admin privilege 15 secret pw');
    await r.executeCommand('end');

    const vty = r.createVtyShell('admin');
    await vty.execute('configure terminal');
    await vty.execute('hostname FROM-VTY');
    await vty.execute('end');

    const log = await r.executeCommand('show logging');
    expect(log).toContain('%SYS-5-CONFIG_I: Configured from console by admin');
    expect(log).toContain('%SYS-5-CONFIG_I: Configured from console by console');
  });
});
