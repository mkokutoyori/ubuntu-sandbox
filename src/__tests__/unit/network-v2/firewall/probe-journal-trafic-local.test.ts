/**
 * Le pare-feu ne journalisait que ce qui le TRAVERSE.
 *
 * Mesure de depart sur un laboratoire a deux hotes : un `ping` d'un LAN
 * a l'autre produit bien son enregistrement `type="traffic"
 * subtype="forward"`, tandis qu'un `ping` VERS le pare-feu et une
 * requete DNS EMISE par le pare-feu ne produisent RIEN — `execute log
 * display` repond « No matching log data. » et la seule chose que le
 * magasin contient est `event/system`. Le trafic qui se termine sur la
 * machine et celui qu'elle origine sont pourtant la moitie de ce qu'un
 * administrateur cherche dans un journal de pare-feu : c'est la que se
 * voient les tentatives de connexion a l'administration, les sondes sur
 * les ports d'ecoute, et ce que la machine appelle elle-meme.
 *
 * **`config log setting` etait un objet ENTIEREMENT inerte** : son
 * `onCommit` etait un corps vide, et ses six attributs — dont les trois
 * qui gouvernent exactement ce trafic — etaient acceptes, rendus par
 * `show log setting`, donc rejoues a l'import d'une topologie, et lus
 * par personne. `LogSettings` est le magasin qui manquait, de portee
 * VDOM comme la commande.
 *
 * **Le format vient de captures reelles et non de la memoire** :
 * `logid="0001000014" type="traffic" subtype="local" level="notice"`,
 * avec `policyid=0 policytype="local-in-policy"` quand aucune politique
 * locale nommee ne s'applique. Deux details ne s'inventent pas et sont
 * confirmes par plusieurs captures independantes : l'interface qui
 * n'existe pas du cote de la machine s'ecrit `unknown0` — `dstintf`
 * pour ce qui ARRIVE, `srcintf` pour ce qu'elle EMET — et un paquet
 * local ACCEPTE porte `action="accept"` meme quand `dstintf` vaut
 * `unknown0`. Une capture de 2019 ecrit `dstintf="<nom du vdom>"` la ou
 * deux autres ecrivent `unknown0` ; le simulateur retient la forme
 * majoritaire plutot que d'inventer une regle pour choisir entre les
 * deux, et ses deux directions ne peuvent donc pas se contredire.
 *
 * **`local-in-deny-broadcast` a ete AJOUTE** : la reference 6.0.4 le
 * declare a cote des deux autres, et son absence aurait rendu la
 * famille incoherente — un refus en diffusion et un refus en unicast
 * sont deux faits differents, et c'est justement pourquoi une vraie
 * machine les commute separement, un segment bavard noyant le journal.
 * La classe de la destination est lue par `classifyIpv4Destination`, la
 * regle que la couche internet porte deja, plutot que par un quatrieme
 * predicat.
 *
 * **QUATRE emetteurs UDP originaient du trafic**, chacun avec sa copie
 * de « resoudre la route, prendre l'adresse du port, emettre » :
 * `sendUdpDatagram`, `sendUdpToPeer`, le point d'extremite du plan de
 * controle et le client DNS. Trois d'entre eux descendent sur le
 * premier, ce qui ferme la duplication ET fait que tout ce que la
 * machine emet passe par UN point ou le journal se pose. Le quatrieme,
 * la REPONSE du serveur DNS, reste dehors deliberement : elle repart par
 * l'interface d'ARRIVEE avec l'adresse que le client a composee, ce
 * n'est pas une decision de routage — meme raison que la reponse SNMP.
 *
 * **Ce que le simulateur ne sait pas evaluer est REFUSE en nommant la
 * brique qui manque** plutot qu'accepte comme un reglage inerte :
 * `resolve-ip` (ce simulateur ne resout que dans le sens direct, donc
 * un journal n'a aucun nom a ajouter a une adresse) et
 * `sniffer-traffic` (il n'y a pas de `config firewall sniffer`, donc
 * aucun journal de sniffer a filtrer).
 *
 * Limite mesuree et ecrite plutot que tue : le `ping` EMIS par le
 * pare-feu (`execute ping`) n'est pas journalise, son chemin ICMP ne
 * passant pas par l'emetteur UDP unifie ; seul l'UDP originé l'est.
 *
 * Discrimine par `git stash push -- src/network/` : 6 des 11 cas
 * tombent. Les 5 restants sont nommes ici plutot que laisses a
 * decouvrir :
 *
 *   - « le laboratoire relaie vraiment » et « le trafic qui TRAVERSE
 *     reste journalise en forward » sont les TEMOINS, et c'est leur
 *     objet de passer des deux cotes : sans eux, un journal vide et un
 *     laboratoire mal bati seraient indiscernables, et rien ne
 *     garderait que la moitie qui marchait n'a pas ete cassee ;
 *   - « config log setting est acceptee et rendue » passait deja, et
 *     c'est l'enonce meme du defaut : la commande etait acceptee et
 *     rendue — donc rejouee a l'import — avec un corps de validation
 *     VIDE ;
 *   - « sans le reglage, un ping vers le pare-feu ne journalise rien »
 *     et « local-in-allow ne journalise pas le refus » passaient pour
 *     une raison qui ne prouve rien du mecanisme : AUCUN journal local
 *     n'existait, donc son absence etait garantie par la vacuite ; ils
 *     valent desormais pour le commutateur.
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

interface Cmd { executeCommand(cmd: string): Promise<string> }

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

async function laboratoire() {
  const fw = new FortiGate('firewall-fortinet', 'FGT', 0, 0);
  const sh = fw.getShell() as FortiShell;
  const a = new LinuxPC('linux-pc', 'A', 200, 0);
  const b = new LinuxPC('linux-pc', 'B', -200, 0);
  a.powerOn();
  b.powerOn();
  new Cable('c1').connect(fw.getPort('port1')!, a.getPorts()[0]);
  new Cable('c2').connect(fw.getPort('port2')!, b.getPorts()[0]);

  run(sh, 'config system interface',
    'edit "port1"', 'set mode static', 'set ip 10.1.1.1 255.255.255.0',
    'set allowaccess ping', 'next',
    'edit "port2"', 'set mode static', 'set ip 10.2.2.1 255.255.255.0',
    'set allowaccess ping', 'next', 'end',
    'config firewall policy', 'edit 1',
    'set srcintf "port1"', 'set dstintf "port2"',
    'set srcaddr "all"', 'set dstaddr "all"',
    'set action accept', 'set schedule "always"', 'set service "ALL"',
    'next', 'end');

  await runOn(a, 'ip link set eth0 up', 'ip addr add 10.1.1.10/24 dev eth0',
    'ip route add default via 10.1.1.1');
  await runOn(b, 'ip link set eth0 up', 'ip addr add 10.2.2.10/24 dev eth0',
    'ip route add default via 10.2.2.1');

  return { fw, sh, a, b };
}

function locaux(fw: FortiGate): readonly ReadonlyMap<string, string>[] {
  return fw.getLogStore().all()
    .filter(record => record.type === 'traffic' && record.subtype === 'local')
    .map(record => record.fields);
}

describe('le journal du trafic local', () => {
  it('le laboratoire relaie vraiment', async () => {
    const { a } = await laboratoire();

    expect(await runOn(a, 'ping -c 1 10.2.2.10')).toContain('0% packet loss');
  });

  it('config log setting est acceptee et rendue', async () => {
    const { sh } = await laboratoire();
    run(sh, 'config log setting', 'set local-in-allow enable', 'end');

    expect(sh.execute('show log setting')).toContain('set local-in-allow enable');
  });

  it('sans le reglage, un ping vers le pare-feu ne journalise rien', async () => {
    const { fw, a } = await laboratoire();
    await runOn(a, 'ping -c 1 10.1.1.1');

    expect(locaux(fw)).toHaveLength(0);
  });

  it('local-in-allow journalise le ping accepte vers le pare-feu', async () => {
    const { fw, sh, a } = await laboratoire();
    run(sh, 'config log setting', 'set local-in-allow enable', 'end');
    await runOn(a, 'ping -c 1 10.1.1.1');

    const [premier] = locaux(fw);
    expect(premier?.get('srcip')).toBe('10.1.1.10');
    expect(premier?.get('srcintf')).toBe('port1');
    expect(premier?.get('dstintf')).toBe('unknown0');
    expect(premier?.get('action')).toBe('accept');
  });

  it('le journal local porte le logid et le type de politique attestes', async () => {
    const { fw, sh, a } = await laboratoire();
    run(sh, 'config log setting', 'set local-in-allow enable', 'end');
    await runOn(a, 'ping -c 1 10.1.1.1');

    expect(fw.getLogStore().all().find(r => r.subtype === 'local')?.id)
      .toBe('0001000014');
    expect(locaux(fw)[0]?.get('policytype')).toBe('local-in-policy');
    expect(locaux(fw)[0]?.get('policyid')).toBe('0');
  });

  it('local-in-deny-unicast journalise le ping refuse par allowaccess', async () => {
    const { fw, sh, a } = await laboratoire();
    run(sh, 'config system interface', 'edit "port1"',
      'unset allowaccess', 'next', 'end',
      'config log setting', 'set local-in-deny-unicast enable', 'end');
    await runOn(a, 'ping -c 1 10.1.1.1');

    expect(locaux(fw)[0]?.get('action')).toBe('deny');
  });

  it('local-in-allow ne journalise pas le refus', async () => {
    const { fw, sh, a } = await laboratoire();
    run(sh, 'config system interface', 'edit "port1"',
      'unset allowaccess', 'next', 'end',
      'config log setting', 'set local-in-allow enable', 'end');
    await runOn(a, 'ping -c 1 10.1.1.1');

    expect(locaux(fw)).toHaveLength(0);
  });

  it('local-out journalise la requete DNS emise par le pare-feu', async () => {
    const { fw, sh } = await laboratoire();
    run(sh, 'config system dns', 'set primary 10.2.2.10', 'end',
      'config log setting', 'set local-out enable', 'end');
    fw.getDnsClient().resolve('exemple.lab');

    const emis = locaux(fw).find(fields => fields.get('dstport') === '53');
    expect(emis?.get('srcintf')).toBe('unknown0');
    expect(emis?.get('dstintf')).toBe('port2');
    expect(emis?.get('action')).toBe('accept');
  });

  it('le trafic qui TRAVERSE reste journalise en forward', async () => {
    const { fw, sh, a } = await laboratoire();
    run(sh, 'config firewall policy', 'edit 1', 'set logtraffic all', 'next', 'end');
    await runOn(a, 'ping -c 1 10.2.2.10');
    fw.getSessionTable().clear();

    expect(fw.getLogStore().all().some(r => r.subtype === 'forward')).toBe(true);
  });

  it('resolve-ip est refuse en nommant la brique qui manque', async () => {
    const { sh } = await laboratoire();
    sh.execute('config log setting');

    expect(sh.execute('set resolve-ip enable')).toContain('forward only');
  });

  it('sniffer-traffic est refuse en nommant la brique qui manque', async () => {
    const { sh } = await laboratoire();
    sh.execute('config log syslogd filter');

    expect(sh.execute('set sniffer-traffic disable'))
      .toContain('config firewall sniffer');
  });
});
