/*
 * Probe (found by reopening the Meridian enterprise lab): three things typed into a lab were lost or broken by
 * Save/Export then reopen.
 *  1. FortiGate: `config vpn ipsec phase1-interface` rendered AFTER the policies and static routes that name the
 *     tunnel interface it creates, so replaying the export refused every `set device "<tunnel>"` and
 *     `set srcintf "<tunnel>"` and left the VPN empty.
 *  2. Windows DC: records added by hand to an AD-integrated DNS zone were not exported (only the ones the DC
 *     registers itself came back).
 *  3. Windows Exchange: the whole organisation (install, receive connectors, mailboxes) was absent from the export.
 * Discriminated with git stash on src/network, src/store, src/powershell: 3 of 4 fall before the fix; the witness
 * (the same round trip of a plain interface address) passes either way and proves the harness is sound.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { loadAllDevicePlatforms } from '@/network';
import { useNetworkStore } from '@/store/networkStore';
import { exportTopology, importTopology } from '@/store/topologySerializer';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { Logger } from '@/network/core/Logger';
import { LabWorkbench } from '@/labs/LabWorkbench';
import { resetExchangeOrganizations } from '@/network/devices/windows/server/exchange/ExchangeOrganization';
import type { Equipment } from '@/network';

beforeEach(async () => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); EquipmentRegistry.resetInstance(); Logger.reset();
  resetExchangeOrganizations();
  await loadAllDevicePlatforms();
  useNetworkStore.getState().clearAll();
});

async function reopen(): Promise<Map<string, Equipment>> {
  const { deviceInstances, connections } = useNetworkStore.getState();
  const topology = JSON.parse(JSON.stringify(exportTopology('probe', deviceInstances, connections)));
  resetExchangeOrganizations();
  useNetworkStore.getState().clearAll();
  const result = await importTopology(topology);
  useNetworkStore.getState().replaceTopology(result.deviceInstances, result.connections);
  return new Map([...result.deviceInstances.values()].map((d) => [d.getName(), d]));
}

describe('export then reopen', () => {
  it('witness: a FortiGate interface address survives', async () => {
    const bench = new LabWorkbench();
    const fgt = bench.place('firewall-fortinet', 'F1', 0, 0);
    await bench.shell(fgt, 'config system interface', 'edit port1', 'set mode static', 'set ip 10.1.1.1 255.255.255.0', 'next', 'end');
    const devices = await reopen();
    expect(await devices.get('F1')!.executeCommand('show system interface port1')).toContain('10.1.1.1 255.255.255.0');
  });

  it('FortiGate: an IPsec tunnel used by a route and a policy comes back', async () => {
    const bench = new LabWorkbench();
    const fgt = bench.place('firewall-fortinet', 'F1', 0, 0);
    await bench.shell(
      fgt,
      'config system interface', 'edit wan1', 'set mode static', 'set ip 203.0.113.1 255.255.255.0', 'next', 'end',
      'config vpn ipsec phase1-interface', 'edit "to-b"', 'set interface "wan1"', 'set ike-version 2', 'set remote-gw 203.0.113.2',
      'set psksecret sekret123', 'set proposal aes256-sha256', 'next', 'end',
      'config router static', 'edit 1', 'set dst 10.2.0.0 255.255.255.0', 'set device "to-b"', 'next', 'end',
      'config firewall policy', 'edit 1', 'set srcintf "wan1"', 'set dstintf "to-b"', 'set srcaddr "all"', 'set dstaddr "all"',
      'set service "ALL"', 'set action accept', 'set schedule "always"', 'next', 'end',
    );
    const devices = await reopen();
    const f = devices.get('F1')!;
    expect(await f.executeCommand('show vpn ipsec phase1-interface')).toContain('edit "to-b"');
    expect(await f.executeCommand('show router static')).toContain('set device "to-b"');
    expect(await f.executeCommand('show firewall policy')).toContain('set dstintf "to-b"');
  });

  it('Windows DC: a record added by hand to the AD-integrated zone comes back', async () => {
    const bench = new LabWorkbench();
    const dc = bench.place('windows-server', 'DC1', 0, 0);
    await bench.powershell(
      dc,
      'Install-WindowsFeature -Name AD-Domain-Services -IncludeManagementTools', 'Install-WindowsFeature DNS -IncludeManagementTools',
      'Install-ADDSForest -DomainName probe.lan -DomainNetBiosName PROBE -SafeModeAdministratorPassword (ConvertTo-SecureString "DSRM@Probe1!" -AsPlainText -Force) -Force:$true',
      'Add-DnsServerResourceRecordA -ZoneName probe.lan -Name db -IPv4Address 10.9.9.9',
    );
    const devices = await reopen();
    const shell = (await import('@/terminal/subshells/PowerShellSubShell')).PowerShellSubShell.create(devices.get('DC1') as never).subShell;
    const out = (await shell.processLine('Resolve-DnsName db.probe.lan -Server 127.0.0.1')).output.join('\n');
    expect(out).toContain('10.9.9.9');
  });

  it('Windows Exchange: the organisation and its listening receive connector come back', async () => {
    const bench = new LabWorkbench();
    const mx = bench.place('windows-server', 'MX1', 0, 0);
    await bench.powershell(
      mx,
      'Install-WindowsFeature -Name AD-Domain-Services -IncludeManagementTools',
      'Install-ADDSForest -DomainName probe.lan -DomainNetBiosName PROBE -SafeModeAdministratorPassword (ConvertTo-SecureString "DSRM@Probe1!" -AsPlainText -Force) -Force:$true',
      'Install-ExchangeServer -Roles Mailbox -OrganizationName "Probe"',
    );
    const devices = await reopen();
    const shell = (await import('@/terminal/subshells/PowerShellSubShell')).PowerShellSubShell.create(devices.get('MX1') as never).subShell;
    expect((await shell.processLine('Get-ExchangeServer')).output.join('\n')).toContain('MX1');
    expect((await shell.processLine('Get-ReceiveConnector')).output.join('\n')).toContain('Default Frontend MX1');
  });
});
