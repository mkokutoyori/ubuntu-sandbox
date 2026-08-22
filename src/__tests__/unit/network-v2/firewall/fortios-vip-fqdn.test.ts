/**
 * Le TYPE d'un VIP gouverne, ou il ne veut rien dire.
 *
 * §6.4 du carnet nomme le point : « `dns-translation` et `fqdn` sont
 * declares et non commis ». La mesure le confirme et l'explique :
 * l'`onCommit` de `config firewall vip` commence litteralement par
 * `if (object.effective('type')[0] !== 'static-nat') return;`. Le mot-cle
 * est accepte, rendu par `show`, rejoue a l'import d'une topologie — et
 * ne traduit RIEN.
 *
 * Le chainon du dessous est desormais REEL et n'est pas refait ici :
 * `FirewallDnsClient` interroge un vrai resolveur, `config system dns`
 * lui transmet ses serveurs, et `resolveFqdn` est branche sur le magasin
 * d'objets. Un temoin l'eprouve dans le meme laboratoire, sans quoi un
 * labo mal bati et un defaut du VIP seraient indiscernables.
 *
 * Ecrite A L'AVEUGLE contre ce que fait un vrai FortiGate, verifie contre
 * la documentation Fortinet :
 *
 *   1. **Un VIP `set type fqdn` prend `set mapped-addr <objet>`** — pas
 *      `mappedip`, qui n'a pas de sens quand l'adresse vient d'un nom.
 *   2. **Il traduit vers l'adresse que le nom resout**, et un vrai client
 *      atteint le vrai serveur en composant l'adresse externe.
 *   3. **Quand le nom change de reponse, le VIP suit.** C'est la raison
 *      d'etre de ce type : sinon autant ecrire l'adresse a la main.
 *   4. **Un `mapped-addr` qui ne designe pas un objet FQDN est refuse**,
 *      et un objet inexistant aussi — un VIP qui pointe sur rien
 *      traduirait vers rien en silence.
 *   5. **`dns-translation` est REFUSE** en nommant la brique manquante :
 *      il n'y a a aucun moment un mot-cle accepte et inerte.
 *   6. **Non-regression** : un VIP `static-nat` traduit toujours.
 *
 * Discrimination (`git stash push -- src/network/`) : 6 des 9 cas tombent
 * avant correctif. Les 3 autres sont nommes ici plutot que laisses a
 * decouvrir, et aucun ne prouve le mecanisme :
 *   - le TEMOIN du chainon DNS passe des deux cotes — c'est son objet, il
 *     etablit que la resolution marchait DEJA et que l'echec vient donc
 *     du VIP ;
 *   - « un objet inexistant est refuse » passait parce que le schema
 *     valide deja une reference, pas parce que le type est commis ;
 *   - le cas de non-regression `static-nat`, dont l'objet est de passer
 *     des deux cotes.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { FortiShell } from '@/network/devices/firewall/vendors/fortios/FortiShell';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress, IPAddress, SubnetMask } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { Zone } from '@/network/dns/zone/Zone';
import { ZoneStore } from '@/network/dns/zone/ZoneStore';
import { makeARecord, makeSoaRecord, makeNsRecord } from '@/network/dns/wire/ResourceRecord';
import { AuthoritativeServer } from '@/network/dns/resolver/AuthoritativeServer';
import { bindDnsUdpServer } from '@/network/dns/transport/DnsUdpTransport';

const RESOLVEUR = '192.168.1.53';
const SERVEUR_WEB = '192.168.1.80';
const AUTRE_WEB = '192.168.1.81';
const EXTERNE = '203.0.113.50';
const CLIENT = '203.0.113.10';

interface Cmd { executeCommand(cmd: string): Promise<string> }

const runOn = (d: Cmd, cmds: string[]) =>
  cmds.reduce(async (p, c) => { await p; await d.executeCommand(c); }, Promise.resolve<unknown>(undefined));

function run(sh: FortiShell, ...lines: string[]): string {
  let last = '';
  for (const line of lines) last = sh.execute(line);
  return last;
}

function zoneLab(): { store: ZoneStore; zone: Zone } {
  const zone = new Zone('lab.local', makeSoaRecord('lab.local', 3600, {
    mname: 'ns1.lab.local', rname: 'hostmaster.lab.local',
    serial: 2026082001, refresh: 7200, retry: 3600, expire: 1209600, minimum: 60,
  }));
  zone.addRecord(makeNsRecord('lab.local', 86400, 'ns1.lab.local'));
  zone.addRecord(makeARecord('ns1.lab.local', 3600, RESOLVEUR));
  zone.addRecord(makeARecord('web.lab.local', 60, SERVEUR_WEB));

  const store = new ZoneStore();
  store.addZone(zone);
  return { store, zone };
}

async function laboratoire() {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();

  const fw = new FortiGate('firewall-fortinet', 'FGT', 0, 0);
  const sh = fw.getShell();
  const commutateur = new GenericSwitch('switch-generic', 'SW', 8, 0, 150);
  const dns = new LinuxServer('linux-server', 'DNS', -200, 150);
  const web = new LinuxServer('linux-server', 'WEB', -200, 250);
  const autre = new LinuxServer('linux-server', 'WEB2', -200, 350);
  const client = new LinuxPC('linux-pc', 'PC', 200, 0);
  for (const d of [dns, web, autre, client, commutateur]) d.powerOn();

  new Cable('a').connect(fw.getPort('port1')!, commutateur.getPort('eth0')!);
  new Cable('b').connect(dns.getPorts()[0], commutateur.getPort('eth1')!);
  new Cable('c').connect(web.getPorts()[0], commutateur.getPort('eth2')!);
  new Cable('e').connect(autre.getPorts()[0], commutateur.getPort('eth3')!);
  new Cable('d').connect(client.getPorts()[0], fw.getPort('port2')!);

  run(sh,
    'config system interface',
    'edit "port1"', 'set mode static',
    'set ip 192.168.1.1 255.255.255.0', 'set allowaccess ping', 'next',
    'edit "port2"', 'set mode static',
    'set ip 203.0.113.1 255.255.255.0', 'set allowaccess ping', 'next', 'end');

  const mask = new SubnetMask('255.255.255.0');
  dns.getPorts()[0].configureIP(new IPAddress(RESOLVEUR), mask);

  const { store, zone } = zoneLab();
  const serveurDns = new AuthoritativeServer(store);
  bindDnsUdpServer(dns, (query) => serveurDns.answer(query));

  await runOn(dns, ['ip link set eth0 up', `ip addr add ${RESOLVEUR}/24 dev eth0`,
    'ip route add default via 192.168.1.1']);
  await runOn(web, ['ip link set eth0 up', `ip addr add ${SERVEUR_WEB}/24 dev eth0`,
    'ip route add default via 192.168.1.1', 'systemctl start nginx']);
  await runOn(autre, ['ip link set eth0 up', `ip addr add ${AUTRE_WEB}/24 dev eth0`,
    'ip route add default via 192.168.1.1', 'systemctl start nginx']);
  await runOn(client, ['ip link set eth0 up', `ip addr add ${CLIENT}/24 dev eth0`,
    'ip route add default via 203.0.113.1']);

  return { fw, sh, client, zone };
}

function resolveurDeclare(sh: FortiShell): string {
  return run(sh, 'config system dns', `set primary ${RESOLVEUR}`, 'end');
}

function objetFqdn(sh: FortiShell): string {
  return run(sh, 'config firewall address', 'edit "web-lab"',
    'set type fqdn', 'set fqdn "web.lab.local"', 'next', 'end');
}

function vipFqdn(sh: FortiShell): string {
  return run(sh, 'config firewall vip', 'edit "vers-web"',
    'set type fqdn', `set extip ${EXTERNE}`,
    'set extintf "port2"', 'set mapped-addr "web-lab"', 'next', 'end');
}

function politiqueVersVip(sh: FortiShell, vip: string): string {
  return run(sh, 'config firewall policy', 'edit 1',
    'set srcintf "port2"', 'set dstintf "port1"',
    'set srcaddr "all"', `set dstaddr "${vip}"`,
    'set action accept', 'set schedule "always"', 'set service "ALL"',
    'next', 'end');
}

function adresseTraduite(fw: FortiGate, vip: string): string | undefined {
  const rule = fw.getNatPolicy().ordered().find(entry => entry.id === `vip:${vip}`);
  const translation = rule?.destinationTranslation;
  return translation?.kind === 'static-ip' ? translation.translatedAddress : undefined;
}

beforeEach(() => { Logger.reset(); });

describe('le chainon DNS du pare-feu — le temoin', () => {
  it('un objet adresse `fqdn` correspond a l`adresse resolue', async () => {
    const { fw, sh } = await laboratoire();
    resolveurDeclare(sh);
    objetFqdn(sh);

    expect(fw.getDnsClient().resolve('web.lab.local')).toContain(SERVEUR_WEB);
    expect(fw.getObjectStore().matchesAddress('web-lab', SERVEUR_WEB)).toBe(true);
    expect(fw.getObjectStore().matchesAddress('web-lab', AUTRE_WEB)).toBe(false);
  });
});

describe('un VIP `type fqdn` traduit vers le nom resolu', () => {
  it('la configuration est acceptee et `show` la reproduit', async () => {
    const { sh } = await laboratoire();
    resolveurDeclare(sh); objetFqdn(sh);

    vipFqdn(sh);

    const rendu = sh.execute('show firewall vip');
    expect(rendu).toMatch(/set type fqdn/);
    expect(rendu).toMatch(/set mapped-addr "web-lab"/);
  });

  it('le VIP pointe sur l`adresse que le nom resout', async () => {
    const { fw, sh } = await laboratoire();
    resolveurDeclare(sh); objetFqdn(sh);

    vipFqdn(sh);

    expect(adresseTraduite(fw, 'vers-web')).toBe(SERVEUR_WEB);
  });

  it('un vrai client atteint le vrai serveur par l`adresse externe', async () => {
    const { sh, client } = await laboratoire();
    resolveurDeclare(sh); objetFqdn(sh);
    vipFqdn(sh);
    politiqueVersVip(sh, 'vers-web');

    const sortie = await client.executeCommand(`curl -sS http://${EXTERNE}/`);

    expect(sortie).toMatch(/<html|Welcome|nginx/i);
  });

  it('quand le nom change de reponse, le VIP suit', async () => {
    const { fw, sh, zone } = await laboratoire();
    resolveurDeclare(sh); objetFqdn(sh);
    vipFqdn(sh);
    expect(adresseTraduite(fw, 'vers-web')).toBe(SERVEUR_WEB);

    for (const record of zone.allRecords()) {
      if (record.name === 'web.lab.local') zone.removeRecord(record);
    }
    zone.addRecord(makeARecord('web.lab.local', 60, AUTRE_WEB));
    run(sh, 'config firewall address', 'edit "web-lab"',
      'set fqdn "web.lab.local"', 'next', 'end');

    expect(adresseTraduite(fw, 'vers-web')).toBe(AUTRE_WEB);
  });

  it('`mapped-addr` qui designe un objet inexistant est refuse', async () => {
    const { sh } = await laboratoire();
    resolveurDeclare(sh);
    run(sh, 'config firewall vip', 'edit "vers-web"',
      'set type fqdn', `set extip ${EXTERNE}`);

    expect(run(sh, 'set mapped-addr "absent"')).toMatch(/Command fail|value parse error/i);
    run(sh, 'abort');
  });

  it('`mapped-addr` qui designe un objet non-FQDN est refuse', async () => {
    const { sh } = await laboratoire();
    resolveurDeclare(sh);
    run(sh, 'config firewall address', 'edit "un-hote"',
      'set subnet 10.9.9.9 255.255.255.255', 'next', 'end');
    run(sh, 'config firewall vip', 'edit "vers-web"',
      'set type fqdn', `set extip ${EXTERNE}`, 'set mapped-addr "un-hote"');

    expect(run(sh, 'next')).toMatch(/Command fail|fqdn/i);
    run(sh, 'abort');
  });
});

describe('`dns-translation` est refuse en nommant la brique', () => {
  it('le type est refuse plutot qu`accepte et inerte', async () => {
    const { sh } = await laboratoire();
    run(sh, 'config firewall vip', 'edit "dyn"');

    const refus = run(sh, 'set type dns-translation');

    expect(refus).toMatch(/Command fail/i);
    expect(refus).toMatch(/DNS/i);
    run(sh, 'abort');
  });
});

describe('non-regression', () => {
  it('un VIP `static-nat` traduit toujours', async () => {
    const { sh, client } = await laboratoire();
    run(sh, 'config firewall vip', 'edit "statique"',
      `set extip ${EXTERNE}`, 'set extintf "port2"',
      `set mappedip "${SERVEUR_WEB}"`, 'next', 'end');
    politiqueVersVip(sh, 'statique');

    const sortie = await client.executeCommand(`curl -sS http://${EXTERNE}/`);

    expect(sortie).toMatch(/<html|Welcome|nginx/i);
  });
});
