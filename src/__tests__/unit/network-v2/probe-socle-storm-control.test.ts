/**
 * Un pourcentage de trafic vaut entre zero et cent, et une tempete a
 * TROIS sortes.
 *
 * Sonde ecrite AVANT lecture du gestionnaire, contre la reference IOS :
 *
 *   storm-control {broadcast | multicast | unicast} level
 *       { <niveau haut> [<niveau bas>]
 *       | bps <debit> [<debit bas>]
 *       | pps <paquets/s> [<bas>] }
 *   storm-control action {shutdown | trap}
 *
 * Les sortes de trafic sont TROIS et l'action DEUX : ce sont des
 * ensembles fermes. Un `level` est un POURCENTAGE, donc il ne descend pas
 * sous zero et ne monte pas au-dessus de cent — c'est de l'arithmetique,
 * pas une table de constructeur.
 *
 * Mesure de depart sur un commutateur Catalyst, en relisant la
 * configuration :
 *
 *   storm-control broadcast level zorglub   -> ACCEPTE
 *   storm-control multicast level 250       -> ACCEPTE, rendu tel quel
 *   storm-control unicast level -5          -> ACCEPTE, rendu tel quel
 *   storm-control zorglub level 50          -> ACCEPTE, rendu tel quel
 *   storm-control broadcast level pps zorglub -> ACCEPTE, rendu tel quel
 *   storm-control action zorglub            -> ACCEPTE, rendu tel quel
 *
 * Six saisies impossibles sur six. Rien n'est juge : ni la sorte de
 * trafic, ni les bornes du pourcentage, ni le mot de l'action. Et
 * `show storm-control` affiche `NaN%` dans la colonne `Lower` pour la
 * premiere.
 *
 * La consequence depasse l'affichage : la configuration rendue est
 * REJOUEE a l'import d'une topologie, donc une interface revient avec une
 * `storm-control zorglub level 50` qu'aucune machine ne sait relire, et
 * un seuil de 250 % ou de -5 % qui ne peut declencher ni jamais ni
 * toujours — c'est-a-dire une protection contre les tempetes qui n'en est
 * pas une, sans un mot pour le dire.
 *
 * Discrimine par `git stash` sur les deux fichiers cables : 17 des 27 cas
 * tombent avant correctif. Les 10 autres sont nommes ici :
 *
 *   - les cinq `level` dans les bornes et les deux actions justes : ils
 *     etaient DEJA acceptes et rendus tels quels — le sac de texte
 *     acceptait tout, donc il acceptait aussi le juste. Ce sont les
 *     TEMOINS, et sans eux un correctif qui refuserait TOUT satisferait
 *     la sonde ;
 *   - `storm-control broadcast level pps 1000` accepte et relu : meme
 *     raison, et il borne le refus ajoute sur la forme `pps` ;
 *   - `show storm-control` qui decrit un seuil pose : la vue existait et
 *     lisait les vrais seuils, c'est le NaN de sa colonne basse qui etait
 *     le defaut ;
 *   - « un port sans seuil ne rend AUCUNE ligne » : rien n'etait pose,
 *     donc l'absence etait vraie sans rien prouver.
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

type Dev = { executeCommand(c: string): Promise<string> };

const commutateur = (n: string) => new CiscoSwitch('switch-cisco', n) as unknown as Dev;

async function surLePort(d: Dev, ...cmds: string[]): Promise<string> {
  let last = '';
  for (const c of ['enable', 'configure terminal',
    'interface GigabitEthernet0/1', ...cmds]) {
    last = String(await d.executeCommand(c));
  }
  return last;
}

async function config(d: Dev): Promise<string> {
  await d.executeCommand('end');
  const cfg = String(await d.executeCommand('show running-config'));
  await d.executeCommand('configure terminal');
  return cfg;
}

async function vue(d: Dev): Promise<string> {
  await d.executeCommand('end');
  return String(await d.executeCommand('show storm-control'));
}

describe('une sorte de trafic qui n existe pas est refusee', () => {
  const INVENTEES = ['zorglub', 'anycast', 'bcast'];

  it.each(INVENTEES)('`storm-control %s level 50` est refuse', async (sorte) => {
    const d = commutateur(`S${INVENTEES.indexOf(sorte)}`);
    expect(await surLePort(d, `storm-control ${sorte} level 50`)).toContain('%');
  });

  it('et rien n en reste dans la configuration', async () => {
    const d = commutateur('SR');
    await surLePort(d, ...INVENTEES.map((s) => `storm-control ${s} level 50`));
    for (const sorte of INVENTEES) {
      expect(await config(d), sorte).not.toContain(`storm-control ${sorte}`);
    }
  });
});

describe('un pourcentage vaut entre zero et cent', () => {
  const HORS_BORNES = [
    'storm-control broadcast level 250',
    'storm-control multicast level -5',
    'storm-control unicast level 100.01',
    'storm-control broadcast level zorglub',
    'storm-control broadcast level 50 250',
  ];

  it.each(HORS_BORNES)('`%s` est refuse', async (cmd) => {
    const d = commutateur(`P${HORS_BORNES.indexOf(cmd)}`);
    expect(await surLePort(d, cmd)).toContain('%');
  });

  const DANS_BORNES = [
    'storm-control broadcast level 50.00',
    'storm-control multicast level 30',
    'storm-control unicast level 100',
    'storm-control broadcast level 0',
    'storm-control broadcast level 80 60',
  ];

  it.each(DANS_BORNES)('`%s` est accepte et RELU', async (cmd) => {
    const d = commutateur(`B${DANS_BORNES.indexOf(cmd)}`);
    expect(await surLePort(d, cmd)).not.toContain('%');
    expect(await config(d)).toContain(cmd);
  });
});

describe('les formes `pps` et `bps` veulent un nombre', () => {
  const MAUVAISES = [
    'storm-control broadcast level pps zorglub',
    'storm-control broadcast level bps zorglub',
    'storm-control broadcast level pps -1',
  ];

  it.each(MAUVAISES)('`%s` est refuse', async (cmd) => {
    const d = commutateur(`R${MAUVAISES.indexOf(cmd)}`);
    expect(await surLePort(d, cmd)).toContain('%');
  });

  it('`storm-control broadcast level pps 1000` est accepte et RELU', async () => {
    const d = commutateur('RO');
    expect(await surLePort(d, 'storm-control broadcast level pps 1000')).not.toContain('%');
    expect(await config(d)).toContain('storm-control broadcast level pps 1000');
  });
});

describe('une action a deux mots, et pas un de plus', () => {
  it.each(['zorglub', 'reload', 'drop'])('`storm-control action %s` est refuse', async (mot) => {
    const d = commutateur(`A${mot}`);
    expect(await surLePort(d, `storm-control action ${mot}`)).toContain('%');
  });

  it.each(['shutdown', 'trap'])('`storm-control action %s` est accepte et RELU', async (mot) => {
    const d = commutateur(`AO${mot}`);
    expect(await surLePort(d, `storm-control action ${mot}`)).not.toContain('%');
    expect(await config(d)).toContain(`storm-control action ${mot}`);
  });
});

describe('la vue ne contient JAMAIS `NaN`', () => {
  it('meme apres les saisies fautives', async () => {
    const d = commutateur('NAN');
    await surLePort(d,
      'storm-control broadcast level zorglub',
      'storm-control multicast level 250',
      'storm-control unicast level -5');
    expect(await vue(d)).not.toContain('NaN');
  });
});

describe('non-regression — ce que la famille faisait deja', () => {
  it('`show storm-control` decrit toujours un seuil pose', async () => {
    const d = commutateur('XA');
    await surLePort(d, 'storm-control broadcast level 50.00');
    const texte = await vue(d);
    expect(texte).toContain('Gi0/1');
    expect(texte).toContain('50.00%');
  });

  it('`no storm-control broadcast level` retire toujours', async () => {
    const d = commutateur('XB');
    await surLePort(d, 'storm-control broadcast level 50.00',
      'no storm-control broadcast level');
    expect(await config(d)).not.toContain('storm-control broadcast level');
  });

  it('et un port sans seuil ne rend AUCUNE ligne', async () => {
    const d = commutateur('XC');
    await surLePort(d);
    expect(await config(d)).not.toContain('storm-control');
  });
});
