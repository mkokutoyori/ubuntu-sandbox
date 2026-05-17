/**
 * TDD — Huawei switch ACL + interface-view DHCP-snooping / IP source
 * guard. Surfaced by debug-output/huawei/huawei-security-mgmt.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { HuaweiSwitch } from '@/network/devices/HuaweiSwitch';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
});

async function sysSwitch(): Promise<HuaweiSwitch> {
  const sw = new HuaweiSwitch('switch-huawei', 'SW1', 24);
  await sw.executeCommand('system-view');
  return sw;
}

describe('Huawei ACL', () => {
  it('acl <number> enters acl view; rule recognized; display acl works', async () => {
    const sw = await sysSwitch();
    expect(await sw.executeCommand('acl 3001')).not.toMatch(/Unrecognized command/);
    expect(sw.getPrompt()).toBe('[SW1-acl-adv-3001]');
    expect(await sw.executeCommand(
      'rule 5 permit ip source 192.168.10.0 0.0.0.255 destination 192.168.20.0 0.0.0.255'))
      .not.toMatch(/Unrecognized command/);
    expect(await sw.executeCommand('rule 10 deny ip')).not.toMatch(/Unrecognized/);
    await sw.executeCommand('quit');
    expect(sw.getPrompt()).toBe('[SW1]');
    const all = await sw.executeCommand('display acl all');
    expect(all).not.toMatch(/Unrecognized command/);
    expect(all).toContain('3001');
    const one = await sw.executeCommand('display acl 3001');
    expect(one).toContain('3001');
    expect(one).toMatch(/rule 5/);
  });

  it('acl name <name> [number] basic ACL enters view', async () => {
    const sw = await sysSwitch();
    expect(await sw.executeCommand('acl name MGMT 2999'))
      .not.toMatch(/Unrecognized command/);
    expect(sw.getPrompt()).toBe('[SW1-acl-basic-MGMT]');
    expect(await sw.executeCommand('rule permit source 10.0.0.0 0.0.0.255'))
      .not.toMatch(/Unrecognized command/);
  });
});

describe('Huawei interface — DHCP snooping / IP source guard', () => {
  it('interface-view dhcp/arp/ip-source security recognized', async () => {
    const sw = await sysSwitch();
    await sw.executeCommand('dhcp enable');
    await sw.executeCommand('dhcp snooping enable');
    await sw.executeCommand('interface GigabitEthernet0/0/1');
    for (const c of ['dhcp snooping enable', 'dhcp snooping trusted',
      'ip source check user-bind enable',
      'arp anti-attack check user-bind enable']) {
      expect(await sw.executeCommand(c)).not.toMatch(/Unrecognized command/);
    }
    const out = await sw.executeCommand('display this');
    expect(out).toContain('dhcp snooping enable');
  });
});
