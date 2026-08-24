import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { MACAddress, resetCounters } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { CommandTrie } from '@/network/devices/shells/CommandTrie';

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

async function dans(entree: readonly string[]): Promise<Cli> {
  const device = nu();
  for (const c of ['enable', 'configure terminal', ...entree]) {
    await device.executeCommand(c);
  }
  return device;
}

const RIP = ['router rip'];
const EIGRP = ['router eigrp 100'];
const BGP = ['router bgp 65000'];

describe('configRouterTrie est VIDE', () => {
  it('ne porte plus aucun chemin', () => {
    const shell = (nu() as unknown as { shell: Record<string, unknown> }).shell;
    expect((shell.configRouterTrie as CommandTrie).enumerateExecutablePaths())
      .toEqual([]);
  });
});

const REGLAGES: ReadonlyArray<readonly [readonly string[], string]> = [
  [RIP, 'version 2'],
  [RIP, 'version 1'],
  [RIP, 'no version'],
  [RIP, 'network 10.0.0.0'],
  [RIP, 'no network 10.0.0.0'],
  [RIP, 'auto-summary'],
  [RIP, 'no auto-summary'],
  [RIP, 'passive-interface GigabitEthernet0/0'],
  [RIP, 'no passive-interface GigabitEthernet0/0'],
  [RIP, 'redistribute static'],
  [RIP, 'redistribute connected metric 5'],
  [RIP, 'no redistribute static'],
  [RIP, 'default-information originate'],
  [RIP, 'no default-information originate'],
  [RIP, 'default-metric 5'],
  [RIP, 'distance 120'],
  [RIP, 'no distance'],
  [RIP, 'timers basic 30 180 180 240'],
  [RIP, 'no timers basic'],
  [RIP, 'maximum-paths 4'],
  [RIP, 'no maximum-paths'],
  [RIP, 'neighbor 10.0.0.2'],
  [RIP, 'offset-list 0 in 2 GigabitEthernet0/0'],
  [RIP, 'output-delay 10'],
  [RIP, 'flash-update-threshold 10'],
  [RIP, 'validate-update-source'],
  [RIP, 'no validate-update-source'],
  [RIP, 'distribute-list 10 in'],
  [EIGRP, 'network 10.0.0.0 0.0.0.255'],
  [EIGRP, 'eigrp router-id 1.1.1.1'],
  [EIGRP, 'eigrp stub connected'],
  [EIGRP, 'no eigrp router-id'],
  [EIGRP, 'variance 2'],
  [EIGRP, 'metric weights 0 1 0 1 0 0'],
  [EIGRP, 'traffic-share balanced'],
  [EIGRP, 'passive-interface default'],
  [EIGRP, 'maximum-paths 6'],
  [EIGRP, 'redistribute static'],
  [BGP, 'router-id 2.2.2.2'],
  [BGP, 'neighbor 10.0.0.2 remote-as 65001'],
  [BGP, 'neighbor 10.0.0.2 description le pair du sud'],
  [BGP, 'no neighbor 10.0.0.2'],
  [BGP, 'neighbor IBGP peer-group'],
  [BGP, 'neighbor 10.0.0.2 update-source Loopback0'],
  [BGP, 'neighbor 10.0.0.2 weight 100'],
  [BGP, 'bgp log-neighbor-changes'],
  [BGP, 'bgp default local-preference 200'],
  [EIGRP, 'metric maximum-hops 50'],
  [BGP, 'neighbor 10.0.0.2 next-hop-self'],
  [BGP, 'neighbor 10.0.0.2 route-reflector-client'],
  [BGP, 'neighbor 10.0.0.2 ebgp-multihop 2'],
  [BGP, 'neighbor 10.0.0.2 password CiscoBGP'],
  [BGP, 'neighbor 10.0.0.2 prefix-list PL1 out'],
  [BGP, 'neighbor 10.0.0.2 soft-reconfiguration inbound'],
  [BGP, 'neighbor 10.0.0.2 maximum-prefix 1000 80'],
  [BGP, 'bgp bestpath compare-routerid'],
  [BGP, 'bgp deterministic-med'],
  [BGP, 'network 10.0.0.0 mask 255.255.255.0'],
  [BGP, 'aggregate-address 10.0.0.0 255.0.0.0 summary-only'],
  [BGP, 'bgp router-id 3.3.3.3'],
  [BGP, 'no bgp default ipv4-unicast'],
  [BGP, 'address-family ipv4'],
  [BGP, 'synchronization'],
  [BGP, 'no synchronization'],
];

describe('chaque reglage reste accepte apres la migration', () => {
  it.each(REGLAGES)('%s › `%s`', async (entree, commande) => {
    expect(await (await dans(entree)).executeCommand(commande))
      .not.toContain('Invalid input');
  });
});

describe('un mot-cle n\'existe QUE pour le protocole a qui il appartient', () => {
  const ETRANGERS: ReadonlyArray<readonly [readonly string[], string]> = [
    [RIP, 'variance 2'],
    [RIP, 'aggregate-address 10.0.0.0 255.0.0.0'],
    [RIP, 'redistribute rip'],
    [RIP, 'redistribute isis'],
    [RIP, 'synchronization'],
    [RIP, 'metric 5'],
    [RIP, 'metric weights 0 1 0 1 0 0'],
    [RIP, 'address-family ipv4'],
    [EIGRP, 'version 2'],
    [EIGRP, 'aggregate-address 10.0.0.0 255.0.0.0'],
    [EIGRP, 'output-delay 10'],
    [BGP, 'version 2'],
    [BGP, 'auto-summary'],
    [BGP, 'variance 2'],
    [BGP, 'passive-interface GigabitEthernet0/0'],
  ];

  it.each(ETRANGERS)('%s › `%s` est refuse', async (entree, commande) => {
    expect(await (await dans(entree)).executeCommand(commande))
      .toContain('Invalid input');
  });

  /*
   * Le mot-cle se lit en TETE de ligne et non n'importe ou dans le
   * texte : une description contient le mot d'une autre commande —
   * `no` s'annonce « Restore default version control » — et une
   * recherche de sous-chaine ferait passer une aide juste pour fausse,
   * ou l'inverse.
   */
  const motsProposes = (aide: string): string[] =>
    aide.split('\n').map(l => l.trim().split(/\s+/)[0]).filter(Boolean);

  it('`?` ne propose pas ce que la meme machine refuserait', async () => {
    const rip = motsProposes((await dans(RIP)).cliHelp(''));
    expect(rip).toContain('version');
    expect(rip).not.toContain('aggregate-address');
    expect(rip).not.toContain('variance');

    const bgp = motsProposes((await dans(BGP)).cliHelp(''));
    expect(bgp).toContain('aggregate-address');
    expect(bgp).not.toContain('version');
    expect(bgp).not.toContain('auto-summary');

    const eigrp = motsProposes((await dans(EIGRP)).cliHelp(''));
    expect(eigrp).toContain('variance');
    expect(eigrp).not.toContain('aggregate-address');
  });

  it('`no ?` ne propose que ce que CE protocole peut nier', async () => {
    const bgp = (await dans(BGP)).cliHelp('no ');
    expect(bgp).not.toContain('version');
    expect(bgp).toContain('neighbor');

    const rip = (await dans(RIP)).cliHelp('no ');
    expect(rip).toContain('version');
    expect(rip).not.toContain('aggregate-address');
  });

  it('`no` porte son propre nom et non celui de son premier enfant', async () => {
    for (const entree of [RIP, EIGRP, BGP]) {
      const ligne = (await dans(entree)).cliHelp('')
        .split('\n').find(l => l.trim().startsWith('no '));
      expect(ligne).toContain('Negate a command');
    }
  });

  it('la tabulation suit la meme regle que l\'aide', async () => {
    expect((await dans(RIP)).cliTabCandidates('vari')).toEqual([]);
    expect((await dans(EIGRP)).cliTabCandidates('vari')).toEqual(['variance']);
  });

  /*
   * Le domaine d'une source de redistribution DEPEND du protocole : on
   * ne redistribue pas RIP dans RIP, et ce simulateur n'a pas de moteur
   * IS-IS. Les deux mots existent pourtant sous EIGRP et sous BGP, donc
   * les retirer partout serait aussi faux que les proposer partout.
   */
  it('`redistribute ?` n\'offre que les sources que CE protocole accepte', async () => {
    const rip = motsProposes((await dans(RIP)).cliHelp('redistribute '));
    expect(rip).toContain('connected');
    expect(rip).toContain('ospf');
    expect(rip).not.toContain('rip');
    expect(rip).not.toContain('isis');

    for (const entree of [EIGRP, BGP]) {
      const autre = motsProposes((await dans(entree)).cliHelp('redistribute '));
      expect(autre).toContain('rip');
      expect(autre).toContain('isis');
    }
  });

  /*
   * NOMMER n'est pas RESTREINDRE, et confondre les deux est la facon la
   * plus discrete de casser une commande en la documentant : `?` doit
   * annoncer les formes connues sans refuser celles que le gestionnaire
   * range en l'etat. Un pair BGP en porte des dizaines, et sous RIP
   * `metric` prend un simple nombre.
   */
  it('une place qui NOMME ses formes accepte quand meme le reste', async () => {
    const aide = motsProposes((await dans(BGP)).cliHelp('neighbor 10.0.0.2 '));
    expect(aide).toContain('remote-as');
    expect(aide).not.toContain('next-hop-self');

    const device = await dans(BGP);
    expect(await device.executeCommand('neighbor 10.0.0.2 next-hop-self'))
      .not.toContain('Invalid input');
  });

  /*
   * `metric` appartient a EIGRP dans la table de propriete, et le
   * gestionnaire portait pourtant une branche RIP : les deux se
   * contredisaient, sans consequence tant que le filtre ne gouvernait
   * que l'AIDE. Il gouverne maintenant l'execution, donc la
   * contradiction se tranche — en faveur de la table, parce qu'un vrai
   * `router rip` n'a pas de commande `metric` (la metrique RIP se regle
   * par `default-metric` ou par un `offset-list`).
   */
  it('`metric` est d\'EIGRP, et le gestionnaire disait le contraire', async () => {
    expect(await (await dans(EIGRP)).executeCommand('metric weights 0 1 0 1 0 0'))
      .not.toContain('Invalid input');
    expect(await (await dans(RIP)).executeCommand('default-metric 5'))
      .not.toContain('Invalid input');
  });

  it('un mot-cle sans proprietaire appartient aux trois', async () => {
    for (const entree of [RIP, EIGRP, BGP]) {
      expect((await dans(entree)).cliHelp('')).toContain('redistribute');
    }
  });
});

describe('le reglage atteint son moteur', () => {
  it('la version RIP ressort dans la configuration', async () => {
    const device = await dans(RIP);
    await device.executeCommand('version 2');
    await device.executeCommand('network 10.0.0.0');
    await device.executeCommand('end');
    const vue = await device.executeCommand('show running-config');
    expect(vue).toContain('version 2');
    expect(vue).toContain('network 10.0.0.0');
  });

  it('le pair BGP garde son AS distant', async () => {
    const device = await dans(BGP);
    await device.executeCommand('neighbor 10.0.0.2 remote-as 65001');
    await device.executeCommand('end');
    expect(await device.executeCommand('show running-config'))
      .toContain('remote-as 65001');
  });

  /*
   * Un gabarit se DECLARE avant d'etre regle, et les deux commandes se
   * tapent sur la meme machine : un cas par appareil neuf ne pourrait
   * pas le montrer, et son refus ressemblerait a un defaut.
   */
  it('un peer-group porte un NOM, et se regle apres avoir ete declare', async () => {
    const device = await dans(BGP);
    expect(await device.executeCommand('neighbor IBGP peer-group'))
      .not.toContain('Invalid input');
    expect(await device.executeCommand('neighbor IBGP remote-as 65000'))
      .not.toContain('Invalid input');
    await device.executeCommand('end');
    expect(await device.executeCommand('show running-config')).toContain('IBGP');
  });

  /*
   * Deux refus voisins et distincts, et les confondre ferait passer un
   * message pour l'autre : un NOM qui ne designe aucun gabarit n'est pas
   * un voisin (une adresse en serait un), tandis qu'une ADRESSE qui
   * rejoint un gabarit inexistant recoit le message d'IOS qui nomme ce
   * qui manque.
   */
  it('un nom qui ne designe aucun gabarit n\'est pas un voisin', async () => {
    expect(await (await dans(BGP)).executeCommand('neighbor ABSENT remote-as 65000'))
      .toContain('Invalid input');
  });

  it('rejoindre un gabarit jamais declare est refuse, en le nommant', async () => {
    expect(await (await dans(BGP)).executeCommand('neighbor 10.0.0.2 peer-group ABSENT'))
      .toContain('Configure the peer-group ABSENT first');
  });

  it('le router-id EIGRP est retenu', async () => {
    const device = await dans(EIGRP);
    await device.executeCommand('eigrp router-id 1.1.1.1');
    await device.executeCommand('end');
    expect(await device.executeCommand('show running-config'))
      .toContain('1.1.1.1');
  });
});

describe('`?` nomme la place au lieu d\'un mot muet', () => {
  const ATTENDU: ReadonlyArray<readonly [readonly string[], string, string]> = [
    [RIP, 'network ', 'Network number'],
    [RIP, 'redistribute ', 'Connected routes'],
    [RIP, 'distance ', '<1-255>'],
    [RIP, 'maximum-paths ', '<1-32>'],
    [RIP, 'neighbor ', 'Neighbour address'],
    [RIP, 'passive-interface ', 'Every interface, unless listed otherwise'],
    [EIGRP, 'variance ', '<1-128>'],
    [EIGRP, 'eigrp ', 'Make this router an EIGRP stub'],
    [EIGRP, 'eigrp router-id ', 'A.B.C.D'],
    [BGP, 'router-id ', 'A.B.C.D'],
    [BGP, 'address-family ', 'IPv4 address family'],
    [BGP, 'aggregate-address ', 'Aggregate address'],
    [BGP, 'neighbor ', 'Neighbour address, or the name of a peer-group'],
    [BGP, 'neighbor 10.0.0.2 ', 'Autonomous system number of the neighbour'],
    [BGP, 'bgp ', 'Router identifier of this BGP process'],
    [EIGRP, 'metric ', 'Coefficients of the composite metric'],
  ];

  it.each(ATTENDU)('%s › `%s?` annonce %s', async (entree, saisie, attendu) => {
    expect((await dans(entree)).cliHelp(saisie)).toContain(attendu);
  });

  it.each([
    [RIP, 'maximum-paths 40'],
    [RIP, 'distance 300'],
    [EIGRP, 'variance 200'],
    [RIP, 'redistribute zorglub'],
    [BGP, 'router-id pas-une-adresse'],
  ] as ReadonlyArray<readonly [readonly string[], string]>)(
    '%s › `%s` est refuse', async (entree, commande) => {
      expect(await (await dans(entree)).executeCommand(commande))
        .toContain('Invalid input');
    });
});
