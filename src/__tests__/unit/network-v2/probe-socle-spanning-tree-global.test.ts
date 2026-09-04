/**
 * La famille `spanning-tree` GLOBALE passe au socle.
 *
 * Sonde ecrite contre la reference Catalyst, avant lecture du
 * gestionnaire :
 *
 *   spanning-tree mode { pvst | rapid-pvst | mst }
 *   spanning-tree extend system-id
 *   spanning-tree portfast default
 *   spanning-tree portfast { bpduguard | bpdufilter } default
 *   spanning-tree loopguard default
 *   spanning-tree pathcost method { long | short }
 *   spanning-tree backbonefast
 *   spanning-tree uplinkfast [ max-update-rate <0-32000> ]
 *   spanning-tree priority <0-61440>
 *   spanning-tree vlan <liste> [ forward-time <4-30> | hello-time <1-10>
 *                              | max-age <6-40> | priority <0-61440>
 *                              | root { primary | secondary } ]
 *   spanning-tree mst <instance> priority <0-61440>
 *
 * POURQUOI CETTE FAMILLE PLUTOT QU'UNE AUTRE. Le releve des chemins
 * encore portes par le trie donne `spanning-tree` en tete de ce que le
 * commutateur n'a pas migre, et c'est aussi la famille dont le lot
 * precedent a du declarer l'aide a la main faute de noeuds : onze
 * mots-cles sont AVALES par un unique gestionnaire glouton, donc aucun
 * ne porte sa place, son refus ni son aide. Declarer autour d'eux les
 * rend justes un par un ; les MIGRER les rend justes d'un seul tenant,
 * parce qu'une commande du socle porte les trois ensemble.
 *
 * CE QUE LA MESURE A TROUVE, et qui n'est pas de l'aide :
 *
 *   spanning-tree priority 100        -> ACCEPTE (IOS exige un multiple
 *                                       de 4096 et le DIT)
 *   spanning-tree vlan 10 hello-time 99 -> ACCEPTE (plage reelle 1-10)
 *   spanning-tree vlan 10 max-age 1   -> ACCEPTE (plage reelle 6-40)
 *   spanning-tree vlan 10 forward-time 99 -> ACCEPTE (plage reelle 4-30)
 *   spanning-tree vlan 10 zorglub 5   -> ACCEPTE, ne fait rien
 *   spanning-tree mst 0 priority 100  -> ACCEPTE
 *
 * Une valeur hors plage acceptee n'est pas un detail d'affichage : elle
 * est POSEE sur l'agent, rendue par la configuration, rejouee a l'import
 * d'une topologie, et un `hello-time` de 99 secondes decrit un arbre que
 * le protocole ne peut pas produire.
 *
 * CE QUE CETTE SONDE NE DEMANDE DELIBEREMENT PAS : que `spanning-tree
 * priority` disparaisse du mode GLOBAL. Un vrai Catalyst ne connait
 * cette forme que sous `vlan <n>`, mais des laboratoires du depot s'en
 * servent et la retirer est un changement de comportement a mesurer pour
 * lui-meme — c'est deja inscrit au `TODO.md`. La sonde exige seulement
 * qu'elle applique la plage qu'elle annonce.
 *
 * DEUX PREMISSES DE CETTE SONDE ETAIENT FAUSSES, corrigees dans la sonde
 * et non dans le code. (1) Elle observait `show spanning-tree vlan 10`
 * apres `root primary` sur un commutateur ou le VLAN 10 n'existe pas :
 * la machine repond « Spanning tree instance(s) for vlan 10 do not
 * exist. », ce qu'un vrai Catalyst repond aussi, donc c'est le
 * laboratoire qui etait faux ; elle lit desormais la configuration, ou
 * `root primary` doit paraitre sous la forme qu'il CALCULE, `priority
 * 24576`. (2) Elle exigeait que `no spanning-tree mode` fasse
 * DISPARAITRE la ligne, tenant le mode par defaut pour tacite. La
 * mesure montre que la machine rend `spanning-tree mode pvst`, et la
 * documentation Cisco qui trancherait — un vrai Catalyst ecrit-il cette
 * ligne dans sa configuration d'usine ? — n'est pas atteignable depuis
 * ce reseau (`cisco.com` est refuse par le mandataire de sortie). La
 * sonde observe donc le COMPORTEMENT, le retour a PVST+, et la question
 * de la tacite est inscrite au `TODO.md` plutot que tranchee de
 * memoire.
 *
 * Discrimine par `git stash` sur les cinq fichiers cables : 8 des 62
 * cas tombent avant migration — les trois formes `spanning-tree mst
 * <n> priority`, servies par un second glouton qui ne validait rien, et
 * les cinq places dont l'aide reproposait les soeurs du mot-cle. Les 54
 * autres passent des deux cotes, et c'est le RESULTAT ATTENDU d'une
 * migration : `refusReglageStpGlobal` faisait deja correctement le
 * travail que les places declarees font maintenant, et une migration
 * qui changerait ce que la machine repond ne serait pas une migration.
 * Ce qu'ils gardent est exactement cela — qu'aucune des vingt-six
 * formes de la famille n'ait change de reponse en changeant de moteur.
 * Une seule reponse a change, et elle est nommee dans
 * `probe-aide-du-mot-cle-absorbe.test.ts` : `spanning-tree portfast ?`
 * n'annonce plus `<cr>` pour une frappe que la machine declare
 * incomplete.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { MACAddress, resetCounters } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  EquipmentRegistry.resetInstance();
  Logger.clear();
});

type Dev = {
  executeCommand(c: string): Promise<string>;
  cliHelp(s: string): string;
};

async function commutateur(n: string): Promise<Dev> {
  const d = new CiscoSwitch('switch-cisco', n) as unknown as Dev;
  for (const c of ['enable', 'configure terminal']) await d.executeCommand(c);
  return d;
}

async function config(d: Dev): Promise<string> {
  await d.executeCommand('end');
  const cfg = String(await d.executeCommand('show running-config'));
  await d.executeCommand('configure terminal');
  return cfg;
}

function mots(aide: string): string[] {
  return aide.split('\n').map((l) => l.trim().split(/\s+/)[0] ?? '')
    .filter((m) => m.length > 0);
}

const cle = (s: string) => s.replace(/\W/g, '');

describe('une plage annoncee par cette famille est APPLIQUEE', () => {
  const HORS_PLAGE: readonly string[] = [
    'spanning-tree vlan 10 hello-time 0',
    'spanning-tree vlan 10 hello-time 11',
    'spanning-tree vlan 10 max-age 5',
    'spanning-tree vlan 10 max-age 41',
    'spanning-tree vlan 10 forward-time 3',
    'spanning-tree vlan 10 forward-time 31',
    'spanning-tree vlan 10 priority 61441',
    'spanning-tree priority 61441',
    'spanning-tree mst 0 priority 61441',
  ];

  it.each(HORS_PLAGE)('`%s` est refuse', async (ligne) => {
    const d = await commutateur(`A${cle(ligne)}`);
    expect(String(await d.executeCommand(ligne))).toContain('%');
  });

  const DANS_PLAGE: readonly string[] = [
    'spanning-tree vlan 10 hello-time 1',
    'spanning-tree vlan 10 hello-time 10',
    'spanning-tree vlan 10 max-age 6',
    'spanning-tree vlan 10 max-age 40',
    'spanning-tree vlan 10 forward-time 4',
    'spanning-tree vlan 10 forward-time 30',
    'spanning-tree vlan 10 priority 4096',
    'spanning-tree priority 61440',
    'spanning-tree mst 0 priority 32768',
  ];

  it.each(DANS_PLAGE)('`%s` reste accepte', async (ligne) => {
    const d = await commutateur(`B${cle(ligne)}`);
    expect(String(await d.executeCommand(ligne))).not.toContain('%');
  });
});

describe('une priorite de pont est un multiple de 4096', () => {
  it.each(['spanning-tree priority 100', 'spanning-tree vlan 10 priority 100',
    'spanning-tree mst 0 priority 100'])(
    '`%s` est refuse en le DISANT', async (ligne) => {
      const d = await commutateur(`C${cle(ligne)}`);
      expect(String(await d.executeCommand(ligne))).toContain('4096');
    });

  it('et un multiple reste accepte', async () => {
    const d = await commutateur('C2');
    expect(String(await d.executeCommand('spanning-tree priority 24576')))
      .not.toContain('%');
  });
});

describe('un reglage que cette famille ne lit pas est refuse', () => {
  it.each(['spanning-tree vlan 10 zorglub 5', 'spanning-tree pathcost zorglub',
    'spanning-tree pathcost method zorglub', 'spanning-tree extend zorglub',
    'spanning-tree loopguard zorglub', 'spanning-tree portfast zorglub',
    'spanning-tree portfast bpduguard zorglub', 'spanning-tree mode zorglub',
    'spanning-tree mst 0 zorglub 100', 'spanning-tree vlan zorglub priority 4096'])(
    '`%s` est refuse', async (ligne) => {
      const d = await commutateur(`D${cle(ligne)}`);
      expect(String(await d.executeCommand(ligne))).toContain('% Invalid');
    });

  it.each(['spanning-tree vlan', 'spanning-tree priority', 'spanning-tree mode',
    'spanning-tree pathcost method', 'spanning-tree vlan 10 hello-time'])(
    '`%s` dit INCOMPLET', async (ligne) => {
      const d = await commutateur(`E${cle(ligne)}`);
      expect(String(await d.executeCommand(ligne))).toContain('% Incomplete command.');
    });

  it('et un refus ne laisse rien dans la configuration', async () => {
    const d = await commutateur('DR');
    await d.executeCommand('spanning-tree vlan 10 hello-time 99');
    await d.executeCommand('spanning-tree priority 100');
    const cfg = await config(d);
    expect(cfg).not.toContain('hello-time 99');
    expect(cfg).not.toContain('priority 100');
  });
});

describe('`?` annonce ce que chaque mot-cle prend vraiment', () => {
  it('`spanning-tree vlan 10 ?` offre les cinq reglages', async () => {
    const d = await commutateur('F1');
    expect(mots(d.cliHelp('spanning-tree vlan 10 ')).filter((m) => m !== '<cr>'))
      .toEqual(['forward-time', 'hello-time', 'max-age', 'priority', 'root']);
  });

  it('`spanning-tree pathcost ?` n offre que `method`', async () => {
    const d = await commutateur('F2');
    expect(mots(d.cliHelp('spanning-tree pathcost '))).toEqual(['method']);
  });

  it('`spanning-tree extend ?` n offre que `system-id`', async () => {
    const d = await commutateur('F3');
    expect(mots(d.cliHelp('spanning-tree extend '))).toEqual(['system-id']);
  });

  it('`spanning-tree loopguard ?` n offre que `default`', async () => {
    const d = await commutateur('F4');
    expect(mots(d.cliHelp('spanning-tree loopguard '))).toEqual(['default']);
  });

  it('`spanning-tree priority ?` annonce la plage', async () => {
    const d = await commutateur('F5');
    expect(d.cliHelp('spanning-tree priority ')).toContain('<0-61440>');
  });

  it('`spanning-tree vlan 10 hello-time ?` annonce la plage', async () => {
    const d = await commutateur('F6');
    expect(d.cliHelp('spanning-tree vlan 10 hello-time ')).toContain('<1-10>');
  });
});

describe('ce que la famille POSE est ce que la configuration relit', () => {
  const RELUES: ReadonlyArray<readonly [string, string]> = [
    ['spanning-tree mode rapid-pvst', 'spanning-tree mode rapid-pvst'],
    ['spanning-tree backbonefast', 'spanning-tree backbonefast'],
    ['spanning-tree uplinkfast max-update-rate 100',
      'spanning-tree uplinkfast max-update-rate 100'],
    ['spanning-tree portfast default', 'spanning-tree portfast default'],
    ['spanning-tree loopguard default', 'spanning-tree loopguard default'],
    ['spanning-tree pathcost method long', 'spanning-tree pathcost method long'],
    ['spanning-tree vlan 10 priority 4096', 'spanning-tree vlan 10 priority 4096'],
  ];

  it.each(RELUES)('`%s` est rendu `%s`', async (ligne, attendu) => {
    const d = await commutateur(`G${cle(ligne)}`);
    expect(String(await d.executeCommand(ligne))).not.toContain('%');
    expect(await config(d)).toContain(attendu);
  });

  it('et `spanning-tree vlan 10 root primary` pose la priorite 24576', async () => {
    const d = await commutateur('G2');
    expect(String(await d.executeCommand('spanning-tree vlan 10 root primary')))
      .not.toContain('%');
    expect(await config(d)).toContain('spanning-tree vlan 10 priority 24576');
  });
});

describe('non-regression — les negations et le reste de la famille', () => {
  it.each(['no spanning-tree portfast default', 'no spanning-tree loopguard',
    'no spanning-tree uplinkfast', 'no spanning-tree backbonefast',
    'no spanning-tree pathcost', 'no spanning-tree mode',
    'no spanning-tree vlan 10'])(
    '`%s` reste accepte', async (ligne) => {
      const d = await commutateur(`H${cle(ligne)}`);
      expect(String(await d.executeCommand(ligne))).not.toContain('%');
    });

  it('`no spanning-tree mode` revient a PVST+', async () => {
    const d = await commutateur('H2');
    await d.executeCommand('spanning-tree mode rapid-pvst');
    expect(await config(d)).toContain('spanning-tree mode rapid-pvst');
    await d.executeCommand('no spanning-tree mode');
    expect(await config(d)).toContain('spanning-tree mode pvst');
  });

  it('`spanning-tree mst configuration` entre bien dans son sous-mode', async () => {
    const d = await commutateur('H3');
    await d.executeCommand('spanning-tree mst configuration');
    expect(String(await d.executeCommand('name REGION'))).not.toContain('%');
  });

  it('et `show spanning-tree summary` decrit toujours la machine', async () => {
    const d = await commutateur('H4');
    await d.executeCommand('spanning-tree uplinkfast');
    await d.executeCommand('end');
    expect(String(await d.executeCommand('show spanning-tree summary')))
      .toContain('UplinkFast');
  });
});
