/*
 * Probe — a saved topology brings a DHCP client back as a DHCP client, with its lease, and the DHCP server back
 * with the binding that lease points to.
 *
 * Measured first (a Windows Server with the DHCP role, a Windows client and a Linux client that took their
 * lease from it, exported and re-imported): the clients came back with the leased address stored as a STATIC
 * address — `ipconfig /all` said "DHCP Enabled. . . : No" and listed no DNS server and no DNS suffix, the Linux
 * client lost its `dynamic` flag — and the server came back with its scope and an empty lease table, so the
 * next `ipconfig /renew` was free to hand a different address. A lab whose clients resolve names through the
 * DNS servers the DHCP server announces lost its name resolution on the first reload.
 *
 * Authority: RFC 2131 §4.4.1 and §4.3.2 — a client keeps the lease record it was given (its "lease database")
 * and asks for the same address again when it starts; a server remembers the binding. A saved machine is a
 * machine that was running and starts again: both sides are put back as they were, the lease running again for
 * its whole duration from the moment the topology is opened.
 *
 * Discrimination (the probe run on the tree before the change): 6 of the 9 cases fall. The three that pass
 * either way: the two WITNESSES, "hands out .100 and .101 before any export" and "the client holds the lease
 * before the export", which prove the lab itself is sound; and "a renewal keeps the address it had", a
 * NON-REGRESSION (before the change the client is static and keeps its address, after it the restored lease is
 * renewed and keeps it too).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, MACAddress } from '@/network/core/types';
import { createDevice, resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import type { Equipment } from '@/network/equipment/Equipment';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';
import { buildConnection, type Connection } from '@/store/networkStore';
import { exportTopology, importTopology, type TopologyExport } from '@/store/topologySerializer';

beforeEach(() => {
  resetCounters();
  MACAddress.resetCounter();
  resetDeviceCounters();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

interface Lab {
  devices: Map<string, Equipment>;
  connections: Connection[];
}

const psOf = (device: Equipment) => {
  const shell = PowerShellSubShell.create(device as never).subShell;
  return async (line: string): Promise<string> => (await shell.processLine(line)).output.join('\n');
};

async function lab(): Promise<Lab> {
  const sw = createDevice('switch-generic', 0, 0, 'SW');
  const server = createDevice('windows-server', 0, 0, 'DHCP1');
  const winClient = createDevice('windows-pc', 0, 0, 'WIN1');
  const linuxClient = createDevice('linux-pc', 0, 0, 'LIN1');
  const connections = [
    buildConnection(server, 'eth0', sw, sw.getPorts()[0].getName(), 'ethernet'),
    buildConnection(winClient, 'eth0', sw, sw.getPorts()[1].getName(), 'ethernet'),
    buildConnection(linuxClient, 'eth0', sw, sw.getPorts()[2].getName(), 'ethernet'),
  ].filter((c): c is Connection => c !== null);
  const admin = psOf(server);
  await admin('New-NetIPAddress -InterfaceAlias "Ethernet 0" -IPAddress 10.0.0.10 -PrefixLength 24');
  await admin('Install-WindowsFeature DHCP -IncludeManagementTools');
  await admin('Add-DhcpServerv4Scope -Name LAB -StartRange 10.0.0.100 -EndRange 10.0.0.110 -SubnetMask 255.255.255.0');
  await admin('Set-DhcpServerv4OptionValue -ScopeId 10.0.0.0 -Router 10.0.0.1 -DnsServer 10.0.0.53 -DnsDomain lab.test');
  await winClient.executeCommand('ipconfig /renew');
  await linuxClient.executeCommand('sudo dhclient eth0');
  const devices = new Map<string, Equipment>([sw, server, winClient, linuxClient].map((d) => [d.getId(), d as unknown as Equipment]));
  return { devices, connections };
}

async function reopened(source: Lab): Promise<Map<string, Equipment>> {
  const exported = JSON.parse(JSON.stringify(exportTopology('lab', source.devices, source.connections))) as TopologyExport;
  EquipmentRegistry.resetInstance();
  const imported = await importTopology(exported);
  return new Map([...imported.deviceInstances.values()].map((d) => [d.getName(), d]));
}

const byName = (source: Lab): Map<string, Equipment> =>
  new Map([...source.devices.values()].map((d) => [d.getName(), d]));

describe('the lab before any export (witnesses)', () => {
  it('hands out .100 and .101 before any export', async () => {
    const devices = byName(await lab());

    expect(await devices.get('WIN1')!.executeCommand('ipconfig')).toContain('10.0.0.100');
    expect(await devices.get('LIN1')!.executeCommand('ip -4 addr show eth0')).toContain('10.0.0.101');
  }, 60000);

  it('the client holds the lease before the export', async () => {
    const devices = byName(await lab());

    const all = await devices.get('WIN1')!.executeCommand('ipconfig /all');
    expect(all).toMatch(/DHCP Enabled\. \. \. \. \. \. \. \. \. \. \. : Yes/);
    expect(all).toMatch(/DNS Servers[ .]*: 10\.0\.0\.53/);
  }, 60000);
});

describe('the exported file', () => {
  it('does not store a leased address as a static one', async () => {
    const source = await lab();

    const exported = exportTopology('lab', source.devices, source.connections);
    const win = exported.devices.find((d) => d.name === 'WIN1')!;
    expect(win.interfaces.find((i) => i.name === 'eth0')?.ipAddress).toBeUndefined();
    expect(win.defaultGateway).toBeUndefined();
  }, 60000);

  it('carries the lease of each client', async () => {
    const source = await lab();

    const exported = exportTopology('lab', source.devices, source.connections);
    const leases = (name: string) => exported.devices.find((d) => d.name === name)?.dhcpLeases?.map((l) => l.lease.ipAddress);
    expect(leases('WIN1')).toEqual(['10.0.0.100']);
    expect(leases('LIN1')).toEqual(['10.0.0.101']);
  }, 60000);
});

describe('the reopened lab', () => {
  it('Windows client is a DHCP client again, with the options of its lease', async () => {
    const devices = await reopened(await lab());

    const all = await devices.get('WIN1')!.executeCommand('ipconfig /all');
    expect(all).toMatch(/DHCP Enabled\. \. \. \. \. \. \. \. \. \. \. : Yes/);
    expect(all).toMatch(/IPv4 Address[ .]*: 10\.0\.0\.100/);
    expect(all).toMatch(/DNS Servers[ .]*: 10\.0\.0\.53/);
    expect(all).toMatch(/Connection-specific DNS Suffix[ .]*: lab\.test/);
    expect(all).toMatch(/DHCP Server[ .]*: 10\.0\.0\.10/);
  }, 60000);

  it('Linux client keeps a dynamic address and the default route it learned', async () => {
    const devices = await reopened(await lab());

    expect(await devices.get('LIN1')!.executeCommand('ip -4 addr show eth0')).toMatch(/inet 10\.0\.0\.101\/24 .* dynamic /);
    expect(await devices.get('LIN1')!.executeCommand('ip route')).toContain('default via 10.0.0.1 dev eth0 proto dhcp');
  }, 60000);

  it('the server still knows both bindings', async () => {
    const devices = await reopened(await lab());

    const leases = await psOf(devices.get('DHCP1')!)('Get-DhcpServerv4Lease -ScopeId 10.0.0.0');
    expect(leases).toContain('10.0.0.100');
    expect(leases).toContain('10.0.0.101');
  }, 60000);

  it('a renewal keeps the address it had', async () => {
    const devices = await reopened(await lab());

    await devices.get('WIN1')!.executeCommand('ipconfig /renew');
    expect(await devices.get('WIN1')!.executeCommand('ipconfig')).toContain('10.0.0.100');
  }, 60000);

  it('a new client does not receive an address a restored binding holds', async () => {
    const devices = await reopened(await lab());
    const late = createDevice('windows-pc', 0, 0, 'WIN2');
    const sw = devices.get('SW')!;
    buildConnection(late, 'eth0', sw, sw.getPorts()[3].getName(), 'ethernet');

    await late.executeCommand('ipconfig /renew');
    expect(await late.executeCommand('ipconfig')).toContain('10.0.0.102');
  }, 60000);
});
