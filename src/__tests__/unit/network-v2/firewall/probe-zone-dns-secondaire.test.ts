/**
 * `set type secondary` et `set ip-primary` etaient acceptes, rendus, et
 * la zone n'etait JAMAIS transferee.
 *
 * Mesure de depart, sur un FortiGate cable a un primaire qui detient
 * `www.lab.local` : le pare-feu repondait NXDOMAIN AUTORITAIRE — avec le
 * bit `aa` pose — pendant que le TEMOIN interrogeant le primaire au meme
 * instant rendait `192.0.2.50`. Ce n'est pas une absence de reponse mais
 * une reponse FAUSSE avec autorite, celle qui fait arreter la recherche
 * au client. `onCommit` jetait `ip-primary` entierement, et le serveur
 * DNS du pare-feu ne servait que les enregistrements tapes a la main
 * sous `dns-entry`, si bien qu'une zone secondaire se comportait
 * exactement comme une primaire vide. La documentation de la commande
 * ne laisse aucun doute sur le sens : la version 6.0.4 nomme l'attribut
 * `ip-master` et ecrit « Entries in this master DNS server and imported
 * into the DNS zone » — les entrees sont IMPORTEES, c'est-a-dire
 * transferees.
 *
 * **Le numero de serie servi etait invente.** `buildZone` posait
 * `serial: 1` en dur pour toute zone ; un vrai secondaire sert le SOA du
 * primaire, ce qui est precisement la facon dont un operateur verifie
 * que les deux sont synchronises. Le pare-feu annoncait donc 1 la ou le
 * primaire est a 2026090401.
 *
 * **Le protocole existait et etait CLOUE a `EndHost`.**
 * `SecondaryZoneAgent`, `AxfrSession`, `IxfrSession` et `NotifyProtocol`
 * sont reels et eprouves depuis longtemps — mais l'agent prend un
 * `EndHost` dans son constructeur et les deux transports prennent un
 * `EndHost` en parametre, or `Firewall` etend `Equipment`. La limite
 * n'etait pas dans le protocole mais dans ce a quoi il etait attache :
 * ce qu'un transfert de zone demande vraiment est « pose-moi une
 * question en UDP, pose-moi une question en TCP », rien de plus.
 * `ZoneTransferClient` porte desormais la regle une seule fois derriere
 * `ZoneTransferTransport`, et `SecondaryZoneAgent` est ecrit PAR-DESSUS
 * plutot que recopie.
 *
 * **Une SECONDE ecriture du meme transfert existait, et elle avait
 * diverge.** `Bind9Service.refreshSecondaryZone` refaisait la sonde SOA,
 * la comparaison de serie, l'AXFR et l'installation en magasin — sans
 * jamais demander d'IXFR (donc aucun transfert incrementiel possible) et
 * sans garde de re-entrance, si bien qu'une rafale de NOTIFY lancait
 * autant de transferts qui se chevauchent. Elle lit maintenant le meme
 * client, et gagne les deux. Dit honnetement : le primaire de `named`
 * ne SERT pas encore l'IXFR (il repond toujours par un AXFR complet),
 * donc le gain incrementiel ne se voit aujourd'hui que face a un
 * primaire qui le sert ; ce qui est mesurable tout de suite est la garde
 * de re-entrance.
 *
 * **Un nom portait deux contrats.** `SyslogHost.tcpConnect` prend TROIS
 * arguments et rend un flux SYNCHRONE, la ou `EndHost.tcpConnect` en
 * prend deux et rend une promesse ; les trois routeurs esquivaient la
 * collision en passant un objet adaptateur au lieu de `this`, et seul le
 * pare-feu passait `this` — donc lui donner le `tcpConnect` ordinaire
 * dont le transfert a besoin cassait la compilation. Celui de syslog est
 * renomme `openTcpStream`, ce qu'il fait reellement.
 *
 * **Trouve en extrayant, et corrige** : un delta IXFR dont la serie ne
 * correspond pas fait LEVER `applyIxfrDeltas`, et l'exception
 * s'echappait par un `void refresh()`. La RFC 1995 §4 dit quoi faire —
 * retomber sur un AXFR complet — et c'est ce que le client fait
 * desormais, la retombee etant bornee a un seul tour.
 *
 * Discrimine par `git stash push -- src/network/` : 9 des 12 cas
 * tombent — et l'annoncer ainsi serait flatteur sans la precision qui
 * suit. CINQ tombent pour une raison de STRUCTURE, la methode
 * interrogee n'existant pas du tout avant le correctif
 * (`transferredZone`, `transferZone`, `tcpConnect`). Les QUATRE autres
 * portent une mesure de COMPORTEMENT observee sur le fil : la reponse
 * servie au client, le numero de serie annonce, la reprise apres
 * NOTIFY, et le refus de l'AXFR en UDP — que la RFC 5936 §2.2 exige et
 * que le serveur rendait en NXDOMAIN, ne connaissant pas le type 252 et
 * retombant sur son relais. Cette derniere avait ete annoncee comme
 * passant des deux cotes avant la mesure ; c'est la mesure qui tranche.
 *
 * Les 3 cas qui passent des deux cotes sont nommes ici plutot que
 * laisses a decouvrir :
 *
 *   - « le primaire detient l_enregistrement » est le TEMOIN, dont c'est
 *     l'objet de passer des deux cotes ;
 *   - « la zone secondaire est acceptee et rendue » passait deja, et
 *     c'est l'enonce meme du defaut : acceptee, rendue, lue par personne ;
 *   - « une zone primaire sert ses entrees tapees a la main » est le cas
 *     de non-regression.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import type { FortiShell } from '@/network/devices/firewall/vendors/fortios/FortiShell';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { Zone } from '@/network/dns/zone/Zone';
import { makeARecord, makeSoaRecord } from '@/network/dns/wire/ResourceRecord';
import { PrimaryZoneAgent } from '@/network/dns/transfer/PrimaryZoneAgent';
import { queryDnsOverUdp } from '@/network/dns/transport/DnsUdpTransport';
import { DnsOpcode, DnsRcode } from '@/network/dns/wire/DnsHeaderFlags';
import { RRType, DnsClass } from '@/network/dns/wire/RRType';
import type { DnsMessage } from '@/network/dns/wire/DnsMessage';
import type { ARecordData } from '@/network/dns/wire/ResourceRecord';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

const ORIGIN = 'lab.local';
const PRIMARY_IP = '10.1.1.10';
const FIREWALL_IP = '10.1.1.1';
const SERIAL = 2026090401;

function zoneOf(serial = SERIAL, address = '192.0.2.50'): Zone {
  const zone = new Zone(ORIGIN, makeSoaRecord(ORIGIN, 3600, {
    mname: `ns1.${ORIGIN}`, rname: `hostmaster.${ORIGIN}`,
    serial, refresh: 7200, retry: 3600, expire: 1209600, minimum: 300,
  }));
  zone.addRecord(makeARecord(`ns1.${ORIGIN}`, 3600, PRIMARY_IP));
  zone.addRecord(makeARecord(`www.${ORIGIN}`, 3600, address));
  return zone;
}

let nextId = 1;

function question(qname: string, qtype: number = RRType.A): DnsMessage {
  return {
    id: nextId++,
    flags: {
      qr: false, opcode: DnsOpcode.QUERY, aa: false, tc: false,
      rd: false, ra: false, ad: false, cd: false, rcode: DnsRcode.NOERROR,
    },
    questions: [{ qname, qtype, qclass: DnsClass.IN }],
    answers: [], authorities: [], additionals: [],
  };
}

function run(sh: FortiShell, ...lines: string[]): string {
  let last = '';
  for (const line of lines) last = sh.execute(line);
  return last;
}

async function settle(rounds = 40): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise(r => setTimeout(r, 25));
}

interface Labo {
  fw: FortiGate;
  sh: FortiShell;
  client: LinuxPC;
  primary: PrimaryZoneAgent;
  host: LinuxServer;
}

function laboratoire(zone: Zone = zoneOf()): Labo {
  const fw = new FortiGate('firewall-fortinet', 'FGT', 0, 0);
  const sh = fw.getShell() as FortiShell;
  const sw = new GenericSwitch('switch-generic', 'sw', 8, 200, 0);
  const host = new LinuxServer('linux-server', 'ns', 300, 0);
  const client = new LinuxPC('linux-pc', 'cl', 300, 100);
  host.powerOn();
  client.powerOn();

  new Cable('c1').connect(fw.getPort('port1')!, sw.getPorts()[0]);
  new Cable('c2').connect(host.getPorts()[0], sw.getPorts()[1]);
  new Cable('c3').connect(client.getPorts()[0], sw.getPorts()[2]);

  const mask = new SubnetMask('255.255.255.0');
  host.getPorts()[0].configureIP(new IPAddress(PRIMARY_IP), mask);
  client.getPorts()[0].configureIP(new IPAddress('10.1.1.20'), mask);

  run(sh, 'config system interface', 'edit "port1"', 'set mode static',
    `set ip ${FIREWALL_IP} 255.255.255.0`, 'next', 'end',
    'config system dns-server', 'edit "port1"', 'set mode recursive', 'next', 'end');

  const primary = new PrimaryZoneAgent(host, zone, {
    secondaries: [new IPAddress(FIREWALL_IP)],
  });
  primary.start();

  return { fw, sh, client, primary, host };
}

function declareSecondary(sh: FortiShell, ipPrimary = PRIMARY_IP): void {
  run(sh, 'config system dns-database', 'edit "zone1"',
    `set domain "${ORIGIN}"`, 'set type secondary',
    ...(ipPrimary.length > 0 ? [`set ip-primary ${ipPrimary}`] : []),
    'next', 'end');
}

function ask(from: LinuxPC, server: string, qname: string, qtype = RRType.A) {
  return queryDnsOverUdp(from, new IPAddress(server), question(qname, qtype), 53, 800);
}

function addressOf(reply: DnsMessage | null): string | null {
  const first = reply?.answers[0]?.data as ARecordData | undefined;
  return first ? String(first.address) : null;
}

describe('une zone DNS secondaire se transfere vraiment', () => {
  it('le primaire detient l_enregistrement', async () => {
    const labo = laboratoire();

    const reply = await ask(labo.client, PRIMARY_IP, `www.${ORIGIN}`);

    expect(addressOf(reply)).toBe('192.0.2.50');
  }, 20000);

  it('la zone secondaire est acceptee et rendue', async () => {
    const labo = laboratoire();
    declareSecondary(labo.sh);

    const rendered = labo.sh.execute('show system dns-database');
    expect(rendered).toContain('set type secondary');
    expect(rendered).toContain(`set ip-primary ${PRIMARY_IP}`);
  }, 20000);

  it('la zone est transferee des la configuration', async () => {
    const labo = laboratoire();
    declareSecondary(labo.sh);
    await settle();

    expect(labo.fw.getDnsServer().transferredZone('zone1')?.soa.data.serial).toBe(SERIAL);
  }, 20000);

  it('le pare-feu sert l_enregistrement que seul le primaire detenait', async () => {
    const labo = laboratoire();
    declareSecondary(labo.sh);
    await settle();

    const reply = await ask(labo.client, FIREWALL_IP, `www.${ORIGIN}`);

    expect(addressOf(reply)).toBe('192.0.2.50');
    expect(reply?.flags.rcode).toBe(DnsRcode.NOERROR);
    expect(reply?.flags.aa).toBe(true);
  }, 20000);

  it('le numero de serie servi est celui du primaire, pas un 1 invente', async () => {
    const labo = laboratoire();
    declareSecondary(labo.sh);
    await settle();

    const reply = await ask(labo.client, FIREWALL_IP, ORIGIN, RRType.SOA);
    const soa = reply?.answers[0]?.data as { serial?: number } | undefined;

    expect(soa?.serial).toBe(SERIAL);
  }, 20000);

  it('sans ip-primary, aucun transfert n_est tente', async () => {
    const labo = laboratoire();
    declareSecondary(labo.sh, '');
    await settle();

    expect(labo.fw.getDnsServer().transferredZone('zone1')).toBeNull();
  }, 20000);

  it('une zone primaire sert ses entrees tapees a la main', async () => {
    const labo = laboratoire();
    run(labo.sh, 'config system dns-database', 'edit "zone1"',
      `set domain "${ORIGIN}"`, 'set type primary',
      'config dns-entry', 'edit 1', 'set hostname "srv"',
      'set ip 10.9.9.9', 'next', 'end', 'next', 'end');
    await settle(4);

    const reply = await ask(labo.client, FIREWALL_IP, `srv.${ORIGIN}`);

    expect(addressOf(reply)).toBe('10.9.9.9');
  }, 20000);

  it('un NOTIFY du primaire declenche un nouveau transfert', async () => {
    const labo = laboratoire();
    declareSecondary(labo.sh);
    await settle();

    await labo.primary.applyUpdate({
      removals: [makeARecord(`www.${ORIGIN}`, 3600, '192.0.2.50')],
      additions: [makeARecord(`www.${ORIGIN}`, 3600, '192.0.2.77')],
    });
    await settle();

    const reply = await ask(labo.client, FIREWALL_IP, `www.${ORIGIN}`);

    expect(addressOf(reply)).toBe('192.0.2.77');
  }, 25000);

  it('un NOTIFY venu d_une autre adresse que le primaire ne transfere pas', async () => {
    const labo = laboratoire();
    declareSecondary(labo.sh, '10.1.1.99');
    await settle(8);

    await labo.primary.applyUpdate({
      removals: [makeARecord(`www.${ORIGIN}`, 3600, '192.0.2.50')],
      additions: [makeARecord(`www.${ORIGIN}`, 3600, '192.0.2.77')],
    });
    await settle(8);

    expect(labo.fw.getDnsServer().transferredZone('zone1')).toBeNull();
  }, 25000);

  it('un AXFR recu en UDP est refuse', async () => {
    const labo = laboratoire();
    declareSecondary(labo.sh);
    await settle();

    const reply = await ask(labo.client, FIREWALL_IP, ORIGIN, RRType.AXFR);

    expect(reply?.flags.rcode).toBe(DnsRcode.REFUSED);
  }, 20000);

  it('le pare-feu sait ouvrir une connexion TCP sortante', async () => {
    const labo = laboratoire();

    const socket = await labo.fw.tcpConnect(PRIMARY_IP, 53);

    expect(socket).not.toBeNull();
    socket?.close();
  }, 20000);

  it('un transfert deja en cours n_en lance pas un second', async () => {
    const labo = laboratoire();
    declareSecondary(labo.sh);
    await settle();

    const transfers: number[] = [];
    labo.primary.onTransfer((qtype) => transfers.push(qtype));
    await labo.primary.applyUpdate({
      removals: [makeARecord(`www.${ORIGIN}`, 3600, '192.0.2.50')],
      additions: [makeARecord(`www.${ORIGIN}`, 3600, '192.0.2.77')],
      notify: false,
    });

    const server = labo.fw.getDnsServer();
    await Promise.all([server.transferZone('zone1'), server.transferZone('zone1')]);
    await settle(8);

    expect(transfers).toHaveLength(1);
  }, 25000);
});
