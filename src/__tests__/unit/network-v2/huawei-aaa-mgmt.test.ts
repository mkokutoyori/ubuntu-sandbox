/**
 * TDD — Huawei AAA / user-interface / SSH-Telnet / SNMP / NTP / syslog.
 *
 * Surfaced by debug-output/huawei/huawei-security-mgmt. The simple
 * management-plane commands are common to the switch AND the router, so
 * they live in a shared module (DRY); the aaa/user-interface sub-views
 * are switch-FSM-specific.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { HuaweiSwitch } from '@/network/devices/HuaweiSwitch';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
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

describe('Huawei AAA sub-view', () => {
  it('aaa enters [SW1-aaa]; local-user commands recognized', async () => {
    const sw = await sysSwitch();
    expect(await sw.executeCommand('aaa')).not.toMatch(/Unrecognized command/);
    expect(sw.getPrompt()).toBe('[SW1-aaa]');
    for (const c of [
      'local-user admin password irreversible-cipher Huawei@123',
      'local-user admin privilege level 15',
      'local-user admin service-type ssh telnet terminal']) {
      expect(await sw.executeCommand(c)).not.toMatch(/Unrecognized command/);
    }
    await sw.executeCommand('quit');
    expect(sw.getPrompt()).toBe('[SW1]');
    const out = await sw.executeCommand('display local-user');
    expect(out).not.toMatch(/Unrecognized command/);
    expect(out).toContain('admin');
  });
});

describe('Huawei user-interface sub-view', () => {
  it('user-interface vty enters view; auth/protocol recognized', async () => {
    const sw = await sysSwitch();
    expect(await sw.executeCommand('user-interface vty 0 4'))
      .not.toMatch(/Unrecognized command/);
    expect(sw.getPrompt()).toBe('[SW1-ui-vty0-4]');
    for (const c of ['authentication-mode aaa', 'protocol inbound ssh',
      'user privilege level 15', 'idle-timeout 10 0']) {
      expect(await sw.executeCommand(c)).not.toMatch(/Unrecognized command/);
    }
    await sw.executeCommand('quit');
    expect(sw.getPrompt()).toBe('[SW1]');
  });

  it('user-interface console 0 also works', async () => {
    const sw = await sysSwitch();
    expect(await sw.executeCommand('user-interface console 0'))
      .not.toMatch(/Unrecognized command/);
    expect(sw.getPrompt()).toBe('[SW1-ui-console0]');
  });
});

describe('Huawei SSH / Telnet / SNMP / NTP / syslog (shared switch+router)', () => {
  it('switch: server + ssh user + snmp + ntp + info-center recognized', async () => {
    const sw = await sysSwitch();
    for (const c of ['stelnet server enable', 'telnet server enable',
      'ssh user admin authentication-type password',
      'ssh user admin service-type stelnet',
      'snmp-agent sys-info version v2c v3',
      'snmp-agent community read cipher public',
      'ntp-service unicast-server 10.0.0.1',
      'clock timezone UTC add 00:00',
      'info-center enable', 'info-center loghost 10.0.0.251',
      'sflow collector 1 ip 10.0.0.252']) {
      expect(await sw.executeCommand(c)).not.toMatch(/Unrecognized command/);
    }
    await sw.executeCommand('return');
    expect(await sw.executeCommand('display ssh server status'))
      .not.toMatch(/Unrecognized command/);
    expect(await sw.executeCommand('display snmp-agent sys-info'))
      .not.toMatch(/Unrecognized command/);
    expect(await sw.executeCommand('display ntp-service status'))
      .not.toMatch(/Unrecognized command/);
  });

  it('router: the same shared commands work (DRY)', async () => {
    const r = new HuaweiRouter('R1');
    await r.executeCommand('system-view');
    for (const c of ['stelnet server enable', 'telnet server enable',
      'snmp-agent sys-info version v2c v3', 'ntp-service unicast-server 10.0.0.1',
      'info-center enable']) {
      expect(await r.executeCommand(c)).not.toMatch(/Unrecognized command/);
    }
    await r.executeCommand('return');
    expect(await r.executeCommand('display ssh server status'))
      .not.toMatch(/Unrecognized command/);
  });
});
