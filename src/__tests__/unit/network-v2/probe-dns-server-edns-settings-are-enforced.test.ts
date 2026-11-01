/*
 * Probe — Get-/Set-DnsServerEDns exist, keep their settings in the DNS Parameters registry key, and the Windows DNS
 * server obeys them on the wire: EnableProbes decides whether its queries to other servers carry an EDNS record,
 * EnableReception whether it accepts a query that carries one, CacheTimeout how long it remembers that a server does not
 * support EDNS.
 *
 * Measured first (a recursive Windows DNS server resolving through a second Windows DNS server, a tap on the second
 * one's port decoding every inbound query): the cmdlets did not exist; the recursive server never put an OPT record in
 * a query; the second server answered a query that carried one whatever its settings; a server that answered FORMERR to
 * an OPT query broke the resolution (no retry without the record, nothing remembered).
 *
 * Authority: [MS-DNSP] 3.1.1.1.1 EnableEDnsProbes (the server includes EDNS records in remote queries; default 1; zero
 * literal), EnableEDnsReception (the server accepts queries that contain an EDNS record; default 1; zero literal) and
 * EDnsCacheTimeout (the interval for which the server caches the remote server's support of EDNS; default 900 seconds;
 * zero stands for the default); RFC 6891 section 7 (a responder that does not implement EDNS answers FORMERR to a message
 * with an OPT record and does not put one in the response; a requestor retries without EDNS); Microsoft Learn KB 832223
 * (the Windows server's queries carry an OPT record with a UDP payload size of 1280; dnscmd /config /enableednsprobes 0
 * turns it off); Microsoft Learn, Get-/Set-DnsServerEDns (CacheTimeout, EnableProbes, EnableReception). The Learn page of
 * Set-DnsServerEDns gives a default CacheTimeout of one week; [MS-DNSP] and the cmdlet's own output on a real server say
 * 15 minutes, and the protocol document is followed. Not sourced: that a FORMERR is the only reason to remember a server
 * as not supporting EDNS.
 *
 * Discrimination (the probe run on the tree before the change): 8 of the 11 cases fall. The three that pass either way
 * are CONTROLS (with probes off the queries carry no OPT record and still resolve; a server with reception off still
 * answers a query without one; a server that accepts EDNS answers with an OPT record in its reply).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { IPAddress, SubnetMask, resetCounters, ETHERTYPE_IPV4, type IPv4Packet, type UDPPacket } from '@/network/core/types';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { WindowsServer } from '@/network/devices/WindowsServer';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { RRType, DnsClass } from '@/network/dns/wire/RRType';
import { DnsOpcode, DnsRcode } from '@/network/dns/wire/DnsHeaderFlags';
import { decodeDnsMessage } from '@/network/dns/wire/DnsMessageCodec';
import { makeOptRecord, findOpt } from '@/network/dns/wire/EdnsOptRecord';
import { queryDnsOverUdp } from '@/network/dns/transport/DnsUdpTransport';
import type { DnsMessage } from '@/network/dns/wire/DnsMessage';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';

const PARAMETERS = 'HKLM\\SYSTEM\\CurrentControlSet\\Services\\DNS\\Parameters';

beforeEach(() => { resetCounters(); resetDeviceCounters(); Logger.clear(); });

const run = async (server: WindowsServer, line: string): Promise<string> =>
  (await PowerShellSubShell.create(server).subShell.processLine(line)).output.join('\n');

function question(qname: string, qtype: number, withOpt: boolean): DnsMessage {
  return {
    id: Math.floor(Math.random() * 60000),
    flags: { qr: false, opcode: DnsOpcode.QUERY, aa: false, tc: false, rd: true, ra: false, ad: false, cd: false, rcode: DnsRcode.NOERROR },
    questions: [{ qname, qtype, qclass: DnsClass.IN }],
    answers: [], authorities: [], additionals: withOpt ? [makeOptRecord(1232)] : [],
  };
}

interface Seen { readonly qname: string; readonly opt: number | null }

async function lab() {
  const sw = new GenericSwitch('switch-generic', 'sw1', 8, 0, 0);
  const resolver = new WindowsServer('WNS1');
  const authority = new WindowsServer('WNS2');
  const client = new LinuxPC('linux-pc', 'PC1');
  const mask = new SubnetMask('255.255.255.0');
  [resolver, authority, client].forEach((device, index) => {
    new Cable(`c${index}`).connect(device.getPorts()[0], sw.getPorts()[index]);
    device.getPorts()[0].configureIP(new IPAddress(['10.0.1.10', '10.0.1.30', '10.0.1.2'][index]), mask);
  });
  for (const machine of [resolver, authority]) {
    machine.setCurrentUser('Administrator');
    await run(machine, 'Install-WindowsFeature DNS');
  }
  await run(authority, 'Add-DnsServerPrimaryZone -Name lab.test');
  for (const name of ['www', 'mail', 'ftp', 'db']) {
    await run(authority, `Add-DnsServerResourceRecordA -ZoneName lab.test -Name ${name} -IPv4Address 10.0.9.1`);
  }
  await run(resolver, 'foreach ($h in Get-DnsServerRootHint) { Remove-DnsServerRootHint -NameServer $h.NameServer -Force }');
  await run(resolver, 'Add-DnsServerRootHint -NameServer a.root.test -IPAddress 10.0.1.30');
  const seen: Seen[] = [];
  authority.getPorts()[0].attachTap(({ direction, frame }) => {
    if (direction !== 'in' || frame.etherType !== ETHERTYPE_IPV4) return;
    const udp = (frame.payload as IPv4Packet).payload as UDPPacket | undefined;
    if (udp?.type !== 'udp' || udp.destinationPort !== 53 || !(udp.payload instanceof Uint8Array)) return;
    const message = decodeDnsMessage(udp.payload);
    if (message.flags.qr) return;
    const opt = findOpt(message);
    seen.push({ qname: message.questions[0].qname, opt: opt === null ? null : opt.data.udpPayloadSize });
  });
  const askResolver = (qname: string) => queryDnsOverUdp(client, new IPAddress('10.0.1.10'), question(qname, RRType.A, false), 53, 9000);
  const askAuthority = (qname: string, withOpt: boolean) => queryDnsOverUdp(client, new IPAddress('10.0.1.30'), question(qname, RRType.A, withOpt), 53, 9000);
  const seenFor = (qname: string): Seen[] => seen.filter((entry) => entry.qname === qname);
  return { resolver, authority, askResolver, askAuthority, seenFor };
}

describe('the settings surface', () => {
  it('Get-DnsServerEDns reports the documented defaults', async () => {
    const { resolver } = await lab();
    expect(await run(resolver, '(Get-DnsServerEDns).CacheTimeout.TotalSeconds')).toBe('900');
    expect(await run(resolver, '(Get-DnsServerEDns).EnableProbes')).toBe('True');
    expect(await run(resolver, '(Get-DnsServerEDns).EnableReception')).toBe('True');
  });

  it('Set-DnsServerEDns writes the DNS Parameters registry values and reads them back, -PassThru shows them', async () => {
    const { resolver } = await lab();
    const out = await run(resolver, 'Set-DnsServerEDns -CacheTimeout 00:30:00 -EnableProbes $false -EnableReception $false -PassThru');
    expect(out).toMatch(/00:30:00\s+False\s+False/);
    const registry = await resolver.executeCommand(`reg query ${PARAMETERS}`);
    expect(registry).toMatch(/EDnsCacheTimeout\s+REG_DWORD\s+0x708/);
    expect(registry).toMatch(/EnableEDnsProbes\s+REG_DWORD\s+0x0/);
    expect(registry).toMatch(/EnableEDnsReception\s+REG_DWORD\s+0x0/);
  });

  it('a value written with reg.exe is the setting the cmdlet reports', async () => {
    const { resolver } = await lab();
    await resolver.executeCommand(`reg add ${PARAMETERS} /v EnableEDnsProbes /t REG_DWORD /d 0 /f`);
    expect(await run(resolver, '(Get-DnsServerEDns).EnableProbes')).toBe('False');
  });

  it('a cache timeout of zero stands for the default', async () => {
    const { resolver } = await lab();
    await run(resolver, 'Set-DnsServerEDns -CacheTimeout 00:00:00');
    expect(await run(resolver, '(Get-DnsServerEDns).CacheTimeout.TotalSeconds')).toBe('900');
  });
});

describe('EnableProbes', () => {
  it('the recursive server puts an OPT record of 1280 bytes in the queries it sends', async () => {
    const { askResolver, seenFor } = await lab();
    expect((await askResolver('www.lab.test'))?.answers).toHaveLength(1);
    expect(seenFor('www.lab.test')).toEqual([{ qname: 'www.lab.test', opt: 1280 }]);
  });

  it('CONTROL: with probes off its queries carry no OPT record and still resolve', async () => {
    const { resolver, askResolver, seenFor } = await lab();
    await run(resolver, 'Set-DnsServerEDns -EnableProbes $false');
    expect((await askResolver('www.lab.test'))?.answers).toHaveLength(1);
    expect(seenFor('www.lab.test')).toEqual([{ qname: 'www.lab.test', opt: null }]);
  });
});

describe('EnableReception', () => {
  it('a server that does not accept EDNS answers FORMERR to a query with an OPT record', async () => {
    const { authority, askAuthority } = await lab();
    await run(authority, 'Set-DnsServerEDns -EnableReception $false');
    const reply = await askAuthority('www.lab.test', true);
    expect(reply?.flags.rcode).toBe(DnsRcode.FORMERR);
    expect(reply?.additionals.some((rr) => rr.data.type === RRType.OPT)).toBe(false);
  });

  it('CONTROL: the same server still answers a query without one', async () => {
    const { authority, askAuthority } = await lab();
    await run(authority, 'Set-DnsServerEDns -EnableReception $false');
    expect((await askAuthority('www.lab.test', false))?.answers).toHaveLength(1);
  });

  it('CONTROL: a server that accepts EDNS answers the query with an OPT record in the reply', async () => {
    const { askAuthority } = await lab();
    const reply = await askAuthority('www.lab.test', true);
    expect(reply?.answers).toHaveLength(1);
    expect(reply?.additionals.some((rr) => rr.data.type === RRType.OPT)).toBe(true);
  });
});

describe('a server that answers FORMERR to EDNS', () => {
  it('is queried again without the record, and remembered for the next names', async () => {
    const { authority, askResolver, seenFor } = await lab();
    await run(authority, 'Set-DnsServerEDns -EnableReception $false');
    expect((await askResolver('www.lab.test'))?.answers).toHaveLength(1);
    expect(seenFor('www.lab.test')).toEqual([{ qname: 'www.lab.test', opt: 1280 }, { qname: 'www.lab.test', opt: null }]);
    expect((await askResolver('mail.lab.test'))?.answers).toHaveLength(1);
    expect(seenFor('mail.lab.test')).toEqual([{ qname: 'mail.lab.test', opt: null }]);
  });

  it('is probed again once the cache timeout has passed', async () => {
    const { resolver, authority, askResolver, seenFor } = await lab();
    await run(authority, 'Set-DnsServerEDns -EnableReception $false');
    await run(resolver, 'Set-DnsServerEDns -CacheTimeout 00:00:30');
    await askResolver('www.lab.test');
    resolver._stepSystemClock(29_000);
    await askResolver('mail.lab.test');
    expect(seenFor('mail.lab.test')).toEqual([{ qname: 'mail.lab.test', opt: null }]);
    resolver._stepSystemClock(2_000);
    await askResolver('ftp.lab.test');
    expect(seenFor('ftp.lab.test')).toEqual([{ qname: 'ftp.lab.test', opt: 1280 }, { qname: 'ftp.lab.test', opt: null }]);
  });
});
