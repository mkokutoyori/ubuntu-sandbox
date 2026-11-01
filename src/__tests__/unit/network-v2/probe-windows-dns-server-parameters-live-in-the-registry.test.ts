/*
 * Probe — the Windows DNS server keeps its forwarders, its forwarding timeout, its "use root hints" choice and
 * its recursion switch in the registry value that holds them, which reg.exe, the DnsServer cmdlets, the resolver
 * and a saved topology all read.
 *
 * Measured first (a Windows Server with the DNS role, `Set-DnsServerForwarder -IPAddress 10.0.0.20`,
 * `Set-DnsServerRecursion -Enable $false`): `reg query HKLM\SYSTEM\CurrentControlSet\Services\DNS\Parameters`
 * answered "unable to find the specified registry key" — the forwarder lived in a private field of the role —
 * and a topology exported and reopened came back with an empty forwarder list and recursion enabled, so a
 * lab whose domain controller forwarded to a resolver lost its name resolution on the first reload.
 *
 * Authority: official_docs (Windows Commands, dnscmd /config): "Changes values in the registry for the DNS
 * server" — /forwardingtimeout [seconds], /isslave [0|1] ("1 - the DNS server is a subordinate: if the
 * forwarder doesn't respond, the DNS server terminates the search"), /norecursion [0|1]. The multi-string
 * Forwarders value is the one the DnsServer service reads at start. `EnableForwarderReordering` is the
 * simulator's own name for the "forwarder reordering" property of Get-DnsServerForwarder, which the
 * documentation gives no registry name for.
 *
 * Discrimination (the probe run on the tree before the change): 5 of the 7 cases fall. The two that pass either
 * way are the WITNESS (the cmdlet sets and reads the forwarder) and the NON-REGRESSION "forwards to the
 * forwarder the cmdlet set" (the resolver already forwarded to what the cmdlet set; the change moves where
 * that fact is kept, not whether it is honoured).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, MACAddress } from '@/network/core/types';
import { createDevice, resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import type { Equipment } from '@/network/equipment/Equipment';
import type { WindowsPC } from '@/network/devices/WindowsPC';
import type { LinuxServer } from '@/network/devices/LinuxServer';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';
import { buildConnection, type Connection } from '@/store/networkStore';
import { exportTopology, importTopology, type TopologyExport } from '@/store/topologySerializer';
import type { VirtualFileSystem } from '@/network/devices/linux/VirtualFileSystem';

const PARAMETERS = 'HKLM\\SYSTEM\\CurrentControlSet\\Services\\DNS\\Parameters';

const CORP_ZONE = [
  '$TTL 3600',
  '$ORIGIN corp.test.',
  '@ IN SOA ns.corp.test. hostmaster.corp.test. ( 1 3600 900 604800 300 )',
  '@ IN NS ns.corp.test.',
  'ns IN A 10.0.0.20',
  'portal IN A 10.0.0.80',
  '',
].join('\n');

beforeEach(() => {
  resetCounters();
  MACAddress.resetCounter();
  resetDeviceCounters();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

const psOf = (device: Equipment) => {
  const shell = PowerShellSubShell.create(device as never).subShell;
  return async (line: string): Promise<string> => (await shell.processLine(line)).output.join('\n');
};

interface Lab {
  devices: Map<string, Equipment>;
  connections: Connection[];
}

async function lab(): Promise<Lab> {
  const sw = createDevice('switch-generic', 0, 0, 'SW');
  const corp = createDevice('linux-server', 0, 0, 'CORP') as unknown as LinuxServer;
  const dns1 = createDevice('windows-server', 0, 0, 'DNS1') as unknown as WindowsPC;
  const win = createDevice('windows-pc', 0, 0, 'WIN1') as unknown as WindowsPC;
  const connections = [
    buildConnection(corp as unknown as Equipment, 'eth0', sw, sw.getPorts()[0].getName(), 'ethernet'),
    buildConnection(dns1 as unknown as Equipment, 'eth0', sw, sw.getPorts()[1].getName(), 'ethernet'),
    buildConnection(win as unknown as Equipment, 'eth0', sw, sw.getPorts()[2].getName(), 'ethernet'),
  ].filter((c): c is Connection => c !== null);
  const vfs = (corp as unknown as { executor: { vfs: VirtualFileSystem } }).executor.vfs;
  vfs.writeFile('/etc/bind/named.conf', 'options { directory "/var/cache/bind"; recursion no; };\nzone "corp.test" { type primary; file "/etc/bind/db.corp"; };\n', 0, 0, 0o022);
  vfs.writeFile('/etc/bind/db.corp', CORP_ZONE, 0, 0, 0o022);
  await corp.executeCommand('sudo ip addr add 10.0.0.20/24 dev eth0');
  await corp.executeCommand('systemctl start named');
  dns1.setCurrentUser('Administrator');
  win.setCurrentUser('Administrator');
  const admin = psOf(dns1 as unknown as Equipment);
  await admin('New-NetIPAddress -InterfaceAlias "Ethernet 0" -IPAddress 10.0.0.30 -PrefixLength 24');
  await admin('Install-WindowsFeature DNS -IncludeManagementTools');
  await psOf(win as unknown as Equipment)('New-NetIPAddress -InterfaceAlias "Ethernet 0" -IPAddress 10.0.0.100 -PrefixLength 24');
  const devices = new Map<string, Equipment>([sw, corp as unknown as Equipment, dns1 as unknown as Equipment, win as unknown as Equipment].map((d) => [d.getId(), d]));
  return { devices, connections };
}

const byName = (source: Lab): Map<string, Equipment> =>
  new Map([...source.devices.values()].map((d) => [d.getName(), d]));

async function reopened(source: Lab): Promise<Map<string, Equipment>> {
  const exported = JSON.parse(JSON.stringify(exportTopology('lab', source.devices, source.connections))) as TopologyExport;
  EquipmentRegistry.resetInstance();
  const imported = await importTopology(exported);
  return new Map([...imported.deviceInstances.values()].map((d) => [d.getName(), d]));
}

describe('the cmdlets and the registry are two views of one store', () => {
  it('Set-DnsServerForwarder sets what Get-DnsServerForwarder reads — WITNESS', async () => {
    const devices = byName(await lab());
    const admin = psOf(devices.get('DNS1')!);

    await admin('Set-DnsServerForwarder -IPAddress 10.0.0.20');
    expect(await admin('(Get-DnsServerForwarder).IPAddress -join ","')).toBe('10.0.0.20');
  }, 60000);

  it('the forwarder is the multi-string value reg query shows', async () => {
    const devices = byName(await lab());
    const admin = psOf(devices.get('DNS1')!);

    await admin('Set-DnsServerForwarder -IPAddress 10.0.0.20,10.0.0.21 -Timeout 5 -UseRootHint $false');
    const dump = await devices.get('DNS1')!.executeCommand(`reg query ${PARAMETERS}`);
    expect(dump).toMatch(/Forwarders\s+REG_MULTI_SZ\s+10\.0\.0\.20\\010\.0\.0\.21/);
    expect(dump).toMatch(/ForwardingTimeout\s+REG_DWORD\s+0x5/);
    expect(dump).toMatch(/IsSlave\s+REG_DWORD\s+0x1/);
  }, 60000);

  it('reg add on the value changes what the cmdlet reports', async () => {
    const devices = byName(await lab());
    const dns1 = devices.get('DNS1')!;
    const admin = psOf(dns1);

    await dns1.executeCommand(`reg add ${PARAMETERS} /v Forwarders /t REG_MULTI_SZ /d "10.0.0.54\\010.0.0.55" /f`);
    expect(await admin('(Get-DnsServerForwarder).IPAddress -join ","')).toBe('10.0.0.54,10.0.0.55');
  }, 60000);

  it('recursion is the NoRecursion value, in both directions', async () => {
    const devices = byName(await lab());
    const dns1 = devices.get('DNS1')!;
    const admin = psOf(dns1);

    await admin('Set-DnsServerRecursion -Enable $false');
    expect(await dns1.executeCommand(`reg query ${PARAMETERS} /v NoRecursion`)).toMatch(/NoRecursion\s+REG_DWORD\s+0x1/);
    await dns1.executeCommand(`reg add ${PARAMETERS} /v NoRecursion /t REG_DWORD /d 0 /f`);
    expect(await admin('(Get-DnsServerRecursion).Enable')).toBe('True');
  }, 60000);
});

describe('the resolver follows the registry', () => {
  it('forwards to the forwarder the cmdlet set', async () => {
    const devices = byName(await lab());
    await psOf(devices.get('DNS1')!)('Set-DnsServerForwarder -IPAddress 10.0.0.20 -UseRootHint $false');

    expect(await psOf(devices.get('WIN1')!)('(Resolve-DnsName portal.corp.test -Server 10.0.0.30).IPAddress')).toBe('10.0.0.80');
  }, 60000);

  it('forwards to a forwarder written with reg add, and refuses once NoRecursion is 1', async () => {
    const devices = byName(await lab());
    const dns1 = devices.get('DNS1')!;
    const client = psOf(devices.get('WIN1')!);

    await dns1.executeCommand(`reg add ${PARAMETERS} /v Forwarders /t REG_MULTI_SZ /d "10.0.0.20" /f`);
    await dns1.executeCommand(`reg add ${PARAMETERS} /v IsSlave /t REG_DWORD /d 1 /f`);
    expect(await client('(Resolve-DnsName portal.corp.test -Server 10.0.0.30).IPAddress')).toBe('10.0.0.80');
    await dns1.executeCommand(`reg add ${PARAMETERS} /v NoRecursion /t REG_DWORD /d 1 /f`);
    expect(await client('(Resolve-DnsName portal.corp.test -Server 10.0.0.30 -ErrorAction SilentlyContinue).IPAddress')).not.toBe('10.0.0.80');
  }, 60000);
});

describe('a reopened topology', () => {
  it('keeps the forwarder, the timeout and recursion, and still forwards', async () => {
    const source = await lab();
    const admin = psOf(byName(source).get('DNS1')!);
    await admin('Set-DnsServerForwarder -IPAddress 10.0.0.20 -Timeout 5 -UseRootHint $false');
    await admin('Set-DnsServerRecursion -Enable $true');

    const devices = await reopened(source);
    const back = psOf(devices.get('DNS1')!);
    expect(await back('(Get-DnsServerForwarder).IPAddress -join ","')).toBe('10.0.0.20');
    expect(await back('(Get-DnsServerForwarder).Timeout')).toBe('5');
    expect(await psOf(devices.get('WIN1')!)('(Resolve-DnsName portal.corp.test -Server 10.0.0.30).IPAddress')).toBe('10.0.0.80');
  }, 60000);
});
