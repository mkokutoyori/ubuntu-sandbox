/**
 * PRD-CLI-Fidelite-VRP.md §20 / lot V11 — deux vues d'un meme port en
 * disent la meme chose.
 *
 * Les deux constats laisses ouverts par V10 n'etaient pas isoles :
 * `display interface` et `display ip interface` repondaient, sur la MEME
 * machine au MEME instant, avec un nom different, un etat different et
 * un masque different. Et les deux plateformes n'acceptaient pas les
 * memes ecritures du meme nom.
 *
 * La forme de ce fichier suit ce constat : il compare les vues ENTRE
 * ELLES et les plateformes entre elles, plutot que chacune contre une
 * attente ecrite a la main. Une attente ecrite a la main peut recopier
 * la mauvaise reponse ; une comparaison ne le peut pas.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { HuaweiSwitch } from '@/network/devices/HuaweiSwitch';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

let serie = 0;
interface Cli { executeCommand(c: string): Promise<string> }

async function routeur(): Promise<Cli> {
  const r = new HuaweiRouter(`U${++serie}`) as unknown as Cli;
  for (const c of ['system-view', 'interface LoopBack 0',
    'ip address 1.1.1.1 255.255.255.255', 'quit',
    'interface GigabitEthernet0/0/0', 'ip address 10.0.12.1 255.255.255.0',
    'undo shutdown', 'quit', 'quit']) await r.executeCommand(c);
  return r;
}

async function commutateur(): Promise<Cli> {
  const s = new HuaweiSwitch('switch-huawei', `V${++serie}`) as unknown as Cli;
  for (const c of ['system-view', 'vlan 10', 'quit', 'interface Vlanif 10',
    'ip address 10.0.10.1 255.255.255.0', 'quit',
    'interface LoopBack 0', 'ip address 2.2.2.2 255.255.255.255', 'quit',
    'quit']) await s.executeCommand(c);
  return s;
}

const etat = (bloc: string) => bloc.split('\n')[0].replace(/^\S+\s/, '');
const nom = (bloc: string) => bloc.split('\n')[0].split(' ')[0];
const adresse = (bloc: string) =>
  bloc.split('\n').find((l) => l.includes('Internet Address'))?.trim() ?? null;

// ── Deux vues, un objet ───────────────────────────────────────────

describe('les deux vues d\'un port en disent la meme chose', () => {
  const PORTS_ROUTEUR = ['LoopBack0', 'GigabitEthernet0/0/0'];
  const PORTS_SWITCH = ['Vlanif10', 'LoopBack0', 'GigabitEthernet0/0/1'];

  it('routeur : meme nom, meme etat, meme adresse', async () => {
    for (const port of PORTS_ROUTEUR) {
      const r = await routeur();
      const vueA = await r.executeCommand(`display interface ${port}`);
      const vueB = await r.executeCommand(`display ip interface ${port}`);
      expect(nom(vueB), `${port} : le nom`).toBe(nom(vueA));
      expect(etat(vueB), `${port} : l'etat`).toBe(etat(vueA));
      if (adresse(vueA) && adresse(vueB)) {
        expect(adresse(vueB), `${port} : l'adresse`).toBe(adresse(vueA));
      }
    }
  });

  it('switch : meme nom, meme etat', async () => {
    for (const port of PORTS_SWITCH) {
      const s = await commutateur();
      const vueA = await s.executeCommand(`display interface ${port}`);
      const vueB = await s.executeCommand(`display ip interface ${port}`);
      expect(nom(vueB), `${port} : le nom`).toBe(nom(vueA));
      expect(etat(vueB), `${port} : l'etat`).toBe(etat(vueA));
    }
  });

  it('un LoopBack qui existe est UP dans les DEUX vues', async () => {
    // Il etait UP dans l'une et DOWN dans l'autre, sur la meme machine
    // au meme instant.
    for (const [fabrique, port] of [[routeur, 'LoopBack0'], [commutateur, 'LoopBack0']] as const) {
      const d = await fabrique();
      expect(await d.executeCommand(`display interface ${port}`)).toContain('current state : UP');
      expect(await d.executeCommand(`display ip interface ${port}`)).toContain('current state : UP');
    }
  });

  it('l\'adresse est rendue en longueur de prefixe, pas en masque pointe', async () => {
    const r = await routeur();
    for (const vue of ['display interface', 'display ip interface']) {
      const bloc = await r.executeCommand(`${vue} GigabitEthernet0/0/0`);
      expect(bloc, vue).toContain('10.0.12.1/24');
      expect(bloc, vue).not.toContain('255.255.255.0/');
      expect(bloc, vue).not.toContain('/255.255.255.0');
    }
  });
});

// ── Un nom, toutes ses ecritures ──────────────────────────────────

const ECRITURES = (type: string, num: string) => [
  `${type}${num}`, `${type} ${num}`,
  `${type.toLowerCase()}${num}`, `${type.toUpperCase()}${num}`,
  `${type.toLowerCase()} ${num}`,
];

describe('un nom se resout de la meme facon partout', () => {
  it('routeur : toute ecriture legitime mene au nom canonique', async () => {
    for (const [type, num, canonique] of [
      ['GigabitEthernet', '0/0/0', 'GigabitEthernet0/0/0'],
      ['LoopBack', '0', 'LoopBack0'],
    ] as const) {
      for (const ecriture of [...ECRITURES(type, num), `gi${num}`, `loop${num}`]) {
        if (ecriture.startsWith('gi') && type !== 'GigabitEthernet') continue;
        if (ecriture.startsWith('loop') && type !== 'LoopBack') continue;
        for (const vue of ['display interface', 'display ip interface']) {
          const r = await routeur();
          const bloc = await r.executeCommand(`${vue} ${ecriture}`);
          expect(nom(bloc), `${vue} ${ecriture}`).toBe(canonique);
        }
      }
    }
  });

  it('switch : la meme regle, y compris sur les interfaces virtuelles', async () => {
    for (const [type, num, canonique] of [
      ['GigabitEthernet', '0/0/1', 'GigabitEthernet0/0/1'],
      ['Vlanif', '10', 'Vlanif10'],
      ['LoopBack', '0', 'LoopBack0'],
    ] as const) {
      for (const ecriture of ECRITURES(type, num)) {
        for (const vue of ['display interface', 'display ip interface']) {
          const s = await commutateur();
          const bloc = await s.executeCommand(`${vue} ${ecriture}`);
          expect(nom(bloc), `${vue} ${ecriture}`).toBe(canonique);
        }
      }
    }
  });

  it('les deux plateformes acceptent les MEMES ecritures', async () => {
    for (const ecriture of ['GigabitEthernet0/0/0', 'GigabitEthernet 0/0/0',
      'gigabitethernet0/0/0', 'gi0/0/0', 'g 0/0/0',
      'LoopBack0', 'LoopBack 0', 'loopback0', 'loop0', 'loop 0']) {
      const cible = ecriture.replace(/0\/0\/0/, '0/0/1');
      const r = await routeur();
      const s = await commutateur();
      const refusR = (await r.executeCommand(`display interface ${ecriture}`)).startsWith('Error:');
      const refusS = (await s.executeCommand(`display interface ${cible}`)).startsWith('Error:');
      expect(refusS, `${ecriture} : refuse d'un cote seulement`).toBe(refusR);
      expect(refusR, ecriture).toBe(false);
    }
  });

  it('le nom court interne ne sort jamais a l\'ecran', async () => {
    const r = await routeur();
    for (const vue of ['display interface', 'display ip interface',
      'display interface brief', 'display ip interface brief']) {
      const bloc = await r.executeCommand(
        vue.endsWith('brief') ? vue : `${vue} GigabitEthernet0/0/0`);
      expect(bloc, vue).not.toMatch(/\bGE0\/0\/0\b/);
    }
  });
});

describe('ce qui n\'existe pas reste refuse', () => {
  it('un type inconnu, un numero inexistant', async () => {
    for (const [fabrique, formes] of [
      [routeur, ['zzz0', 'GigabitEthernet9/9/9', 'LoopBack 7']],
      [commutateur, ['zzz0', 'Vlanif 99', 'GigabitEthernet9/9/9']],
    ] as const) {
      for (const forme of formes) {
        for (const vue of ['display interface', 'display ip interface']) {
          const d = await fabrique();
          expect(await d.executeCommand(`${vue} ${forme}`), `${vue} ${forme}`)
            .toMatch(/^Error: Wrong parameter found at '\^' position\./);
        }
      }
    }
  });

  it('un refus ne rend jamais la saisie comme si elle etait un nom', async () => {
    const s = await commutateur();
    const bloc = await s.executeCommand('display interface vlanif99');
    expect(bloc).not.toContain('vlanif99 current state');
  });
});
