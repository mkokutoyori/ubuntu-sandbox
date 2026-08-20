/**
 * PRD-CLI-Fidelite-VRP.md §22 / lot V13 — la famille « brief » des
 * interfaces : une table, un etat, un filtre.
 *
 * Meme regle que le lot V12, appliquee aux vues soeurs. Sept desaccords
 * mesures entre les deux plateformes pour DEUX commandes, dont trois qui
 * ne sont pas de mise en page :
 *
 * - `*down` n'existait pas sur le commutateur : un port ferme par
 *   l'operateur s'y montrait comme un port sans cable ;
 * - ses colonnes `PHY` et `Protocol` etaient la MEME expression, donc
 *   incapables de differer ;
 * - `display interface description` n'existait pas du tout sur le
 *   commutateur, qui stocke pourtant les descriptions.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { HuaweiSwitch } from '@/network/devices/HuaweiSwitch';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { LEGENDE_INTERFACE_BRIEF } from '@/network/devices/shells/huawei/huaweiTableLayouts';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

let serie = 0;
interface Cli { executeCommand(c: string): Promise<string> }

/** Les deux machines portent le MEME etat : un port decrit, un port ferme. */
async function routeur(): Promise<Cli> {
  const r = new HuaweiRouter(`Y${++serie}`) as unknown as Cli;
  for (const c of ['system-view',
    'interface GigabitEthernet0/0/0', 'description VERS LE SIEGE', 'quit',
    'interface GigabitEthernet0/0/1', 'shutdown', 'quit',
    'interface LoopBack 0', 'quit', 'quit']) await r.executeCommand(c);
  return r;
}

async function commutateur(): Promise<Cli> {
  const s = new HuaweiSwitch('switch-huawei', `Z${++serie}`, 8) as unknown as Cli;
  for (const c of ['system-view',
    'interface GigabitEthernet0/0/0', 'description VERS LE SIEGE', 'quit',
    'interface GigabitEthernet0/0/1', 'shutdown', 'quit',
    'interface LoopBack 0', 'quit', 'quit']) await s.executeCommand(c);
  return s;
}

const BRIEF = 'display interface brief';
const DESC = 'display interface description';
const lignes = (s: string) => s.split('\n');
const entete = (s: string) => lignes(s).find((l) => l.startsWith('Interface')) ?? '';
const ligneDe = (s: string, port: string) =>
  lignes(s).find((l) => l.startsWith(port)) ?? '';

describe('une seule table pour les deux plateformes', () => {
  it('`display interface brief` : meme legende, meme en-tete', async () => {
    const r = await (await routeur()).executeCommand(BRIEF);
    const s = await (await commutateur()).executeCommand(BRIEF);
    expect(lignes(s)[0]).toBe(LEGENDE_INTERFACE_BRIEF);
    expect(lignes(s)[0]).toBe(lignes(r)[0]);
    expect(entete(s)).toBe(entete(r));
  });

  it('`display interface description` : meme en-tete, et elle EXISTE des deux cotes', async () => {
    const r = await (await routeur()).executeCommand(DESC);
    const s = await (await commutateur()).executeCommand(DESC);
    expect(r).not.toMatch(/^Error:/);
    expect(s).not.toMatch(/^Error:/);
    expect(entete(s)).toBe(entete(r));
  });

  it('les colonnes de `brief` sont celles d\'un vrai VRP', async () => {
    // Les largeurs sont fixees par la sonde d'alignement de l'autre
    // agent, relevee sur une sortie capturee. On verifie ici que le
    // COMMUTATEUR les a adoptees, pas qu'elles sont justes.
    const s = await (await commutateur()).executeCommand(BRIEF);
    for (const col of ['Interface', 'PHY', 'Protocol', 'InUti', 'OutUti', 'inErrors', 'outErrors']) {
      expect(entete(s), col).toContain(col);
    }
  });

  it('aucune ligne ne traine de blanc de fin', async () => {
    for (const [nom, fabrique] of [['routeur', routeur], ['switch', commutateur]] as const) {
      for (const vue of [BRIEF, DESC]) {
        const out = await (await fabrique()).executeCommand(vue);
        for (const l of lignes(out)) expect(l, `${nom} ${vue}`).toBe(l.trimEnd());
      }
    }
  });
});

describe('l\'etat est celui du predicat partage', () => {
  it('`*down` marque un port ferme par l\'operateur, des DEUX cotes', async () => {
    for (const [nom, fabrique] of [['routeur', routeur], ['switch', commutateur]] as const) {
      for (const vue of [BRIEF, DESC]) {
        const out = await (await fabrique()).executeCommand(vue);
        expect(ligneDe(out, 'GigabitEthernet0/0/1'), `${nom} ${vue} : ferme`)
          .toContain('*down');
        expect(ligneDe(out, 'GigabitEthernet0/0/0'), `${nom} ${vue} : ouvert`)
          .not.toContain('*down');
      }
    }
  });

  it('la vue breve et la vue de detail donnent le meme etat', async () => {
    for (const [nom, fabrique, ports] of [
      ['routeur', routeur, ['GigabitEthernet0/0/1', 'LoopBack0']],
      ['switch', commutateur, ['GigabitEthernet0/0/1', 'LoopBack0']],
    ] as const) {
      for (const port of ports) {
        const d = await fabrique();
        const bref = ligneDe(await d.executeCommand(BRIEF), port);
        const detail = await d.executeCommand(`display interface ${port}`);
        const fermeEnDetail = detail.includes('Administratively DOWN');
        expect(bref.includes('*down'), `${nom} ${port}`).toBe(fermeEnDetail);
        const upEnDetail = detail.includes('current state : UP');
        expect(/\bup\b/.test(bref.split(/\s+/)[1]), `${nom} ${port} : up`).toBe(upEnDetail);
      }
    }
  });

  it('le commutateur liste ses interfaces virtuelles, comme le routeur', async () => {
    // Une LoopBack creee sur le commutateur etait invisible de sa propre
    // vue breve, alors que sa vue `display ip interface brief` la liste.
    for (const [nom, fabrique] of [['routeur', routeur], ['switch', commutateur]] as const) {
      const out = await (await fabrique()).executeCommand(BRIEF);
      expect(ligneDe(out, 'LoopBack0'), nom).not.toBe('');
      expect(ligneDe(out, 'LoopBack0'), nom).toContain('up');
    }
  });
});

describe('le filtre est lu, et non plus jete', () => {
  it('la vue se limite a l\'interface demandee, des deux cotes', async () => {
    for (const [nom, fabrique] of [['routeur', routeur], ['switch', commutateur]] as const) {
      for (const vue of [BRIEF, DESC]) {
        const d = await fabrique();
        const out = await d.executeCommand(`${vue} GigabitEthernet0/0/0`);
        expect(out, `${nom} ${vue}`).toContain('GigabitEthernet0/0/0');
        expect(out, `${nom} ${vue}`).not.toContain('GigabitEthernet0/0/1');
        expect(out, `${nom} ${vue}`).not.toContain('LoopBack0');
      }
    }
  });

  it('toute ecriture legitime du nom fait le meme filtre', async () => {
    for (const ecriture of ['GigabitEthernet0/0/0', 'GigabitEthernet 0/0/0',
      'gigabitethernet0/0/0', 'gi0/0/0', 'g 0/0/0']) {
      for (const fabrique of [routeur, commutateur]) {
        const d = await fabrique();
        const out = await d.executeCommand(`${BRIEF} ${ecriture}`);
        expect(out, ecriture).toContain('GigabitEthernet0/0/0');
        expect(out, ecriture).not.toContain('GigabitEthernet0/0/1');
      }
    }
  });

  it('un nom qui n\'existe pas est refuse, au lieu de rendre tout le tableau', async () => {
    for (const [nom, fabrique] of [['routeur', routeur], ['switch', commutateur]] as const) {
      for (const vue of [BRIEF, DESC]) {
        const d = await fabrique();
        const out = await d.executeCommand(`${vue} zzz`);
        expect(out, `${nom} ${vue}`)
          .toMatch(/^Error: Wrong parameter found at '\^' position\./);
        expect(out.split('\n').length, `${nom} ${vue}`).toBe(3);
      }
    }
  });

  it('sans filtre, tout le tableau', async () => {
    for (const fabrique of [routeur, commutateur]) {
      const out = await (await fabrique()).executeCommand(BRIEF);
      for (const p of ['GigabitEthernet0/0/0', 'GigabitEthernet0/0/1', 'LoopBack0']) {
        expect(out, p).toContain(p);
      }
    }
  });
});

describe('la description est rendue la ou elle est rangee', () => {
  it('le commutateur rend la description qu\'il stocke deja', async () => {
    const s = await commutateur();
    const out = await s.executeCommand(DESC);
    expect(ligneDe(out, 'GigabitEthernet0/0/0')).toContain('VERS LE SIEGE');
  });

  it('un port sans description ne rend rien de plus', async () => {
    for (const fabrique of [routeur, commutateur]) {
      const out = await (await fabrique()).executeCommand(DESC);
      expect(ligneDe(out, 'GigabitEthernet0/0/1')).not.toContain('undefined');
    }
  });
});
