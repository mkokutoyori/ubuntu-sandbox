/**
 * TDD — Lot C: DHCP server pool sub-options as real pool state.
 * next-server/bootfile/netbios/option/lease infinite + manual host
 * reservation are recorded on the real DHCPServer pool and projected
 * by `show ip dhcp pool` — no silent no-ops, no fabricated values.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

describe('Cisco DHCP pool sub-options — real pool state', () => {
  it('next-server/bootfile/netbios/option are recognised and projected', async () => {
    const r = new CiscoRouter('R1');
    await r.executeCommand('enable');
    await r.executeCommand('configure terminal');
    await r.executeCommand('ip dhcp pool LAN');
    for (const c of [
      'network 192.168.1.0 255.255.255.0',
      'default-router 192.168.1.1',
      'dns-server 8.8.8.8',
      'next-server 192.168.1.4',
      'bootfile boot1.bin',
      'netbios-name-server 192.168.1.2',
      'netbios-node-type h-node',
      'option 150 ip 192.168.1.3',
      'option 66 ascii tftp.lab.local',
      'lease infinite',
    ]) {
      expect(await r.executeCommand(c), c).not.toMatch(/Invalid input|Incomplete/);
    }
    await r.executeCommand('end');

    const out = await r.executeCommand('show ip dhcp pool LAN');
    expect(out).not.toMatch(/Invalid input/);
    expect(out).toContain('192.168.1.4');     // next-server
    expect(out).toContain('boot1.bin');        // bootfile
    expect(out).toContain('192.168.1.2');      // netbios server
    expect(out).toContain('Option 150');       // raw option
    expect(out).toContain('tftp.lab.local');   // option 66 ascii
    expect(out).toMatch(/Lease Time +: infinite/);
  });

  it('manual reservation pool (host/hardware-address/client-name) is real', async () => {
    const r = new CiscoRouter('R1');
    await r.executeCommand('enable');
    await r.executeCommand('configure terminal');
    await r.executeCommand('ip dhcp pool RES');
    for (const c of [
      'host 192.168.1.50 255.255.255.0',
      'hardware-address 0011.2233.4455',
      'client-name printer1',
      'client-identifier 0100.1122.3344.55',
    ]) {
      expect(await r.executeCommand(c), c).not.toMatch(/Invalid input|Incomplete/);
    }
    await r.executeCommand('end');

    const out = await r.executeCommand('show ip dhcp pool RES');
    expect(out).toContain('192.168.1.50');
    expect(out).toContain('0011.2233.4455');
    expect(out).toContain('printer1');
  });

  it('client-identifier deny still works (specific over greedy)', async () => {
    const r = new CiscoRouter('R1');
    await r.executeCommand('enable');
    await r.executeCommand('configure terminal');
    await r.executeCommand('ip dhcp pool P');
    await r.executeCommand('network 10.0.0.0 255.255.255.0');
    expect(await r.executeCommand('client-identifier deny 01aa.bbcc.ddee'))
      .not.toMatch(/Invalid input/);
    await r.executeCommand('end');
  });
});
