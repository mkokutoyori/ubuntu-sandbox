/**
 * `spanning-tree` — la famille la plus tapee d'un cours de commutation,
 * et celle dont les valeurs sont les plus contraintes.
 *
 * Deux contraintes d'IOS ne sont pas des bornes ordinaires et sont ici
 * le coeur de la mesure : une priorite de pont se pose par PAS de 4096,
 * et une priorite de port par pas de 16. Un simulateur qui accepte 4097
 * apprend un reglage que le materiel refuse, et l'apprenant ne
 * decouvre la regle qu'en cours d'examen.
 *
 * Ce qui est mesure : ce que la CLI accepte, ce qu'elle refuse, ce que
 * la configuration rend — elle est REJOUEE a l'import d'une topologie —
 * et que la valeur posee ATTEINT le moteur, ce que `show spanning-tree`
 * lit.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { MACAddress, resetCounters } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';

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
  getPrompt?(): string;
  getPortNames(): string[];
}

let serial = 0;

async function commutateur(...lignes: string[]): Promise<Cli> {
  const sw = new CiscoSwitch('switch-cisco', `SW${serial++}`, 8, 0, 0) as unknown as Cli;
  sw.powerOn();
  for (const c of ['enable', 'configure terminal', ...lignes]) await sw.executeCommand(c);
  return sw;
}

async function surUnPort(...lignes: string[]): Promise<Cli> {
  const sw = new CiscoSwitch('switch-cisco', `SW${serial++}`, 8, 0, 0) as unknown as Cli;
  sw.powerOn();
  for (const c of ['enable', 'configure terminal',
    `interface ${sw.getPortNames()[0]}`, ...lignes]) {
    await sw.executeCommand(c);
  }
  return sw;
}

const REFUS = /Invalid input|Incomplete command|Unrecognized|must be|Invalid/;
const refuse = (sortie: string): boolean => REFUS.test(sortie);

async function configuration(cli: Cli): Promise<string> {
  await cli.executeCommand('end');
  return cli.executeCommand('show running-config');
}

describe('le MODE de l arbre couvrant', () => {
  it.each(['pvst', 'rapid-pvst', 'mst'])('`spanning-tree mode %s` est accepte et rendu',
    async (mode) => {
      const sw = await commutateur(`spanning-tree mode ${mode}`);

      expect(await configuration(sw), mode).toContain(`spanning-tree mode ${mode}`);
    });

  it('un mode invente est refuse', async () => {
    const sw = await commutateur();

    expect(refuse(await sw.executeCommand('spanning-tree mode zorglub'))).toBe(true);
  });

  it('`spanning-tree mode ?` annonce les trois modes', async () => {
    const sw = await commutateur();
    const aide = sw.cliHelp('spanning-tree mode ');

    for (const mode of ['pvst', 'rapid-pvst', 'mst']) expect(aide, mode).toContain(mode);
  });

  it('le mode pose ATTEINT le moteur — `show spanning-tree` le lit', async () => {
    const sw = await commutateur('spanning-tree mode rapid-pvst', 'vlan 10');
    await sw.executeCommand('end');

    expect(await sw.executeCommand('show spanning-tree')).toMatch(/rstp|rapid/i);
  });
});

describe('la priorite de PONT se pose par pas de 4096', () => {
  it.each(['0', '4096', '24576', '61440'])('`spanning-tree vlan 10 priority %s` est accepte',
    async (valeur) => {
      const sw = await commutateur('vlan 10', 'exit');

      expect(refuse(await sw.executeCommand(`spanning-tree vlan 10 priority ${valeur}`)), valeur)
        .toBe(false);
    });

  /*
   * 4097 est DANS la plage annoncee et refuse quand meme : c'est une
   * contrainte de PAS et non de bornes, et c'est celle qu'un apprenant
   * decouvre le plus souvent en examen.
   */
  it.each(['4097', '1000', '30000'])('`priority %s` est refuse — ce n est pas un multiple',
    async (valeur) => {
      const sw = await commutateur('vlan 10', 'exit');
      const sortie = await sw.executeCommand(`spanning-tree vlan 10 priority ${valeur}`);

      expect(refuse(sortie), valeur).toBe(true);
      expect(sortie, valeur).toMatch(/4096/);
    });

  it('une priorite hors plage est refusee', async () => {
    const sw = await commutateur('vlan 10', 'exit');

    expect(refuse(await sw.executeCommand('spanning-tree vlan 10 priority 65536'))).toBe(true);
  });

  it('la priorite posee est RENDUE et atteint le moteur', async () => {
    const sw = await commutateur('vlan 10', 'exit', 'spanning-tree vlan 10 priority 4096');
    const cfg = await configuration(sw);

    expect(cfg).toContain('spanning-tree vlan 10 priority 4096');
    expect(await sw.executeCommand('show spanning-tree vlan 10')).toContain('4096');
  });

  /*
   * `spanning-tree vlan 10 priority ?` n'annonce PAS encore la plage :
   * la branche `vlan` reste un noeud glouton, donc l'aide y rend la
   * liste du parent. Le declarer demande un mot-cle APRES une place —
   * `vlan <liste> priority <valeur>` — et la valeur dependant du
   * mot-cle (`priority` 0-61440, `hello-time` 1-10), une declaration
   * positionnelle annoncerait une plage fausse pour les minuteries.
   * C'est la migration au socle qui le porte ; inscrit au `TODO.md`.
   *
   * Ce que la commande REFUSE est mesure plus haut et ne depend pas de
   * l'aide : c'est la moitie qui compte pour l'operateur.
   */
  it('la plage est APPLIQUEE meme quand l aide ne l annonce pas encore', async () => {
    const sw = await commutateur('vlan 10', 'exit');

    expect(refuse(await sw.executeCommand('spanning-tree vlan 10 priority 61441'))).toBe(true);
    expect(refuse(await sw.executeCommand('spanning-tree vlan 10 priority 61440'))).toBe(false);
  });
});

describe('`root primary` choisit une priorite au lieu de la faire calculer', () => {
  it('`spanning-tree vlan 10 root primary` est accepte et baisse la priorite', async () => {
    const sw = await commutateur('vlan 10', 'exit');

    expect(refuse(await sw.executeCommand('spanning-tree vlan 10 root primary'))).toBe(false);
    await sw.executeCommand('end');

    expect(await sw.executeCommand('show spanning-tree vlan 10')).toMatch(/24576|4096|8192/);
  });

  it('`root secondary` est accepte aussi', async () => {
    const sw = await commutateur('vlan 10', 'exit');

    expect(refuse(await sw.executeCommand('spanning-tree vlan 10 root secondary'))).toBe(false);
  });
});

describe('les minuteries du pont', () => {
  it.each([
    ['hello-time 2', false], ['hello-time 10', false], ['hello-time 11', true],
    ['forward-time 15', false], ['forward-time 31', true],
    ['max-age 20', false], ['max-age 41', true],
  ])('`spanning-tree vlan 10 %s` — refuse=%s', async (reglage, attenduRefuse) => {
    const sw = await commutateur('vlan 10', 'exit');
    const sortie = await sw.executeCommand(`spanning-tree vlan 10 ${reglage}`);

    expect(refuse(sortie), reglage).toBe(attenduRefuse);
  });
});

describe('ce qui vit sur le PORT', () => {
  it('`spanning-tree portfast` est accepte et rendu', async () => {
    const sw = await surUnPort('spanning-tree portfast');

    expect(await configuration(sw)).toContain('spanning-tree portfast');
  });

  it('`spanning-tree bpduguard enable` est accepte et rendu', async () => {
    const sw = await surUnPort('spanning-tree bpduguard enable');

    expect(await configuration(sw)).toContain('spanning-tree bpduguard enable');
  });

  it('`spanning-tree cost 100` est accepte et rendu', async () => {
    const sw = await surUnPort('spanning-tree cost 100');

    expect(await configuration(sw)).toContain('spanning-tree cost 100');
  });

  it('un cout hors plage est refuse', async () => {
    const sw = await surUnPort();

    expect(refuse(await sw.executeCommand('spanning-tree cost 0'))).toBe(true);
  });

  /*
   * La priorite de PORT se pose elle aussi par pas — de 16 — mais ce
   * depot a DEJA tranche autrement pour elle : l'agent ARRONDIT au
   * multiple inferieur, et `stp-prd-fidelity` epingle ce choix en
   * tapant la commande. La sonde mesure donc ce qui a ete decide, et
   * l'ecart avec IOS — qui refuse — est inscrit au `TODO.md` plutot que
   * renverse ici sans que l'autre agent l'ait dit.
   */
  it.each(['0', '16', '128', '240'])('`spanning-tree port-priority %s` est accepte',
    async (valeur) => {
      const sw = await surUnPort();

      expect(refuse(await sw.executeCommand(`spanning-tree port-priority ${valeur}`)), valeur)
        .toBe(false);
    });

  it('une valeur hors bornes est refusee, une valeur intermediaire est ARRONDIE', async () => {
    const sw = await surUnPort();

    expect(refuse(await sw.executeCommand('spanning-tree port-priority 241'))).toBe(true);
    expect(refuse(await sw.executeCommand('spanning-tree port-priority 100'))).toBe(false);
  });

  it('`spanning-tree cost` n existe PAS en configuration globale', async () => {
    const sw = await commutateur();

    expect(refuse(await sw.executeCommand('spanning-tree cost 100'))).toBe(true);
  });
});

describe('les reglages GLOBAUX qui ont un jumeau sur le port', () => {
  it('`spanning-tree portfast default` est accepte et rendu', async () => {
    const sw = await commutateur('spanning-tree portfast default');

    expect(await configuration(sw)).toContain('spanning-tree portfast default');
  });

  it('`spanning-tree portfast bpduguard default` est accepte et rendu', async () => {
    const sw = await commutateur('spanning-tree portfast bpduguard default');

    expect(await configuration(sw)).toContain('spanning-tree portfast bpduguard default');
  });

  it('`spanning-tree portfast` SEUL n existe pas en configuration globale', async () => {
    const sw = await commutateur();

    expect(refuse(await sw.executeCommand('spanning-tree portfast'))).toBe(true);
  });
});

describe('le sous-mode MST', () => {
  it('`spanning-tree mst configuration` entre dans son sous-mode', async () => {
    const sw = await commutateur('spanning-tree mst configuration');

    expect(sw.getPrompt?.() ?? '').toMatch(/config-mst/);
  });

  it('le nom, la revision et une instance y sont acceptes et rendus', async () => {
    const sw = await commutateur('spanning-tree mst configuration',
      'name REGION1', 'revision 3', 'instance 1 vlan 10-20');
    const cfg = await configuration(sw);

    expect(cfg).toContain('REGION1');
    expect(cfg).toContain('revision 3');
    expect(cfg).toMatch(/instance 1 vlan/);
  });

  it('une revision hors plage est refusee', async () => {
    const sw = await commutateur('spanning-tree mst configuration');

    expect(refuse(await sw.executeCommand('revision 70000'))).toBe(true);
  });

  it('une instance hors plage est refusee', async () => {
    const sw = await commutateur('spanning-tree mst configuration');

    expect(refuse(await sw.executeCommand('instance 5000 vlan 10'))).toBe(true);
  });

  it('`exit` ramene en configuration globale', async () => {
    const sw = await commutateur('spanning-tree mst configuration', 'exit');

    expect(refuse(await sw.executeCommand('hostname APRES'))).toBe(false);
  });
});

describe('la negation', () => {
  it('`no spanning-tree vlan 10` est accepte', async () => {
    const sw = await commutateur('vlan 10', 'exit');

    expect(refuse(await sw.executeCommand('no spanning-tree vlan 10'))).toBe(false);
  });

  it('`no spanning-tree portfast` retire le reglage du port', async () => {
    const sw = await surUnPort('spanning-tree portfast', 'no spanning-tree portfast');

    expect(await configuration(sw)).not.toMatch(/^ spanning-tree portfast$/m);
  });

  it('`no spanning-tree mode` revient au defaut', async () => {
    const sw = await commutateur('spanning-tree mode mst', 'no spanning-tree mode');

    expect(await configuration(sw)).not.toContain('spanning-tree mode mst');
  });
});

describe('l aide de la famille', () => {
  it('`spanning-tree ?` annonce ses sous-commandes globales', async () => {
    const sw = await commutateur();
    const aide = sw.cliHelp('spanning-tree ');

    for (const mot of ['mode', 'vlan', 'portfast']) expect(aide, mot).toContain(mot);
  });

  it('`spanning-tree ?` sur le PORT annonce les siennes', async () => {
    const sw = await surUnPort();
    const aide = sw.cliHelp('spanning-tree ');

    for (const mot of ['cost', 'port-priority', 'portfast']) expect(aide, mot).toContain(mot);
  });

  it('aucune ligne d aide de la famille ne reste sans description', async () => {
    const sw = await commutateur();
    const nues: string[] = [];
    for (const amont of ['spanning-tree ', 'spanning-tree mode ', 'spanning-tree vlan 10 ',
      'spanning-tree portfast ', 'no spanning-tree ']) {
      for (const ligne of sw.cliHelp(amont).split('\n')) {
        const texte = ligne.trim();
        if (texte === '' || texte === '<cr>') continue;
        if (!/\s{2,}\S/.test(texte)) nues.push(`${amont}-> ${texte}`);
      }
    }
    expect(nues).toEqual([]);
  });
});
