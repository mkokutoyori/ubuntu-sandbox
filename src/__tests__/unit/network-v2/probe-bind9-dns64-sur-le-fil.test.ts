/**
 * RFC 6147 sur un vrai named : l'option `dns64 <prefixe> { clients; mapped; exclude; recursive-only;
 * break-dnssec; suffix }`, sur le fil (UDP/53 entre un client et deux serveurs).
 *
 * Mesure avant correction : `named.conf` refusait la ligne (« unknown option 'dns64' ») et le
 * serveur ne synthetisait jamais un AAAA, quelle que soit la configuration : un client IPv6
 * seul n'avait aucun moyen d'atteindre un nom qui n'a qu'un enregistrement A. La synthese se fait
 * sur les deux chemins de reponse : donnees locales (serveur faisant autorite) et resolution
 * recursive via un redirecteur (le serveur du lab est un VRAI second named, les deux echanges
 * traversent le commutateur).
 *
 * Avec src remis a la version precedente, 5 cas sur 7 tombent. Deux passent dans les deux etats : le
 * temoin (sans option dns64, un AAAA sur un nom a enregistrement A seul est une reponse vide
 * NOERROR) et recursive-only, que l'absence de synthese satisfait aussi. `suffix` : la RFC 6052 §2.2 garde les bits
 * du suffixe a zero ; une valeur non nulle est refusee, pas rangee sans effet. `clients` ne sait
 * decrire que des reseaux IPv4 (le meme defaut que toutes les ACL de ce serveur) : `any` et les ACL
 * nommees en sont la forme utile.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { RRType, DnsClass } from '@/network/dns/wire/RRType';
import { DnsOpcode, DnsRcode } from '@/network/dns/wire/DnsHeaderFlags';
import { queryDnsOverUdp } from '@/network/dns/transport/DnsUdpTransport';
import type { DnsMessage } from '@/network/dns/wire/DnsMessage';
import type { VirtualFileSystem } from '@/network/devices/linux/VirtualFileSystem';

const NS1_IP = '10.0.1.10';
const NS2_IP = '10.0.1.20';
const PC_IP = '10.0.1.2';

const ORG_ZONE = [
  '$ORIGIN example.org.',
  '$TTL 3600',
  '@    IN SOA ns2.example.org. admin.example.org. ( 1 3600 900 604800 300 )',
  '     IN NS  ns2.example.org.',
  'ns2  IN A   10.0.1.20',
  'www  IN A   8.8.4.4',
  'lan  IN A   10.1.2.3',
  'dual IN A   8.8.8.8',
  'dual IN AAAA 2001:db8::7',
  'alias IN CNAME www',
  '',
].join('\n');

const LOCAL_ZONE = ORG_ZONE.replace(/example\.org/g, 'local.test').replace('ns2.local.test. admin', 'ns1.local.test. admin');

function writeRoot(server: LinuxServer, path: string, content: string): void {
  (server as unknown as { executor: { vfs: VirtualFileSystem } }).executor.vfs.writeFile(path, content, 0, 0, 0o022);
}

async function buildLab(ns1Options: string): Promise<{ pc: LinuxPC; ns1: LinuxServer }> {
  const sw = new GenericSwitch('switch-generic', 'sw1', 8, 0, 0);
  const ns1 = new LinuxServer('linux-server', 'NS1');
  const ns2 = new LinuxServer('linux-server', 'NS2');
  const pc = new LinuxPC('linux-pc', 'PC');
  const mask = new SubnetMask('255.255.255.0');
  [ns1, ns2, pc].forEach((device, i) => new Cable(`c${i}`).connect(device.getPorts()[0], sw.getPorts()[i]));
  ns1.getPorts()[0].configureIP(new IPAddress(NS1_IP), mask);
  ns2.getPorts()[0].configureIP(new IPAddress(NS2_IP), mask);
  pc.getPorts()[0].configureIP(new IPAddress(PC_IP), mask);
  writeRoot(ns1, '/etc/bind/named.conf', [
    'options {', ns1Options, '};',
    'zone "local.test" { type primary; file "/etc/bind/db.local.test"; };', '',
  ].join('\n'));
  writeRoot(ns1, '/etc/bind/db.local.test', LOCAL_ZONE);
  writeRoot(ns2, '/etc/bind/named.conf',
    'options { recursion no; };\nzone "example.org" { type primary; file "/etc/bind/db.example.org"; };\n');
  writeRoot(ns2, '/etc/bind/db.example.org', ORG_ZONE);
  await ns1.executeCommand('systemctl start named');
  await ns2.executeCommand('systemctl start named');
  return { pc, ns1 };
}

let nextId = 1;
function aaaa(from: LinuxPC, qname: string, options: { rd?: boolean; cd?: boolean } = {}): Promise<DnsMessage | null> {
  const query: DnsMessage = {
    id: nextId++,
    flags: {
      qr: false, opcode: DnsOpcode.QUERY, aa: false, tc: false,
      rd: options.rd ?? true, ra: false, ad: false, cd: options.cd ?? false, rcode: DnsRcode.NOERROR,
    },
    questions: [{ qname, qtype: RRType.AAAA, qclass: DnsClass.IN }],
    answers: [], authorities: [], additionals: [],
  };
  return queryDnsOverUdp(from, new IPAddress(NS1_IP), query, 53, 600);
}

const addresses = (message: DnsMessage | null): string[] =>
  (message?.answers ?? []).filter((rr) => rr.data.type === RRType.AAAA)
    .map((rr) => (rr.data as { address: { toString(): string } }).address.toString());

const BASE = '  recursion yes;\n  allow-recursion { any; };\n  forwarders { 10.0.1.20; };';
const DNS64 = '  dns64 64:ff9b::/96 { clients { any; }; };';

beforeEach(() => { resetCounters(); resetDeviceCounters(); Logger.clear(); });

describe('named dns64', () => {
  it('witness: without the option an AAAA query for an A-only name is an empty NOERROR', async () => {
    const { pc } = await buildLab(BASE);
    const answer = await aaaa(pc, 'www.local.test');
    expect(answer!.flags.rcode).toBe(DnsRcode.NOERROR);
    expect(addresses(answer)).toEqual([]);
  }, 30000);

  it('synthesizes from local authoritative data under the Well-Known Prefix', async () => {
    const { pc } = await buildLab(`${BASE}\n${DNS64}`);
    const answer = await aaaa(pc, 'www.local.test');
    expect(addresses(answer)).toEqual(['64:ff9b::808:404']);
    expect(answer!.flags.rcode).toBe(DnsRcode.NOERROR);
  }, 30000);

  it('synthesizes from a recursive resolution through the forwarder, keeping the CNAME chain', async () => {
    const { pc } = await buildLab(`${BASE}\n${DNS64}`);
    const answer = await aaaa(pc, 'alias.example.org');
    expect(addresses(answer)).toEqual(['64:ff9b::808:404']);
    expect(answer!.answers.map((rr) => rr.data.type)).toEqual([RRType.CNAME, RRType.AAAA]);
  }, 30000);

  it('leaves a real AAAA alone and does not answer for a private A under the Well-Known Prefix', async () => {
    const { pc } = await buildLab(`${BASE}\n${DNS64}`);
    expect(addresses(await aaaa(pc, 'dual.example.org'))).toEqual(['2001:db8::7']);
    expect(addresses(await aaaa(pc, 'lan.local.test'))).toEqual([]);
  }, 30000);

  it('a network-specific prefix may carry a private address, and mapped leaves some out', async () => {
    const { pc } = await buildLab(`${BASE}\n  dns64 2001:db8:122:344::/96 { mapped { !8.8.8.0/24; any; }; };`);
    expect(addresses(await aaaa(pc, 'lan.local.test'))).toEqual(['2001:db8:122:344::a01:203']);
    expect(addresses(await aaaa(pc, 'www.local.test'))).toEqual(['2001:db8:122:344::808:404']);
  }, 30000);

  it('recursive-only: a query without RD is not synthesized', async () => {
    const { pc } = await buildLab(`${BASE}\n${DNS64}`);
    expect(addresses(await aaaa(pc, 'www.local.test', { rd: false }))).toEqual([]);
  }, 30000);

  it('refuses a non-zero suffix instead of storing it without effect', async () => {
    const { ns1 } = await buildLab(`${BASE}\n  dns64 2001:db8::/32 { suffix ::1; };`);
    expect(await ns1.executeCommand('named-checkconf /etc/bind/named.conf')).toContain('suffix');
  }, 30000);
});
