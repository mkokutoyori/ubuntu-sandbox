/*
 * Probe — the global query block list of the Windows DNS server is stored in the DNS Parameters registry key, read and
 * changed by Get-/Set-DnsServerGlobalQueryBlockList, and enforced when the server answers from a primary zone.
 *
 * Measured first (a Windows DNS server holding corp.test with wpad, isatap, intranet and www records, a UDP client): the
 * two cmdlets did not exist, the registry held neither EnableGlobalQueryBlockList nor GlobalQueryBlockList, and the server
 * answered every name it held, so wpad.corp.test resolved to whatever record had been created for it.
 *
 * Authority: [MS-DNSP] 3.1.1.1.1 EnableGlobalQueryBlockList (default 1; when answering from a locally hosted primary zone
 * the server checks the relative portion of the query name against the list and MUST return a name error instead of a
 * positive answer; never applied to the name of the zone; only to records within each zone) and 3.1.1.4 GlobalQueryBlockList
 * (a list of single-label strings; at first start the server stores the generic list, isatap and wpad, with
 * EnableGlobalQueryBlockList at 1); Microsoft Learn, Set-DnsServerGlobalQueryBlockList (-Enable, -List replaces the whole
 * list, no name clears it, the example shows a name stored in lower case) and Get-DnsServerGlobalQueryBlockList; dnscmd
 * /config /enableglobalqueryblocklist and /globalqueryblocklist (isatap, wpad by default). The dnscmd text says the server
 * "doesn't respond"; [MS-DNSP] says name error, and the protocol document is followed. Not sourced: the order of the two
 * default names in the list (the documentation lists isatap first), and that a secondary zone is left alone (the
 * protocol document speaks of primary zones only).
 *
 * Discrimination (the probe run on the tree before the change): 13 of the 17 cases fall. The four that pass either way
 * are the WITNESS (the zone answers an ordinary name), a NON-REGRESSION (names around the blocked label are still
 * answered) and two CONTROLS (the apex of a zone named wpad is not blocked; a secondary zone is left alone).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { WindowsServer } from '@/network/devices/WindowsServer';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { RRType, DnsClass } from '@/network/dns/wire/RRType';
import { DnsOpcode, DnsRcode } from '@/network/dns/wire/DnsHeaderFlags';
import { queryDnsOverUdp } from '@/network/dns/transport/DnsUdpTransport';
import type { DnsMessage } from '@/network/dns/wire/DnsMessage';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';

const PARAMETERS = 'HKLM\\SYSTEM\\CurrentControlSet\\Services\\DNS\\Parameters';

beforeEach(() => { resetCounters(); resetDeviceCounters(); Logger.clear(); });

const run = async (server: WindowsServer, line: string): Promise<string> =>
  (await PowerShellSubShell.create(server).subShell.processLine(line)).output.join('\n');

function question(qname: string, qtype: number): DnsMessage {
  return {
    id: Math.floor(Math.random() * 60000),
    flags: { qr: false, opcode: DnsOpcode.QUERY, aa: false, tc: false, rd: false, ra: false, ad: false, cd: false, rcode: DnsRcode.NOERROR },
    questions: [{ qname, qtype, qclass: DnsClass.IN }],
    answers: [], authorities: [], additionals: [],
  };
}

async function lab() {
  const sw = new GenericSwitch('switch-generic', 'sw1', 8, 0, 0);
  const server = new WindowsServer('WNS1');
  const master = new WindowsServer('WNS2');
  const client = new LinuxPC('linux-pc', 'PC1');
  const mask = new SubnetMask('255.255.255.0');
  [server, master, client].forEach((device, index) => {
    new Cable(`c${index}`).connect(device.getPorts()[0], sw.getPorts()[index]);
    device.getPorts()[0].configureIP(new IPAddress(['10.0.1.10', '10.0.1.30', '10.0.1.2'][index]), mask);
  });
  for (const machine of [server, master]) {
    machine.setCurrentUser('Administrator');
    await run(machine, 'Install-WindowsFeature DNS');
  }
  await run(server, 'Add-DnsServerPrimaryZone -Name corp.test');
  for (const [name, address] of [['www', '10.0.9.1'], ['wpad', '10.0.9.9'], ['isatap', '10.0.9.10'], ['intranet', '10.0.9.11'], ['x.wpad', '10.0.9.12'], ['wpad.x', '10.0.9.13']]) {
    await run(server, `Add-DnsServerResourceRecordA -ZoneName corp.test -Name ${name} -IPv4Address ${address}`);
  }
  await run(server, 'Add-DnsServerPrimaryZone -Name wpad.test');
  await run(server, 'Add-DnsServerResourceRecordA -ZoneName wpad.test -Name @ -IPv4Address 10.0.9.20');
  const ask = (qname: string, qtype: number = RRType.A) => queryDnsOverUdp(client, new IPAddress('10.0.1.10'), question(qname, qtype), 53, 9000);
  return { server, master, ask };
}

describe('the list and its cmdlets', () => {
  it('Get-DnsServerGlobalQueryBlockList reports the generic list, enabled', async () => {
    const { server } = await lab();
    const out = await run(server, 'Get-DnsServerGlobalQueryBlockList');
    expect(out).toMatch(/Enable\s+:\s+True/);
    expect(out).toMatch(/List\s+:\s+\{isatap, wpad\}/);
  });

  it('the server stores the generic list in the registry when it first starts', async () => {
    const { server } = await lab();
    const registry = await server.executeCommand(`reg query ${PARAMETERS}`);
    expect(registry).toMatch(/EnableGlobalQueryBlockList\s+REG_DWORD\s+0x1/);
    expect(registry).toMatch(/GlobalQueryBlockList\s+REG_MULTI_SZ\s+isatap\\0wpad/);
  });

  it('-List replaces the whole list and stores names in lower case, -PassThru shows the result', async () => {
    const { server } = await lab();
    const out = await run(server, 'Set-DnsServerGlobalQueryBlockList -List "Isatap" -PassThru');
    expect(out).toMatch(/Enable\s+:\s+True/);
    expect(out).toMatch(/List\s+:\s+\{isatap\}/);
  });

  it('the names are stored in lower case in the registry', async () => {
    const { server } = await lab();
    await run(server, 'Set-DnsServerGlobalQueryBlockList -List "Isatap","WPAD"');
    expect(await server.executeCommand(`reg query ${PARAMETERS} /v GlobalQueryBlockList`)).toMatch(/REG_MULTI_SZ\s+isatap\\0wpad/);
  });

  it('a value written with reg.exe is the setting the cmdlet reports', async () => {
    const { server } = await lab();
    await server.executeCommand(`reg add ${PARAMETERS} /v EnableGlobalQueryBlockList /t REG_DWORD /d 0 /f`);
    expect(await run(server, 'Get-DnsServerGlobalQueryBlockList')).toMatch(/Enable\s+:\s+False/);
  });
});

describe('answering from a primary zone', () => {
  it('WITNESS: an ordinary name is answered', async () => {
    const { ask } = await lab();
    const reply = await ask('www.corp.test');
    expect(reply?.flags.rcode).toBe(DnsRcode.NOERROR);
    expect(reply?.answers).toHaveLength(1);
  });

  it('a name on the list gets a name error although the zone holds a record for it', async () => {
    const { ask } = await lab();
    expect((await ask('wpad.corp.test'))?.flags.rcode).toBe(DnsRcode.NXDOMAIN);
    expect((await ask('isatap.corp.test'))?.flags.rcode).toBe(DnsRcode.NXDOMAIN);
  });

  it('the name error is authoritative and carries the SOA of the zone', async () => {
    const { ask } = await lab();
    const reply = await ask('wpad.corp.test');
    expect(reply?.flags.aa).toBe(true);
    expect(reply?.answers).toHaveLength(0);
    expect(reply?.authorities.map((rr) => rr.data.type)).toEqual([RRType.SOA]);
  });

  it('the match ignores case and covers every query type', async () => {
    const { ask } = await lab();
    expect((await ask('WPAD.Corp.Test'))?.flags.rcode).toBe(DnsRcode.NXDOMAIN);
    expect((await ask('wpad.corp.test', RRType.AAAA))?.flags.rcode).toBe(DnsRcode.NXDOMAIN);
  });

  it('NON-REGRESSION: only the whole relative name is compared, so names around the blocked label are answered', async () => {
    const { ask } = await lab();
    expect((await ask('x.wpad.corp.test'))?.answers).toHaveLength(1);
    expect((await ask('wpad.x.corp.test'))?.answers).toHaveLength(1);
  });

  it('CONTROL: the name of a zone is never blocked, even a zone called wpad', async () => {
    const { ask } = await lab();
    expect((await ask('wpad.test'))?.answers).toHaveLength(1);
  });

  it('-Enable $false lets the names through, -Enable $true blocks them again', async () => {
    const { server, ask } = await lab();
    expect((await ask('wpad.corp.test'))?.flags.rcode).toBe(DnsRcode.NXDOMAIN);
    await run(server, 'Set-DnsServerGlobalQueryBlockList -Enable $false');
    expect((await ask('wpad.corp.test'))?.answers).toHaveLength(1);
    await run(server, 'Set-DnsServerGlobalQueryBlockList -Enable $true');
    expect((await ask('wpad.corp.test'))?.flags.rcode).toBe(DnsRcode.NXDOMAIN);
  });

  it('-List swaps the blocked names: the old ones are answered, the new one is refused', async () => {
    const { server, ask } = await lab();
    await run(server, 'Set-DnsServerGlobalQueryBlockList -List "intranet"');
    expect((await ask('intranet.corp.test'))?.flags.rcode).toBe(DnsRcode.NXDOMAIN);
    expect((await ask('wpad.corp.test'))?.answers).toHaveLength(1);
    expect((await ask('isatap.corp.test'))?.answers).toHaveLength(1);
  });

  it('an empty -List clears the list', async () => {
    const { server, ask } = await lab();
    await run(server, 'Set-DnsServerGlobalQueryBlockList -List @()');
    expect(await run(server, '(Get-DnsServerGlobalQueryBlockList).List.Count')).toBe('0');
    expect((await ask('wpad.corp.test'))?.answers).toHaveLength(1);
  });

  it('a block list that is enabled by default keeps blocking when its registry value is deleted', async () => {
    const { server, ask } = await lab();
    await server.executeCommand(`reg delete ${PARAMETERS} /v EnableGlobalQueryBlockList /f`);
    expect((await ask('wpad.corp.test'))?.flags.rcode).toBe(DnsRcode.NXDOMAIN);
  });

  it('CONTROL: a secondary zone is not touched, the protocol document speaks of primary zones only', async () => {
    const { server, master, ask } = await lab();
    await run(master, 'Add-DnsServerPrimaryZone -Name sec.test');
    await run(master, 'Add-DnsServerResourceRecordA -ZoneName sec.test -Name wpad -IPv4Address 10.0.9.30');
    await run(master, 'Set-DnsServerPrimaryZone -Name sec.test -SecureSecondaries TransferAnyServer');
    await run(server, 'Add-DnsServerSecondaryZone -Name sec.test -MasterServers 10.0.1.30');
    const deadline = Date.now() + 8000;
    let reply = await ask('wpad.sec.test');
    while (reply?.answers.length !== 1 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      reply = await ask('wpad.sec.test');
    }
    expect(reply?.answers).toHaveLength(1);
  }, 20000);

  it('a value written with reg.exe changes the answers at once', async () => {
    const { server, ask } = await lab();
    expect((await ask('wpad.corp.test'))?.flags.rcode).toBe(DnsRcode.NXDOMAIN);
    await server.executeCommand(`reg add ${PARAMETERS} /v EnableGlobalQueryBlockList /t REG_DWORD /d 0 /f`);
    expect((await ask('wpad.corp.test'))?.answers).toHaveLength(1);
  });
});
