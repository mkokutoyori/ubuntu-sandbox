/*
 * Probe — the DnsClient module's Name Resolution Policy Table and DNS-over-HTTPS server list:
 * Add/Get/Set/Remove-DnsClientNrptRule, Get-DnsClientNrptPolicy, Get/Set-DnsClientNrptGlobal,
 * Add/Get/Set/Remove-DnsClientDohServerAddress.
 *
 * Measured first (Windows client, Windows PowerShell 5.1 session): none of the eleven cmdlets existed ("The term
 * 'Add-DnsClientNrptRule' is not recognized ..."), so a split-DNS client could not be told "ask 10.0.0.20 for
 * .corp.test" from PowerShell, and the DNS client ignored any such policy.
 *
 * Source: Microsoft Learn, module DnsClient (reference of each cmdlet): the parameter names, the
 * MSFT_DnsClientNrptRule / MSFT_DnsClientNrptPolicy / MSFT_DnsClientNrptGlobal / MSFT_DnsClientDohServerAddress
 * property lists, the ValidateSet of -NameEncoding, -DAProxyType, -QueryPolicy, -SecureNameQueryFallback and
 * -EnableDAForAllNetworks. The archived "Name Resolution Policy Table" article gives the registry layout of a rule
 * (HKLM\SYSTEM\CurrentControlSet\Services\Dnscache\Parameters\DnsPolicyConfig\<id>: Version, Name, ConfigOptions,
 * GenericDNSServers) and the namespace forms (suffix with a leading dot, FQDN, prefix, "." for any name).
 *
 * The rules are registry keys; the DNS client that resolves a name consults them (the NameServers of the rule whose
 * namespace matches most specifically replace the servers of the adapters), so Get-DnsClientNrptRule, reg.exe and
 * Resolve-DnsName are three views of one store. A rule's DirectAccess / IPsec fields are stored and rendered, not
 * evaluated: this simulator has no DirectAccess channel and no IPsec-protected DNS query path.
 *
 * Discrimination (the probe run on the tree before the change): 14 of the 15 cases fall; the cmdlets did not
 * exist. The one case that passes either way is "applies the rule to its namespace only": before the change
 * the name never resolves because nothing can create a rule, after it the name does not resolve because the
 * rule names another namespace; it is the NEGATIVE CONTROL of "makes the client resolve a namespace through
 * the rule", not a proof by itself. The WITNESS of the lab is the first assertion of that evaluated case: with
 * the only configured DNS server dead, `portal.corp.test` does not resolve until a rule names the live server.
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
const DEAD_DNS = '10.0.0.250';

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
  await ps(`Set-DnsClientServerAddress -InterfaceAlias "Ethernet 0" -ServerAddresses ${DEAD_DNS}`);
  return { win, ps };
}

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.clear();
});

describe('NRPT rules', () => {
  it('adds a rule and reads it back with the documented properties', async () => {
    const { ps } = await lab();
    await ps(`Add-DnsClientNrptRule -Namespace ".corp.test" -NameServers ${CORP_IP} -Comment "split dns"`);
    const out = await ps('Get-DnsClientNrptRule');
    expect(out).toMatch(/Name\s*:\s*\{[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}\}/);
    expect(out).toMatch(/Namespace\s*:\s*\{\.corp\.test\}/);
    expect(out).toMatch(/NameServers\s*:\s*\{10\.0\.0\.20\}/);
    expect(out).toMatch(/Comment\s*:\s*split dns/);
    expect(out).toMatch(/NameEncoding\s*:\s*Utf8WithMapping/);
  });

  it('makes the client resolve a namespace through the rule when its adapter server is dead', async () => {
    const { ps } = await lab();
    expect(await ps('(Resolve-DnsName portal.corp.test -ErrorAction SilentlyContinue).IPAddress')).not.toBe('10.0.0.80');
    await ps(`Add-DnsClientNrptRule -Namespace ".corp.test" -NameServers ${CORP_IP}`);
    expect(await ps('(Resolve-DnsName portal.corp.test).IPAddress')).toBe('10.0.0.80');
  });

  it('applies the rule to its namespace only', async () => {
    const { ps } = await lab();
    await ps(`Add-DnsClientNrptRule -Namespace ".other.test" -NameServers ${CORP_IP}`);
    expect(await ps('(Resolve-DnsName portal.corp.test -ErrorAction SilentlyContinue).IPAddress')).not.toBe('10.0.0.80');
  });

  it('prefers the most specific namespace', async () => {
    const { ps } = await lab();
    await ps(`Add-DnsClientNrptRule -Namespace "." -NameServers ${DEAD_DNS}`);
    await ps(`Add-DnsClientNrptRule -Namespace ".corp.test" -NameServers ${CORP_IP}`);
    expect(await ps('(Resolve-DnsName portal.corp.test).IPAddress')).toBe('10.0.0.80');
  });

  it('stores the rule where Windows keeps it, so reg query shows the same fact', async () => {
    const { win, ps } = await lab();
    await ps(`Add-DnsClientNrptRule -Namespace ".corp.test" -NameServers ${CORP_IP}`);
    const dump = await win.executeCommand('reg query HKLM\\SYSTEM\\CurrentControlSet\\Services\\Dnscache\\Parameters\\DnsPolicyConfig /s');
    expect(dump).toMatch(/Name\s+REG_MULTI_SZ\s+\.corp\.test/);
    expect(dump).toMatch(/GenericDNSServers\s+REG_SZ\s+10\.0\.0\.20/);
    expect(dump).toMatch(/ConfigOptions\s+REG_DWORD\s+0x8/);
    expect(dump).toMatch(/Version\s+REG_DWORD\s+0x2/);
  });

  it('modifies a rule by name, and the resolver follows the change', async () => {
    const { ps } = await lab();
    await ps(`Add-DnsClientNrptRule -Namespace ".corp.test" -NameServers ${DEAD_DNS}`);
    expect(await ps('(Resolve-DnsName portal.corp.test -ErrorAction SilentlyContinue).IPAddress')).not.toBe('10.0.0.80');
    await ps(`Get-DnsClientNrptRule | Set-DnsClientNrptRule -NameServers ${CORP_IP}`);
    expect(await ps('(Get-DnsClientNrptRule).NameServers -join ","')).toBe(CORP_IP);
    expect(await ps('(Resolve-DnsName portal.corp.test).IPAddress')).toBe('10.0.0.80');
  });

  it('removes a rule, after which the namespace is no longer reachable through it', async () => {
    const { ps } = await lab();
    await ps(`Add-DnsClientNrptRule -Namespace ".corp.test" -NameServers ${CORP_IP}`);
    await ps('Get-DnsClientNrptRule | Remove-DnsClientNrptRule -Force');
    expect(await ps('Get-DnsClientNrptRule')).toBe('');
    expect(await ps('(Resolve-DnsName portal.corp.test -ErrorAction SilentlyContinue).IPAddress')).not.toBe('10.0.0.80');
  });

  it('returns the rule with -PassThru', async () => {
    const { ps } = await lab();
    expect(await ps(`(Add-DnsClientNrptRule -Namespace ".corp.test" -NameServers ${CORP_IP} -PassThru).Namespace`)).toBe('.corp.test');
  });

  it('refuses what the documented parameters refuse', async () => {
    const { ps } = await lab();
    expect(await ps('Add-DnsClientNrptRule -NameServers 10.0.0.20')).toContain('missing mandatory parameters: Namespace');
    expect(await ps('Add-DnsClientNrptRule -Namespace .corp.test -NameServers nonsense')).toContain('"nonsense" is not a valid IP address');
    expect(await ps('Add-DnsClientNrptRule -Namespace .corp.test -NameEncoding Rot13')).toContain('Rot13');
    expect(await ps("Get-DnsClientNrptRule -Name '{00000000-0000-0000-0000-000000000000}'")).toContain("No MSFT_DnsClientNrptRule objects found with property 'Name' equal to '{00000000-0000-0000-0000-000000000000}'.");
    expect(await ps('Add-DnsClientNrptRule -Namespace .corp.test -NameServers 10.0.0.20 -GpoName Corp')).toContain('Group Policy based NRPT rules are not available');
  });

  it('lists the namespaces of the policy, and the effective policy with the global settings', async () => {
    const { ps } = await lab();
    await ps(`Add-DnsClientNrptRule -Namespace ".corp.test",".lab.test" -NameServers ${CORP_IP}`);
    expect(await ps('(Get-DnsClientNrptPolicy).Namespace -join ","')).toBe('.corp.test,.lab.test');
    expect(await ps('(Get-DnsClientNrptPolicy -Effective | Select-Object -First 1).QueryPolicy')).toBe('Disable');
  });
});

describe('NRPT global settings', () => {
  it('reports the defaults, changes them and reads them back', async () => {
    const { ps } = await lab();
    const before = await ps('Get-DnsClientNrptGlobal');
    expect(before).toMatch(/EnableDAForAllNetworks\s+QueryPolicy\s+SecureNameQueryFallback/);
    expect(before).toMatch(/Disable\s+Disable\s+Disable/);
    await ps('Set-DnsClientNrptGlobal -QueryPolicy QueryBoth -SecureNameQueryFallback FallbackUnsecure');
    expect(await ps('Get-DnsClientNrptGlobal')).toMatch(/Disable\s+QueryBoth\s+FallbackUnsecure/);
  });

  it('refuses a value outside the documented set', async () => {
    const { ps } = await lab();
    expect(await ps('Set-DnsClientNrptGlobal -QueryPolicy Sometimes')).toContain('Sometimes');
  });
});

describe('DNS-over-HTTPS server addresses', () => {
  it('lists the well-known servers Windows ships', async () => {
    const { ps } = await lab();
    const list = await ps('(Get-DnsClientDohServerAddress).ServerAddress -join ","');
    expect(list).toContain('1.1.1.1');
    expect(list).toContain('8.8.8.8');
    expect(list).toContain('9.9.9.9');
  });

  it('adds a server, reads it back, changes it, and removes it', async () => {
    const { ps } = await lab();
    await ps('Add-DnsClientDohServerAddress -ServerAddress 10.0.0.53 -DohTemplate https://dns.corp.test/dns-query -AllowFallbackToUdp $false -AutoUpgrade $true');
    const added = await ps('Get-DnsClientDohServerAddress -ServerAddress 10.0.0.53 | Format-List ServerAddress,DohTemplate,AutoUpgrade');
    expect(added).toMatch(/DohTemplate\s*:\s*https:\/\/dns\.corp\.test\/dns-query/);
    expect(added).toMatch(/AutoUpgrade\s*:\s*True/);
    await ps('Set-DnsClientDohServerAddress -ServerAddress 10.0.0.53 -AutoUpgrade $false -DohTemplate https://dns2.corp.test/dns-query');
    expect(await ps('(Get-DnsClientDohServerAddress -ServerAddress 10.0.0.53).DohTemplate')).toBe('https://dns2.corp.test/dns-query');
    await ps('Remove-DnsClientDohServerAddress -ServerAddress 10.0.0.53 -Confirm:$false');
    expect(await ps('Get-DnsClientDohServerAddress -ServerAddress 10.0.0.53')).toContain("No MSFT_DnsClientDohServerAddress objects found with property 'ServerAddress' equal to '10.0.0.53'.");
  });

  it('refuses a duplicate address and a template that is not https', async () => {
    const { ps } = await lab();
    expect(await ps('Add-DnsClientDohServerAddress -ServerAddress 1.1.1.1 -DohTemplate https://cloudflare-dns.com/dns-query')).toContain('already exists');
    expect(await ps('Add-DnsClientDohServerAddress -ServerAddress 10.0.0.54 -DohTemplate http://dns.corp.test/dns-query')).toContain('is not a valid URI template');
  });
});
