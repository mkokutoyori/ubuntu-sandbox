/**
 * `service-sla-tie-break` etait un TEXTE LIBRE que personne ne lisait,
 * et la zone SD-WAN n'existait pour personne.
 *
 * L'attribut etait declare `text(...)` sur `config system sdwan` →
 * `config zone`, la ou la reference donne trois valeurs et seulement
 * trois. Deux consequences se cumulaient. La CLI acceptait n'importe
 * quel mot — `set service-sla-tie-break zorglub` passait — ce que la
 * regle du depot interdit : un critere que le moteur ne sait pas decider
 * est REFUSE, pas stocke. Et la table de zone n'avait aucun `onCommit` :
 * seul son nom remontait, par le `onCommit` du parent, si bien que la
 * valeur etait rendue par `show` — donc rejouee a l'import d'une
 * topologie — et perdue au passage vers le moteur.
 *
 * **Le depart etait donc `cfg-order` en dur.** Quand plusieurs membres
 * respectent le SLA, `chosenAmong` rendait `eligible[0]`, c'est-a-dire
 * le premier de `priority-members` : exactement `cfg-order`, sans que
 * l'operateur puisse en choisir un autre. Un des trois comportements
 * etait la, les deux autres inatteignables.
 *
 * **Les trois valeurs sont decidables ici, et c'est ce qui autorise a
 * les declarer.** `cfg-order` est le comportement d'avant.
 * `input-device` se decide sur le port d'ARRIVEE, que le pipeline
 * connait deja et qu'il suffisait de porter jusqu'a la sonde de
 * steerage. `fib-best-match` se decide sur la table de routage : parmi
 * les membres eligibles, celui dont une route vers la destination a le
 * prefixe le plus long. Aucune des trois n'est un decor.
 *
 * **La table de routage gagne la question qu'on lui pose, la ou elle
 * vit.** `lookup` rend LA meilleure route, toutes interfaces confondues,
 * ce qui ne repond pas a « quelle est la meilleure route PAR CETTE
 * interface » ; `prefixLengthTowards` la pose, en reutilisant
 * `selected()` et `prefixBits` plutot qu'en recopiant la comparaison de
 * masques a cote.
 *
 * **Deux defauts plus profonds ont ete trouves en essayant de mesurer
 * sur le fil, et ils sont corriges ici parce que sans eux la mesure
 * etait impossible.** D'abord, une zone SD-WAN ne vivait que dans
 * `SdwanTable` et n'atteignait jamais la `ZoneTable` : « quelle zone
 * possede cette interface » avait donc deux magasins, dont un seul etait
 * consulte. La zone SD-WAN est desormais publiee dans la `ZoneTable`, un
 * seul magasin pour un seul fait. Ensuite, et c'est le plus lourd :
 * `matchesEndpoints` comparait `rule.to` a l'INTERFACE brute des que le
 * profil est keye par interface, ce qu'un FortiGate est. Une politique
 * dont le `dstintf` nomme une ZONE — un `system zone` ordinaire tout
 * autant qu'une zone SD-WAN — ne pouvait donc JAMAIS correspondre, alors
 * que le schema accepte les deux comme cibles de reference et que
 * l'etage calculait deja la zone d'entree et de sortie sans que
 * personne ne les lise.
 *
 * Le correctif n'elargit PAS « keye par interface » pour tout le monde,
 * et c'est un test existant qui l'a impose : `policy-evaluator.test.ts`
 * porte « en mode interface, la zone n'est pas consultee », decrit dans
 * son voisin comme « le modele ASA ». Sur un ASA c'est exact — un
 * `access-group` nomme un `nameif`, pas une zone — donc ce test n'encode
 * pas un defaut mais un contrat, et le casser aurait rendu l'ASA plus
 * permissif sans raison. Nommer une zone est une propriete du PROFIL
 * (`policyNamesZones`, vrai pour FortiOS, absent pour l'ASA), pas du
 * mode de cle. Dit franchement pour FortiOS : une vraie machine REFUSE
 * de nommer directement une interface deja placee dans une zone, donc
 * accepter les deux est plus permissif qu'elle sur une configuration
 * qu'elle ne laisse pas construire ; c'est le prix paye pour ne pas
 * casser les politiques existantes qui nomment l'interface.
 *
 * La mesure de bout en bout tient a un montage simple : la destination
 * est le voisin du membre `port3`, et le premier membre configure est
 * `port2`. Sous `cfg-order` le trafic part par `port2` et n'arrive
 * jamais ; sous `fib-best-match` la route connectee /24 de `port3` gagne
 * et la reponse revient. Le meme paquet, le meme laboratoire, deux
 * verdicts.
 *
 * Discrimine par `git stash push -- src/network/` : 6 des 10 cas
 * tombent. Les 4 qui passent des deux cotes sont nommes ici :
 *
 *   - « sans SD-WAN, le voisin de port3 repond » est le TEMOIN ;
 *   - « cfg-order choisit le premier membre configure » passait deja, et
 *     c'est l'enonce meme du defaut : ce depart-la etait le seul, en dur ;
 *   - « sous cfg-order le trafic n_arrive pas au voisin de port3 »
 *     passait pour la meme raison, et son jumeau `fib-best-match` est
 *     celui qui porte la mesure sur le fil ;
 *   - « input-device retombe sur le premier membre si le port d_arrivee
 *     n_en est pas un » passait avant pour une raison qui ne prouve
 *     rien : le premier membre etait choisi de toute facon. Son jumeau,
 *     « input-device choisit le membre par lequel le trafic est
 *     arrive », est celui qui discrimine.
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

async function laboratoire(options: {
  tieBreak?: string; sdwan?: boolean;
} = {}) {
  const fw = new FortiGate('firewall-fortinet', 'FGT', 0, 0);
  const sh = fw.getShell() as FortiShell;
  const peers = [1, 2, 3].map(index => {
    const pc = new LinuxPC('linux-pc', `P${index}`, 200, index * 100);
    pc.powerOn();
    new Cable(`c${index}`).connect(fw.getPort(`port${index}`)!, pc.getPorts()[0]);
    return pc;
  });

  run(sh, 'config system interface',
    'edit "port1"', 'set mode static', 'set ip 10.1.1.1 255.255.255.0', 'next',
    'edit "port2"', 'set mode static', 'set ip 10.2.2.1 255.255.255.0', 'next',
    'edit "port3"', 'set mode static', 'set ip 10.3.3.1 255.255.255.0', 'next', 'end');

  if (options.sdwan !== false) {
    run(sh, 'config system sdwan', 'set status enable',
      'config zone', 'edit "wan"',
      ...(options.tieBreak ? [`set service-sla-tie-break ${options.tieBreak}`] : []),
      'next', 'end',
      'config members',
      'edit 1', 'set interface "port2"', 'set gateway 10.2.2.10', 'set zone "wan"', 'next',
      'edit 2', 'set interface "port3"', 'set gateway 10.3.3.10', 'set zone "wan"', 'next',
      'end',
      'config service', 'edit 1', 'set name "sortie"',
      'set dst "all"', 'set priority-members 1 2', 'next', 'end',
      'end');
  }

  run(sh, 'config firewall policy', 'edit 1',
    'set srcintf "port1"',
    options.sdwan === false ? 'set dstintf "port2" "port3"' : 'set dstintf "wan"',
    'set srcaddr "all"', 'set dstaddr "all"',
    'set action accept', 'set schedule "always"', 'set service "ALL"', 'next', 'end');

  for (const [index, pc] of peers.entries()) {
    const octet = index + 1;
    await runOn(pc, 'ip link set eth0 up',
      `ip addr add 10.${octet}.${octet}.10/24 dev eth0`,
      `ip route add default via 10.${octet}.${octet}.1`);
  }

  return { fw, sh, p1: peers[0], p3: peers[2] };
}

function steered(fw: FortiGate, destination: string, ingressPort?: string) {
  return fw.getSdwan().steer(
    { sourceIP: '10.1.1.10', destinationIP: destination, ingressPort },
    (names) => names.includes('all'));
}

describe('le departage entre membres respectant le SLA', () => {
  it('sans SD-WAN, le voisin de port3 repond', async () => {
    const labo = await laboratoire({ sdwan: false });

    expect(await runOn(labo.p1, 'ping -c 2 10.3.3.10')).toContain(', 0% packet loss');
  }, 25000);

  it('la zone est rendue par show', async () => {
    const labo = await laboratoire({ tieBreak: 'fib-best-match' });

    expect(labo.sh.execute('show system sdwan'))
      .toContain('set service-sla-tie-break fib-best-match');
  }, 25000);

  it('une valeur inventee est refusee', async () => {
    const labo = await laboratoire();

    const refusal = run(labo.sh, 'config system sdwan', 'config zone', 'edit "wan"',
      'set service-sla-tie-break zorglub');
    labo.sh.execute('abort');

    expect(refusal).toContain("value parse error before 'zorglub'");
    expect(refusal).toContain('cfg-order, fib-best-match, input-device');
  }, 25000);

  it('la zone porte son depart jusqu_au moteur', async () => {
    const labo = await laboratoire({ tieBreak: 'input-device' });

    expect(labo.fw.getSdwan().getTable().zone('wan')?.tieBreak).toBe('input-device');
  }, 25000);

  it('sans valeur declaree, le depart est cfg-order', async () => {
    const labo = await laboratoire();

    expect(labo.fw.getSdwan().getTable().zone('wan')?.tieBreak).toBe('cfg-order');
  }, 25000);

  it('cfg-order choisit le premier membre configure', async () => {
    const labo = await laboratoire({ tieBreak: 'cfg-order' });

    expect(steered(labo.fw, '10.9.9.9')?.iface).toBe('port2');
  }, 25000);

  it('input-device choisit le membre par lequel le trafic est arrive', async () => {
    const labo = await laboratoire({ tieBreak: 'input-device' });

    expect(steered(labo.fw, '10.9.9.9', 'port3')?.iface).toBe('port3');
  }, 25000);

  it('input-device retombe sur le premier membre si le port d_arrivee n_en est pas un', async () => {
    const labo = await laboratoire({ tieBreak: 'input-device' });

    expect(steered(labo.fw, '10.9.9.9', 'port1')?.iface).toBe('port2');
  }, 25000);

  it('sous cfg-order le trafic n_arrive pas au voisin de port3', async () => {
    const labo = await laboratoire({ tieBreak: 'cfg-order' });

    expect(await runOn(labo.p1, 'ping -c 2 10.3.3.10')).toContain(', 100% packet loss');
  }, 25000);

  it('sous fib-best-match le meme trafic arrive', async () => {
    const labo = await laboratoire({ tieBreak: 'fib-best-match' });

    expect(await runOn(labo.p1, 'ping -c 2 10.3.3.10')).toContain(', 0% packet loss');
  }, 25000);
});
