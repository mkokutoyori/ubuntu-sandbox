/**
 * TDD — Cisco AAA / line / SSH / crypto / ACL + switch DAI &
 * port-security show. AAA/line/ACL are common to switch & router
 * (both extend CiscoShellBase) → shared base (DRY).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
});

async function cfgSwitch(): Promise<CiscoSwitch> {
  const sw = new CiscoSwitch('switch-cisco', 'SW1', 26);
  await sw.executeCommand('enable');
  await sw.executeCommand('configure terminal');
  return sw;
}

describe('Cisco AAA / SSH / crypto / username (switch & router, DRY)', () => {
  it('switch: aaa/enable secret/username/crypto/snmp/ntp/logging', async () => {
    const sw = await cfgSwitch();
    for (const c of ['aaa new-model', 'enable secret cisco',
      'username admin privilege 15 secret cisco', 'ip domain-name lab.local',
      'crypto key generate rsa modulus 2048', 'snmp-server community public RO',
      'ntp server 10.0.0.1', 'logging host 10.0.0.251',
      'service password-encryption']) {
      expect(await sw.executeCommand(c)).not.toMatch(/Invalid input|Unrecognized/);
    }
  });

  it('router: the same shared mgmt commands work (DRY)', async () => {
    const r = new CiscoRouter('R1');
    await r.executeCommand('enable');
    await r.executeCommand('configure terminal');
    for (const c of ['aaa new-model', 'enable secret cisco',
      'username admin secret cisco', 'crypto key generate rsa modulus 2048']) {
      expect(await r.executeCommand(c)).not.toMatch(/Invalid input|Unrecognized/);
    }
  });
});

describe('Cisco line sub-mode (switch & router, DRY)', () => {
  it('switch: line vty enters config-line; transport/login recognized', async () => {
    const sw = await cfgSwitch();
    expect(await sw.executeCommand('line vty 0 4')).not.toMatch(/Invalid input/);
    expect(sw.getPrompt()).toBe('SW1(config-line)#');
    for (const c of ['transport input ssh', 'login local',
      'exec-timeout 5 0', 'password cisco', 'logging synchronous']) {
      expect(await sw.executeCommand(c)).not.toMatch(/Invalid input|Unrecognized/);
    }
    await sw.executeCommand('exit');
    expect(sw.getPrompt()).toBe('SW1(config)#');
  });

  it('router: line console 0 sub-mode works too', async () => {
    const r = new CiscoRouter('R1');
    await r.executeCommand('enable');
    await r.executeCommand('configure terminal');
    expect(await r.executeCommand('line console 0')).not.toMatch(/Invalid input/);
    expect(await r.executeCommand('login local')).not.toMatch(/Invalid input/);
  });
});

describe('Cisco ACL (switch)', () => {
  it('numbered + named ACL recognized; show access-lists works', async () => {
    const sw = await cfgSwitch();
    expect(await sw.executeCommand('access-list 10 permit 10.0.0.0 0.0.0.255'))
      .not.toMatch(/Invalid input|Unrecognized/);
    expect(await sw.executeCommand('ip access-list extended BLOCK'))
      .not.toMatch(/Invalid input|Unrecognized/);
    expect(await sw.executeCommand('permit ip 192.168.10.0 0.0.0.255 any'))
      .not.toMatch(/Invalid input|Unrecognized/);
    expect(await sw.executeCommand('deny ip any any')).not.toMatch(/Invalid input/);
    await sw.executeCommand('end');
    const out = await sw.executeCommand('show access-lists');
    expect(out).not.toMatch(/Invalid input/);
    expect(out).toMatch(/10|BLOCK/);
  });
});

describe('Cisco switch DAI / port-security show', () => {
  it('ip arp inspection + show port-security recognized', async () => {
    const sw = await cfgSwitch();
    for (const c of ['ip arp inspection vlan 10']) {
      expect(await sw.executeCommand(c)).not.toMatch(/Invalid input|Unrecognized/);
    }
    await sw.executeCommand('interface GigabitEthernet0/1');
    expect(await sw.executeCommand('ip arp inspection trust'))
      .not.toMatch(/Invalid input|Unrecognized/);
    await sw.executeCommand('end');
    expect(await sw.executeCommand('show port-security'))
      .not.toMatch(/Invalid input/);
  });
});
