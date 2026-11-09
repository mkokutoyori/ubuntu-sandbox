/*
 * Probe — Suspend-/Resume-/Sync-/Export-DnsServerZone and Restore-DnsServerPrimaryZone/SecondaryZone exist and do what their pages and
 * [MS-DNSP] say: a suspended zone is "not used to answer queries or take updates until it is resumed" (PauseZone), so the names it holds
 * fall to the zone above it or to the recursion, an update is refused, a transfer is refused and a suspended conditional forwarder
 * forwards nothing; Sync writes to persistent storage what the server holds in memory (the zone file, the file of each zone scope, the
 * root hints); Export writes the zone to a file of the DNS directory; Restore reloads a file-backed primary zone from its file and a
 * secondary zone from its master. The examples of the Learn pages are the transcripts; a Windows server holding corp.test, clients on
 * two client subnets and a second Windows server that pulls the zone are the lab.
 *
 * Measured first: none of the six cmdlets existed ("is not recognized") and Get-DnsServerZone reported IsPaused for a secondary zone
 * that has not transferred yet and for no other.
 *
 * Authority: the Learn pages of the six cmdlets (the parameters, -Name aliased ZoneName, the positions, "While suspended, the DNS server
 * ignores all queries for the zone", "restores ... for file-backed zones, it reloads from the zone file", "For secondary zones, this
 * information is always stored in a file", "Checks the DNS server memory for changes, and writes them to persistent storage", "places
 * the file in the DNS directory"), [MS-DNSP] PauseZone and ResumeZone ("do not use this zone to answer queries or take updates until
 * it is resumed"), and the Windows message table for the refusal to overwrite an export (ERROR_ALREADY_EXISTS, "Cannot create a file
 * when that file already exists."). Not sourced, said here: that an update to a suspended zone is answered NOTAUTH and a transfer
 * REFUSED as for a zone that is not on the server, that a suspended conditional forwarder zone forwards nothing, that Sync-DnsServerZone
 * writes the root hints file and the files of the zone scopes as well as the zone file, that an exported file is the zone file of the
 * server, that restoring an Active Directory integrated zone reloads nothing (the directory is the server's own store here), and the
 * wording of the refusal to restore a zone that is not a primary or a secondary one.
 *
 * Discrimination (the probe run on the tree before the change): 29 of 31 cases fall, the ones that need the cmdlets and the ones that
 * need a zone to be paused. The two that pass on both sides are named: the WITNESS (the zone answers while it runs) and the CONTROL (a
 * secondary zone that has not transferred is still reported as paused).
 */
import { describe, it, expect } from 'vitest';
import { IPAddress } from '@/network/core/types';
import { RRType } from '@/network/dns/wire/RRType';
import { DnsRcode } from '@/network/dns/wire/DnsHeaderFlags';
import type { DnsMessage } from '@/network/dns/wire/DnsMessage';
import type { ARecordData } from '@/network/dns/wire/ResourceRecord';
import { queryDnsOverTcp } from '@/network/dns/transport/DnsTcpTransport';
import type { LinuxPC } from '@/network/devices/LinuxPC';
import { policyLab as governed, question, run, SERVER } from './dnsRateLimitingLab';

const SUSPEND = 'Suspend-DnsServerZone';
const RESUME = 'Resume-DnsServerZone';
const SYNC = 'Sync-DnsServerZone';
const EXPORT = 'Export-DnsServerZone';
const RESTORE_PRIMARY = 'Restore-DnsServerPrimaryZone';
const RESTORE_SECONDARY = 'Restore-DnsServerSecondaryZone';

const NON_INTERACTIVE = 'PowerShell is in NonInteractive mode.';
const NO_ZONE = (name: string): string => `Zone "${name}" does not exist on this server.`;
const DNS_DIRECTORY = 'C:\\Windows\\System32\\dns';

const addressesOf = (reply: DnsMessage | null): string[] =>
  (reply?.answers ?? []).filter(record => record.data.type === RRType.A).map(record => (record.data as ARecordData).address.toString());

const refusedAxfr = async (from: LinuxPC): Promise<boolean> =>
  (await queryDnsOverTcp(from, new IPAddress(SERVER), question('corp.test', RRType.AXFR), 53, 1500))?.flags.rcode === DnsRcode.REFUSED;

const dynamicUpdate = (from: LinuxPC, line: string): Promise<string> =>
  from.executeCommand(`printf 'server ${SERVER}\\nzone corp.test\\n${line}\\nsend\\n' | nsupdate`);

describe('Suspend-DnsServerZone and Resume-DnsServerZone', () => {
  it('suspend the zone of the example and print it under -PassThru, the zone saying it is paused', async () => {
    const { cmd } = await governed();
    expect(await cmd(`${SUSPEND} -Name corp.test -Force -PassThru | ForEach-Object { "$($_.ZoneName)|$($_.IsPaused)" }`)).toBe('corp.test|True');
    expect(await cmd('(Get-DnsServerZone -Name corp.test).IsPaused')).toBe('True');
    expect(await cmd(`${RESUME} -Name corp.test -Force -PassThru | ForEach-Object { "$($_.ZoneName)|$($_.IsPaused)" }`)).toBe('corp.test|False');
    expect(await cmd('(Get-DnsServerZone -Name corp.test).IsPaused')).toBe('False');
  });

  it('are quiet without -PassThru, take the zone by position or by its alias and accept the zone from the pipeline', async () => {
    const { cmd } = await governed();
    expect(await cmd(`${SUSPEND} corp.test -Force`)).toBe('');
    expect(await cmd('(Get-DnsServerZone -Name corp.test).IsPaused')).toBe('True');
    expect(await cmd(`${RESUME} -ZoneName corp.test -Force`)).toBe('');
    expect(await cmd(`Get-DnsServerZone -Name corp.test | ${SUSPEND} -Force`)).toBe('');
    expect(await cmd('(Get-DnsServerZone -Name corp.test).IsPaused')).toBe('True');
    expect(await cmd(`Get-DnsServerZone -Name corp.test | ${RESUME} -Force`)).toBe('');
    expect(await cmd('(Get-DnsServerZone -Name corp.test).IsPaused')).toBe('False');
  });

  it('ask before they act unless -Force is given, and name their target under -WhatIf', async () => {
    const { cmd } = await governed();
    expect(await cmd(`${SUSPEND} -Name corp.test`)).toContain(`${SUSPEND}: ${NON_INTERACTIVE}`);
    expect(await cmd(`${SUSPEND} -Name corp.test -WhatIf`)).toContain(`What if: Performing the operation "${SUSPEND}" on target "corp.test".`);
    expect(await cmd('(Get-DnsServerZone -Name corp.test).IsPaused')).toBe('False');
    await cmd(`${SUSPEND} -Name corp.test -Force`);
    expect(await cmd(`${RESUME} -Name corp.test`)).toContain(`${RESUME}: ${NON_INTERACTIVE}`);
    expect(await cmd(`${RESUME} -Name corp.test -WhatIf`)).toContain(`What if: Performing the operation "${RESUME}" on target "corp.test".`);
    expect(await cmd('(Get-DnsServerZone -Name corp.test).IsPaused')).toBe('True');
  });

  it('refuse a zone that is not on the server and ask for the name that is missing', async () => {
    const { cmd } = await governed();
    expect(await cmd(`${SUSPEND} -Name nope.test -Force`)).toContain(`${SUSPEND}: ${NO_ZONE('nope.test')}`);
    expect(await cmd(`${RESUME} -Name nope.test -Force`)).toContain(`${RESUME}: ${NO_ZONE('nope.test')}`);
    expect(await cmd(`${SUSPEND} -Force`)).toContain(`${SUSPEND}: Cannot process command because of one or more missing mandatory parameters: Name.`);
  });

  it('can be repeated: suspending a suspended zone or resuming a running one is not an error', async () => {
    const { cmd } = await governed();
    expect(await cmd(`${RESUME} -Name corp.test -Force`)).toBe('');
    expect(await cmd(`${SUSPEND} -Name corp.test -Force`)).toBe('');
    expect(await cmd(`${SUSPEND} -Name corp.test -Force`)).toBe('');
    expect(await cmd('(Get-DnsServerZone -Name corp.test).IsPaused')).toBe('True');
  });

  it('(WITNESS) is answered by the zone while it runs', async () => {
    const { ask, clientA } = await governed();
    expect(addressesOf(await ask(clientA, 'web.corp.test'))).toEqual(['10.0.9.1']);
  });

  it('stop the zone answering: its names are refused while it is suspended and answered again once it is resumed', async () => {
    const { cmd, ask, verdict, clientA, clientC } = await governed();
    await cmd(`${SUSPEND} -Name corp.test -Force`);
    expect(await verdict(clientA, 'web.corp.test')).toBe('refused');
    expect(await verdict(clientC, 'mail.corp.test')).toBe('refused');
    await cmd(`${RESUME} -Name corp.test -Force`);
    expect(addressesOf(await ask(clientA, 'web.corp.test'))).toEqual(['10.0.9.1']);
  });

  it('let the zone above answer for the names of a suspended child zone', async () => {
    const { cmd, ask, verdict, clientA } = await governed();
    await cmd('Add-DnsServerPrimaryZone -Name sub.corp.test');
    await cmd('Add-DnsServerResourceRecordA -ZoneName sub.corp.test -Name host -IPv4Address 10.0.8.1');
    expect(addressesOf(await ask(clientA, 'host.sub.corp.test'))).toEqual(['10.0.8.1']);
    await cmd(`${SUSPEND} -Name sub.corp.test -Force`);
    expect(await verdict(clientA, 'host.sub.corp.test')).toBe('nxdomain');
    expect(addressesOf(await ask(clientA, 'web.corp.test'))).toEqual(['10.0.9.1']);
  });

  it('refuse the dynamic updates of a suspended zone and take them again once it is resumed', async () => {
    const { cmd, clientA } = await governed();
    await cmd('Set-DnsServerPrimaryZone -Name corp.test -DynamicUpdate NonsecureAndSecure');
    await cmd(`${SUSPEND} -Name corp.test -Force`);
    await dynamicUpdate(clientA, 'update add dyn.corp.test 300 A 10.0.0.9');
    expect(await cmd('(Get-DnsServerResourceRecord -ZoneName corp.test -Name dyn).Count')).toBe('0');
    await cmd(`${RESUME} -Name corp.test -Force`);
    await dynamicUpdate(clientA, 'update add dyn.corp.test 300 A 10.0.0.9');
    expect(await cmd('(Get-DnsServerResourceRecord -ZoneName corp.test -Name dyn).RecordData.IPv4Address')).toBe('10.0.0.9');
  });

  it('refuse the transfers of a suspended zone and serve them again once it is resumed', async () => {
    const { cmd, clientA } = await governed();
    await cmd('Set-DnsServerPrimaryZone -Name corp.test -SecureSecondaries TransferAnyServer');
    expect(await refusedAxfr(clientA)).toBe(false);
    await cmd(`${SUSPEND} -Name corp.test -Force`);
    expect(await refusedAxfr(clientA)).toBe(true);
    await cmd(`${RESUME} -Name corp.test -Force`);
    expect(await refusedAxfr(clientA)).toBe(false);
  });

  it('stop a conditional forwarder zone forwarding, and let it forward again once it is resumed', async () => {
    const { cmd, verdict, clientA } = await governed();
    await cmd('Add-DnsServerConditionalForwarderZone -Name ext.test -MasterServers 10.0.1.30');
    expect(await verdict(clientA, 'host.ext.test')).toBe('answered');
    await cmd(`${SUSPEND} -Name ext.test -Force`);
    expect(await cmd('(Get-DnsServerZone -Name ext.test).IsPaused')).toBe('True');
    expect(await verdict(clientA, 'host.ext.test')).not.toBe('answered');
    await cmd(`${RESUME} -Name ext.test -Force`);
    expect(await verdict(clientA, 'host.ext.test')).toBe('answered');
  });

  it('count the transfer of a suspended zone as a query for a zone that is not there, not as a refusal for security', async () => {
    const { cmd, clientA } = await governed();
    const count = (member: string) => cmd(`(Get-DnsServerStatistics).MasterStatistics.${member}`);
    expect(await refusedAxfr(clientA)).toBe(true);
    expect([await count('RefuseSecurity'), await count('RefuseNotAuth')]).toEqual(['1', '0']);
    await cmd(`${SUSPEND} -Name corp.test -Force`);
    expect(await refusedAxfr(clientA)).toBe(true);
    expect([await count('RefuseSecurity'), await count('RefuseNotAuth')]).toEqual(['1', '1']);
  });

  it('go with a conditional forwarder zone too: a forwarder zone that is added again is not suspended', async () => {
    const { cmd, verdict, clientA } = await governed();
    await cmd('Add-DnsServerConditionalForwarderZone -Name ext.test -MasterServers 10.0.1.30');
    await cmd(`${SUSPEND} -Name ext.test -Force`);
    expect(await cmd('(Get-DnsServerZone -Name ext.test).IsPaused')).toBe('True');
    await cmd('Remove-DnsServerZone -Name ext.test -Force');
    await cmd('Add-DnsServerConditionalForwarderZone -Name ext.test -MasterServers 10.0.1.30');
    expect(await cmd('(Get-DnsServerZone -Name ext.test).IsPaused')).toBe('False');
    expect(await verdict(clientA, 'host.ext.test')).toBe('answered');
  });

  it('go with the zone: a zone that is added again is not suspended', async () => {
    const { cmd } = await governed();
    await cmd(`${SUSPEND} -Name corp.test -Force`);
    expect(await cmd('(Get-DnsServerZone -Name corp.test).IsPaused')).toBe('True');
    await cmd('Remove-DnsServerZone -Name corp.test -Force');
    await cmd('Add-DnsServerPrimaryZone -Name corp.test');
    expect(await cmd('(Get-DnsServerZone -Name corp.test).IsPaused')).toBe('False');
  });

  it('(CONTROL) keep saying a secondary zone is paused as long as it has not transferred', async () => {
    const { master } = await governed();
    await run(master, 'Add-DnsServerSecondaryZone -Name corp.test -MasterServers 10.0.1.10');
    expect(await run(master, '(Get-DnsServerZone -Name corp.test).IsPaused')).toBe('True');
  });
});

describe('Sync-DnsServerZone', () => {
  it('writes the zone file again, and prints the zone under -PassThru (example 1)', async () => {
    const { cmd } = await governed();
    await cmd(`Remove-Item ${DNS_DIRECTORY}\\corp.test.dns`);
    expect(await cmd(`Test-Path ${DNS_DIRECTORY}\\corp.test.dns`)).toBe('False');
    expect(await cmd(`${SYNC} -Name corp.test -PassThru | ForEach-Object { $_.ZoneName }`)).toBe('corp.test');
    expect(await cmd(`Test-Path ${DNS_DIRECTORY}\\corp.test.dns`)).toBe('True');
    expect(await cmd(`Get-Content ${DNS_DIRECTORY}\\corp.test.dns`)).toContain('10.0.9.1');
  });

  it('writes the files of the zone scopes and the root hints as well', async () => {
    const { cmd } = await governed();
    await cmd('Add-DnsServerZoneScope -ZoneName corp.test -Name ScopeA');
    await cmd('Add-DnsServerResourceRecordA -ZoneName corp.test -Name www -IPv4Address 10.1.1.1 -ZoneScope ScopeA');
    await cmd(`Remove-Item ${DNS_DIRECTORY}\\corp.test\\ScopeA.dns`);
    await cmd(`Remove-Item ${DNS_DIRECTORY}\\cache.dns`);
    expect(await cmd(SYNC)).toBe('');
    expect(await cmd(`Get-Content ${DNS_DIRECTORY}\\corp.test\\ScopeA.dns`)).toContain('10.1.1.1');
    expect(await cmd(`Test-Path ${DNS_DIRECTORY}\\cache.dns`)).toBe('True');
  });

  it('writes every zone when no name is given, and prints them all under -PassThru', async () => {
    const { cmd } = await governed();
    await cmd('Add-DnsServerPrimaryZone -Name other.test');
    await cmd(`Remove-Item ${DNS_DIRECTORY}\\corp.test.dns`);
    await cmd(`Remove-Item ${DNS_DIRECTORY}\\other.test.dns`);
    expect(await cmd(`(${SYNC} -PassThru | Where-Object { $_.ZoneName -in "corp.test","other.test" }).Count`)).toBe('2');
    expect(await cmd(`Test-Path ${DNS_DIRECTORY}\\corp.test.dns`)).toBe('True');
    expect(await cmd(`Test-Path ${DNS_DIRECTORY}\\other.test.dns`)).toBe('True');
  });

  it('takes the zone by position, refuses a zone that is not on the server and names its target under -WhatIf', async () => {
    const { cmd } = await governed();
    expect(await cmd(`${SYNC} corp.test`)).toBe('');
    expect(await cmd(`${SYNC} nope.test`)).toContain(`${SYNC}: ${NO_ZONE('nope.test')}`);
    await cmd(`Remove-Item ${DNS_DIRECTORY}\\corp.test.dns`);
    expect(await cmd(`${SYNC} -Name corp.test -WhatIf`)).toContain(`What if: Performing the operation "${SYNC}" on target "corp.test".`);
    expect(await cmd(`Test-Path ${DNS_DIRECTORY}\\corp.test.dns`)).toBe('False');
  });
});

describe('Export-DnsServerZone', () => {
  it('writes the records of the zone to a file of the DNS directory (example 1)', async () => {
    const { cmd } = await governed();
    expect(await cmd(`${EXPORT} -Name "corp.test" -FileName "exportedcorp.test"`)).toBe('');
    const exported = await cmd(`Get-Content ${DNS_DIRECTORY}\\exportedcorp.test`);
    expect(exported).toContain('10.0.9.1');
    expect(exported).toContain('10.0.9.3');
  });

  it('takes the zone then the file by position, prints the zone under -PassThru and leaves the zone as it was', async () => {
    const { cmd } = await governed();
    expect(await cmd(`${EXPORT} corp.test second.dns -PassThru | ForEach-Object { $_.ZoneName }`)).toBe('corp.test');
    expect(await cmd(`Test-Path ${DNS_DIRECTORY}\\second.dns`)).toBe('True');
    expect(await cmd('(Get-DnsServerZone -Name corp.test).ZoneFile')).toBe('corp.test.dns');
  });

  it('does not overwrite a file that exists, and refuses a zone that is not on the server', async () => {
    const { cmd } = await governed();
    await cmd(`${EXPORT} -Name corp.test -FileName once.dns`);
    expect(await cmd(`${EXPORT} -Name corp.test -FileName once.dns`)).toContain(`${EXPORT}: Cannot create a file when that file already exists.`);
    expect(await cmd(`${EXPORT} -Name nope.test -FileName other.dns`)).toContain(`${EXPORT}: ${NO_ZONE('nope.test')}`);
    expect(await cmd(`Test-Path ${DNS_DIRECTORY}\\other.dns`)).toBe('False');
  });

  it('asks for the name and the file that are missing', async () => {
    const { cmd } = await governed();
    expect(await cmd(`${EXPORT} -Name corp.test`)).toContain(`${EXPORT}: Cannot process command because of one or more missing mandatory parameters: FileName.`);
    expect(await cmd(`${EXPORT} -FileName x.dns`)).toContain(`${EXPORT}: Cannot process command because of one or more missing mandatory parameters: Name.`);
  });
});

describe('Restore-DnsServerPrimaryZone', () => {
  const edit = async (cmd: (line: string) => Promise<string>): Promise<void> => {
    await cmd(`(Get-Content ${DNS_DIRECTORY}\\corp.test.dns) -replace "10.0.9.1", "10.0.9.77" | Set-Content ${DNS_DIRECTORY}\\corp.test.dns`);
  };

  it('reloads the zone from its file: what was changed in the file shows, what was changed in memory since goes (example 1)', async () => {
    const { cmd, ask, clientA } = await governed();
    await edit(cmd);
    expect(addressesOf(await ask(clientA, 'web.corp.test'))).toEqual(['10.0.9.1']);
    expect(await cmd(`${RESTORE_PRIMARY} -Name corp.test -Force -PassThru | ForEach-Object { $_.ZoneName }`)).toBe('corp.test');
    expect(addressesOf(await ask(clientA, 'web.corp.test'))).toEqual(['10.0.9.77']);
  });

  it('asks before it reloads unless -Force is given, and names its target under -WhatIf', async () => {
    const { cmd, ask, clientA } = await governed();
    await edit(cmd);
    expect(await cmd(`${RESTORE_PRIMARY} -Name corp.test`)).toContain(`${RESTORE_PRIMARY}: ${NON_INTERACTIVE}`);
    expect(await cmd(`${RESTORE_PRIMARY} -Name corp.test -WhatIf`)).toContain(`What if: Performing the operation "${RESTORE_PRIMARY}" on target "corp.test".`);
    expect(addressesOf(await ask(clientA, 'web.corp.test'))).toEqual(['10.0.9.1']);
  });

  it('keeps the zone suspended if it was, and its settings', async () => {
    const { cmd } = await governed();
    await cmd('Set-DnsServerPrimaryZone -Name corp.test -DynamicUpdate NonsecureAndSecure');
    await cmd(`${SUSPEND} -Name corp.test -Force`);
    await cmd(`${RESTORE_PRIMARY} -Name corp.test -Force`);
    expect(await cmd('(Get-DnsServerZone -Name corp.test).IsPaused')).toBe('True');
    expect(await cmd('(Get-DnsServerZone -Name corp.test).DynamicUpdate')).toBe('NonsecureAndSecure');
  });

  it('leaves the zone as it was when the file does not load, and says why', async () => {
    const { cmd, ask, clientA } = await governed();
    await cmd(`Set-Content -Path ${DNS_DIRECTORY}\\corp.test.dns -Value "garbage garbage garbage"`);
    expect(await cmd(`${RESTORE_PRIMARY} -Name corp.test -Force`)).toContain(`${RESTORE_PRIMARY}: The zone file "corp.test.dns" is invalid`);
    expect(addressesOf(await ask(clientA, 'web.corp.test'))).toEqual(['10.0.9.1']);
    await cmd(`Remove-Item ${DNS_DIRECTORY}\\corp.test.dns`);
    expect(await cmd(`${RESTORE_PRIMARY} -Name corp.test -Force`)).toContain(`${RESTORE_PRIMARY}: The zone file "corp.test.dns" does not exist in C:\\Windows\\System32\\dns.`);
  });

  it('refuses a zone that is not a primary zone, and a zone that is not on the server', async () => {
    const { cmd, master } = await governed();
    await run(master, 'Add-DnsServerSecondaryZone -Name corp.test -MasterServers 10.0.1.10');
    expect(await run(master, `${RESTORE_PRIMARY} -Name corp.test -Force`)).toContain(`${RESTORE_PRIMARY}: Zone "corp.test" is not a primary zone.`);
    expect(await cmd(`${RESTORE_PRIMARY} -Name nope.test -Force`)).toContain(`${RESTORE_PRIMARY}: ${NO_ZONE('nope.test')}`);
  });
});

describe('Restore-DnsServerSecondaryZone', () => {
  const pulled = async (master: Parameters<typeof run>[0], expected: string): Promise<string> => {
    const listing = '(Get-DnsServerResourceRecord -ZoneName corp.test -Name web).RecordData.IPv4Address';
    let seen = await run(master, listing);
    for (let attempt = 0; attempt < 40 && seen !== expected; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 50));
      seen = await run(master, listing);
    }
    return seen;
  };

  it('copies the zone again from its master (example 1)', async () => {
    const { cmd, master } = await governed();
    await cmd('Set-DnsServerPrimaryZone -Name corp.test -SecureSecondaries TransferAnyServer');
    await run(master, 'Add-DnsServerSecondaryZone -Name corp.test -ZoneFile corp.test.dns -MasterServers 10.0.1.10');
    await run(master, 'Start-DnsServerZoneTransfer -Name corp.test');
    expect(await pulled(master, '10.0.9.1')).toBe('10.0.9.1');
    await cmd('Set-DnsServerResourceRecord -ZoneName corp.test -OldInputObject (Get-DnsServerResourceRecord -ZoneName corp.test -Name web -RRType A) -NewInputObject (Get-DnsServerResourceRecord -ZoneName corp.test -Name web -RRType A | ForEach-Object { $_.RecordData.IPv4Address = "10.0.9.55"; $_ })');
    expect(await run(master, `${RESTORE_SECONDARY} -Name corp.test -Force -PassThru | ForEach-Object { $_.ZoneName }`)).toBe('corp.test');
    expect(await pulled(master, '10.0.9.55')).toBe('10.0.9.55');
  }, 30000);

  it('refuses a zone that is not a secondary zone, and a zone that is not on the server', async () => {
    const { cmd } = await governed();
    expect(await cmd(`${RESTORE_SECONDARY} -Name corp.test -Force`)).toContain(`${RESTORE_SECONDARY}: Zone "corp.test" is not a secondary zone.`);
    expect(await cmd(`${RESTORE_SECONDARY} -Name nope.test -Force`)).toContain(`${RESTORE_SECONDARY}: ${NO_ZONE('nope.test')}`);
  });

  it('asks before it copies unless -Force is given, and names its target under -WhatIf', async () => {
    const { master } = await governed();
    await run(master, 'Add-DnsServerSecondaryZone -Name corp.test -MasterServers 10.0.1.10');
    expect(await run(master, `${RESTORE_SECONDARY} -Name corp.test`)).toContain(`${RESTORE_SECONDARY}: ${NON_INTERACTIVE}`);
    expect(await run(master, `${RESTORE_SECONDARY} -Name corp.test -WhatIf`)).toContain(`What if: Performing the operation "${RESTORE_SECONDARY}" on target "corp.test".`);
  });
});
