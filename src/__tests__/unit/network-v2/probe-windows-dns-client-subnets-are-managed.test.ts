/*
 * Probe — Add-, Get-, Set- and Remove-DnsServerClientSubnet exist and manage the client subnet records of a Windows DNS
 * server the way the Learn pages and [MS-DNSP] 3.1.4.1 describe them: a record is a name and two lists of subnets, one
 * per family, written as the administrator wrote them; Add refuses a name already taken, Set -Action ADD / REMOVE /
 * REPLACE adds subnets, removes the listed ones (refusing a subnet that is not there and refusing to leave the record
 * empty) or replaces the family it is given, Remove asks for the confirmation a non-interactive host cannot give unless
 * -Force, and the records outlive the restart of the service.
 *
 * Measured first (mandeng at bd5ba48f2, a Windows server with the DNS role): none of the four cmdlets existed.
 *
 * Authority: the Learn pages of the four cmdlets (parameter sets, -Action, -PassThru, -Force, the pipeline example, the
 * three sample outputs) and [MS-DNSP] 2.2.15.2.1 / 3.1.4.1 (CreateClientSubnetRecord, DeleteClientSubnetRecord,
 * AddSubnetsInRecord, DeleteSubnetsInRecord, ResetClientSubnetRecord and their refusals), with the texts of the error
 * codes 9976, 9975, 9978 and 9573 from its Win32 error table. Not sourced, said here: the wording of "already exists"
 * (the specification names the constant but gives it the number of "does not exist") and of "the subnet is already in
 * the record", written after the neighbouring texts; the default table of the objects (the sample shows two columns,
 * the objects here carry the three members of the provider class); REPLACE leaves the family it is not given alone,
 * as the page's second example shows, where the specification speaks of replacing every subnet of the record.
 * The refusal to remove a record a policy still uses (9975) arrives with the policies, which are what use records.
 *
 * Discrimination (the probe run on the tree before the change): 31 of 32 cases fall. The one that passes either way is the
 * CONTROL "the lab runs a DNS server that answers its own cmdlets", the same server answering before the cmdlets exist.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters } from '@/network/core/types';
import { WindowsServer } from '@/network/devices/WindowsServer';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';

beforeEach(() => { resetCounters(); resetDeviceCounters(); Logger.clear(); });

const run = async (machine: WindowsServer, line: string): Promise<string> =>
  (await PowerShellSubShell.create(machine).subShell.processLine(line)).output.join('\n');

async function lab(): Promise<WindowsServer> {
  const server = new WindowsServer('WNS1');
  server.setCurrentUser('Administrator');
  await run(server, 'Install-WindowsFeature DNS');
  return server;
}

const NAMES = 'Get-DnsServerClientSubnet | ForEach-Object { $_.Name }';
const SUBNETS = (name: string) =>
  `$s = Get-DnsServerClientSubnet -Name ${name}; "$($s.IPV4Subnet -join ',')|$($s.IPV6Subnet -join ',')"`;

describe('CONTROL', () => {
  it('the lab runs a DNS server that answers its own cmdlets', async () => {
    const server = await lab();
    await run(server, 'Add-DnsServerPrimaryZone -Name corp.test');
    expect(await run(server, '(Get-DnsServerZone -Name corp.test).ZoneName')).toBe('corp.test');
  });
});

describe('Add-DnsServerClientSubnet', () => {
  it('adds a subnet written as IPv4 and returns the record under -PassThru (page example 1)', async () => {
    const server = await lab();
    const out = await run(server, 'Add-DnsServerClientSubnet -Name "NorthAmericaSubnet" -IPv4Subnet 172.21.33.0/16 -PassThru | Format-List');
    expect(out).toMatch(/Name\s+:\s+NorthAmericaSubnet/);
    expect(out).toMatch(/IPV4Subnet\s+:\s+\{172\.21\.33\.0\/16\}/);
    expect(out).toMatch(/IPV6Subnet\s+:\s*$/m);
  });

  it('adds a subnet written as IPv6 (page example 2)', async () => {
    const server = await lab();
    const out = await run(server, 'Add-DnsServerClientSubnet -Name "EuropeSubnet" -IPv6Subnet 0db8::1/28 -PassThru | Format-List');
    expect(out).toMatch(/IPV4Subnet\s+:\s*$/m);
    expect(out).toMatch(/IPV6Subnet\s+:\s+\{0db8::1\/28\}/);
  });

  it('adds a subnet of each family, by position as well as by name (page example 3)', async () => {
    const server = await lab();
    await run(server, 'Add-DnsServerClientSubnet -Name "AsiaSubnet" -IPv6Subnet 0db8::1/28 -IPv4Subnet 172.16.0.1/8');
    await run(server, 'Add-DnsServerClientSubnet "Positional" 10.0.0.0/8 2001:db8::/32');
    expect(await run(server, SUBNETS('AsiaSubnet'))).toBe('172.16.0.1/8|0db8::1/28');
    expect(await run(server, SUBNETS('Positional'))).toBe('10.0.0.0/8|2001:db8::/32');
  });

  it('writes nothing by default', async () => {
    const server = await lab();
    expect(await run(server, 'Add-DnsServerClientSubnet -Name A -IPv4Subnet 10.0.0.0/8')).toBe('');
  });

  it('refuses a name that is taken, whatever its case, and keeps the first record', async () => {
    const server = await lab();
    await run(server, 'Add-DnsServerClientSubnet -Name Asia -IPv4Subnet 10.0.0.0/8');
    const out = await run(server, 'Add-DnsServerClientSubnet -Name ASIA -IPv4Subnet 192.168.0.0/16');
    expect(out).toContain('Add-DnsServerClientSubnet : The client subnet already exists on the DNS server.');
    expect(await run(server, SUBNETS('Asia'))).toBe('10.0.0.0/8|');
  });

  it.each(['10.0.0.0', '10.0.0.0/33', '300.0.0.0/8', '0db8::1/28'])('refuses the IPv4 subnet "%s" and creates nothing', async (subnet) => {
    const server = await lab();
    const out = await run(server, `Add-DnsServerClientSubnet -Name Bad -IPv4Subnet ${subnet}`);
    expect(out).toContain('Add-DnsServerClientSubnet : The parameter is incorrect.');
    expect(await run(server, NAMES)).toBe('');
  });

  it('asks for the name', async () => {
    const server = await lab();
    expect(await run(server, 'Add-DnsServerClientSubnet -IPv4Subnet 10.0.0.0/8')).toContain('missing mandatory parameters: Name');
  });

  it('names its target under -WhatIf and adds nothing', async () => {
    const server = await lab();
    const out = await run(server, 'Add-DnsServerClientSubnet -Name Asia -IPv4Subnet 10.0.0.0/8 -WhatIf');
    expect(out).toContain('What if: Performing the operation "Add-DnsServerClientSubnet" on target "Asia".');
    expect(await run(server, NAMES)).toBe('');
  });
});

describe('Get-DnsServerClientSubnet', () => {
  it('lists every record in the order they were added, or the one named, whatever the case', async () => {
    const server = await lab();
    await run(server, 'Add-DnsServerClientSubnet -Name NorthAmericaSubnet -IPv4Subnet 172.21.0.0/12');
    await run(server, 'Add-DnsServerClientSubnet -Name EuropeSubnet -IPv6Subnet 0db8::1/28');
    expect(await run(server, NAMES)).toBe('NorthAmericaSubnet\nEuropeSubnet');
    expect(await run(server, '(Get-DnsServerClientSubnet -Name europesubnet).Name')).toBe('EuropeSubnet');
    expect(await run(server, '(Get-DnsServerClientSubnet "EuropeSubnet").Name')).toBe('EuropeSubnet');
  });

  it('refuses a record that does not exist', async () => {
    const server = await lab();
    expect(await run(server, 'Get-DnsServerClientSubnet -Name nosuch')).toContain('Get-DnsServerClientSubnet : The client subnet does not exist on the DNS server.');
  });

  it('shows nothing on a server without records', async () => {
    const server = await lab();
    expect(await run(server, 'Get-DnsServerClientSubnet')).toBe('');
  });
});

describe('Set-DnsServerClientSubnet', () => {
  it('adds a subnet (page example 1)', async () => {
    const server = await lab();
    await run(server, 'Add-DnsServerClientSubnet -Name AsiaSubnet -IPv6Subnet 0db8::1/28 -IPv4Subnet 1.10.0.1/8');
    const out = await run(server, 'Set-DnsServerClientSubnet -Name AsiaSubnet -Action ADD -IPv4Subnet 192.168.0.4/16 -PassThru | Format-List');
    expect(out).toMatch(/IPV4Subnet\s+:\s+\{1\.10\.0\.1\/8, 192\.168\.0\.4\/16\}/);
    expect(out).toMatch(/IPV6Subnet\s+:\s+\{0db8::1\/28\}/);
  });

  it('refuses a subnet the record holds already', async () => {
    const server = await lab();
    await run(server, 'Add-DnsServerClientSubnet -Name Asia -IPv4Subnet 10.0.0.0/8');
    expect(await run(server, 'Set-DnsServerClientSubnet -Name Asia -Action ADD -IPv4Subnet 10.0.0.0/8')).toContain('The IP subnet that is specified already exists in the client subnet.');
  });

  it('replaces the family it is given and leaves the other (page example 2)', async () => {
    const server = await lab();
    await run(server, 'Add-DnsServerClientSubnet -Name AsiaSubnet -IPv6Subnet 0db8::1/28 -IPv4Subnet 10.0.0.1/8');
    await run(server, 'Set-DnsServerClientSubnet -Name AsiaSubnet -Action REPLACE -IPv6Subnet 0db8::1/8');
    expect(await run(server, SUBNETS('AsiaSubnet'))).toBe('10.0.0.1/8|0db8::1/8');
  });

  it('removes a subnet (page example 3), refuses one that is not there, and refuses to empty the record', async () => {
    const server = await lab();
    await run(server, 'Add-DnsServerClientSubnet -Name AsiaSubnet -IPv6Subnet 0db8::1/8 -IPv4Subnet 10.0.0.1/8');
    await run(server, 'Set-DnsServerClientSubnet -Name AsiaSubnet -Action REMOVE -IPv4Subnet 10.0.0.1/8');
    expect(await run(server, SUBNETS('AsiaSubnet'))).toBe('|0db8::1/8');
    expect(await run(server, 'Set-DnsServerClientSubnet -Name AsiaSubnet -Action REMOVE -IPv4Subnet 10.0.0.1/8')).toContain('The IP subnet specified does not exist in the client subnet.');
    expect(await run(server, 'Set-DnsServerClientSubnet -Name AsiaSubnet -Action REMOVE -IPv6Subnet 0db8::1/8')).toContain('Not allowed to remove all addresses.');
    expect(await run(server, SUBNETS('AsiaSubnet'))).toBe('|0db8::1/8');
  });

  it('refuses a replacement that gives no subnet', async () => {
    const server = await lab();
    await run(server, 'Add-DnsServerClientSubnet -Name Asia -IPv4Subnet 10.0.0.0/8');
    expect(await run(server, 'Set-DnsServerClientSubnet -Name Asia -Action REPLACE')).toContain('Not allowed to remove all addresses.');
    expect(await run(server, SUBNETS('Asia'))).toBe('10.0.0.0/8|');
  });

  it('refuses a record that does not exist, an action it does not know and a missing action', async () => {
    const server = await lab();
    await run(server, 'Add-DnsServerClientSubnet -Name Asia -IPv4Subnet 10.0.0.0/8');
    expect(await run(server, 'Set-DnsServerClientSubnet -Name Nosuch -Action ADD -IPv4Subnet 1.0.0.0/8')).toContain('The client subnet does not exist on the DNS server.');
    const bogus = await run(server, 'Set-DnsServerClientSubnet -Name Asia -Action BOGUS -IPv4Subnet 1.0.0.0/8');
    expect(bogus).toContain('does not belong to the set "ADD,REMOVE,REPLACE"');
    expect(bogus.match(/Set-DnsServerClientSubnet :/g)).toHaveLength(1);
    expect(await run(server, 'Set-DnsServerClientSubnet -Name Asia -IPv4Subnet 1.0.0.0/8')).toContain('missing mandatory parameters: Action');
    expect(await run(server, SUBNETS('Asia'))).toBe('10.0.0.0/8|');
  });

  it('asks for the name', async () => {
    const server = await lab();
    expect(await run(server, 'Set-DnsServerClientSubnet -Action ADD -IPv4Subnet 1.0.0.0/8')).toContain('missing mandatory parameters: Name');
  });

  it('writes nothing by default, and returns the record under -PassThru whatever the case of the name it was given', async () => {
    const server = await lab();
    await run(server, 'Add-DnsServerClientSubnet -Name AsiaSubnet -IPv4Subnet 10.0.0.0/8');
    expect(await run(server, 'Set-DnsServerClientSubnet -Name AsiaSubnet -Action ADD -IPv4Subnet 1.0.0.0/8')).toBe('');
    const out = await run(server, 'Set-DnsServerClientSubnet -Name asiasubnet -Action ADD -IPv4Subnet 2.0.0.0/8 -PassThru | Format-List');
    expect(out).toMatch(/Name\s+:\s+AsiaSubnet/);
    expect(out).toMatch(/IPV4Subnet\s+:\s+\{10\.0\.0\.0\/8, 1\.0\.0\.0\/8, 2\.0\.0\.0\/8\}/);
  });

  it('takes the action without regard to case', async () => {
    const server = await lab();
    await run(server, 'Add-DnsServerClientSubnet -Name Asia -IPv4Subnet 10.0.0.0/8');
    await run(server, 'Set-DnsServerClientSubnet -Name Asia -Action add -IPv4Subnet 1.0.0.0/8');
    expect(await run(server, SUBNETS('Asia'))).toBe('10.0.0.0/8,1.0.0.0/8|');
  });
});

describe('Remove-DnsServerClientSubnet', () => {
  it('removes the record with -Force and returns it under -PassThru (page example 1)', async () => {
    const server = await lab();
    await run(server, 'Add-DnsServerClientSubnet -Name AsiaSubnet -IPv6Subnet 0db8::1/8 -IPv4Subnet 192.168.0.4/16');
    const out = await run(server, 'Remove-DnsServerClientSubnet -Name AsiaSubnet -PassThru -Force | Format-List');
    expect(out).toMatch(/Name\s+:\s+AsiaSubnet/);
    expect(out).toMatch(/IPV4Subnet\s+:\s+\{192\.168\.0\.4\/16\}/);
    expect(await run(server, NAMES)).toBe('');
  });

  it('removes every record handed over by the pipeline (page example 2)', async () => {
    const server = await lab();
    await run(server, 'Add-DnsServerClientSubnet -Name EuropeSubnet -IPv6Subnet 0db8::1/28');
    await run(server, 'Add-DnsServerClientSubnet -Name NorthAmericaSubnet -IPv4Subnet 172.21.0.0/16');
    await run(server, 'Get-DnsServerClientSubnet | Remove-DnsServerClientSubnet -Force');
    expect(await run(server, NAMES)).toBe('');
  });

  it('asks for a confirmation a non-interactive host cannot give, and removes nothing', async () => {
    const server = await lab();
    await run(server, 'Add-DnsServerClientSubnet -Name Asia -IPv4Subnet 10.0.0.0/8');
    expect(await run(server, 'Remove-DnsServerClientSubnet -Name Asia')).toContain('NonInteractive');
    expect(await run(server, NAMES)).toBe('Asia');
    await run(server, 'Remove-DnsServerClientSubnet -Name Asia -Confirm:$false');
    expect(await run(server, NAMES)).toBe('');
  });

  it('names its target under -WhatIf and removes nothing', async () => {
    const server = await lab();
    await run(server, 'Add-DnsServerClientSubnet -Name Asia -IPv4Subnet 10.0.0.0/8');
    expect(await run(server, 'Remove-DnsServerClientSubnet -Name Asia -WhatIf')).toContain('What if: Performing the operation "Remove-DnsServerClientSubnet" on target "Asia".');
    expect(await run(server, NAMES)).toBe('Asia');
  });

  it('asks for the name', async () => {
    const server = await lab();
    expect(await run(server, 'Remove-DnsServerClientSubnet -Force')).toContain('missing mandatory parameters: Name');
  });

  it('writes nothing by default', async () => {
    const server = await lab();
    await run(server, 'Add-DnsServerClientSubnet -Name Asia -IPv4Subnet 10.0.0.0/8');
    expect(await run(server, 'Remove-DnsServerClientSubnet -Name Asia -Force')).toBe('');
  });

  it('refuses a record that does not exist', async () => {
    const server = await lab();
    expect(await run(server, 'Remove-DnsServerClientSubnet -Name Nosuch -Force')).toContain('Remove-DnsServerClientSubnet : The client subnet does not exist on the DNS server.');
  });
});

describe('persistence', () => {
  it('keeps the records when the DNS service is stopped and started', async () => {
    const server = await lab();
    await run(server, 'Add-DnsServerClientSubnet -Name Asia -IPv4Subnet 10.0.0.0/8');
    await run(server, 'Stop-Service DNS');
    await run(server, 'Start-Service DNS');
    expect(await run(server, SUBNETS('Asia'))).toBe('10.0.0.0/8|');
  });
});
