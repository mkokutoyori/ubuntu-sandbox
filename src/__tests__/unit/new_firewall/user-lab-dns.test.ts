/*
 * The user's lab, imported as exported: WinServer1 (HQ, 192.168.30.0/24) hosts
 * the Windows DNS Server role for corp.test; Server3 (LAN, 192.168.1.0/24, BIND9)
 * is its secondary and PC2 / PC1 are LAN clients. Everything crosses FW1, whose
 * policy 1 (LAN_SUBNET -> HQ_ADDRESS, service ALL, NAT) is rewritten through
 * its CLI. Only configuration is added; topology and equipment are the lab's.
 *
 *   - policy 1 as imported: PC2 resolves through WinServer1 and Server3 pulls
 *     the zone (witness) — WinServer1 sees Server3 as FW1's NAT address
 *     192.168.20.2, so that is the address to authorise in SecondaryServers;
 *   - authorising Server3's own LAN address instead: WinServer1 answers REFUSED
 *     to the AXFR and the secondary never loads;
 *   - policy 1 narrowed to UDP/53: the SOA check crosses, the AXFR (TCP/53) is
 *     dropped, the zone stays unloaded; reopened with the DNS service it loads;
 *   - NOTIFY goes HQ -> LAN, for which the lab has no policy: FW1 drops it and
 *     the secondary stays stale until it is told to retransfer;
 *   - policy 1 disabled: nothing resolves.
 *
 * Discrimination (git stash of the twelve behavioural source files): 3 of the
 * 6 cases fall before the change (Server3 never loads the zone, so the NAT,
 * UDP-only and NOTIFY cases fail). The other three pass either way: the
 * resolving witness, the disabled-policy guard, and the refused-transfer case
 * (a secondary that never loads is also the pre-change outcome).
 */
import { describe, it, expect } from 'vitest';
import type { LinuxServer } from '@/network/devices/LinuxServer';
import type { LinuxPC } from '@/network/devices/LinuxPC';
import { IPAddress } from '@/network/core/types';
import { RRType, DnsClass } from '@/network/dns/wire/RRType';
import { DnsOpcode, DnsRcode } from '@/network/dns/wire/DnsHeaderFlags';
import { queryDnsOverUdp } from '@/network/dns/transport/DnsUdpTransport';
import type { DnsMessage } from '@/network/dns/wire/DnsMessage';
import type { ARecordData } from '@/network/dns/wire/ResourceRecord';
import type { VirtualFileSystem } from '@/network/devices/linux/VirtualFileSystem';
import { addRoutesToHq, loadUserLab, type LabDevice, type UserLab } from './userLab';
import { taper } from './fortigateBatteryHarness';
import { shell, windows } from './userLabDomain';

const NAT_ADDRESS = '192.168.20.2';

function addressOf(device: LabDevice): string {
  const address = windows(device).getPorts()[0].getIPAddress();
  if (!address) throw new Error(`${device.getName()} has no address`);
  return address.toString();
}

let nextId = 1;

function question(qname: string): DnsMessage {
  return {
    id: nextId++,
    flags: {
      qr: false, opcode: DnsOpcode.QUERY, aa: false, tc: false,
      rd: false, ra: false, ad: false, cd: false, rcode: DnsRcode.NOERROR,
    },
    questions: [{ qname, qtype: RRType.A, qclass: DnsClass.IN }],
    answers: [], authorities: [], additionals: [],
  };
}

function ask(lab: UserLab, server: string, qname: string): Promise<DnsMessage | null> {
  return queryDnsOverUdp(lab.PC1 as unknown as LinuxPC, new IPAddress(server), question(qname), 53, 800);
}

async function eventually(probe: () => Promise<DnsMessage | null>, accept: (m: DnsMessage) => boolean): Promise<DnsMessage> {
  const deadline = Date.now() + 8000;
  for (;;) {
    const value = await probe();
    if (value !== null && accept(value)) return value;
    if (Date.now() > deadline) throw new Error('condition not reached in time');
    await new Promise(resolve => setTimeout(resolve, 150));
  }
}

const hasAddress = (address: string) => (m: DnsMessage) =>
  m.answers.some(rr => String((rr.data as ARecordData).address) === address);

async function dnsLab(secondaryAuthorisedAs: 'nat' | 'lan'): Promise<UserLab> {
  const lab = await loadUserLab();
  await addRoutesToHq(lab);
  windows(lab.WinServer1).setCurrentUser('Administrator');
  await shell(lab.WinServer1, 'Install-WindowsFeature DNS');
  await shell(lab.WinServer1, 'Add-DnsServerPrimaryZone -Name corp.test');
  await shell(lab.WinServer1, 'Add-DnsServerResourceRecordA -ZoneName corp.test -Name www -IPv4Address 192.168.30.80');
  const authorised = secondaryAuthorisedAs === 'nat' ? NAT_ADDRESS : addressOf(lab.Server3);
  await shell(lab.WinServer1, `Set-DnsServerPrimaryZone -Name corp.test -SecureSecondaries TransferToSecureServers -SecondaryServers ${authorised} -Notify NotifyServers -NotifyServers ${addressOf(lab.Server3)}`);
  return lab;
}

async function startSecondary(lab: UserLab): Promise<void> {
  const server = lab.Server3 as unknown as LinuxServer;
  const vfs = (server as unknown as { executor: { vfs: VirtualFileSystem } }).executor.vfs;
  vfs.writeFile('/etc/bind/named.conf', [
    'options { recursion no; };',
    'zone "corp.test" { type secondary;', `  primaries { ${addressOf(lab.WinServer1)}; };`, '  file "db.corp.test"; };', '',
  ].join('\n'), 0, 0, 0o022);
  await server.executeCommand('systemctl start named');
}

describe('user lab — Windows DNS primary / BIND9 secondary through FW1', () => {
  it('TÉMOIN : la policy 1 d origine laisse PC2 résoudre via WinServer1', async () => {
    const lab = await dnsLab('nat');
    const out = await lab.PC2.executeCommand(`nslookup www.corp.test ${addressOf(lab.WinServer1)}`);
    expect(out).toContain('192.168.30.80');
  });

  it('TÉMOIN : Server3 charge la zone quand l adresse NATée de FW1 est autorisée', async () => {
    const lab = await dnsLab('nat');
    await startSecondary(lab);
    const loaded = await eventually(() => ask(lab, addressOf(lab.Server3), 'www.corp.test'), hasAddress('192.168.30.80'));
    expect(loaded.flags.aa).toBe(true);
  });

  it('autoriser l adresse LAN de Server3 ne suffit pas : le transfert est refusé', async () => {
    const lab = await dnsLab('lan');
    await startSecondary(lab);
    await new Promise(resolve => setTimeout(resolve, 1500));
    const early = await ask(lab, addressOf(lab.Server3), 'www.corp.test');
    expect(early?.flags.rcode).toBe(DnsRcode.SERVFAIL);
  });

  it('policy 1 limitée à UDP/53 : le SOA passe, l AXFR TCP est coupé, puis rouvert', async () => {
    const lab = await dnsLab('nat');
    await taper(lab.FW1, [
      'config firewall service custom', 'edit "DNS-UDP"', 'set udp-portrange 53', 'next', 'end',
      'config firewall policy', 'edit 1', 'set service "DNS-UDP"', 'next', 'end',
    ]);
    await startSecondary(lab);
    await new Promise(resolve => setTimeout(resolve, 2500));
    expect((await ask(lab, addressOf(lab.Server3), 'www.corp.test'))?.flags.rcode).toBe(DnsRcode.SERVFAIL);

    await taper(lab.FW1, ['config firewall policy', 'edit 1', 'set service "DNS"', 'next', 'end']);
    await (lab.Server3 as unknown as LinuxServer).executeCommand('rndc retransfer corp.test');
    await eventually(() => ask(lab, addressOf(lab.Server3), 'www.corp.test'), hasAddress('192.168.30.80'));
  });

  it('la NOTIFY HQ -> LAN est coupée par FW1 : le secondaire reste en retard jusqu au retransfert', async () => {
    const lab = await dnsLab('nat');
    await startSecondary(lab);
    await eventually(() => ask(lab, addressOf(lab.Server3), 'www.corp.test'), hasAddress('192.168.30.80'));
    await shell(lab.WinServer1, 'Add-DnsServerResourceRecordA -ZoneName corp.test -Name db -IPv4Address 192.168.30.81');
    await new Promise(resolve => setTimeout(resolve, 1500));
    expect((await ask(lab, addressOf(lab.Server3), 'db.corp.test'))?.flags.rcode).toBe(DnsRcode.NXDOMAIN);
    await (lab.Server3 as unknown as LinuxServer).executeCommand('rndc retransfer corp.test');
    await eventually(() => ask(lab, addressOf(lab.Server3), 'db.corp.test'), hasAddress('192.168.30.81'));
  });

  it('la policy 1 désactivée ne laisse rien résoudre', async () => {
    const lab = await dnsLab('nat');
    await taper(lab.FW1, ['config firewall policy', 'edit 1', 'set status disable', 'next', 'end']);
    const out = await lab.PC2.executeCommand(`nslookup www.corp.test ${addressOf(lab.WinServer1)}`);
    expect(out).not.toContain('192.168.30.80');
  });
});
