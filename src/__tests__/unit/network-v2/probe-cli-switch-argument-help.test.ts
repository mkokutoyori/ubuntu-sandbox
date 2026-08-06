import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

async function inConfig(): Promise<CiscoSwitch> {
  const sw = new CiscoSwitch('SW1');
  await sw.executeCommand('enable');
  await sw.executeCommand('configure terminal');
  return sw;
}

async function inInterface(): Promise<CiscoSwitch> {
  const sw = await inConfig();
  await sw.executeCommand('interface GigabitEthernet0/1');
  return sw;
}

describe('the switch shell announces its argument types too', () => {
  it.each([
    ['switchport access vlan ?', '<1-4094>'],
    ['channel-group ?', '<1-64>'],
    ['spanning-tree cost ?', '<1-200000000>'],
    ['spanning-tree port-priority ?', '<0-240>'],
    ['mtu ?', '<68-9216>'],
    ['description ?', 'LINE'],
  ])('%s announces %s', async (command, expected) => {
    const sw = await inInterface();
    expect(await sw.executeCommand(command)).toContain(expected);
  });

  it.each([
    ['vlan ?', '<1-4094>'],
    ['ip default-gateway ?', 'A.B.C.D'],
    ['ip name-server ?', 'A.B.C.D'],
  ])('%s announces %s', async (command, expected) => {
    const sw = await inConfig();
    expect(await sw.executeCommand(command)).toContain(expected);
  });

  it('a VLAN name is a WORD', async () => {
    const sw = await inConfig();
    await sw.executeCommand('vlan 10');
    expect(await sw.executeCommand('name ?')).toContain('WORD');
  });
});

describe('the switch help invents nothing either', () => {
  it('no offered keyword lacks a description, on either platform, in any mode', async () => {
    const undescribed: string[] = [];
    const scan = (label: string, out: string) => {
      for (const l of out.split('\n')) {
        if (!l.trim() || l.includes('<cr>')) continue;
        if (/^\s+\S+\s*$/.test(l)) undescribed.push(`${label}: ${l.trim()}`);
      }
    };
    for (const [name, dev] of [
      ['SW', new CiscoSwitch('SW2')], ['R', new CiscoRouter('R2')],
    ] as const) {
      const ifName = name === 'SW' ? 'GigabitEthernet0/1' : 'GigabitEthernet0/0';
      scan(`${name} user`, await dev.executeCommand('?'));
      await dev.executeCommand('enable');
      scan(`${name} privileged`, await dev.executeCommand('?'));
      await dev.executeCommand('configure terminal');
      scan(`${name} config`, await dev.executeCommand('?'));
      await dev.executeCommand(`interface ${ifName}`);
      scan(`${name} config-if`, await dev.executeCommand('?'));
      await dev.executeCommand('exit');
      await dev.executeCommand('line vty 0 4');
      scan(`${name} config-line`, await dev.executeCommand('?'));
    }
    expect(undescribed).toEqual([]);
  });

  it('a hint-only node is not offered as a command', async () => {
    const sw = await inInterface();
    const help = await sw.executeCommand('?');
    expect(help).not.toMatch(/^\s+access vlan\b/m);
    expect(help).not.toMatch(/^\s+native\b/m);
  });

  it('every declared range is the range the command really enforces', async () => {
    const sw = await inInterface();
    const refused = (out: string) => /Invalid|%/.test(out);

    expect(refused(await sw.executeCommand('mtu 67'))).toBe(true);
    expect(refused(await sw.executeCommand('mtu 68'))).toBe(false);
    expect(refused(await sw.executeCommand('mtu 9216'))).toBe(false);
    expect(refused(await sw.executeCommand('mtu 9217'))).toBe(true);

    expect(refused(await sw.executeCommand('switchport mode access'))).toBe(false);
    expect(refused(await sw.executeCommand('switchport access vlan 0'))).toBe(true);
    expect(refused(await sw.executeCommand('switchport access vlan 4095'))).toBe(true);

    expect(refused(await sw.executeCommand('channel-group 0 mode on'))).toBe(true);
    expect(refused(await sw.executeCommand('channel-group 64 mode on'))).toBe(false);
    expect(refused(await sw.executeCommand('channel-group 65 mode on'))).toBe(true);
  });

  it('the ranges that IOS enforces are now enforced here too', async () => {
    const sw = await inInterface();
    const refused = (out: string) => /Invalid|%/.test(out);

    expect(refused(await sw.executeCommand('spanning-tree cost 0'))).toBe(true);
    expect(refused(await sw.executeCommand('spanning-tree cost 1'))).toBe(false);
    expect(refused(await sw.executeCommand('spanning-tree cost 200000000'))).toBe(false);
    expect(refused(await sw.executeCommand('spanning-tree cost 200000001'))).toBe(true);

    expect(refused(await sw.executeCommand('spanning-tree port-priority 0'))).toBe(false);
    expect(refused(await sw.executeCommand('spanning-tree port-priority 240'))).toBe(false);
    expect(refused(await sw.executeCommand('spanning-tree port-priority 241'))).toBe(true);
  });

  it('an out-of-range value is REFUSED, never thrown', async () => {
    const sw = await inInterface();
    for (const value of [0, 1, 67, 9217, 99999]) {
      const out = await sw.executeCommand(`mtu ${value}`);
      expect(out).toContain('%');
      expect(out).not.toContain('Error:');
    }
  });

  it('declaring the arguments did not break their execution', async () => {
    const sw = await inInterface();
    expect(await sw.executeCommand('switchport mode access')).toBe('');
    expect(await sw.executeCommand('switchport access vlan 10')).not.toMatch(/Invalid input/);
    expect(await sw.executeCommand('description UPLINK')).not.toMatch(/Invalid input/);
    await sw.executeCommand('exit');
    expect(await sw.executeCommand('vlan 20')).not.toMatch(/Invalid input/);
    expect(await sw.executeCommand('name SALES')).not.toMatch(/Invalid input/);
  });
});
