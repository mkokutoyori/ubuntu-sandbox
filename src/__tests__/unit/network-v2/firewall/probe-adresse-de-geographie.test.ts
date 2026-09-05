/**
 * Une adresse de geographie n'existait PAS, et `countryOf` etait un
 * moteur sans porte.
 *
 * `set type geography` + `set country FR` etait accepte et rendu par
 * `show firewall address`, mais `onCommit` retournait AVANT de creer
 * l'objet — sa premiere ligne ecarte tout type autre que `ipmask`,
 * `iprange`, `fqdn` et `wildcard`. L'adresse n'existait donc dans aucun
 * magasin : `matchesAddress('FRANCE', ...)` ne trouvait ni objet ni
 * groupe et rendait `false` pour TOUTE adresse. Une politique de refus
 * ecrite sur une adresse de geographie ne mordait jamais, et une
 * politique d'autorisation ne s'ouvrait jamais — un objet rendu par la
 * configuration, rejoue a l'import d'une topologie, et sans aucun
 * effet.
 *
 * **En face, la machinerie etait complete et n'attendait qu'une
 * source.** `geographyAddress()`, le champ `countryCode` de
 * `AddressObject`, la branche `case 'geography'` de
 * `addressObjectMatches` et le crochet `countryOf` du contexte de
 * correspondance existaient tous — et personne n'alimentait le crochet.
 * C'est la forme de defaut que ce depot rencontre le plus souvent : un
 * moteur ecrit, correct, et sans porte par ou entrer.
 *
 * **La source est `config system geoip-override`, et ce choix evite
 * d'inventer.** La reference 6.0.4 la decrit comme la table qui
 * « override geolocation mappings » : l'operateur nomme un
 * `country-id` de deux lettres et declare des plages `ip-range`. Aucune
 * base geographique n'est donc fabriquee ici — ce qui aurait ete
 * inventer des donnees que rien n'atteste — et un laboratoire dit
 * lui-meme quelle plage appartient a quel pays. Une adresse hors de
 * toute plage declaree n'a pas de pays, donc l'adresse de geographie ne
 * la matche pas : le critere echoue FERME, ce que demande tout moteur
 * de correspondance de securite.
 *
 * `set country-id` est refuse s'il ne fait pas deux caracteres, comme
 * la reference l'ecrit (`size[2]`) : accepter `FRA` et le rendre
 * donnerait un pays qu'aucune adresse ne pourrait plus nommer.
 *
 * Discrimine par `git stash push -- src/network/` : 7 des 12 cas
 * tombent — j'en avais annonce 8, et la mesure corrige. Les 5 qui
 * passent des deux cotes sont nommes ici :
 *
 *   - « le laboratoire relaie vraiment » est le TEMOIN ;
 *   - « l_adresse de geographie est acceptee et rendue » passait deja,
 *     et c'est l'enonce meme du defaut : acceptee, rendue, et
 *     n'existant nulle part ;
 *   - les TROIS cas negatifs — « elle ne matche pas une adresse hors
 *     plage », « sans aucun override, l_adresse de geographie ne matche
 *     rien » et « hors de la plage declaree, le trafic passe » —
 *     passaient avant le correctif pour une raison qui ne prouve rien :
 *     l'objet n'existait pas, donc ne matchait rien, donc ces trois
 *     enonces etaient vrais sans qu'aucun mecanisme les porte. Ils n'ont
 *     de contenu qu'apres, et chacun a un jumeau positif qui tombe.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import type { FortiShell } from '@/network/devices/firewall/vendors/fortios/FortiShell';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

interface Cmd { executeCommand(command: string): Promise<string> }

async function runOn(device: Cmd, ...commands: string[]): Promise<string> {
  let last = '';
  for (const command of commands) last = await device.executeCommand(command);
  return last;
}

function run(sh: FortiShell, ...lines: string[]): string {
  let last = '';
  for (const line of lines) last = sh.execute(line);
  return last;
}

const OVERRIDE = Object.freeze([
  'config system geoip-override', 'edit "labo-fr"',
  'set description "plage du laboratoire"', 'set country-id FR',
  'config ip-range', 'edit 1',
  'set start-ip 10.1.1.10', 'set end-ip 10.1.1.20', 'next', 'end',
  'next', 'end',
]);

async function laboratoire(options: {
  override?: boolean; deny?: boolean; address?: string;
} = {}) {
  const fw = new FortiGate('firewall-fortinet', 'FGT', 0, 0);
  const sh = fw.getShell() as FortiShell;
  const a = new LinuxPC('linux-pc', 'A', 200, 0);
  const b = new LinuxPC('linux-pc', 'B', 200, 100);
  a.powerOn();
  b.powerOn();
  new Cable('c1').connect(fw.getPort('port1')!, a.getPorts()[0]);
  new Cable('c2').connect(fw.getPort('port2')!, b.getPorts()[0]);

  run(sh, 'config system interface',
    'edit "port1"', 'set mode static', 'set ip 10.1.1.1 255.255.255.0', 'next',
    'edit "port2"', 'set mode static', 'set ip 10.2.2.1 255.255.255.0', 'next', 'end');

  if (options.override !== false) run(sh, ...OVERRIDE);

  run(sh, 'config firewall address', 'edit "FRANCE"',
    'set type geography', 'set country FR', 'next', 'end');

  if (options.deny) {
    run(sh, 'config firewall policy', 'edit 1',
      'set srcintf "port1"', 'set dstintf "port2"',
      'set srcaddr "FRANCE"', 'set dstaddr "all"',
      'set action deny', 'set schedule "always"', 'set service "ALL"', 'next', 'end');
  }
  run(sh, 'config firewall policy', 'edit 2',
    'set srcintf "port1"', 'set dstintf "port2"',
    'set srcaddr "all"', 'set dstaddr "all"',
    'set action accept', 'set schedule "always"', 'set service "ALL"', 'next', 'end');

  const host = options.address ?? '10.1.1.10';
  await runOn(a, 'ip link set eth0 up', `ip addr add ${host}/24 dev eth0`,
    'ip route add default via 10.1.1.1');
  await runOn(b, 'ip link set eth0 up', 'ip addr add 10.2.2.10/24 dev eth0',
    'ip route add default via 10.2.2.1');

  return { fw, sh, a, b };
}

describe('une adresse de geographie designe vraiment un pays', () => {
  it('le laboratoire relaie vraiment', async () => {
    const labo = await laboratoire();

    expect(await runOn(labo.a, 'ping -c 2 10.2.2.10')).toContain(', 0% packet loss');
  }, 25000);

  it('l_adresse de geographie est acceptee et rendue', async () => {
    const labo = await laboratoire();
    const rendered = labo.sh.execute('show firewall address FRANCE');

    expect(rendered).toContain('set type geography');
    expect(rendered).toContain('set country "FR"');
  }, 25000);

  it('l_override est accepte et rendu avec ses plages', async () => {
    const labo = await laboratoire();
    const rendered = labo.sh.execute('show system geoip-override');

    expect(rendered).toContain('set country-id "FR"');
    expect(rendered).toContain('set start-ip 10.1.1.10');
    expect(rendered).toContain('set end-ip 10.1.1.20');
  }, 25000);

  it('un country-id qui ne fait pas deux caracteres est refuse', async () => {
    const labo = await laboratoire();

    const refusal = run(labo.sh, 'config system geoip-override', 'edit "labo-fra"',
      'set country-id FRA', 'next');
    labo.sh.execute('abort');

    expect(refusal).toContain('country-id');
  }, 25000);

  it('une adresse de la plage porte le pays declare', async () => {
    const labo = await laboratoire();

    expect(labo.fw.getGeoIpOverrides().countryOf('10.1.1.10')).toBe('FR');
  }, 25000);

  it('une adresse hors plage ne porte aucun pays', async () => {
    const labo = await laboratoire();

    expect(labo.fw.getGeoIpOverrides().countryOf('10.1.1.99')).toBeUndefined();
  }, 25000);

  it('l_adresse de geographie existe dans le magasin d_objets', async () => {
    const labo = await laboratoire();

    expect(labo.fw.getObjectStore().getAddress('FRANCE')?.countryCode).toBe('FR');
  }, 25000);

  it('elle matche une adresse de la plage', async () => {
    const labo = await laboratoire();

    expect(labo.fw.getObjectStore().matchesAddress('FRANCE', '10.1.1.10')).toBe(true);
  }, 25000);

  it('elle ne matche pas une adresse hors plage', async () => {
    const labo = await laboratoire();

    expect(labo.fw.getObjectStore().matchesAddress('FRANCE', '10.1.1.99')).toBe(false);
  }, 25000);

  it('sans aucun override, l_adresse de geographie ne matche rien', async () => {
    const labo = await laboratoire({ override: false });

    expect(labo.fw.getObjectStore().matchesAddress('FRANCE', '10.1.1.10')).toBe(false);
  }, 25000);

  it('la politique de refus mord sur une adresse de la plage', async () => {
    const labo = await laboratoire({ deny: true });

    expect(await runOn(labo.a, 'ping -c 2 10.2.2.10')).toContain(', 100% packet loss');
  }, 25000);

  it('hors de la plage declaree, le trafic passe', async () => {
    const labo = await laboratoire({ deny: true, address: '10.1.1.99' });

    expect(await runOn(labo.a, 'ping -c 2 10.2.2.10')).toContain(', 0% packet loss');
  }, 25000);
});
