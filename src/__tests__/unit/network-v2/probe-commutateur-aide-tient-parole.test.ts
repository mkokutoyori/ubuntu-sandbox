/**
 * Sur un COMMUTATEUR aussi, un mot que `?` propose est un mot qui existe.
 *
 * Ce depot tient depuis longtemps un garde-fou pour cet invariant —
 * « tout mot que `?` propose est execute et ne doit pas repondre
 * `% Invalid input` » — et il ne balayait que le ROUTEUR. L'invariant
 * s'arretait donc a la moitie du parc, ce qui est exactement le
 * contraire de ce qu'un garde-fou d'UNIFORMITE doit faire.
 *
 * Mesure, en faisant passer le commutateur dans le meme balayage : 139
 * mots proposes et refuses.
 *
 *   spanning-tree bpdufilter | bpduguard | hello-time | forward-time |
 *   max-age                  -> annonces en configuration GLOBALE, et
 *                               refuses : sur un vrai Catalyst les deux
 *                               premiers vivent sous `portfast` et les
 *                               trois autres sous `vlan <n>`
 *   spanning-tree extend ?   -> reproposait la liste du PARENT, donc
 *                               `spanning-tree extend loopguard`, que
 *                               l'analyseur refuse ; idem `loopguard`,
 *                               `pathcost`, `portfast` et `priority`
 *   show lacp                -> annonce, refuse (ses sous-commandes
 *                               `neighbor`, `counters`, `sys-id`
 *                               fonctionnent pourtant)
 *   show interfaces etherchannel -> annonce, refuse, alors que
 *                               `show etherchannel` rend la vue
 *   duplex / speed / mls qos cos / l2protocol-tunnel
 *                            -> nus, ils repondaient « ce mot n'existe
 *                               pas » a un mot que la machine connait
 *
 * LES TROIS FAMILLES SE DISTINGUENT, et le correctif differe :
 *
 * (1) Ce que la machine ne connait pas a cette place n'est plus
 *     ANNONCE : les cinq mots quittent la liste globale de
 *     `spanning-tree`.
 * (2) Ce qui existe et n'etait pas SERVI l'est : `show lacp` nu rend
 *     `% Incomplete command.` comme IOS, et `show interfaces
 *     etherchannel` DELEGUE a `show etherchannel` — c'est la meme
 *     question posee par l'autre porte, et la recopier ferait deux vues
 *     d'un seul etat.
 * (3) Un mot-cle CONNU auquel il manque son argument dit
 *     `% Incomplete command.` et non le caret : c'est la distinction
 *     qu'IOS fait entre « ce mot n'existe pas » et « continuez ».
 *
 * `spanning-tree extend`, `loopguard`, `pathcost`, `portfast` et
 * `priority` deviennent de VRAIS noeuds qui lisent le MEME corps que le
 * glouton : une suite declaree n'est qu'un mot affiche, et c'est ce qui
 * faisait reproposer les freres du parent.
 *
 * Discrimine par `git stash` sur le fichier cable : 16 des 48 cas
 * tombent avant correctif. Les 32 autres sont les TEMOINS, et ils
 * portent ici plus que d'habitude : la moitie du lot RETIRE des mots de
 * l'aide et l'autre moitie change un message, donc sans eux un
 * correctif qui viderait la liste ou refuserait toute la famille
 * satisferait la sonde. Ils epinglent les huit formes globales qui
 * doivent rester acceptees, les cinq places ou vivent vraiment les mots
 * retires (`portfast bpduguard default`, `vlan 10 hello-time 4`…), les
 * trois sous-commandes de `show lacp`, les quatre formes d'interface
 * bien ecrites, les trois refus au caret qui doivent le rester, et le
 * message propre de la priorite hors du pas de 4096.
 *
 * L'un d'eux a ete AJOUTE apres coup, et il vaut d'etre nomme : la
 * premiere version de la delegation d'`etherchannel` interceptait AUSSI
 * la forme PAR PORT (`show interfaces Fa0/6 etherchannel`), qui
 * existait deja et rend une autre vue. C'est la course de non-regression
 * qui l'a attrapee ; le cas l'epingle desormais.
 *
 * CE QUE CETTE SONDE NE DEMANDE DELIBEREMENT PAS : que `spanning-tree
 * priority 4096` soit refuse en configuration globale. Un vrai Catalyst
 * ne connait cette forme que sous `vlan <n>`, mais ce simulateur
 * l'accepte depuis toujours et des laboratoires s'en servent ; la
 * retirer est un autre lot, inscrit au `TODO.md`.
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

interface Dev {
  executeCommand(c: string): Promise<string>;
  cliHelp(s: string): string;
}

const commutateur = (n: string) =>
  new CiscoSwitch('switch-cisco', n) as unknown as Dev;

async function conf(d: Dev, ...cmds: string[]): Promise<string> {
  let last = '';
  for (const c of ['enable', 'configure terminal', ...cmds]) {
    last = String(await d.executeCommand(c));
  }
  return last;
}

const cle = (s: string) => s.replace(/\W/g, '');

describe('la configuration globale n annonce plus ce qu elle refuse', () => {
  const RETIRES = ['bpdufilter', 'bpduguard', 'hello-time', 'forward-time', 'max-age'];

  it.each(RETIRES)('`spanning-tree ?` n offre plus `%s`', async (mot) => {
    const d = commutateur(`A${cle(mot)}`);
    await conf(d);
    const aide = d.cliHelp('spanning-tree ');
    expect(aide.split('\n').map((l) => l.trim().split(/\s+/)[0])).not.toContain(mot);
  });

  it.each(RETIRES)('et `spanning-tree %s` reste refuse', async (mot) => {
    const d = commutateur(`B${cle(mot)}`);
    expect(await conf(d, `spanning-tree ${mot}`)).toContain('% Invalid');
  });

  it.each(['portfast bpduguard default', 'portfast bpdufilter default',
    'vlan 10 hello-time 4', 'vlan 10 forward-time 15', 'vlan 10 max-age 20'])(
    '`spanning-tree %s` — la place ou ces mots vivent — reste accepte', async (reste) => {
      const d = commutateur(`C${cle(reste)}`);
      expect(await conf(d, `spanning-tree ${reste}`)).not.toContain('%');
    });
});

describe('un aiguillage pris ferme ses autres branches', () => {
  const BRANCHES: ReadonlyArray<readonly [string, string]> = [
    ['extend', 'system-id'],
    ['loopguard', 'default'],
    ['pathcost', 'method'],
    ['portfast', 'default'],
  ];

  it.each(BRANCHES)('`spanning-tree %s ?` n offre que ses suites', async (mot, attendu) => {
    const d = commutateur(`D${cle(mot)}`);
    await conf(d);
    const aide = d.cliHelp(`spanning-tree ${mot} `);
    expect(aide).toContain(attendu);
    for (const frere of ['backbonefast', 'uplinkfast', 'mode', 'mst']) {
      expect(aide, frere).not.toContain(frere);
    }
  });

  it('`spanning-tree priority ?` annonce un NOMBRE, pas des mots-cles', async () => {
    const d = commutateur('DP');
    await conf(d);
    const aide = d.cliHelp('spanning-tree priority ');
    expect(aide).toContain('<0-61440>');
    expect(aide).not.toContain('backbonefast');
  });

  it.each(['spanning-tree extend system-id', 'spanning-tree loopguard default',
    'spanning-tree pathcost method long', 'spanning-tree portfast default',
    'spanning-tree priority 4096', 'spanning-tree uplinkfast',
    'spanning-tree backbonefast', 'spanning-tree mode rapid-pvst'])(
    '`%s` reste accepte', async (ligne) => {
      const d = commutateur(`E${cle(ligne)}`);
      expect(await conf(d, ligne)).not.toContain('%');
    });

  it.each(['spanning-tree extend zorglub', 'spanning-tree pathcost zorglub'])(
    '`%s` reste refuse', async (ligne) => {
      const d = commutateur(`F${cle(ligne)}`);
      expect(await conf(d, ligne)).toContain('% Invalid');
    });

  it('et la priorite hors du pas de 4096 garde son message', async () => {
    const d = commutateur('FP');
    expect(await conf(d, 'spanning-tree priority 4097')).toContain('increments of 4096');
  });
});

describe('ce qui existe et n etait pas servi l est', () => {
  it('`show interfaces etherchannel` rend la MEME vue que `show etherchannel`',
    async () => {
      const d = commutateur('G1');
      await d.executeCommand('enable');
      const parLInterface = String(await d.executeCommand('show interfaces etherchannel'));
      const direct = String(await d.executeCommand('show etherchannel'));
      expect(parLInterface).not.toContain('% Invalid');
      expect(parLInterface).toBe(direct);
    });

  it('et la forme PAR PORT garde sa vue a elle', async () => {
    const d = commutateur('G0');
    await d.executeCommand('enable');
    const parPort = String(await d.executeCommand(
      'show interfaces GigabitEthernet0/1 etherchannel'));
    expect(parPort).not.toContain('% Invalid');
    expect(parPort).toContain('not part of an EtherChannel');
  });

  it('`show lacp` nu est INCOMPLET, pas invalide', async () => {
    const d = commutateur('G2');
    await d.executeCommand('enable');
    expect(String(await d.executeCommand('show lacp'))).toContain('% Incomplete command.');
  });

  it.each(['show lacp neighbor', 'show lacp counters', 'show lacp sys-id'])(
    '`%s` reste servi', async (c) => {
      const d = commutateur(`G${cle(c)}`);
      await d.executeCommand('enable');
      expect(String(await d.executeCommand(c))).not.toContain('% Invalid');
    });
});

describe('un mot-cle connu sans son argument dit INCOMPLET', () => {
  it.each(['duplex', 'speed', 'mls qos cos', 'l2protocol-tunnel'])(
    '`%s` nu rend `% Incomplete command.`', async (c) => {
      const d = commutateur(`H${cle(c)}`);
      expect(await conf(d, 'interface GigabitEthernet0/1', c))
        .toContain('% Incomplete command.');
    });

  it.each([['duplex full', ''], ['speed 100', ''], ['mls qos cos 5', ''],
    ['l2protocol-tunnel cdp', '']])('`%s` reste accepte', async (c) => {
    const d = commutateur(`I${cle(c)}`);
    expect(await conf(d, 'interface GigabitEthernet0/1', c)).not.toContain('%');
  });

  it.each(['duplex zorglub', 'speed zorglub', 'mls qos cos zorglub'])(
    '`%s` reste refuse au caret', async (c) => {
      const d = commutateur(`J${cle(c)}`);
      expect(await conf(d, 'interface GigabitEthernet0/1', c)).toContain('% Invalid');
    });
});
