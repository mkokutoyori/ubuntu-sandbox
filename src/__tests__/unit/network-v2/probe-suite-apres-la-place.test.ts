/**
 * Ecrit A L'AVEUGLE depuis le contrat du socle, avant toute lecture du
 * moteur de completion.
 *
 * Une commande peut declarer un mot-cle APRES sa place d'argument :
 * `show ip sla statistics <n> details` et `show traffic-shape <iface>
 * statistics` sont deux formes reelles d'IOS, et le socle les declare
 * toutes les deux de la meme facon — une suite `afterArguments`, dont le
 * chemin est `[...mots, place, mot-cle]`.
 *
 * Le contrat tient en une phrase : ce que la machine EXECUTE, `?`
 * l'ANNONCE. Une suite declaree apres une place doit donc etre offerte
 * une fois la place remplie, exactement comme elle l'est avant.
 *
 * DEFAUT MESURE qui a motive cette sonde : la moitie du contrat manque.
 *
 *     show traffic-shape GigabitEthernet0/0 ?   ->  statistics   (bon)
 *     show ip sla statistics 1 ?                ->  <cr> seul    (mauvais)
 *
 * Les deux commandes declarent leurs suites de la meme facon et portent
 * une place `REST`. Ce qui repond pour la premiere est le NOEUD que le
 * trie lui garde encore, avec les enfants `_hintOnly` que
 * `declareContinuations` y pose ; la seconde est migree, donc son noeud
 * est elague, et le socle ne repond pas a sa place. C'est ce qui BLOQUE
 * la migration de `show interfaces`, dont les six suites
 * (`accounting`, `stats`, `rate-limit`, `summary`, `switchport`,
 * `etherchannel`) s'executeraient sans etre annoncees.
 *
 * La sonde garde donc les DEUX moitiés : ce qui est annonce s'execute,
 * et ce qui s'execute est annonce.
 *
 * PREMISSE CORRIGEE PAR LA MESURE. La premiere version comptait
 * `show ip eigrp neighbors <iface>` et `show ip eigrp topology <prefixe>`
 * parmi les cas. Elles ne relevent pas de ce lot : mesure faite, ces
 * deux commandes ne declarent AUCUNE place — `show ip eigrp neighbors ?`
 * n'offre que `detail` et `<cr>` — si bien que `?` repond
 * `% Invalid input` a un argument que la commande EXECUTE pourtant sans
 * broncher. C'est un defaut reel, mais l'inverse de celui-ci : ici une
 * place manque, la une suite manquait derriere une place. Il est inscrit
 * au `TODO.md` plutot que melange, parce que le fermer demande de
 * mesurer ce que ces deux commandes acceptent vraiment.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

interface Dev {
  executeCommand(command: string): Promise<string>;
  cliHelp(input: string): string;
}

const MOT = /^\s{2}(\S+)/;

const offerts = (t: string): string[] =>
  t.includes('Invalid input') ? []
    : t.split('\n').map((l) => MOT.exec(l)?.[1]).filter((x): x is string => !!x);

let serie = 0;

async function routeur(prelude: readonly string[] = []): Promise<Dev> {
  const r = new CiscoRouter(`D${serie++}`) as unknown as Dev;
  await r.executeCommand('enable');
  for (const c of prelude) await r.executeCommand(c);
  return r;
}

/**
 * Le TEMOIN. `show traffic-shape` garde un noeud dans le trie, donc il
 * repond deja ; sans lui, une sonde faite seulement de cas rouges ne
 * distinguerait pas « le socle ne sait pas faire » de « la question est
 * mal posee ».
 */
describe('TEMOIN — une suite apres la place est offerte quand le trie la porte', () => {
  it('`show traffic-shape <iface> ?` annonce `statistics`', async () => {
    const r = await routeur();

    expect(offerts(r.cliHelp('show traffic-shape GigabitEthernet0/0 ')))
      .toContain('statistics');
  });
});

describe('une suite declaree apres la place est OFFERTE', () => {
  const CAS: ReadonlyArray<[string, string, readonly string[]]> = [
    ['show ip sla statistics', 'show ip sla statistics 1 ', ['aggregated', 'details']],
    ['show ip igmp groups', 'show ip igmp groups 224.0.0.9 ', ['detail']],
  ];

  for (const [nom, frappe, mots] of CAS) {
    it(`\`${nom}\` — ${mots.join(', ')}`, async () => {
      const r = await routeur();
      const o = offerts(r.cliHelp(frappe));

      for (const mot of mots) expect(o, mot).toContain(mot);
    });
  }

  it('et `<cr>` reste offert, la place etant facultative', async () => {
    const r = await routeur();

    expect(offerts(r.cliHelp('show ip sla statistics 1 '))).toContain('<cr>');
  });
});

describe('ce qui est offert s EXECUTE', () => {
  const FORMES = [
    'show ip sla statistics 1 details',
    'show ip sla statistics 1 aggregated',
    'show traffic-shape GigabitEthernet0/0 statistics',
  ];

  for (const forme of FORMES) {
    it(`\`${forme}\``, async () => {
      const r = await routeur();

      expect(await r.executeCommand(forme)).not.toContain('Invalid input');
    });
  }
});

describe('la place seule reste servie', () => {
  it('sans suite, la commande repond toujours', async () => {
    const r = await routeur();

    expect(await r.executeCommand('show ip sla statistics 1'))
      .not.toContain('Invalid input');
  });

  it('et la suite offerte AVANT la place l est encore', async () => {
    const r = await routeur();
    const o = offerts(r.cliHelp('show ip sla statistics '));

    expect(o).toContain('aggregated');
    expect(o).toContain('details');
  });
});

/**
 * Le garde-fou : aucune suite declaree ne doit disparaitre une fois la
 * place remplie. Il reparcourt les commandes qui portent A LA FOIS une
 * place et des suites, plutot que de nommer trois cas et d'esperer.
 */
describe('GARDE-FOU — aucune suite ne disparait derriere sa place', () => {
  const AVEC_PLACE: ReadonlyArray<[string, string]> = [
    ['show ip sla statistics', '1'],
    ['show ip igmp groups', '224.0.0.9'],
    ['show traffic-shape', 'GigabitEthernet0/0'],
  ];

  it('ce que `?` annonce avant la place, il l annonce apres', async () => {
    const r = await routeur();
    const manquants: string[] = [];

    for (const [chemin, valeur] of AVEC_PLACE) {
      const avant = offerts(r.cliHelp(`${chemin} `)).filter(m => m !== '<cr>' && /^[a-z-]+$/.test(m));
      if (avant.length === 0) continue;
      const apres = offerts(r.cliHelp(`${chemin} ${valeur} `));
      for (const mot of avant) {
        if (!apres.includes(mot)) manquants.push(`${chemin} ${valeur} ? — ${mot}`);
      }
    }

    expect(manquants).toEqual([]);
  });
});
