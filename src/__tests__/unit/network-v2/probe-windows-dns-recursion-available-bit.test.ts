/*
 * Probe — the RA bit of what a Windows DNS server answers follows its recursion setting, whoever produced the answer.
 *
 * Measured first (a Windows DNS server holding corp.test with recursion enabled, a Linux client, UDP and TCP): the
 * server answered every question it held itself with RA=0 — a name it hosts, a name that does not exist, a malformed
 * query — and only the answers it fetched elsewhere (forwarder, global names) said RA=1, so dig printed
 * ";; WARNING: recursion requested but not available" against a server that recurses, and the flags letter R was
 * missing from the dns.log line of the same answer.
 *
 * Authority: RFC 1035 4.1.1 (STD 13), "RA Recursion Available - this be is set or cleared in a response, and denotes
 * whether recursive query support is available in the name server" — a property of the server, not of the query, so it is
 * the same whatever the RD bit asked and whichever part of the server wrote the answer; the Windows setting is the
 * NoRecursion value of the DNS Parameters key ([MS-DNSP] 3.1.1.1.1), written by Set-DnsServerRecursion.
 *
 * Discrimination (the probe run on the tree before the change): 8 of 9 cases fall. The one that passes either way is the
 * CONTROL "dig against a server that no longer recurses prints ra-less flags and the warning": a server without
 * recursion said RA=0 before the change and says it after, and the same case asserts that the lab answered.
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
import { queryDnsOverTcp } from '@/network/dns/transport/DnsTcpTransport';
import type { DnsMessage } from '@/network/dns/wire/DnsMessage';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';

const SERVER = '10.0.1.10';
const CLIENT = '10.0.1.2';

beforeEach(() => { resetCounters(); resetDeviceCounters(); Logger.clear(); });

const run = async (machine: WindowsServer, line: string): Promise<string> =>
  (await PowerShellSubShell.create(machine).subShell.processLine(line)).output.join('\n');

function question(qname: string, rd = true, extra: readonly string[] = []): DnsMessage {
  return {
    id: 0x5a5a,
    flags: { qr: false, opcode: DnsOpcode.QUERY, aa: false, tc: false, rd, ra: false, ad: false, cd: false, rcode: DnsRcode.NOERROR },
    questions: [qname, ...extra].map((name) => ({ qname: name, qtype: RRType.A, qclass: DnsClass.IN })),
    answers: [], authorities: [], additionals: [],
  };
}

async function lab() {
  const sw = new GenericSwitch('switch-generic', 'sw1', 8, 0, 0);
  const server = new WindowsServer('WNS1');
  const client = new LinuxPC('linux-pc', 'PC1');
  const mask = new SubnetMask('255.255.255.0');
  [server, client].forEach((device, index) => {
    new Cable(`c${index}`).connect(device.getPorts()[0], sw.getPorts()[index]);
    device.getPorts()[0].configureIP(new IPAddress([SERVER, CLIENT][index]), mask);
  });
  server.setCurrentUser('Administrator');
  await run(server, 'Install-WindowsFeature DNS');
  await run(server, 'Add-DnsServerPrimaryZone -Name corp.test');
  await run(server, 'Add-DnsServerResourceRecordA -ZoneName corp.test -Name web -IPv4Address 10.0.9.1');
  const ask = (qname: string, rd = true, extra: readonly string[] = []) =>
    queryDnsOverUdp(client, new IPAddress(SERVER), question(qname, rd, extra), 53, 9000);
  const askOverTcp = (qname: string) => queryDnsOverTcp(client, new IPAddress(SERVER), question(qname), 53, 9000);
  return { server, client, ask, askOverTcp };
}

describe('the RA bit of a Windows DNS server with recursion enabled', () => {
  it('an authoritative answer carries RA', async () => {
    const { ask } = await lab();
    const reply = await ask('web.corp.test');
    expect(reply!.answers.map((record) => record.name)).toEqual(['web.corp.test']);
    expect(reply!.flags).toMatchObject({ qr: true, aa: true, rd: true, ra: true, rcode: DnsRcode.NOERROR });
  });

  it('RA does not depend on RD: a query that did not ask for recursion still learns that the server offers it', async () => {
    const { ask } = await lab();
    const reply = await ask('web.corp.test', false);
    expect(reply!.answers.map((record) => record.name)).toEqual(['web.corp.test']);
    expect(reply!.flags).toMatchObject({ aa: true, rd: false, ra: true });
  });

  it('an authoritative NXDOMAIN carries RA', async () => {
    const { ask } = await lab();
    const reply = await ask('absent.corp.test');
    expect(reply!.flags).toMatchObject({ qr: true, aa: true, ra: true, rcode: DnsRcode.NXDOMAIN });
  });

  it('over TCP the answer carries RA', async () => {
    const { askOverTcp } = await lab();
    const reply = await askOverTcp('web.corp.test');
    expect(reply!.answers.map((record) => record.name)).toEqual(['web.corp.test']);
    expect(reply!.flags).toMatchObject({ aa: true, ra: true });
  });

  it('a query with two questions is refused FORMERR and still carries RA', async () => {
    const { ask } = await lab();
    const reply = await ask('web.corp.test', true, ['absent.corp.test']);
    expect(reply!.flags).toMatchObject({ qr: true, ra: true, rcode: DnsRcode.FORMERR });
  });

  it('dig prints the ra flag and no warning that recursion is unavailable', async () => {
    const { client } = await lab();
    const out = await client.executeCommand(`dig @${SERVER} web.corp.test`);
    expect(out).toContain('status: NOERROR');
    expect(out).toMatch(/flags: qr aa rd ra;/);
    expect(out).not.toContain('WARNING: recursion requested but not available');
    expect(out).toContain('10.0.9.1');
  });
});

describe('the RA bit follows the recursion setting', () => {
  it('disabling recursion clears RA on the answers; enabling it again sets RA back', async () => {
    const { server, ask } = await lab();
    await run(server, 'Set-DnsServerRecursion -Enable $false');
    const disabled = await ask('web.corp.test');
    expect(disabled!.answers.map((record) => record.name)).toEqual(['web.corp.test']);
    expect(disabled!.flags).toMatchObject({ aa: true, rd: true, ra: false });
    await run(server, 'Set-DnsServerRecursion -Enable $true');
    const enabled = await ask('web.corp.test');
    expect(enabled!.flags).toMatchObject({ aa: true, rd: true, ra: true });
  });

  it('CONTROL: dig against a server that no longer recurses prints ra-less flags and the warning', async () => {
    const { server, client } = await lab();
    await run(server, 'Set-DnsServerRecursion -Enable $false');
    const out = await client.executeCommand(`dig @${SERVER} web.corp.test`);
    expect(out).toContain('10.0.9.1');
    expect(out).toMatch(/flags: qr aa rd;/);
    expect(out).toContain(';; WARNING: recursion requested but not available');
  });

  it('the setting is the registry value: a reg add of NoRecursion changes the bit on the next answer', async () => {
    const { server, ask } = await lab();
    await server.executeCommand('reg add HKLM\\SYSTEM\\CurrentControlSet\\Services\\DNS\\Parameters /v NoRecursion /t REG_DWORD /d 1 /f');
    expect((await ask('web.corp.test'))!.flags.ra).toBe(false);
    await server.executeCommand('reg add HKLM\\SYSTEM\\CurrentControlSet\\Services\\DNS\\Parameters /v NoRecursion /t REG_DWORD /d 0 /f');
    expect((await ask('web.corp.test'))!.flags.ra).toBe(true);
  });
});
