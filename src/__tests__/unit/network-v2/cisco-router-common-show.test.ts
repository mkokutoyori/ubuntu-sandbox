/**
 * TDD — anomalies from debug-output/router/cisco-*. A large family of
 * generic IOS "show" commands is missing on BOTH the Cisco router and
 * switch (they share CiscoShellBase), so the fix belongs in the shared
 * base / CiscoCommonShow (DRY) — never duplicated per device.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

const COMMON_SHOW = [
  'show cdp', 'show cdp neighbors', 'show cdp neighbors detail',
  'show cdp interface', 'show lldp', 'show lldp neighbors',
  'show lldp neighbors detail', 'show snmp', 'show ntp status',
  'show ntp associations', 'show controllers', 'show environment',
  'show line', 'show ssh', 'show ip ssh', 'show hosts', 'show vrf',
  'show ip vrf', 'show boot', 'show redundancy', 'show file systems',
  'show calendar', 'show terminal', 'show processes memory',
  'show buffers', 'show tcp brief', 'show sockets', 'show stacks',
  'show reload', 'show aaa sessions',
];

describe('Cisco common show family (router & switch, DRY)', () => {
  it('router: every generic show command is recognized (priv)', async () => {
    const r = new CiscoRouter('R1');
    await r.executeCommand('enable');
    for (const c of COMMON_SHOW) {
      const out = await r.executeCommand(c);
      expect(out, `router: ${c}`).not.toMatch(/Invalid input|Unrecognized|Incomplete/);
    }
  });

  it('router: generic show commands also recognized in user mode', async () => {
    const r = new CiscoRouter('R1');
    for (const c of ['show cdp neighbors', 'show ntp status', 'show line',
      'show hosts', 'show terminal']) {
      const out = await r.executeCommand(c);
      expect(out, `router-user: ${c}`).not.toMatch(/Invalid input|Unrecognized|Incomplete/);
    }
  });

  it('switch: the same shared show commands work (DRY)', async () => {
    const sw = new CiscoSwitch('switch-cisco', 'SW1', 26);
    await sw.executeCommand('enable');
    for (const c of COMMON_SHOW) {
      const out = await sw.executeCommand(c);
      expect(out, `switch: ${c}`).not.toMatch(/Invalid input|Unrecognized|Incomplete/);
    }
  });

  it('content sanity: cdp/ntp/line produce plausible output', async () => {
    const r = new CiscoRouter('R1');
    await r.executeCommand('enable');
    expect(await r.executeCommand('show cdp')).toMatch(/CDP|Sending|enabled/i);
    expect(await r.executeCommand('show ntp status')).toMatch(/clock|stratum|synchroniz/i);
    expect(await r.executeCommand('show line')).toMatch(/Tty|Line|con|vty/i);
  });

  it('REAL state: CDP/LLDP reflect the actual cabled neighbour', async () => {
    const r1 = new CiscoRouter('R1');
    const r2 = new CiscoRouter('R2');
    const pc = new LinuxPC('linux-pc', 'L1', 0, 0);
    new Cable('w1').connect(r1.getPort('GigabitEthernet0/1')!, r2.getPort('GigabitEthernet0/1')!);
    new Cable('w2').connect(r1.getPort('GigabitEthernet0/0')!, pc.getPort('eth0')!);
    await r1.executeCommand('enable');

    const cdp = await r1.executeCommand('show cdp neighbors');
    // The real peers (R2 on Gi0/1, L1 on Gi0/0) must appear; an
    // unconnected port (Gi0/2) must NOT manufacture an entry.
    expect(cdp).toContain('R2');
    expect(cdp).toContain('L1');
    expect(cdp).toMatch(/Total cdp entries displayed : 2/);
    const cdpDetail = await r1.executeCommand('show cdp neighbors detail');
    expect(cdpDetail).toContain('R2');
    expect(cdpDetail).toMatch(/Port ID \(outgoing port\): GigabitEthernet0\/1/);

    // LLDP is disabled by default on Cisco — enabling it is real state.
    await r1.executeCommand('configure terminal');
    await r1.executeCommand('lldp run');
    await r1.executeCommand('end');
    const lldp = await r1.executeCommand('show lldp neighbors');
    expect(lldp).toContain('R2');
    expect(lldp).toMatch(/Total entries displayed: 2/);
  });

  it('REAL state: show interfaces reflects configured IP & link', async () => {
    const r = new CiscoRouter('R1');
    await r.executeCommand('enable');
    await r.executeCommand('configure terminal');
    await r.executeCommand('interface GigabitEthernet0/0');
    await r.executeCommand('ip address 192.168.5.1 255.255.255.0');
    await r.executeCommand('description UPLINK-TEST');
    await r.executeCommand('end');

    const all = await r.executeCommand('show interfaces');
    expect(all).toContain('GigabitEthernet0/0');
    expect(all).toContain('192.168.5.1');

    const desc = await r.executeCommand('show interfaces description');
    expect(desc).toContain('UPLINK-TEST');

    const ipif = await r.executeCommand('show ip interface');
    expect(ipif).toContain('192.168.5.1');
    expect(ipif).toContain('GigabitEthernet0/0');
  });
});
