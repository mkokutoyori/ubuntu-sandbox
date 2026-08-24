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

  it('une version IGMP absurde est refusee par le gestionnaire', async () => {
    expect(await (await surIface()).executeCommand('ip igmp version 9'))
      .toContain('Invalid IGMP version');
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
