import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { MACAddress, resetCounters } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';

/*
 * VXLAN est absent de ce lot, et la mesure dit pourquoi :
 * `buildVxlanInterfaceCommands` n'est appele que derriere
 * `hasVxlanHardware()`, qui rend `false` sur la classe de base et que ni
 * le routeur ni le commutateur ne redefinissent. Aucune des commandes
 * d'interface NVE n'existe donc aujourd'hui sur aucune plateforme —
 * les migrer serait migrer du code mort, et decider qui porte cette
 * carte est un autre sujet que celui-ci.
 */

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  EquipmentRegistry.resetInstance();
});

interface Cli {
  powerOn(): void;
  executeCommand(command: string): Promise<string>;
  cliHelp(input: string): string;
  cliTabCandidates(input: string): string[];
}

let serial = 0;

function nu(): Cli {
  const device = new CiscoRouter(`R${serial++}`, 0, 0) as unknown as Cli;
  device.powerOn();
  return device;
}

/*
 * Une SOUS-INTERFACE est une interface, et c'est le cas que la sonde
 * n'avait pas : `config-subif` est un mode distinct servi par le meme
 * arbre, et sa hierarchie le rattache a `config` et non a `config-if` —
 * donc il n'herite de rien. Une declaration qui ne nomme que
 * `config-if` fait disparaitre `ip nat inside` d'un routeur-sur-un-baton
 * sans que rien ne le signale ; c'est la suite NAT qui l'a attrape.
 */
async function surSousIface(): Promise<Cli> {
  const device = nu();
  for (const c of ['enable', 'configure terminal',
    'interface GigabitEthernet0/0.10', 'encapsulation dot1q 10']) {
    await device.executeCommand(c);
  }
  return device;
}

async function surIface(): Promise<Cli> {
  const device = nu();
  for (const c of ['enable', 'configure terminal', 'interface GigabitEthernet0/0']) {
    await device.executeCommand(c);
  }
  return device;
}

/*
 * Les formes ci-dessous sont relevees sur les GESTIONNAIRES, pas sur les
 * declarations : une sonde ecrite d'apres ce que l'on vient de declarer
 * herite du meme angle mort, ce qui est precisement ce qui a laisse
 * passer trois regressions dans les lots precedents. Chaque ligne est
 * une forme dont on a verifie, en lisant le corps du gestionnaire,
 * qu'elle l'atteint.
 */
const REGLAGES: ReadonlyArray<string> = [
  'bfd interval 300 min_rx 300 multiplier 3',
  'bfd interval 300 min-rx 300 multiplier 5',
  'bfd interval 50',
  'bfd neighbor 10.0.0.2',
  'no bfd neighbor 10.0.0.2',
  'ip igmp',
  'ip igmp version 2',
  'ip igmp version 1',
  'no ip igmp version',
  'ip igmp join-group 239.1.1.1',
  'ip igmp static-group 239.1.1.2',
  'no ip igmp join-group 239.1.1.1',
  'no ip igmp static-group 239.1.1.2',
  'no ip igmp',
  'ip pim sparse-mode',
  'ip pim dense-mode',
  'ip pim sparse-dense-mode',
  'ip pim dr-priority 100',
  'ip pim query-interval 30',
  'no ip pim',
  'no ip pim sparse-mode',
  'no ip pim dense-mode',
  'no ip pim sparse-dense-mode',
  'ip nat inside',
  'ip nat outside',
  'no ip nat inside',
  'no ip nat outside',
];

describe('chaque reglage d\'interface reste accepte apres la migration', () => {
  it.each(REGLAGES)('`%s`', async (commande) => {
    expect(await (await surIface()).executeCommand(commande))
      .not.toContain('Invalid input');
  });
});

describe('une sous-interface porte les memes commandes qu\'une interface', () => {
  it.each(REGLAGES)('`%s`', async (commande) => {
    expect(await (await surSousIface()).executeCommand(commande))
      .not.toContain('Invalid input');
  });

  it('`?` y annonce les memes places', async () => {
    expect((await surSousIface()).cliHelp('ip nat '))
      .toBe((await surIface()).cliHelp('ip nat '));
  });
});

describe('le refus vient du gestionnaire, avec ce qu\'il a a dire', () => {
  /*
   * Une place enumeree {1, 2} ferait DISPARAITRE ce message, en
   * repondant un caret nu la ou la machine explique ce qui manque.
   * C'est une information, pas un refus quelconque.
   */
  it('IGMPv3 est refuse en NOMMANT ce qui n\'est pas modelise', async () => {
    const out = await (await surIface()).executeCommand('ip igmp version 3');
    expect(out).toContain('IGMPv3 is not supported in this simulator');
    expect(out).not.toContain('Invalid input');
  });

  it('une version IGMP hors de la plage annoncee recoit le caret d IOS', async () => {
    const out = await (await surIface()).executeCommand('ip igmp version 9');

    expect(out).toContain("% Invalid input detected at '^' marker.");
    expect(out).not.toContain('Invalid IGMP version');
  });

  it('un groupe hors du multicast est refuse en le disant', async () => {
    expect(await (await surIface()).executeCommand('ip igmp join-group 10.0.0.1'))
      .toContain('Invalid group address');
  });

  it('un voisin BFD qui n\'est pas une adresse est refuse', async () => {
    expect(await (await surIface()).executeCommand('bfd neighbor pas-une-adresse'))
      .toContain('Invalid neighbor');
  });

  it('une priorite PIM negative est refusee', async () => {
    expect(await (await surIface()).executeCommand('ip pim dr-priority -1'))
      .toContain('Invalid');
  });
});

describe('`?` nomme la place au lieu d\'un mot muet', () => {
  const ATTENDU: ReadonlyArray<readonly [string, string]> = [
    ['bfd ', 'BFD static neighbor'],
    ['bfd neighbor ', 'A.B.C.D'],
    ['bfd interval ', 'min_rx'],
    ['ip igmp ', 'Set IGMP version'],
    ['ip igmp join-group ', 'A.B.C.D'],
    ['ip pim ', 'Enable PIM sparse mode'],
    ['ip pim dr-priority ', 'DR election priority'],
    ['ip pim query-interval ', 'seconds'],
    ['ip nat ', 'Mark interface as NAT inside'],
  ];

  it.each(ATTENDU)('`%s?` annonce %s', async (saisie, attendu) => {
    expect((await surIface()).cliHelp(saisie)).toContain(attendu);
  });
});

describe('la tabulation complete ce que l\'aide propose', () => {
  it('`ip pim spa` reste ambigu entre deux modes', async () => {
    const candidats = (await surIface()).cliTabCandidates('ip pim spa');
    expect(candidats).toContain('ip pim sparse-mode');
    expect(candidats).toContain('ip pim sparse-dense-mode');
  });

  it('`ip nat in` garde son mot', async () => {
    expect((await surIface()).cliTabCandidates('ip nat in'))
      .toEqual(['ip nat inside']);
  });
});

/*
 * Deuxieme vague : `crypto map`, la famille ICMP/uRPF/zone et NetFlow.
 * Meme methode — les formes sont relevees sur les gestionnaires, et ce
 * bloc est passe sur le code NON MIGRE avant de l'etre : les cas
 * d'acceptation doivent etre verts DES AVANT, c'est ce qui en fait le
 * garde-fou du sens « la declaration refuse ce que la machine
 * acceptait ».
 */
const REGLAGES_2: ReadonlyArray<string> = [
  'crypto map CM',
  'no crypto map',
  'ip unreachables',
  'no ip unreachables',
  'ip redirects',
  'no ip redirects',
  'ip proxy-arp',
  'no ip proxy-arp',
  'ip verify unicast reverse-path',
  'ip verify unicast source reachable-via any',
  'ip verify unicast source reachable-via rx',
  'zone-member security INSIDE',
  'ip route-cache flow',
  'ip flow ingress',
  'ip flow egress',
  'ip flow monitor MON input',
  'ip flow monitor MON output',
  'ip flow monitor MON',
];

describe('crypto map, ICMP/uRPF/zone et NetFlow restent acceptes', () => {
  it.each(REGLAGES_2)('`%s`', async (commande) => {
    expect(await (await surIface()).executeCommand(commande))
      .not.toContain('Invalid input');
  });

  it.each(REGLAGES_2)('sur une sous-interface aussi › `%s`', async (commande) => {
    expect(await (await surSousIface()).executeCommand(commande))
      .not.toContain('Invalid input');
  });
});

describe('`?` nomme les places de la deuxieme vague', () => {
  const ATTENDU_2: ReadonlyArray<readonly [string, string]> = [
    ['crypto map ', 'Name of the crypto map'],
    ['ip verify unicast ', 'reverse-path'],
    ['zone-member security ', 'Name of the security zone'],
    ['ip flow monitor ', 'Name of the flow monitor'],
    ['ip flow ', 'Enable ingress NetFlow'],
  ];

  it.each(ATTENDU_2)('`%s?` annonce %s', async (saisie, attendu) => {
    expect((await surIface()).cliHelp(saisie)).toContain(attendu);
  });
});

/*
 * Troisieme vague : la famille OSPF d'interface, plus `bfd`,
 * `frame-relay` et `ip nhrp`. Comme les deux precedentes, ce bloc est
 * releve sur les gestionnaires et passe sur le code NON MIGRE avant de
 * l'etre.
 *
 * Chacun de ces gestionnaires VALIDE ET EXPLIQUE — `% Invalid cost
 * value (1-65535)`, `% Invalid priority value (0-255)`, `% Invalid
 * process ID` — donc aucune place ne doit le devancer : une borne
 * declaree rendrait un caret nu la ou la machine nomme l'intervalle.
 */
const REGLAGES_3: ReadonlyArray<string> = [
  'ip ospf 1 area 0',
  'ip ospf area 0',
  'ip ospf cost 100',
  'ip ospf priority 10',
  'ip ospf hello-interval 5',
  'ip ospf dead-interval 20',
  'ip ospf network point-to-point',
  'ip ospf network broadcast',
  'ip ospf network non-broadcast',
  'ip ospf authentication',
  'ip ospf authentication message-digest',
  'ip ospf authentication-key CISCO',
  'ip ospf message-digest-key 1 md5 CISCO',
  'ip ospf retransmit-interval 5',
  'ip ospf transmit-delay 2',
  'ip ospf demand-circuit',
  'ip ospf mtu-ignore',
  'ip ospf bfd',
  'ip ospf flood-reduction',
  'ip ospf database-filter all out',
  'no ip ospf cost',
  'no ip ospf priority',
  'no ip ospf hello-interval',
  'no ip ospf dead-interval',
  'no ip ospf network',
  'no ip ospf authentication',
  'no ip ospf authentication-key',
  'no ip ospf message-digest-key',
  'no ip ospf retransmit-interval',
  'no ip ospf transmit-delay',
  'no ip ospf mtu-ignore',
  'bfd interval 100 min_rx 100 multiplier 3',
  'ip nhrp network-id 1',
  'ip nhrp holdtime 300',
  'frame-relay lmi-type cisco',
];

describe('la famille OSPF d\'interface reste acceptee', () => {
  it.each(REGLAGES_3)('`%s`', async (commande) => {
    expect(await (await surIface()).executeCommand(commande))
      .not.toContain('Invalid input');
  });
});

/*
 * Mesure, et elle contredit l'attente : ces deux bornes sont REFUSEES AU
 * CARET, pas par le gestionnaire. Celui-ci porte pourtant
 * `% Invalid cost value (1-65535)` et `% Invalid priority value
 * (0-255)`, ecrits et INATTEIGNABLES — l'analyse tranche avant lui.
 *
 * Et c'est le caret qui a raison : un vrai IOS connait la plage a
 * l'analyse et rend `% Invalid input detected at '^' marker.`. La
 * migration doit donc DECLARER ces plages pour conserver le
 * comportement, a l'inverse de `bfd neighbor` ou `ip igmp version`, ou
 * le message du gestionnaire etait la seule reponse possible. La
 * difference n'est pas de gout : elle est dans ce que la machine rend
 * deja.
 */
describe('une borne connue de l\'analyse est refusee au caret, comme sur IOS', () => {
  it.each([
    'ip ospf cost 70000',
    'ip ospf cost 0',
    'ip ospf priority 300',
  ])('`%s` est refuse au caret', async (commande) => {
    expect(await (await surIface()).executeCommand(commande))
      .toContain('Invalid input detected');
  });

  /*
   * Le gestionnaire ne refuse que ce qui n'est PAS un nombre : `ip ospf
   * 0 area 0` passe. Mesure plutot que suppose — j'attendais un refus.
   */
  it('un identifiant de processus nul est accepte', async () => {
    expect(await (await surIface()).executeCommand('ip ospf 0 area 0'))
      .not.toContain('Invalid input');
  });
});

/*
 * Ce que la migration APPORTE a OSPF : `?` annonce desormais les bornes
 * de la reference Cisco pour la version que `show version` annonce
 * (15.7(3)M5), verifiees et non tirees de memoire — cout 1-65535,
 * priorite 0-255, les quatre minuteurs 1-65535 secondes, identifiant de
 * cle 1-255 — et les quatre types de reseau avec les mots d'IOS.
 */
/*
 * Une NEGATION se tape SEULE, la ou la forme positive exige une valeur.
 * Le socle ne fabriquait cette forme nue que pour l'un de ses deux
 * mecanismes de negation, si bien qu'une famille migree par l'autre
 * perdait en silence tous ses `no <commande>` — la suite de
 * serialisation l'a attrape, pas ce releve. Ce que le cas verifie n'est
 * pas l'acceptation mais l'EFFET : le reglage doit disparaitre de la
 * configuration rendue.
 */
describe('`no <reglage>` seul rend vraiment son defaut', () => {
  it.each([
    ['ip ospf cost 42', 'no ip ospf cost', 'ip ospf cost'],
    ['ip ospf priority 7', 'no ip ospf priority', 'ip ospf priority'],
    ['ip ospf hello-interval 5', 'no ip ospf hello-interval', 'ip ospf hello-interval'],
    ['ip ospf network point-to-point', 'no ip ospf network', 'ip ospf network'],
  ] as ReadonlyArray<readonly [string, string, string]>)(
    '`%s` puis `%s` retire la ligne', async (pose, defait, ligne) => {
      const device = await surIface();
      await device.executeCommand(pose);
      await device.executeCommand(defait);
      await device.executeCommand('end');
      expect(await device.executeCommand('show running-config')).not.toContain(ligne);
    });
});

describe('`?` annonce les bornes reelles d\'OSPF', () => {
  const ATTENDU_OSPF: ReadonlyArray<readonly [string, string]> = [
    ['ip ospf cost ', '<1-65535>'],
    ['ip ospf priority ', '<0-255>'],
    ['ip ospf hello-interval ', '<1-65535>'],
    ['ip ospf dead-interval ', '<1-65535>'],
    ['ip ospf retransmit-interval ', '<1-65535>'],
    ['ip ospf transmit-delay ', '<1-65535>'],
    ['ip ospf message-digest-key ', '<1-255>'],
    ['ip ospf network ', 'Specify OSPF broadcast multi-access network'],
    ['ip ospf network ', 'Specify OSPF NBMA network'],
    ['ip ospf network ', 'Specify OSPF point-to-multipoint network'],
    ['ip ospf network ', 'Specify OSPF point-to-point network'],
  ];

  it.each(ATTENDU_OSPF)('`%s?` annonce %s', async (saisie, attendu) => {
    expect((await surIface()).cliHelp(saisie)).toContain(attendu);
  });

  it('`point-to-multipoint non-broadcast` reste accepte', async () => {
    expect(await (await surIface())
      .executeCommand('ip ospf network point-to-multipoint non-broadcast'))
      .not.toContain('Invalid input');
  });

  it('un type de reseau inconnu est refuse au caret', async () => {
    expect(await (await surIface()).executeCommand('ip ospf network zorglub'))
      .toContain('Invalid input detected');
  });

  it('un identifiant de cle hors bornes est refuse au caret', async () => {
    expect(await (await surIface()).executeCommand('ip ospf message-digest-key 256 md5 X'))
      .toContain('Invalid input detected');
  });
});

/*
 * Quatrieme vague : la famille PHYSIQUE de l'interface, celle que tout
 * le monde tape — adresse, description, arret, vitesse, duplex, MTU —
 * plus RIP et EIGRP d'interface, qui vivent dans le meme constructeur.
 *
 * Bornes verifiees contre la reference Cisco et identiques a celles que
 * le gestionnaire applique deja : `bandwidth` 1-10000000 kbit/s,
 * `delay` 1-16777215 dizaines de microsecondes.
 */
const REGLAGES_4: ReadonlyArray<string> = [
  'description un lien de test',
  'no description',
  'shutdown',
  'no shutdown',
  'ip address 10.0.0.1 255.255.255.0',
  'ip address 10.0.0.2 255.255.255.0 secondary',
  'no ip address',
  'ipv6 address 2001:db8::1/64',
  'mtu 1500',
  'ip mtu 1400',
  'bandwidth 100000',
  'delay 100',
  'duplex full',
  'duplex half',
  'duplex auto',
  'speed 100',
  'keepalive 10',
  'no keepalive',
  'load-interval 60',
  'ip helper-address 10.0.0.9',
  'no ip helper-address 10.0.0.9',
  'ip directed-broadcast',
  'no ip directed-broadcast',
  'ip tcp adjust-mss 1360',
  'no ip tcp adjust-mss',
  'arp timeout 300',
  'ip policy route-map RM',
  'ip split-horizon',
  'no ip split-horizon',
  'ip rip send version 2',
  'ip rip receive version 2',
  'ip rip authentication mode md5',
  'ip rip v2-broadcast',
  'ip summary-address rip 10.0.0.0 255.0.0.0',
  'ip hello-interval eigrp 100 5',
  'ip hold-time eigrp 100 15',
  'ip bandwidth-percent eigrp 100 50',
  'ip authentication mode eigrp 100 md5',
  'ip authentication key-chain eigrp 100 KC',
  'ip summary-address eigrp 100 10.0.0.0 255.0.0.0',
  'no ip split-horizon eigrp 100',
  'ntp disable',
  'no ntp disable',
  'service-policy input PM',
  'ip accounting',
  'ip unnumbered Loopback0',
  'no ip unnumbered',
];

describe('la famille physique de l\'interface reste acceptee', () => {
  it.each(REGLAGES_4)('`%s`', async (commande) => {
    expect(await (await surIface()).executeCommand(commande))
      .not.toContain('Invalid input');
  });
});

describe('les bornes physiques sont celles d\'IOS, refusees au caret', () => {
  it.each([
    'bandwidth 0',
    'bandwidth 10000001',
    'delay 0',
    'delay 16777216',
    'duplex zorglub',
    'mtu abc',
  ])('`%s` est refuse au caret', async (commande) => {
    expect(await (await surIface()).executeCommand(commande))
      .toContain('Invalid input detected');
  });
});
