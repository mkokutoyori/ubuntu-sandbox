/*
 * Windows DNS Server role: zone types, zone transfer and NOTIFY on the wire,
 * conditional forwarders, generic record cmdlets, cache and zone files.
 *
 * Lab: one switch, WNS1 (Windows Server, DNS role, 10.0.1.10), NS2 (Linux,
 * BIND9, 10.0.1.20), WNS3 (Windows Server, DNS role, 10.0.1.30) and PC1
 * (Linux, 10.0.1.2) which asks the questions. Every exchange between two
 * machines is a real frame: AXFR runs over TCP/53, NOTIFY and SOA over UDP/53.
 *
 * Discrimination (git stash of the twelve behavioural source files): 21 of
 * the 24 cases fall before the change. The three that pass either way:
 *   - the primary zone answers A queries authoritatively (witness: the lab
 *     itself is sound);
 *   - Get-DnsServerZone keeps listing the zone (non-regression);
 *   - without a forwarder the recursive query is refused (guard: the
 *     conditional-forwarder case cannot pass by accident).
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
import { RRType, DnsClass } from '@/network/dns/wire/RRType';
import { DnsOpcode, DnsRcode } from '@/network/dns/wire/DnsHeaderFlags';
import { queryDnsOverUdp } from '@/network/dns/transport/DnsUdpTransport';
import { queryDnsOverTcp } from '@/network/dns/transport/DnsTcpTransport';
import { parseZoneFile } from '@/network/dns/zone/ZoneFile';
import type { DnsMessage } from '@/network/dns/wire/DnsMessage';
import type { ARecordData } from '@/network/dns/wire/ResourceRecord';
import type { VirtualFileSystem } from '@/network/devices/linux/VirtualFileSystem';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';

const WNS1_IP = '10.0.1.10';
const NS2_IP = '10.0.1.20';
const WNS3_IP = '10.0.1.30';
const PC1_IP = '10.0.1.2';

let nextId = 1;

function makeQuery(qname: string, qtype: number = RRType.A as number, recursion = false): DnsMessage {
  return {
    id: nextId++,
    flags: {
      qr: false, opcode: DnsOpcode.QUERY, aa: false, tc: false,
      rd: recursion, ra: false, ad: false, cd: false, rcode: DnsRcode.NOERROR,
    },
    questions: [{ qname, qtype, qclass: DnsClass.IN }],
    answers: [], authorities: [], additionals: [],
  };
}

const ps = (d: WindowsServer) => PowerShellSubShell.create(d).subShell;
const run = async (d: WindowsServer, line: string) => (await ps(d).processLine(line)).output.join('\n');

function writeRoot(server: LinuxServer, path: string, content: string): void {
  (server as unknown as { executor: { vfs: VirtualFileSystem } }).executor.vfs.writeFile(path, content, 0, 0, 0o022);
}

function bindZone(serial: number, wwwAddress: string): string {
  return [
    '$ORIGIN bind.test.', '$TTL 3600',
    `@ IN SOA ns2.bind.test. admin.bind.test. ( ${serial} 3600 900 604800 300 )`,
    '  IN NS ns2.bind.test.',
    `ns2 IN A ${NS2_IP}`,
    `www IN A ${wwwAddress}`, '',
  ].join('\n');
}

interface Lab { wns1: WindowsServer; ns2: LinuxServer; wns3: WindowsServer; pc1: LinuxPC }

async function buildLab(): Promise<Lab> {
  const sw = new GenericSwitch('switch-generic', 'sw1', 8, 0, 0);
  const wns1 = new WindowsServer('WNS1');
  const ns2 = new LinuxServer('linux-server', 'NS2');
  const wns3 = new WindowsServer('WNS3');
  const pc1 = new LinuxPC('linux-pc', 'PC1');
  const mask = new SubnetMask('255.255.255.0');
  const machines = [wns1, ns2, wns3, pc1];
  const addresses = [WNS1_IP, NS2_IP, WNS3_IP, PC1_IP];
  machines.forEach((device, i) => {
    new Cable(`c${i}`).connect(device.getPorts()[0], sw.getPorts()[i]);
    device.getPorts()[0].configureIP(new IPAddress(addresses[i]), mask);
  });
  wns1.setCurrentUser('Administrator');
  wns3.setCurrentUser('Administrator');
  await run(wns1, 'Install-WindowsFeature DNS');
  await run(wns3, 'Install-WindowsFeature DNS');
  return { wns1, ns2, wns3, pc1 };
}

async function startBind(ns2: LinuxServer, conf: string, serial = 2024010101, www = '10.0.9.1'): Promise<void> {
  writeRoot(ns2, '/etc/bind/named.conf', conf);
  writeRoot(ns2, '/etc/bind/db.bind.test', bindZone(serial, www));
  await ns2.executeCommand('systemctl start named');
}

const BIND_PRIMARY = (extra: string) => [
  'options { recursion no; };',
  'zone "bind.test" { type primary; file "/etc/bind/db.bind.test";', extra, '};', '',
].join('\n');

async function answerFor(from: LinuxPC, server: string, qname: string, qtype: number = RRType.A, recursion = false): Promise<DnsMessage | null> {
  return queryDnsOverUdp(from, new IPAddress(server), makeQuery(qname, qtype, recursion), 53, 600);
}

async function eventually<T>(probe: () => Promise<T | null>, accept: (v: T) => boolean, timeoutMs = 8000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== null && accept(value)) return value;
    if (Date.now() > deadline) throw new Error('condition not reached in time');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

const hasAddress = (address: string) => (m: DnsMessage) =>
  m.answers.some(rr => String((rr.data as ARecordData).address) === address);

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.clear();
});

describe('WINDOWS PRIMARY — zone transfer policy', () => {
  it('TEMOIN : la zone primaire répond en autorité', async () => {
    const { wns1, pc1 } = await buildLab();
    await run(wns1, 'Add-DnsServerPrimaryZone -Name lab.test');
    await run(wns1, 'Add-DnsServerResourceRecordA -ZoneName lab.test -Name www -IPv4Address 10.0.9.5');
    const answer = await answerFor(pc1, WNS1_IP, 'www.lab.test');
    expect(answer?.flags.aa).toBe(true);
    expect(hasAddress('10.0.9.5')(answer!)).toBe(true);
  });

  it('refuse par défaut un AXFR TCP venant d un hôte quelconque', async () => {
    const { wns1, pc1 } = await buildLab();
    await run(wns1, 'Add-DnsServerPrimaryZone -Name lab.test');
    const reply = await queryDnsOverTcp(pc1, new IPAddress(WNS1_IP), makeQuery('lab.test', RRType.AXFR), 53, 1000);
    expect(reply?.flags.rcode).toBe(DnsRcode.REFUSED);
    expect(reply?.answers).toHaveLength(0);
  });

  it('refuse un AXFR sur UDP même avec TransferAnyServer', async () => {
    const { wns1, pc1 } = await buildLab();
    await run(wns1, 'Add-DnsServerPrimaryZone -Name lab.test');
    await run(wns1, 'Set-DnsServerPrimaryZone -Name lab.test -SecureSecondaries TransferAnyServer');
    const reply = await answerFor(pc1, WNS1_IP, 'lab.test', RRType.AXFR);
    expect(reply?.flags.rcode).toBe(DnsRcode.REFUSED);
  });

  it('TransferAnyServer sert la zone entière à PC1', async () => {
    const { wns1, pc1 } = await buildLab();
    await run(wns1, 'Add-DnsServerPrimaryZone -Name lab.test');
    await run(wns1, 'Add-DnsServerResourceRecordA -ZoneName lab.test -Name www -IPv4Address 10.0.9.5');
    await run(wns1, 'Set-DnsServerPrimaryZone -Name lab.test -SecureSecondaries TransferAnyServer');
    const reply = await queryDnsOverTcp(pc1, new IPAddress(WNS1_IP), makeQuery('lab.test', RRType.AXFR), 53, 1000);
    expect(reply?.flags.rcode).toBe(DnsRcode.NOERROR);
    expect(reply!.answers.length).toBeGreaterThanOrEqual(3);
  });

  it('TransferToSecureServers ne sert que les adresses listées', async () => {
    const { wns1, pc1 } = await buildLab();
    await run(wns1, 'Add-DnsServerPrimaryZone -Name lab.test');
    await run(wns1, `Set-DnsServerPrimaryZone -Name lab.test -SecureSecondaries TransferToSecureServers -SecondaryServers ${NS2_IP}`);
    const reply = await queryDnsOverTcp(pc1, new IPAddress(WNS1_IP), makeQuery('lab.test', RRType.AXFR), 53, 1000);
    expect(reply?.flags.rcode).toBe(DnsRcode.REFUSED);
  });

  it('TransferToZoneNameServer sert l adresse d un NS déclaré dans la zone', async () => {
    const { wns1, wns3 } = await buildLab();
    await run(wns1, 'Add-DnsServerPrimaryZone -Name lab.test');
    await run(wns1, 'Add-DnsServerResourceRecord -NS -ZoneName lab.test -Name "@" -NameServer ns3.lab.test');
    await run(wns1, `Add-DnsServerResourceRecordA -ZoneName lab.test -Name ns3 -IPv4Address ${WNS3_IP}`);
    await run(wns3, `Add-DnsServerSecondaryZone -Name lab.test -MasterServers ${WNS1_IP}`);
    const secondary = await eventually(async () => (await run(wns3, 'Get-DnsServerZone -Name lab.test')), out => /IsPaused\s*:\s*False/.test(out));
    expect(secondary).toMatch(/ZoneType\s*:\s*Secondary/);
  });
});

describe('BIND9 secondary of a Windows primary', () => {
  it('BIND9 tire la zone du serveur Windows, puis reçoit la modification par NOTIFY', async () => {
    const { wns1, ns2, pc1 } = await buildLab();
    await run(wns1, 'Add-DnsServerPrimaryZone -Name lab.test');
    await run(wns1, 'Add-DnsServerResourceRecordA -ZoneName lab.test -Name www -IPv4Address 10.0.9.5');
    await run(wns1, `Set-DnsServerPrimaryZone -Name lab.test -SecureSecondaries TransferToSecureServers -SecondaryServers ${NS2_IP} -Notify NotifyServers -NotifyServers ${NS2_IP}`);
    writeRoot(ns2, '/etc/bind/named.conf', [
      'options { recursion no; };',
      'zone "lab.test" { type secondary;', `  primaries { ${WNS1_IP}; };`, '  file "db.lab.test"; };', '',
    ].join('\n'));
    await ns2.executeCommand('systemctl start named');
    await eventually(() => answerFor(pc1, NS2_IP, 'www.lab.test'), hasAddress('10.0.9.5'));

    await run(wns1, 'Add-DnsServerResourceRecordA -ZoneName lab.test -Name db -IPv4Address 10.0.9.6');
    const pushed = await eventually(() => answerFor(pc1, NS2_IP, 'db.lab.test'), hasAddress('10.0.9.6'));
    expect(pushed.flags.aa).toBe(true);
  }, 25000);

  it('NoNotify : la modification n atteint pas BIND9 avant le retransfert', async () => {
    const { wns1, ns2, pc1 } = await buildLab();
    await run(wns1, 'Add-DnsServerPrimaryZone -Name lab.test');
    await run(wns1, 'Add-DnsServerResourceRecordA -ZoneName lab.test -Name www -IPv4Address 10.0.9.5');
    await run(wns1, `Set-DnsServerPrimaryZone -Name lab.test -SecureSecondaries TransferToSecureServers -SecondaryServers ${NS2_IP} -Notify NoNotify`);
    writeRoot(ns2, '/etc/bind/named.conf', [
      'options { recursion no; };',
      'zone "lab.test" { type secondary;', `  primaries { ${WNS1_IP}; };`, '  file "db.lab.test"; };', '',
    ].join('\n'));
    await ns2.executeCommand('systemctl start named');
    await eventually(() => answerFor(pc1, NS2_IP, 'www.lab.test'), hasAddress('10.0.9.5'));

    await run(wns1, 'Add-DnsServerResourceRecordA -ZoneName lab.test -Name db -IPv4Address 10.0.9.6');
    await new Promise(resolve => setTimeout(resolve, 800));
    const stale = await answerFor(pc1, NS2_IP, 'db.lab.test');
    expect(stale?.flags.rcode).toBe(DnsRcode.NXDOMAIN);
    await ns2.executeCommand('rndc retransfer lab.test');
    await eventually(() => answerFor(pc1, NS2_IP, 'db.lab.test'), hasAddress('10.0.9.6'));
  }, 25000);
});

describe('WINDOWS SECONDARY of a BIND9 primary', () => {
  const primaryConf = (extra = '') => BIND_PRIMARY(`allow-transfer { ${WNS1_IP}; }; ${extra}`);

  it('SERVFAIL tant que le premier transfert n a pas eu lieu, puis réponse en autorité', async () => {
    const { wns1, ns2, pc1 } = await buildLab();
    await run(wns1, `Add-DnsServerSecondaryZone -Name bind.test -MasterServers ${NS2_IP}`);
    const early = await answerFor(pc1, WNS1_IP, 'www.bind.test');
    expect(early?.flags.rcode).toBe(DnsRcode.SERVFAIL);
    await startBind(ns2, primaryConf());
    await run(wns1, 'Start-DnsServerZoneTransfer -Name bind.test');
    const loaded = await eventually(() => answerFor(pc1, WNS1_IP, 'www.bind.test'), hasAddress('10.0.9.1'));
    expect(loaded.flags.aa).toBe(true);
  }, 25000);

  it('une NOTIFY de BIND9 déclenche le transfert', async () => {
    const { wns1, ns2, pc1 } = await buildLab();
    await startBind(ns2, primaryConf(`also-notify { ${WNS1_IP}; };`));
    await run(wns1, `Add-DnsServerSecondaryZone -Name bind.test -MasterServers ${NS2_IP}`);
    await eventually(() => answerFor(pc1, WNS1_IP, 'www.bind.test'), hasAddress('10.0.9.1'));
    writeRoot(ns2, '/etc/bind/db.bind.test', bindZone(2024010102, '10.0.9.2'));
    await ns2.executeCommand('rndc reload bind.test');
    await eventually(() => answerFor(pc1, WNS1_IP, 'www.bind.test'), hasAddress('10.0.9.2'));
  }, 25000);

  it('sans NOTIFY, le rafraîchissement SOA (refresh) déclenche le transfert', async () => {
    const { wns1, ns2, pc1 } = await buildLab();
    await startBind(ns2, primaryConf());
    await run(wns1, `Add-DnsServerSecondaryZone -Name bind.test -MasterServers ${NS2_IP}`);
    await eventually(() => answerFor(pc1, WNS1_IP, 'www.bind.test'), hasAddress('10.0.9.1'));
    writeRoot(ns2, '/etc/bind/db.bind.test', bindZone(2024010102, '10.0.9.2'));
    await ns2.executeCommand('rndc reload bind.test');
    await new Promise(resolve => setTimeout(resolve, 500));
    expect(hasAddress('10.0.9.2')((await answerFor(pc1, WNS1_IP, 'www.bind.test'))!)).toBe(false);
    wns1.advanceTime(3600 * 1000 + 1000);
    await eventually(() => answerFor(pc1, WNS1_IP, 'www.bind.test'), hasAddress('10.0.9.2'));
  }, 25000);

  it('une NOTIFY venant d un hôte qui n est pas un master est refusée', async () => {
    const { wns1, ns2, pc1 } = await buildLab();
    await startBind(ns2, primaryConf());
    await run(wns1, `Add-DnsServerSecondaryZone -Name bind.test -MasterServers ${NS2_IP}`);
    await eventually(() => answerFor(pc1, WNS1_IP, 'www.bind.test'), hasAddress('10.0.9.1'));
    const base = makeQuery('bind.test', RRType.SOA);
    const notify: DnsMessage = { ...base, flags: { ...base.flags, opcode: DnsOpcode.NOTIFY } };
    const reply = await queryDnsOverUdp(pc1, new IPAddress(WNS1_IP), notify, 53, 600);
    expect(reply?.flags.rcode).toBe(DnsRcode.REFUSED);
  }, 25000);

  it('la zone secondaire est en lecture seule', async () => {
    const { wns1, ns2, pc1 } = await buildLab();
    await startBind(ns2, primaryConf());
    await run(wns1, `Add-DnsServerSecondaryZone -Name bind.test -MasterServers ${NS2_IP}`);
    await eventually(() => answerFor(pc1, WNS1_IP, 'www.bind.test'), hasAddress('10.0.9.1'));
    const out = await run(wns1, 'Add-DnsServerResourceRecordA -ZoneName bind.test -Name evil -IPv4Address 6.6.6.6');
    expect(out).toMatch(/read-only/i);
    const answer = await answerFor(pc1, WNS1_IP, 'evil.bind.test');
    expect(answer?.flags.rcode).toBe(DnsRcode.NXDOMAIN);
  }, 25000);

  it('Get-DnsServerZone décrit la zone secondaire et ses masters', async () => {
    const { wns1, ns2, pc1 } = await buildLab();
    await startBind(ns2, primaryConf());
    await run(wns1, `Add-DnsServerSecondaryZone -Name bind.test -MasterServers ${NS2_IP}`);
    await eventually(() => answerFor(pc1, WNS1_IP, 'www.bind.test'), hasAddress('10.0.9.1'));
    const out = await run(wns1, 'Get-DnsServerZone -Name bind.test');
    expect(out).toMatch(/ZoneType\s*:\s*Secondary/);
    expect(out).toContain(NS2_IP);
  }, 25000);
});

describe('conditional forwarders, forwarders and cache', () => {
  async function partnerLab(): Promise<Lab> {
    const lab = await buildLab();
    await run(lab.wns3, 'Add-DnsServerPrimaryZone -Name partner.test');
    await run(lab.wns3, 'Add-DnsServerResourceRecordA -ZoneName partner.test -Name www -IPv4Address 10.0.7.7');
    return lab;
  }

  it('sans redirecteur ni racine, WNS1 refuse la requête récursive hors de sa zone', async () => {
    const { wns1, pc1 } = await partnerLab();
    await run(wns1, 'Set-DnsServerForwarder -UseRootHint $false');
    const answer = await answerFor(pc1, WNS1_IP, 'www.partner.test', RRType.A, true);
    expect(answer?.flags.rcode).toBe(DnsRcode.REFUSED);
  });

  it('un redirecteur conditionnel envoie la requête à WNS3 sur le fil', async () => {
    const { wns1, pc1 } = await partnerLab();
    await run(wns1, `Add-DnsServerConditionalForwarderZone -Name partner.test -MasterServers ${WNS3_IP}`);
    const answer = await eventually(() => answerFor(pc1, WNS1_IP, 'www.partner.test', RRType.A, true), hasAddress('10.0.7.7'));
    expect(answer.flags.ra).toBe(true);
    expect(await run(wns1, 'Get-DnsServerZone -Name partner.test')).toMatch(/ZoneType\s*:\s*Forwarder/);
  });

  it('Show-DnsServerCache voit la réponse, Clear-DnsServerCache la vide', async () => {
    const { wns1, pc1 } = await partnerLab();
    await run(wns1, `Add-DnsServerConditionalForwarderZone -Name partner.test -MasterServers ${WNS3_IP}`);
    await eventually(() => answerFor(pc1, WNS1_IP, 'www.partner.test', RRType.A, true), hasAddress('10.0.7.7'));
    expect(await run(wns1, 'Show-DnsServerCache')).toContain('10.0.7.7');
    await run(wns1, 'Clear-DnsServerCache -Force');
    expect(await run(wns1, 'Show-DnsServerCache')).not.toContain('10.0.7.7');
  });

  it('Set-DnsServerRecursion -Enable $false coupe la récursion', async () => {
    const { wns1, pc1 } = await partnerLab();
    await run(wns1, `Add-DnsServerConditionalForwarderZone -Name partner.test -MasterServers ${WNS3_IP}`);
    await run(wns1, 'Set-DnsServerRecursion -Enable $false');
    const answer = await answerFor(pc1, WNS1_IP, 'www.partner.test', RRType.A, true);
    expect(answer?.flags.rcode).toBe(DnsRcode.REFUSED);
    expect(await run(wns1, 'Get-DnsServerRecursion')).toMatch(/Enable\s+-+\s+False/);
  });

  it('Add/Remove-DnsServerForwarder et bascule de -UseRootHint', async () => {
    const { wns1 } = await partnerLab();
    await run(wns1, `Add-DnsServerForwarder -IPAddress ${WNS3_IP}`);
    await run(wns1, 'Add-DnsServerForwarder -IPAddress 10.0.1.99');
    expect(await run(wns1, 'Get-DnsServerForwarder')).toContain('10.0.1.99');
    await run(wns1, 'Remove-DnsServerForwarder -IPAddress 10.0.1.99 -Force');
    expect(await run(wns1, 'Get-DnsServerForwarder')).not.toContain('10.0.1.99');
    expect(await run(wns1, 'Set-DnsServerForwarder -UseRootHint $false')).toBe('');
    expect(await run(wns1, 'Get-DnsServerForwarder')).toMatch(/\bFalse\b/);
  });
});

describe('generic record cmdlets, reverse zones and zone files', () => {
  it('Add-DnsServerResourceRecord -Txt/-NS/-Mx, Get -RRType, Remove -RecordData', async () => {
    const { wns1 } = await buildLab();
    await run(wns1, 'Add-DnsServerPrimaryZone -Name lab.test');
    await run(wns1, 'Add-DnsServerResourceRecord -Txt -ZoneName lab.test -Name "@" -DescriptiveText "v=spf1 -all"');
    await run(wns1, 'Add-DnsServerResourceRecord -Mx -ZoneName lab.test -Name "@" -MailExchange mail.lab.test -Preference 10');
    await run(wns1, 'Add-DnsServerResourceRecordA -ZoneName lab.test -Name www -IPv4Address 10.0.9.5');
    await run(wns1, 'Add-DnsServerResourceRecordA -ZoneName lab.test -Name www -IPv4Address 10.0.9.6');
    const txt = await run(wns1, 'Get-DnsServerResourceRecord -ZoneName lab.test -RRType TXT');
    expect(txt).toContain('v=spf1 -all');
    expect(txt).not.toContain('10.0.9.5');
    await run(wns1, 'Remove-DnsServerResourceRecord -ZoneName lab.test -Name www -RRType A -RecordData 10.0.9.5 -Force');
    const remaining = await run(wns1, 'Get-DnsServerResourceRecord -ZoneName lab.test -Name www');
    expect(remaining).toContain('10.0.9.6');
    expect(remaining).not.toContain('10.0.9.5');
  });

  it('Set-DnsServerResourceRecord remplace la donnée via Old/NewInputObject', async () => {
    const { wns1 } = await buildLab();
    await run(wns1, 'Add-DnsServerPrimaryZone -Name lab.test');
    await run(wns1, 'Add-DnsServerResourceRecordA -ZoneName lab.test -Name www -IPv4Address 10.0.9.5');
    const session = ps(wns1);
    for (const line of [
      '$old = Get-DnsServerResourceRecord -ZoneName lab.test -Name www -RRType A',
      '$new = Get-DnsServerResourceRecord -ZoneName lab.test -Name www -RRType A',
      '$new.RecordData.IPv4Address = "10.0.9.99"',
      'Set-DnsServerResourceRecord -ZoneName lab.test -OldInputObject $old -NewInputObject $new',
    ]) await session.processLine(line);
    const out = await run(wns1, 'Get-DnsServerResourceRecord -ZoneName lab.test -Name www');
    expect(out).toContain('10.0.9.99');
    expect(out).not.toContain('10.0.9.5');
  });

  it('-NetworkId crée la zone inverse, un préfixe non aligné est refusé', async () => {
    const { wns1 } = await buildLab();
    await run(wns1, 'Add-DnsServerPrimaryZone -NetworkId 10.0.1.0/24');
    expect(await run(wns1, 'Get-DnsServerZone')).toContain('1.0.10.in-addr.arpa');
    expect(await run(wns1, 'Add-DnsServerPrimaryZone -NetworkId 10.0.0.0/20')).toMatch(/RFC 2317/);
  });

  it('chaque modification réécrit le fichier de zone lisible par le parseur DNS', async () => {
    const { wns1 } = await buildLab();
    await run(wns1, 'Add-DnsServerPrimaryZone -Name lab.test');
    await run(wns1, 'Add-DnsServerResourceRecordA -ZoneName lab.test -Name www -IPv4Address 10.0.9.5');
    await run(wns1, 'Add-DnsServerResourceRecord -Mx -ZoneName lab.test -Name "@" -MailExchange mail.lab.test -Preference 10');
    const file = wns1.getFileSystem().readFile('C:\\Windows\\System32\\dns\\lab.test.dns');
    expect(file.ok).toBe(true);
    const zone = parseZoneFile(file.content!, 'lab.test');
    expect(zone.getRRSet('www.lab.test', RRType.A)).toHaveLength(1);
    expect(zone.getRRSet('lab.test', RRType.MX)).toHaveLength(1);
    await run(wns1, 'Remove-DnsServerZone -Name lab.test -Force');
    expect(wns1.getFileSystem().readFile('C:\\Windows\\System32\\dns\\lab.test.dns').ok).toBe(false);
  });

  it('TEMOIN : Get-DnsServerZone liste toujours la zone créée', async () => {
    const { wns1 } = await buildLab();
    await run(wns1, 'Add-DnsServerPrimaryZone -Name lab.test');
    expect(await run(wns1, 'Get-DnsServerZone')).toContain('lab.test');
  });
});
