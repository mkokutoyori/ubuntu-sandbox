import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { __setLegacyRouterPortCount } from '@/network/devices/inspection/InterfaceStatusView';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
  __setLegacyRouterPortCount(null);
});

async function priv(): Promise<CiscoRouter> {
  const r = new CiscoRouter('R1');
  await r.executeCommand('enable');
  return r;
}

describe('the chassis a Cisco router claims is the one it has', () => {
  it('an ISR 2911 carries three GigabitEthernet interfaces', async () => {
    const r = await priv();
    const gi = r.getPortNames().filter(n => n.startsWith('GigabitEthernet'));
    expect(gi).toEqual(['GigabitEthernet0/0', 'GigabitEthernet0/1', 'GigabitEthernet0/2']);
  });

  it('and the boot banner counts the ones that exist', async () => {
    const r = await priv();
    expect(r.getBootSequence()).toContain('3 Gigabit Ethernet interfaces');
  });

  it('the memory split is a size that exists', async () => {
    const r = await priv();
    const version = String(await r.executeCommand('show version'));
    expect(version).toContain('491520K/32768K bytes of memory');
    expect(version).not.toContain('524288K/65536K');
  });

  it('the product identifier is the one Cisco prints', async () => {
    const r = await priv();
    expect(String(await r.executeCommand('show version'))).toContain('Cisco CISCO2911/K9');
    expect(r.getBootSequence()).toContain('Cisco CISCO2911/K9');
  });

  it('NVRAM is announced as IOS announces it, reserve deducted', async () => {
    const r = await priv();
    expect(String(await r.executeCommand('show version')))
      .toContain('255K bytes of non-volatile configuration memory');
  });

  it('the banner carries the blocks a real boot prints', async () => {
    const banner = (await priv()).getBootSequence();
    expect(banner).toContain('uptime is');
    expect(banner).toContain('System returned to ROM by');
    expect(banner).toContain('Last reload reason:');
    expect(banner).toContain('Technology Package License Information');
  });

  it('the boot text never answers a question on the operator behalf', async () => {
    const banner = (await priv()).getBootSequence();
    expect(banner).not.toContain('Would you like to enter the initial configuration dialog?');
    expect(banner.trimEnd().endsWith('Press RETURN to get started.')).toBe(true);
  });
});

describe('the inventory names an entity, the SNMP agent names a chassis', () => {
  it('show inventory names the physical entity, not the hostname', async () => {
    const r = new CiscoRouter('CORE-RTR');
    await r.executeCommand('enable');
    const inv = String(await r.executeCommand('show inventory'));

    expect(inv).toContain('NAME: "CISCO2911/K9 chassis"');
    expect(inv).not.toContain('NAME: "CORE-RTR"');
  });

  it('show snmp reports the chassis even before the agent is enabled', async () => {
    const r = await priv();
    expect(String(await r.executeCommand('show snmp'))).toContain('Chassis: FTX1234567A');
  });
});

describe('a filesystem the box does not declare does not resolve', () => {
  it('dir flash0: is refused, dir flash: is not', async () => {
    const r = await priv();
    expect(String(await r.executeCommand('dir flash0:')))
      .toContain('%Error opening flash0: (No such file or directory)');
    expect(String(await r.executeCommand('dir flash:'))).toContain('Directory of flash:/');
  });

  it('show file systems declares exactly what dir accepts', async () => {
    const r = await priv();
    const fs = String(await r.executeCommand('show file systems'));
    expect(fs).toContain('flash:');
    expect(fs).not.toContain('flash0:');
  });
});

describe('show boot describes this box, not a redundant pair', () => {
  it('no standby line on a chassis that has no standby', async () => {
    const r = await priv();
    const boot = String(await r.executeCommand('show boot'));
    expect(boot).toContain('Configuration register is 0x2102');
    expect(boot).not.toContain('Standby');
  });
});
