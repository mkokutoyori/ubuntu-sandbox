/**
 * PRD-CLI-Fidelite-VRP.md §21 / lot V12 — `display ip interface brief`,
 * un tableau pour deux plateformes.
 *
 * Le routeur et le commutateur rendaient LE MEME tableau chacun de son
 * cote : largeurs differentes, bloc de compteurs d'un seul cote,
 * marqueur `(s)` d'un seul cote, et l'argument de filtrage ignore par
 * l'un et refuse par l'autre.
 *
 * La forme du fichier suit ce constat : il compare les deux plateformes
 * ENTRE ELLES colonne par colonne, plutot que chacune contre une
 * maquette recopiee a la main.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { HuaweiSwitch } from '@/network/devices/HuaweiSwitch';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { LEGENDE_IP_BRIEF } from '@/network/devices/shells/huawei/huaweiTableLayouts';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

let serie = 0;
interface Cli { executeCommand(c: string): Promise<string> }

async function routeur(): Promise<Cli> {
  const r = new HuaweiRouter(`W${++serie}`) as unknown as Cli;
  for (const c of ['system-view', 'interface LoopBack 0',
    'ip address 1.1.1.1 255.255.255.255', 'quit',
    'interface GigabitEthernet0/0/0', 'ip address 10.0.12.1 255.255.255.0', 'quit',
    'interface GigabitEthernet0/0/1', 'shutdown', 'quit', 'quit']) await r.executeCommand(c);
  return r;
}

async function commutateur(): Promise<Cli> {
  const s = new HuaweiSwitch('switch-huawei', `X${++serie}`) as unknown as Cli;
  for (const c of ['system-view', 'vlan 10', 'quit', 'interface Vlanif 10',
    'ip address 10.0.10.1 255.255.255.0', 'quit',
    'interface LoopBack 0', 'ip address 2.2.2.2 255.255.255.255', 'quit',
    'quit']) await s.executeCommand(c);
  return s;
}

const BRIEF = 'display ip interface brief';
const lignes = (s: string) => s.split('\n');
const enTete = (s: string) => lignes(s).find((l) => l.startsWith('Interface')) ?? '';
/** Les colonnes ou commence chaque intitule — la mise en page, mesuree. */
const bords = (entete: string) =>
  ['Interface', 'IP Address/Mask', 'Physical', 'Protocol'].map((c) => entete.indexOf(c));

describe('un seul tableau pour les deux plateformes', () => {
  it('meme en-tete, aux memes colonnes', async () => {
    const r = await (await routeur()).executeCommand(BRIEF);
    const s = await (await commutateur()).executeCommand(BRIEF);
    expect(enTete(s)).toBe(enTete(r));
    expect(bords(enTete(s))).toEqual(bords(enTete(r)));
    expect(bords(enTete(r)).every((b) => b >= 0)).toBe(true);
  });

  it('les donnees sont calees sur l\'en-tete, des deux cotes', async () => {
    for (const [nom, fabrique] of [['routeur', routeur], ['switch', commutateur]] as const) {
      const out = await (await fabrique()).executeCommand(BRIEF);
      const attendus = bords(enTete(out));
      const donnees = lignes(out).filter((l) => /^(GigabitEthernet|Vlanif|LoopBack|MEth)/.test(l));
      expect(donnees.length, nom).toBeGreaterThan(0);
      for (const ligne of donnees) {
        const champs = [...ligne.matchAll(/\S+/g)].map((m) => m.index ?? -1);
        // Chaque champ commence a un bord de colonne : le tableau est
        // cale, et non aligne par hasard.
        for (const [i, debut] of champs.entries()) {
          expect(attendus, `${nom} : ${ligne}`).toContain(debut);
          expect(i).toBeLessThan(4);
        }
      }
    }
  });

  it('la legende est la meme, et c\'est celle du module', async () => {
    for (const fabrique of [routeur, commutateur]) {
      const out = await (await fabrique()).executeCommand(BRIEF);
      expect(lignes(out).slice(0, 4)).toEqual([...LEGENDE_IP_BRIEF]);
    }
  });

  it('le bloc de compteurs est present des DEUX cotes', async () => {
    for (const [nom, fabrique] of [['routeur', routeur], ['switch', commutateur]] as const) {
      const out = await (await fabrique()).executeCommand(BRIEF);
      for (const quoi of ['UP in Physical', 'DOWN in Physical', 'UP in Protocol', 'DOWN in Protocol']) {
        expect(out, `${nom} : ${quoi}`).toContain(`The number of interface that is ${quoi} is `);
      }
    }
  });

  it('les compteurs comptent ce que le tableau montre', async () => {
    for (const [nom, fabrique] of [['routeur', routeur], ['switch', commutateur]] as const) {
      const out = await (await fabrique()).executeCommand(BRIEF);
      const donnees = lignes(out).filter((l) => /^(GigabitEthernet|Vlanif|LoopBack|MEth)/.test(l));
      const lu = (quoi: string) =>
        parseInt(out.match(new RegExp(`is ${quoi} is (\\d+)`))?.[1] ?? '-1', 10);
      expect(lu('UP in Physical') + lu('DOWN in Physical'), nom).toBe(donnees.length);
      expect(lu('UP in Protocol') + lu('DOWN in Protocol'), nom).toBe(donnees.length);
    }
  });
});

describe('la legende est la specification des marqueurs', () => {
  it('le protocole d\'un LoopBack porte `(s)`, des deux cotes', async () => {
    // La legende que les deux impriment declare `(s): spoofing`, et le
    // protocole d'une interface de bouclage EST spoofe. Le commutateur
    // l'ecrivait, le routeur non — pour le meme type d'objet.
    for (const [nom, fabrique] of [['routeur', routeur], ['switch', commutateur]] as const) {
      const out = await (await fabrique()).executeCommand(BRIEF);
      const loop = lignes(out).find((l) => l.startsWith('LoopBack0'));
      expect(loop, nom).toBeDefined();
      expect(loop, nom).toMatch(/up\(s\)$/);
    }
  });

  it('`*down` marque une interface fermee par l\'operateur, et elle seule', async () => {
    const out = await (await routeur()).executeCommand(BRIEF);
    const fermee = lignes(out).find((l) => l.startsWith('GigabitEthernet0/0/1'));
    const ouverte = lignes(out).find((l) => l.startsWith('GigabitEthernet0/0/0'));
    expect(fermee).toContain('*down');
    expect(ouverte).not.toContain('*down');
  });
});

describe('l\'argument est lu, et non plus jete', () => {
  it('le tableau se limite a l\'interface demandee', async () => {
    const r = await routeur();
    const out = await r.executeCommand(`${BRIEF} GigabitEthernet0/0/0`);
    expect(out).toContain('GigabitEthernet0/0/0');
    expect(out).not.toContain('GigabitEthernet0/0/1');
    expect(out).not.toContain('LoopBack0');
  });

  it('toute ecriture legitime du nom fait le meme filtre', async () => {
    for (const ecriture of ['GigabitEthernet0/0/0', 'GigabitEthernet 0/0/0',
      'gigabitethernet0/0/0', 'gi0/0/0', 'g 0/0/0']) {
      const r = await routeur();
      const out = await r.executeCommand(`${BRIEF} ${ecriture}`);
      expect(out, ecriture).toContain('GigabitEthernet0/0/0');
      expect(out, ecriture).not.toContain('GigabitEthernet0/0/2');
    }
  });

  it('le switch filtre aussi, au lieu de refuser la commande', async () => {
    for (const ecriture of ['Vlanif10', 'Vlanif 10', 'vlanif10']) {
      const s = await commutateur();
      const out = await s.executeCommand(`${BRIEF} ${ecriture}`);
      expect(out, ecriture).toContain('Vlanif10');
      expect(out, ecriture).not.toContain('MEth0/0/1');
    }
  });

  it('un nom qui n\'existe pas est refuse, des deux cotes', async () => {
    for (const [nom, fabrique, mauvais] of [
      ['routeur', routeur, 'zzz'],
      ['routeur', routeur, 'GigabitEthernet9/9/9'],
      ['switch', commutateur, 'Vlanif99'],
    ] as const) {
      const d = await fabrique();
      const out = await d.executeCommand(`${BRIEF} ${mauvais}`);
      expect(out, `${nom} ${mauvais}`)
        .toMatch(/^Error: Wrong parameter found at '\^' position\./);
      expect(out.split('\n').length, `${nom} ${mauvais}`).toBe(3);
    }
  });

  it('sans argument, tout le tableau', async () => {
    const r = await routeur();
    const out = await r.executeCommand(BRIEF);
    for (const p of ['GigabitEthernet0/0/0', 'GigabitEthernet0/0/1', 'LoopBack0']) {
      expect(out, p).toContain(p);
    }
  });
});

describe('la vue s\'accorde avec le detail', () => {
  it('l\'adresse et l\'etat sont ceux que `display ip interface` donne', async () => {
    for (const [fabrique, ports] of [
      [routeur, ['GigabitEthernet0/0/0', 'LoopBack0']],
      [commutateur, ['Vlanif10', 'LoopBack0']],
    ] as const) {
      for (const port of ports) {
        const d = await fabrique();
        const bref = lignes(await d.executeCommand(BRIEF)).find((l) => l.startsWith(port))!;
        const detail = await d.executeCommand(`display ip interface ${port}`);
        const adresse = detail.split('\n')
          .find((l) => l.includes('Internet Address'))?.split('is ')[1]?.trim();
        if (adresse && adresse !== 'unassigned') {
          expect(bref, `${port} : l'adresse`).toContain(adresse);
        }
        const upDetail = detail.includes('current state : UP');
        expect(/\bup\b|\bup\(s\)/.test(bref.split(/\s+/)[2]), `${port} : l'etat`).toBe(upDetail);
      }
    }
  });
});
