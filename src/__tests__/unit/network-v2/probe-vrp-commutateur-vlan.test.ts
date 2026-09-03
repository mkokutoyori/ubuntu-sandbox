/**
 * Un identifiant de VLAN est un nombre de 1 a 4094, sur le commutateur
 * comme ailleurs.
 *
 * Sonde ecrite AVANT lecture du gestionnaire, contre la reference :
 *
 *   vlan batch { <1-4094> [ to <1-4094> ] } …
 *   port trunk allow-pass vlan { <1-4094> [ to <1-4094> ] | all }
 *   revision-level <0-65535>              (vue de region MST)
 *   mode { lacp-static | lacp-dynamic | manual }   (vue Eth-Trunk)
 *
 * La plage 1-4094 vient de l'IEEE 802.1Q — douze bits, dont 0 et 4095
 * sont reserves — et non d'un constructeur ; la revision d'une region
 * MST tient sur seize bits (IEEE 802.1Q clause 13).
 *
 * Mesure de depart sur un commutateur Huawei, en relisant la
 * configuration :
 *
 *   vlan batch zorglub                  -> ACCEPTE, et repond
 *                                          « Info: This operation may
 *                                          take a few seconds… »
 *   port trunk allow-pass vlan zorglub  -> ACCEPTE
 *   revision-level zorglub              -> ACCEPTE
 *   mode zorglub          (Eth-Trunk)   -> ACCEPTE, et RENDU
 *
 * `vlan batch zorglub` est le plus trompeur des cinq : la machine repond
 * par le message d'ATTENTE qu'elle emet quand elle cree vraiment une
 * serie de VLAN, donc l'operateur lit une confirmation la ou rien n'a
 * ete cree. `mode zorglub` est RENDU, donc rejoue a l'import d'une
 * topologie.
 *
 * `parseVlanList` est ajoute a `VlanSet.ts`, ou `parseVlanId`,
 * `VLAN_MIN` et `VLAN_MAX` vivaient deja, et il ferme un defaut que le
 * balayage n'avait PAS vu : les deux places qui lisent une liste de VLAN
 * portaient chacune sa boucle en `parseInt`, et toutes deux jetaient le
 * mot `to` en silence. `vlan batch 10 to 12` creait donc les VLAN 10 et
 * 12 et PAS le 11, et `port trunk allow-pass vlan 10 to 12` admettait
 * deux VLAN sur les trois demandes — une plage qui a l'air posee et dont
 * le milieu manque, ce qu'aucun message ne signale. C'est la vraie
 * raison de partager la grammaire plutot que de border chaque boucle.
 *
 * Les deux cas qui l'epinglent ont ete ECRITS EN DEUX TEMPS, et le dire
 * importe : leur premiere version se contentait de verifier que la
 * commande est acceptee, donc elle passait des deux cotes et ne prouvait
 * rien. Ils observent maintenant les VLAN REELLEMENT crees et la ligne
 * REELLEMENT rendue.
 *
 * ET UNE PREMISSE DE CETTE SONDE ETAIT FAUSSE, corrigee dans la sonde et
 * non dans le code : elle attendait `vlan batch` dans la configuration
 * relue. Une vraie machine, comme celle-ci, rend les VLAN un par un —
 * `vlan batch` est une commande de SAISIE, pas une forme de stockage.
 * Le cas observe desormais que les VLAN existent VRAIMENT, ce qui est
 * la seule chose que la commande promet.
 *
 * Discrimine par `git stash` sur les deux fichiers cables : 15 des 27
 * cas tombent avant correctif. Les 12 autres sont nommes ici :
 *
 *   - les HUIT cas de valeur juste — deux formes de `vlan batch`, trois
 *     de `port trunk allow-pass vlan`, la revision, les deux modes : un
 *     analyseur qui acceptait TOUT les acceptait deja. Ce sont les
 *     TEMOINS, sans lesquels refuser toute la vue satisferait la sonde ;
 *   - les quatre cas de non-regression, qui epinglent que les NOMS
 *     restent libres et qu'un laboratoire de commutation ordinaire se
 *     relit sans changer.
 *
 * CE QUE CETTE SONDE NE DEMANDE DELIBEREMENT PAS, et une premisse
 * ABANDONNEE plutot qu'effacee : `loopback-detect zorglub` est accepte
 * et rendu, et il le RESTE. Cette commande passe par un sac de texte
 * partage avec `port-security`, `storm-control`, `flow-control`,
 * `port-mirroring` et `am` — c'est-a-dire la decision ECRITE de ce depot
 * de garder une commande reelle qu'il ne modelise pas, pour qu'elle
 * survive au rechargement d'une topologie plutot que d'y disparaitre, la
 * meme que pour `ip ssh server algorithm`. Lui donner un vocabulaire
 * demanderait d'attester celui de VRP, hors de portee depuis ce reseau,
 * et une liste ecrite de memoire refuserait des commandes reelles.
 * Inscrit au `TODO.md`.
 *
 * Ne sont pas demandes non plus, pour une raison plus simple : que
 * `name zorglub`, `description zorglub` et `region-name zorglub` soient
 * refuses. Ce sont des NOMS libres — un
 * VLAN, une description et une region MST se nomment comme on veut — et
 * le balayage, qui marque tout `zorglub` survivant dans la
 * configuration, me les avait fait compter pour des defauts. Des cas de
 * non-regression les epinglent ici.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { HuaweiSwitch } from '@/network/devices/HuaweiSwitch';
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

const commutateur = (n: string) =>
  new HuaweiSwitch('switch-huawei', n) as unknown as Dev;

async function dansLaVue(d: Dev, ...cmds: string[]): Promise<string> {
  let last = '';
  for (const c of ['system-view', ...cmds]) {
    last = String(await d.executeCommand(c));
  }
  return last;
}

async function config(d: Dev): Promise<string> {
  await d.executeCommand('quit');
  await d.executeCommand('quit');
  return String(await d.executeCommand('display current-configuration'));
}

const IF = 'interface GigabitEthernet0/0/1';
const cle = (s: string) => s.replace(/\W/g, '');

describe('`vlan batch` cree des VLAN, ou refuse', () => {
  it.each(['zorglub', '0', '4095', '1 to zorglub'])(
    '`vlan batch %s` est refuse', async (v) => {
      const d = commutateur(`B${cle(v)}`);
      expect(await dansLaVue(d, `vlan batch ${v}`)).toContain('Error');
    });

  it('et ne repond pas par le message d attente d une creation', async () => {
    const d = commutateur('BM');
    expect(await dansLaVue(d, 'vlan batch zorglub')).not.toContain('may take a few seconds');
  });

  it.each([
    ['10', ['10']],
    ['10 20', ['10', '20']],
    ['10 to 12', ['10', '11', '12']],
  ] as ReadonlyArray<readonly [string, readonly string[]]>)(
    '`vlan batch %s` cree vraiment les VLAN', async (v, attendus) => {
      const d = commutateur(`BO${cle(v)}`);
      expect(await dansLaVue(d, `vlan batch ${v}`)).not.toContain('Error');
      await d.executeCommand('quit');
      const vue = String(await d.executeCommand('display vlan'));
      for (const id of attendus) {
        expect(vue.split(/\s+/), `VLAN ${id}`).toContain(id);
      }
    });
});

describe('les VLAN admis sur une agregation sont des identifiants', () => {
  it.each(['zorglub', '4095', '1 to zorglub'])(
    '`port trunk allow-pass vlan %s` est refuse', async (v) => {
      const d = commutateur(`T${cle(v)}`);
      expect(await dansLaVue(d, IF, 'port link-type trunk',
        `port trunk allow-pass vlan ${v}`)).toContain('Error');
    });

  it.each(['10', 'all', '10 to 12'])(
    '`port trunk allow-pass vlan %s` reste accepte', async (v) => {
      const d = commutateur(`TO${cle(v)}`);
      expect(await dansLaVue(d, IF, 'port link-type trunk',
        `port trunk allow-pass vlan ${v}`)).not.toContain('Error');
    });

  it('`port trunk allow-pass vlan 10 to 12` admet VRAIMENT le VLAN du milieu',
    async () => {
      const d = commutateur('TR');
      await dansLaVue(d, IF, 'port link-type trunk',
        'undo port trunk allow-pass vlan all',
        'port trunk allow-pass vlan 10 to 12');
      const ligne = (await config(d)).split('\n')
        .find((l) => l.includes('port trunk allow-pass vlan'));
      expect(ligne, 'la ligne des VLAN admis').toBeDefined();
      expect(ligne!.split(/\s+/)).toContain('11');
    });
});

describe('une revision de region MST tient sur seize bits', () => {
  it.each(['zorglub', '65536'])('`revision-level %s` est refuse', async (r) => {
    const d = commutateur(`R${cle(r)}`);
    expect(await dansLaVue(d, 'stp region-configuration',
      `revision-level ${r}`)).toContain('Error');
  });

  it('`revision-level 5` reste accepte et RELU', async () => {
    const d = commutateur('RO');
    expect(await dansLaVue(d, 'stp region-configuration',
      'revision-level 5')).not.toContain('Error');
    expect(await config(d)).toContain('revision-level 5');
  });
});

describe('le mode d une agregation est l un de ceux que la machine connait', () => {
  it.each(['zorglub', 'active'])('`mode %s` est refuse', async (m) => {
    const d = commutateur(`M${cle(m)}`);
    expect(await dansLaVue(d, 'interface Eth-Trunk 1', `mode ${m}`)).toContain('Error');
  });

  it('et rien n en reste dans la configuration', async () => {
    const d = commutateur('MN');
    await dansLaVue(d, 'interface Eth-Trunk 1', 'mode zorglub');
    expect(await config(d)).not.toContain('zorglub');
  });

  it.each(['lacp-static', 'manual'])('`mode %s` reste accepte', async (m) => {
    const d = commutateur(`MO${cle(m)}`);
    expect(await dansLaVue(d, 'interface Eth-Trunk 1', `mode ${m}`)).not.toContain('Error');
  });
});

describe('non-regression — les NOMS restent libres', () => {
  it('`name zorglub` sous un VLAN reste accepte et RELU', async () => {
    const d = commutateur('XA');
    expect(await dansLaVue(d, 'vlan 10', 'name zorglub')).not.toContain('Error');
    expect(await config(d)).toContain('name zorglub');
  });

  it('`description zorglub` reste accepte', async () => {
    const d = commutateur('XB');
    expect(await dansLaVue(d, 'vlan 10', 'description zorglub')).not.toContain('Error');
  });

  it('`region-name zorglub` reste accepte et RELU', async () => {
    const d = commutateur('XC');
    expect(await dansLaVue(d, 'stp region-configuration',
      'region-name zorglub')).not.toContain('Error');
    expect(await config(d)).toContain('region-name zorglub');
  });

  it('et un laboratoire de commutation bien forme reste RELU', async () => {
    const d = commutateur('XD');
    await dansLaVue(d, 'vlan 10', 'quit', IF, 'port link-type access',
      'port default vlan 10');
    const cfg = await config(d);
    expect(cfg).toContain('port link-type access');
    expect(cfg).toContain('port default vlan 10');
  });
});
