/*
 * Probe — DnssecStatistics counts what the recursive resolver of a Windows DNS server really validates: an answer that
 * chains to a trust anchor counts as a successful validation, an answer that was tampered with counts as a failed one, an
 * answer served from the cache is not validated again and counts for nothing, and a server without trust anchor validates
 * nothing. The lab is that of windows-dns-dnssec-validation-probe: a signed zone on a Linux authoritative server, a Windows
 * DNS server forwarding to it, a client asking for the record.
 *
 * Measured first: DnssecStatistics did not exist, the three counters were never fed.
 *
 * Authority: DnsServerDnssecStatistics (SuccessfulValidations: "the number of times a validation attempt on a DNSSEC
 * signature or DS digest hash succeeded"; FailedValidations: "... failed"), the same lab and anchors as the existing
 * validation probe. One count per validated answer, not per signature checked, and RecursionFailures (the failure of a
 * fetch of DNSSEC data) is not told apart from a bogus answer by the validator, so it stays at zero: said here.
 *
 * Discrimination (the probe run on the tree before the change): 4 of 6 cases fall. The two that pass either way are the
 * CONTROL (the lab itself is sound: the signed answer is served, validated with an anchor and not without) and the
 * NON-REGRESSION "validates nothing without a trust anchor" (a server with no anchor counts nothing, before and after).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { WindowsServer } from '@/network/devices/WindowsServer';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';
import { RRType, DnsClass } from '@/network/dns/wire/RRType';
import { DnsOpcode, DnsRcode } from '@/network/dns/wire/DnsHeaderFlags';
import { Zone } from '@/network/dns/zone/Zone';
import { makeARecord, makeSoaRecord, makeNsRecord } from '@/network/dns/wire/ResourceRecord';
import { PrimaryZoneAgent } from '@/network/dns/transfer/PrimaryZoneAgent';
import { generateZoneKey } from '@/network/dns/dnssec/DnsKey';
import { signZone } from '@/network/dns/dnssec/DnsSigner';
import { makeOptRecord } from '@/network/dns/wire/EdnsOptRecord';
import { queryDnsOverUdp } from '@/network/dns/transport/DnsUdpTransport';
import type { DnsMessage } from '@/network/dns/wire/DnsMessage';

const run = async (machine: WindowsServer, line: string): Promise<string> =>
  (await PowerShellSubShell.create(machine).subShell.processLine(line)).output.join('\n');

function query(): DnsMessage {
  return {
    id: 5,
    flags: { qr: false, opcode: DnsOpcode.QUERY, aa: false, tc: false, rd: true, ra: false, ad: false, cd: false, rcode: DnsRcode.NOERROR },
    questions: [{ qname: 'www.lab.test', qtype: RRType.A, qclass: DnsClass.IN }],
    answers: [], authorities: [], additionals: [makeOptRecord(4096, { dnssecOk: true })],
  };
}

async function lab(options: { anchor: boolean; tamper?: boolean }) {
  const sw = new GenericSwitch('switch-generic', 'sw', 8, 0, 0);
  const auth = new LinuxServer('linux-server', 'AUTH');
  const wns = new WindowsServer('DNS1');
  const pc = new LinuxPC('linux-pc', 'PC1');
  const mask = new SubnetMask('255.255.255.0');
  [auth, wns, pc].forEach((device, index) => new Cable(`c${index}`).connect(device.getPorts()[0], sw.getPorts()[index]));
  auth.getPorts()[0].configureIP(new IPAddress('10.0.0.2'), mask);
  wns.getPorts()[0].configureIP(new IPAddress('10.0.0.3'), mask);
  pc.getPorts()[0].configureIP(new IPAddress('10.0.0.4'), mask);
  wns.setCurrentUser('Administrator');
  const zone = new Zone('lab.test', makeSoaRecord('lab.test', 3600, {
    mname: 'ns.lab.test', rname: 'h.lab.test', serial: 1, refresh: 7200, retry: 3600, expire: 1209600, minimum: 300,
  }));
  zone.addRecord(makeNsRecord('lab.test', 3600, 'ns.lab.test'));
  zone.addRecord(makeARecord('ns.lab.test', 3600, '10.0.0.2'));
  zone.addRecord(makeARecord('www.lab.test', 300, '192.0.2.10'));
  const ksk = generateZoneKey('lab.test', 'ksk', 3600);
  signZone(zone, { zsk: generateZoneKey('lab.test', 'zsk', 3600), ksk });
  if (options.tamper) {
    zone.removeRecord(makeARecord('www.lab.test', 300, '192.0.2.10'));
    zone.addRecord(makeARecord('www.lab.test', 300, '6.6.6.6'));
  }
  new PrimaryZoneAgent(auth, zone).start();
  await run(wns, 'Install-WindowsFeature DNS');
  await run(wns, 'Add-DnsServerForwarder -IPAddress 10.0.0.2');
  if (options.anchor) {
    await run(wns, `Add-DnsServerTrustAnchor -Name lab.test -CryptoAlgorithm EcdsaP256Sha256 -Base64Data "${ksk.data.publicKey}"`);
  }
  return { pc, wns, ask: () => queryDnsOverUdp(pc, new IPAddress('10.0.0.3'), query(), 53, 3000) };
}

const dnssec = (machine: WindowsServer): Promise<string> =>
  run(machine, '$d = (Get-DnsServerStatistics).DnssecStatistics; "$($d.SuccessfulValidations) $($d.FailedValidations) $($d.RecursionFailures)"');

beforeEach(() => { resetCounters(); resetDeviceCounters(); Logger.clear(); });

describe('the DNSSEC validations of the resolver', () => {
  it('CONTROL: the lab serves the signed answer, validated with an anchor and unvalidated without', async () => {
    const withAnchor = await lab({ anchor: true });
    expect((await withAnchor.ask())?.flags.ad).toBe(true);
    const without = await lab({ anchor: false });
    const reply = await without.ask();
    expect(reply?.flags.rcode).toBe(DnsRcode.NOERROR);
    expect(reply?.flags.ad).toBe(false);
  });

  it('counts a successful validation for an answer that chains to the anchor', async () => {
    const { wns, ask } = await lab({ anchor: true });
    await ask();
    expect(await dnssec(wns)).toBe('1 0 0');
  });

  it('counts a failed validation for an answer that was tampered with', async () => {
    const { wns, ask } = await lab({ anchor: true, tamper: true });
    expect((await ask())?.flags.rcode).toBe(DnsRcode.SERVFAIL);
    expect(await dnssec(wns)).toBe('0 1 0');
  });

  it('counts a validation once: the second answer comes from the cache', async () => {
    const { wns, ask } = await lab({ anchor: true });
    await ask();
    await ask();
    expect(await dnssec(wns)).toBe('1 0 0');
  });

  it('validates nothing without a trust anchor', async () => {
    const { wns, ask } = await lab({ anchor: false });
    await ask();
    expect(await dnssec(wns)).toBe('0 0 0');
  });

  it('leaves the validations of a cleared server at zero and counts the next one', async () => {
    const { wns, ask } = await lab({ anchor: true });
    await ask();
    await run(wns, 'Clear-DnsServerStatistics -Force');
    expect(await dnssec(wns)).toBe('0 0 0');
    await run(wns, 'Clear-DnsServerCache -Force');
    await ask();
    expect(await dnssec(wns)).toBe('1 0 0');
  });
});
