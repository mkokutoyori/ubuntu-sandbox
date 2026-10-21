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
 * PTR (RFC 6147 §5.3.1, deuxieme option) : une requete inverse sous le prefixe recoit un CNAME vers
 * le nom in-addr.arpa de l'adresse IPv4 puis le PTR de celui-ci, resolu par le redirecteur ; hors
 * du prefixe rien ne change.
 *
 * Avec src remis avant l'option dns64, 7 cas sur 9 tombent (named refuse la configuration, donc ne repond
 * plus du tout au cas « hors prefixe » non plus) ; deux passent dans les deux etats : le temoin (sans
 * option dns64, un AAAA sur un nom a enregistrement A seul est une reponse vide NOERROR) et
 * recursive-only, que l'absence de synthese satisfait aussi. `suffix` : la RFC 6052 §2.2 garde les bits
 * du suffixe a zero ; une valeur non nulle est refusee, pas rangee sans effet. `clients` lit des
 * reseaux IPv4 comme IPv6, et un client IPv6 venu du fil (le cas reel d'un hote qui n'a que de l'IPv6)
 * est juge par son adresse IPv6 : 3 cas ajoutes. Un seul tombe quand Bind9Service est remis avant
 * la correction : la requete PTR interne d'un client IPv6 etait emise depuis le bouclage, donc refusee
 * par un allow-query qui n'admet que son reseau. Les deux autres (synthese pour un reseau present dans
 * clients, absence de synthese pour un reseau absent) passent dans les deux etats de Bind9Service parce
 * que la lecture de l'IPv6 par les listes est deja livree ; le second est un refus borne par le premier.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { IPAddress, IPv6Address, SubnetMask, resetCounters } from '@/network/core/types';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { RRType, DnsClass } from '@/network/dns/wire/RRType';
import { DnsOpcode, DnsRcode } from '@/network/dns/wire/DnsHeaderFlags';
import { queryDnsOverUdp } from '@/network/dns/transport/DnsUdpTransport';
import { ptrQName } from '@/network/dns/compat/DnsWireCompat';
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
  writeRoot(ns2, '/etc/bind/named.conf', [
    'options { recursion no; };',
    'zone "example.org" { type primary; file "/etc/bind/db.example.org"; };',
    'zone "8.8.in-addr.arpa" { type primary; file "/etc/bind/db.8.8"; };', '',
  ].join('\n'));
  writeRoot(ns2, '/etc/bind/db.example.org', ORG_ZONE);
  writeRoot(ns2, '/etc/bind/db.8.8', [
    '$ORIGIN 8.8.in-addr.arpa.', '$TTL 3600',
    '@ IN SOA ns2.example.org. admin.example.org. ( 1 3600 900 604800 300 )',
    '  IN NS  ns2.example.org.',
    '4.4 IN PTR www.example.org.', '',
  ].join('\n'));
  await ns1.executeCommand('systemctl start named');
  await ns2.executeCommand('systemctl start named');
  return { pc, ns1 };
}

let nextId = 1;
function ask(
  from: LinuxPC, qname: string, qtype: number, options: { rd?: boolean; cd?: boolean } = {},
): Promise<DnsMessage | null> {
  const query: DnsMessage = {
    id: nextId++,
    flags: {
      qr: false, opcode: DnsOpcode.QUERY, aa: false, tc: false,
      rd: options.rd ?? true, ra: false, ad: false, cd: options.cd ?? false, rcode: DnsRcode.NOERROR,
    },
    questions: [{ qname, qtype, qclass: DnsClass.IN }],
    answers: [], authorities: [], additionals: [],
  };
  return queryDnsOverUdp(from, new IPAddress(NS1_IP), query, 53, 600);
}

const aaaa = (from: LinuxPC, qname: string, options: { rd?: boolean; cd?: boolean } = {}) =>
  ask(from, qname, RRType.AAAA, options);

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

  it('answers a reverse query under the prefix with a CNAME to the IPv4 reverse name and its PTR (RFC 6147 section 5.3.1)', async () => {
    const { pc } = await buildLab(`${BASE}\n${DNS64}`);
    const answer = await ask(pc, ptrQName('64:ff9b::808:404'), RRType.PTR);
    expect(answer!.answers.map((rr) => rr.data.type)).toEqual([RRType.CNAME, RRType.PTR]);
    expect(answer!.answers[0].data).toMatchObject({ cname: '4.4.8.8.in-addr.arpa' });
    expect(answer!.answers[1].data).toMatchObject({ ptrdname: 'www.example.org' });
  }, 30000);

  it('does not touch a reverse query outside the prefix', async () => {
    const { pc } = await buildLab(`${BASE}\n${DNS64}`);
    const answer = await ask(pc, ptrQName('2001:db8::1'), RRType.PTR);
    expect(answer!.answers.map((rr) => rr.data.type)).not.toContain(RRType.CNAME);
  }, 30000);

  describe('an IPv6 client', () => {
    const V6_SERVER = '2001:db8:1::53';
    const V6_CLIENT = '2001:db8:1::10';

    async function labV6(clients: string, extra = '') {
      const { pc, ns1 } = await buildLab(`${BASE}${extra}\n  dns64 64:ff9b::/96 { clients { ${clients} }; };`);
      await ns1.executeCommand(`ip -6 addr add ${V6_SERVER}/64 dev eth0`);
      await pc.executeCommand(`ip -6 addr add ${V6_CLIENT}/64 dev eth0`);
      return pc;
    }

    const askV6 = (from: LinuxPC, qname: string, qtype: number): Promise<DnsMessage | null> => {
      const query: DnsMessage = {
        id: nextId++,
        flags: { qr: false, opcode: DnsOpcode.QUERY, aa: false, tc: false, rd: true, ra: false, ad: false, cd: false, rcode: DnsRcode.NOERROR },
        questions: [{ qname, qtype, qclass: DnsClass.IN }], answers: [], authorities: [], additionals: [],
      };
      return queryDnsOverUdp(from, new IPv6Address(V6_SERVER), query, 53, 600);
    };

    it('is synthesized for when its IPv6 network is in clients', async () => {
      const pc = await labV6('2001:db8:1::/64;');
      expect(addresses(await askV6(pc, 'www.local.test', RRType.AAAA))).toEqual(['64:ff9b::808:404']);
    }, 30000);

    it('gets the reverse answer too, queried on its own behalf', async () => {
      const pc = await labV6('2001:db8:1::/64;', '\n  allow-query { 2001:db8:1::/64; };');
      const answer = await askV6(pc, ptrQName('64:ff9b::808:404'), RRType.PTR);
      expect(answer!.answers.map((rr) => rr.data.type)).toEqual([RRType.CNAME, RRType.PTR]);
    }, 30000);

    it('is not synthesized for when its network is not in clients', async () => {
      const pc = await labV6('2001:db8:9::/64;');
      expect(addresses(await askV6(pc, 'www.local.test', RRType.AAAA))).toEqual([]);
    }, 30000);
  });
});
