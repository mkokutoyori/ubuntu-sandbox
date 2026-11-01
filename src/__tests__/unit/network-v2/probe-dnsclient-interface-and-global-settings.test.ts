/*
 * Probe — the DnsClient module's per-interface and global settings: Get-DnsClient, Set-DnsClient,
 * Register-DnsClient, Get-DnsClientGlobalSetting, Set-DnsClientGlobalSetting.
 *
 * Measured first (Windows client, Windows PowerShell 5.1 session): none of the five cmdlets existed
 * ("The term 'Get-DnsClient' is not recognized ..."), so the connection-specific DNS suffix, the
 * registration policy of a connection, the global suffix search list and the devolution rule could be read
 * from `ipconfig /all` and `nslookup` only, and not changed from PowerShell at all.
 *
 * Source: Microsoft Learn, module DnsClient (reference of each cmdlet): the property names of MSFT_DNSClient
 * and MSFT_DNSClientGlobalSetting, the -Reset switch, -PassThru, the pipeline from Get-DnsClient, and
 * "Register-DnsClient ... is equivalent to running ipconfig /registerdns".
 *
 * The settings are values of the machine's registry (Tcpip\Parameters\Interfaces\{guid}: Domain,
 * DisableDynamicUpdate, RegisterAdapterName; Tcpip\Parameters: SearchList, UseDomainNameDevolution), read back
 * by `reg query` and by the DNS client that resolves single-label names, so the cmdlets, reg.exe and the
 * resolver are three views of one store.
 *
 * Discrimination (the probe run on the tree before the change): all 14 cases fall; the cmdlets did not exist.
 * Cases that pass either way: none. "ipconfig /all keeps showing a suffix the cmdlet did not set" is the
 * WITNESS inside the third case (the lab prints the line before the cmdlet is used).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';
import type { VirtualFileSystem } from '@/network/devices/linux/VirtualFileSystem';

const CORP_IP = '10.0.0.20';
const WIN_IP = '10.0.0.100';

const CORP_ZONE = [
  '$TTL 3600',
  '$ORIGIN corp.test.',
  '@ IN SOA ns.corp.test. hostmaster.corp.test. ( 1 3600 900 604800 300 )',
  '@ IN NS ns.corp.test.',
  `ns IN A ${CORP_IP}`,
  'portal IN A 10.0.0.80',
  '',
].join('\n');

const vfsOf = (server: LinuxServer): VirtualFileSystem =>
  (server as unknown as { executor: { vfs: VirtualFileSystem } }).executor.vfs;

async function lab() {
  const sw = new GenericSwitch('switch-generic', 'SW', 8, 0, 0);
  const corp = new LinuxServer('linux-server', 'CORP');
  const win = new WindowsPC('windows-pc', 'WIN');
  win.powerOn();
  win.setCurrentUser('Administrator');
  const mask = new SubnetMask('255.255.255.0');
  [corp, win].forEach((device, index) => {
    new Cable(`c${index}`).connect(device.getPorts()[0], sw.getPorts()[index]);
    device.getPorts()[0].configureIP(new IPAddress([CORP_IP, WIN_IP][index]), mask);
  });
  vfsOf(corp).writeFile('/etc/bind/named.conf', 'options { directory "/var/cache/bind"; recursion no; };\nzone "corp.test" { type primary; file "/etc/bind/db.corp"; };\n', 0, 0, 0o022);
  vfsOf(corp).writeFile('/etc/bind/db.corp', CORP_ZONE, 0, 0, 0o022);
  await corp.executeCommand('systemctl start named');
  const shell = PowerShellSubShell.create(win).subShell;
  const ps = async (line: string): Promise<string> => (await shell.processLine(line)).output.join('\n');
  await ps(`Set-DnsClientServerAddress -InterfaceAlias "Ethernet 0" -ServerAddresses ${CORP_IP}`);
  return { win, ps };
}

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.clear();
});

describe('Get-DnsClient and Set-DnsClient', () => {
  it('lists the connection with the Windows defaults, as a table', async () => {
    const { ps } = await lab();
    const out = await ps('Get-DnsClient');
    expect(out).toMatch(/InterfaceAlias\s+InterfaceIndex\s+ConnectionSpecificSuffix\s+ConnectionSpecificSuffixSearchList\s+RegisterThisConnectionsAddress\s+UseSuffixWhenRegistering/);
    expect(out).toMatch(/Ethernet 0\s+\d+\s+.*True\s+False/);
  });

  it('filters by alias and refuses an alias that does not exist in the words of the CIM class', async () => {
    const { ps } = await lab();
    expect(await ps('(Get-DnsClient -InterfaceAlias "Ethernet 0").InterfaceAlias')).toContain('Ethernet 0');
    expect(await ps('Get-DnsClient -InterfaceAlias Nope')).toContain("No MSFT_DNSClient objects found with property 'InterfaceAlias' equal to 'Nope'.");
  });

  it('sets the connection-specific suffix, which ipconfig /all reports too', async () => {
    const { win, ps } = await lab();
    expect(await win.executeCommand('ipconfig /all')).not.toContain('corp.test');
    await ps('Set-DnsClient -InterfaceAlias "Ethernet 0" -ConnectionSpecificSuffix corp.test');
    expect(await ps('(Get-DnsClient -InterfaceAlias "Ethernet 0").ConnectionSpecificSuffix')).toBe('corp.test');
    expect(await win.executeCommand('ipconfig /all')).toMatch(/Connection-specific DNS Suffix\s*\.*\s*: corp\.test/);
  });

  it('resolves a single-label name through the connection-specific suffix it set', async () => {
    const { ps } = await lab();
    expect(await ps('Resolve-DnsName portal')).toContain('does not exist');
    await ps('Set-DnsClient -InterfaceAlias "Ethernet 0" -ConnectionSpecificSuffix corp.test');
    expect(await ps('(Resolve-DnsName portal).IPAddress')).toBe('10.0.0.80');
  });

  it('resets the suffix with -ResetConnectionSpecificSuffix', async () => {
    const { ps } = await lab();
    await ps('Set-DnsClient -InterfaceAlias "Ethernet 0" -ConnectionSpecificSuffix corp.test');
    await ps('Set-DnsClient -InterfaceAlias "Ethernet 0" -ResetConnectionSpecificSuffix');
    expect(await ps('(Get-DnsClient -InterfaceAlias "Ethernet 0").ConnectionSpecificSuffix')).toBe('');
  });

  it('changes the registration policy and writes it where reg.exe reads it', async () => {
    const { win, ps } = await lab();
    await ps('Set-DnsClient -InterfaceAlias "Ethernet 0" -RegisterThisConnectionsAddress $false -UseSuffixWhenRegistering $true');
    const row = await ps('Get-DnsClient -InterfaceAlias "Ethernet 0" | Format-List RegisterThisConnectionsAddress,UseSuffixWhenRegistering');
    expect(row).toMatch(/RegisterThisConnectionsAddress\s*:\s*False/);
    expect(row).toMatch(/UseSuffixWhenRegistering\s*:\s*True/);
    const dump = await win.executeCommand('reg query HKLM\\SYSTEM\\CurrentControlSet\\Services\\Tcpip\\Parameters\\Interfaces /s');
    expect(dump).toMatch(/DisableDynamicUpdate\s+REG_DWORD\s+0x1/);
    expect(dump).toMatch(/RegisterAdapterName\s+REG_DWORD\s+0x1/);
  });

  it('takes its targets from the pipeline of Get-DnsClient and returns them with -PassThru', async () => {
    const { ps } = await lab();
    const out = await ps('Get-DnsClient -InterfaceAlias "Ethernet 0" | Set-DnsClient -ConnectionSpecificSuffix lab.test -PassThru | Select-Object -ExpandProperty ConnectionSpecificSuffix');
    expect(out.trim()).toBe('lab.test');
  });

  it('asks for the interface when none is given', async () => {
    const { ps } = await lab();
    expect(await ps('Set-DnsClient -ConnectionSpecificSuffix corp.test')).toContain('missing mandatory parameters: InterfaceAlias');
  });
});

describe('Get-DnsClientGlobalSetting and Set-DnsClientGlobalSetting', () => {
  it('reports the Windows defaults', async () => {
    const { ps } = await lab();
    const out = await ps('Get-DnsClientGlobalSetting');
    expect(out).toMatch(/UseSuffixSearchList\s*:\s*True/);
    expect(out).toMatch(/SuffixSearchList\s*:\s*\{\}/);
    expect(out).toMatch(/UseDevolution\s*:\s*True/);
    expect(out).toMatch(/DevolutionLevel\s*:\s*0/);
  });

  it('stores the suffix search list where Windows keeps it and reads it back', async () => {
    const { win, ps } = await lab();
    await ps('Set-DnsClientGlobalSetting -SuffixSearchList @("corp.test","lab.test")');
    expect(await ps('(Get-DnsClientGlobalSetting).SuffixSearchList -join ","')).toBe('corp.test,lab.test');
    expect(await win.executeCommand('reg query HKLM\\SYSTEM\\CurrentControlSet\\Services\\Tcpip\\Parameters /v SearchList')).toContain('corp.test,lab.test');
  });

  it('resolves a single-label name through the global search list', async () => {
    const { ps } = await lab();
    expect(await ps('Resolve-DnsName portal')).toContain('does not exist');
    await ps('Set-DnsClientGlobalSetting -SuffixSearchList corp.test');
    expect(await ps('(Resolve-DnsName portal).IPAddress')).toBe('10.0.0.80');
  });

  it('turns devolution off and sets its level', async () => {
    const { ps } = await lab();
    await ps('Set-DnsClientGlobalSetting -UseDevolution $false -DevolutionLevel 3 -PassThru');
    const out = await ps('Get-DnsClientGlobalSetting');
    expect(out).toMatch(/UseDevolution\s*:\s*False/);
    expect(out).toMatch(/DevolutionLevel\s*:\s*3/);
  });

  it('refuses a devolution level that is not a number', async () => {
    const { ps } = await lab();
    expect(await ps('Set-DnsClientGlobalSetting -DevolutionLevel many')).toContain('Cannot convert value "many" to type "System.UInt32"');
  });
});

describe('Register-DnsClient', () => {
  it('is accepted like ipconfig /registerdns and prints nothing', async () => {
    const { ps } = await lab();
    expect(await ps('Register-DnsClient')).toBe('');
  });
});
