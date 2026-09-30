/*
 * DnsServer cmdlets: the attributes of the real module. Each attribute is
 * either evaluated by the engine or refused naming the missing brick
 * (-ComputerName on another host now travels over WinRM, and every attribute
 * that used to be refused is evaluated: see the aging, forwarding and reverse
 * zone probes).
 *
 * Discrimination (git stash of the source files): 13 of the 14 cases fall
 * before the change. The one that passes either way is the witness that a
 * plain Add-DnsServerResourceRecordA still works in this lab.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters } from '@/network/core/types';
import { WindowsServer } from '@/network/devices/WindowsServer';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';

beforeEach(() => { resetCounters(); resetDeviceCounters(); Logger.clear(); });

async function server(): Promise<WindowsServer> {
  const dns = new WindowsServer('DNS1');
  dns.setCurrentUser('Administrator');
  await run(dns, 'Install-WindowsFeature DNS');
  return dns;
}
const run = async (d: WindowsServer, line: string) => (await PowerShellSubShell.create(d).subShell.processLine(line)).output.join('\n');
const zoneFile = (d: WindowsServer, name: string) => d.getFileSystem().readFile(`C:\\Windows\\System32\\dns\\${name}`);

describe('DnsServer cmdlet attributes', () => {
  it('TEMOIN : un enregistrement A simple fonctionne', async () => {
    const dns = await server();
    await run(dns, 'Add-DnsServerPrimaryZone -Name lab.test');
    await run(dns, 'Add-DnsServerResourceRecordA -ZoneName lab.test -Name www -IPv4Address 10.0.0.5');
    expect(await run(dns, 'Get-DnsServerResourceRecord -ZoneName lab.test -Name www')).toContain('10.0.0.5');
  });

  it('-ComputerName vise le serveur local ; un autre nom non résolu échoue sans rien créer', async () => {
    const dns = await server();
    expect(await run(dns, 'Add-DnsServerPrimaryZone -Name lab.test -ComputerName localhost')).toBe('');
    expect(await run(dns, 'Add-DnsServerPrimaryZone -Name a.test -ComputerName DNS1')).toBe('');
    expect(await run(dns, 'Get-DnsServerZone -ComputerName OTHER1')).toMatch(/could not be resolved/);
    expect(await run(dns, 'Add-DnsServerPrimaryZone -Name b.test -ComputerName OTHER1')).toMatch(/could not be resolved/);
    expect(await run(dns, 'Get-DnsServerZone')).not.toMatch(/ZoneName\s*:\s*b\.test/);
  });

  it('-PassThru rend la zone créée', async () => {
    const dns = await server();
    expect(await run(dns, 'Add-DnsServerPrimaryZone -Name lab.test -PassThru')).toContain('lab.test');
    expect(await run(dns, 'Add-DnsServerSecondaryZone -Name sec.test -MasterServers 10.0.0.9 -PassThru')).toMatch(/Secondary/);
    expect(await run(dns, 'Set-DnsServerPrimaryZone -Name lab.test -Notify NoNotify -PassThru')).toMatch(/NoNotify/);
  });

  it('-LoadExisting relit le fichier de zone', async () => {
    const dns = await server();
    await run(dns, 'Add-DnsServerPrimaryZone -Name lab.test');
    await run(dns, 'Add-DnsServerResourceRecordA -ZoneName lab.test -Name www -IPv4Address 10.0.0.5');
    const saved = zoneFile(dns, 'lab.test.dns').content!;
    await run(dns, 'Remove-DnsServerZone -Name lab.test -Force');
    dns.getFileSystem().createFile('C:\\Windows\\System32\\dns\\lab.test.dns', saved);
    await run(dns, 'Add-DnsServerPrimaryZone -Name lab.test -LoadExisting');
    expect(await run(dns, 'Get-DnsServerResourceRecord -ZoneName lab.test -Name www')).toContain('10.0.0.5');
  });

  it('-LoadExisting sans fichier est refusé', async () => {
    const dns = await server();
    expect(await run(dns, 'Add-DnsServerPrimaryZone -Name nofile.test -LoadExisting')).toMatch(/does not exist/);
  });

  it('-CreatePtr crée le PTR dans la zone inverse', async () => {
    const dns = await server();
    await run(dns, 'Add-DnsServerPrimaryZone -Name lab.test');
    await run(dns, 'Add-DnsServerPrimaryZone -NetworkId 10.0.0.0/24');
    await run(dns, 'Add-DnsServerResourceRecordA -ZoneName lab.test -Name www -IPv4Address 10.0.0.5 -CreatePtr');
    const ptr = await run(dns, 'Get-DnsServerResourceRecord -ZoneName 0.0.10.in-addr.arpa -RRType PTR');
    expect(ptr).toContain('www.lab.test');
  });

  it('-CreatePtr sans zone inverse est refusé et n ajoute pas l enregistrement', async () => {
    const dns = await server();
    await run(dns, 'Add-DnsServerPrimaryZone -Name lab.test');
    expect(await run(dns, 'Add-DnsServerResourceRecordA -ZoneName lab.test -Name www -IPv4Address 10.0.0.5 -CreatePtr')).toMatch(/reverse lookup zone/);
    expect(await run(dns, 'Get-DnsServerResourceRecord -ZoneName lab.test -Name www')).not.toContain('10.0.0.5');
  });

  it('-AgeRecord et -AllowUpdateAny sont acceptés et l enregistrement existe', async () => {
    const dns = await server();
    await run(dns, 'Add-DnsServerPrimaryZone -Name lab.test');
    expect(await run(dns, 'Add-DnsServerResourceRecordA -ZoneName lab.test -Name a -IPv4Address 10.0.0.5 -AgeRecord')).toBe('');
    expect(await run(dns, 'Add-DnsServerResourceRecordA -ZoneName lab.test -Name b -IPv4Address 10.0.0.6 -AllowUpdateAny')).toBe('');
    const listed = await run(dns, 'Get-DnsServerResourceRecord -ZoneName lab.test');
    expect(listed).toContain('10.0.0.5');
    expect(listed).toContain('10.0.0.6');
  });

  it('-ForwarderTimeout est appliqué et borné', async () => {
    const dns = await server();
    expect(await run(dns, 'Add-DnsServerConditionalForwarderZone -Name p.test -MasterServers 10.0.0.9 -ForwarderTimeout 7')).toBe('');
    expect(await run(dns, 'Add-DnsServerConditionalForwarderZone -Name q.test -MasterServers 10.0.0.9 -ForwarderTimeout 99')).toMatch(/between 1 and 15/);
    expect(await run(dns, 'Set-DnsServerConditionalForwarderZone -Name p.test -ForwarderTimeout 20')).toMatch(/between 1 and 15/);
    expect(await run(dns, 'Set-DnsServerConditionalForwarderZone -Name p.test -ForwarderTimeout 5')).toBe('');
  });

  it('-UseRecursion $false et -ZoneFile sur un redirecteur conditionnel sont acceptés', async () => {
    const dns = await server();
    expect(await run(dns, 'Add-DnsServerConditionalForwarderZone -Name p.test -MasterServers 10.0.0.9 -UseRecursion $false')).toBe('');
    expect(await run(dns, 'Add-DnsServerConditionalForwarderZone -Name q.test -MasterServers 10.0.0.9 -ZoneFile q.dns')).toBe('');
    expect(await run(dns, 'Get-DnsServerZone -Name q.test')).toMatch(/ZoneFile\s*:\s*q\.dns/);
  });

  it('Set-DnsServerPrimaryZone -ZoneFile déplace le fichier', async () => {
    const dns = await server();
    await run(dns, 'Add-DnsServerPrimaryZone -Name lab.test');
    await run(dns, 'Set-DnsServerPrimaryZone -Name lab.test -ZoneFile moved.dns');
    expect(zoneFile(dns, 'moved.dns').ok).toBe(true);
    expect(zoneFile(dns, 'lab.test.dns').ok).toBe(false);
    expect(await run(dns, 'Get-DnsServerZone -Name lab.test')).toMatch(/ZoneFile\s*:\s*moved\.dns/);
  });

  it('Set-DnsServerSecondaryZone accepte -Notify et -SecureSecondaries', async () => {
    const dns = await server();
    await run(dns, 'Add-DnsServerSecondaryZone -Name sec.test -MasterServers 10.0.0.9');
    expect(await run(dns, 'Set-DnsServerSecondaryZone -Name sec.test -Notify NotifyServers -NotifyServers 10.0.0.8')).toBe('');
    await run(dns, 'Set-DnsServerSecondaryZone -Name sec.test -SecureSecondaries TransferAnyServer');
    const zone = await run(dns, 'Get-DnsServerZone -Name sec.test');
    expect(zone).toMatch(/SecureSecondaries\s*:\s*TransferAnyServer/);
    expect(zone).toMatch(/Notify\s*:\s*NotifyServers/);
  });

  it('Set-DnsServerForwarder accepte -EnableReordering', async () => {
    const dns = await server();
    expect(await run(dns, 'Set-DnsServerForwarder -EnableReordering $false')).toBe('');
    expect(await run(dns, 'Set-DnsServerForwarder -EnableReordering $true -Timeout 5')).toBe('');
  });

  it('un -Name de zone mal formé est refusé sans créer la zone', async () => {
    const dns = await server();
    await run(dns, 'Add-DnsServerPrimaryZone -Name "bad name!"');
    expect(await run(dns, 'Get-DnsServerZone')).not.toContain('bad name');
  });
});
