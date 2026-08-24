/**
 * `access-list <n> remark <texte>` existe, sur le routeur comme sur le
 * commutateur.
 *
 * MESURE de depart : la forme NOMMEE acceptait `remark` et la rendait
 * dans la configuration, mais la forme NUMEROTEE — la plus tapee de
 * toutes, celle de tous les cours — repondait `% Invalid action
 * "remark"` sur le routeur et `% Incomplete command.` sur le
 * commutateur. Le commentaire d'une liste numerotee etait donc
 * impossible a ecrire.
 *
 * Reference : « Commented IP Access List Entries » (Cisco IOS 15E) —
 * `access-list <n> remark <remark>`, remarque de 100 caracteres au
 * maximum, tronquee au-dela, placable avant OU apres l'instruction
 * qu'elle commente, et sans effet sur la logique de la liste.
 *
 *   1. La forme numerotee est acceptee sur le ROUTEUR.
 *   2. Elle est rendue dans la configuration, a sa place.
 *   3. Elle ne consomme AUCUN numero de sequence : les regles gardent
 *      10 et 20.
 *   4. La configuration rendue se REJOUE — c'est elle qui est relue a
 *      l'import d'une topologie.
 *   5. Un texte de plus de 100 caracteres est tronque.
 *   6. Une remarque vide est refusee plutot que rangee.
 *   7. `no access-list <n>` emporte les remarques avec les regles.
 *   8. La forme numerotee est acceptee sur le COMMUTATEUR.
 *   9. TEMOIN : la forme NOMMEE fonctionnait deja et fonctionne encore.
 *  10. TEMOIN : une action inventee reste refusee.
 *
 * Discrimine par `git stash push -- src/network/` : 5 cas tombent avant
 * correctif. Les 5 qui passent des DEUX cotes sont nommes ici, et aucun
 * ne prouve la fonction :
 *
 *   — les deux TEMOINS, dont c'est l'objet — l'action inventee, et la
 *     forme NOMMEE qui fonctionnait deja.
 *   — « ne consomme aucun numero de sequence » : avant correctif les
 *     remarques etaient REFUSEES, donc les regles gardaient 10 et 20
 *     pour la raison meme qui rendait la fonction absente.
 *   — « la configuration rendue se rejoue » : elle se rejouait, sans
 *     les remarques, puisqu'elles n'y etaient pas.
 *   — « `no access-list` emporte les remarques » : il n'y en avait
 *     aucune a emporter.
 */

import { describe, it, expect } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

interface Cmd { executeCommand(cmd: string): Promise<string> }

async function tape(device: Cmd, ...lignes: string[]): Promise<string> {
  const sorties: string[] = [];
  for (const ligne of lignes) sorties.push(await device.executeCommand(ligne));
  return sorties.filter(sortie => sortie !== '').join('\n');
}

function neuf() {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
  EquipmentRegistry.resetInstance();
}

async function routeur(): Promise<CiscoRouter> {
  neuf();
  const r = new CiscoRouter('R1', 0, 0);
  await tape(r, 'enable', 'configure terminal');
  return r;
}

async function commutateur(): Promise<CiscoSwitch> {
  neuf();
  const sw = new CiscoSwitch('switch-cisco', 'SW1', 8);
  await tape(sw, 'enable', 'configure terminal');
  return sw;
}

const LISTE = [
  'access-list 10 remark Autoriser le LAN admin',
  'access-list 10 permit 192.168.20.0 0.0.0.255',
  'access-list 10 remark Refuser le reste',
  'access-list 10 deny any',
];

describe('`access-list <n> remark` sur un routeur', () => {
  it('est acceptee', async () => {
    const r = await routeur();

    expect(await tape(r, ...LISTE)).toBe('');
  });

  it('est rendue dans la configuration, a sa place', async () => {
    const r = await routeur();
    await tape(r, ...LISTE);

    const vu = await tape(r, 'do show running-config | include access-list');

    expect(vu.split('\n')).toEqual(LISTE);
  });

  it('ne consomme aucun numero de sequence', async () => {
    const r = await routeur();
    await tape(r, ...LISTE);

    const vu = await tape(r, 'do show access-lists 10');

    expect(vu).toMatch(/^\s+10 permit/m);
    expect(vu).toMatch(/^\s+20 deny/m);
  });

  it('la configuration rendue se rejoue', async () => {
    const premier = await routeur();
    await tape(premier, ...LISTE);
    const rendu = await tape(premier, 'do show running-config | include access-list');

    const second = await routeur();
    await tape(second, ...rendu.split('\n'));

    expect(await tape(second, 'do show running-config | include access-list'))
      .toBe(rendu);
  });

  it('un texte de plus de 100 caracteres est tronque', async () => {
    const r = await routeur();
    const long = 'A'.repeat(140);
    await tape(r, `access-list 10 remark ${long}`);

    const vu = await tape(r, 'do show running-config | include access-list');

    expect(vu).toBe(`access-list 10 remark ${'A'.repeat(100)}`);
  });

  it('une remarque vide est refusee', async () => {
    const r = await routeur();

    expect(await tape(r, 'access-list 10 remark')).toMatch(/Incomplete/i);
    expect(await tape(r, 'do show running-config | include access-list')).toBe('');
  });

  it('`no access-list` emporte les remarques', async () => {
    const r = await routeur();
    await tape(r, ...LISTE);

    await tape(r, 'no access-list 10');

    expect(await tape(r, 'do show running-config | include access-list')).toBe('');
  });

  it('TEMOIN : une action inventee reste refusee', async () => {
    const r = await routeur();

    expect(await tape(r, 'access-list 10 zorglub 10.0.0.0 0.0.0.255'))
      .toMatch(/Invalid action/i);
  });
});

describe('`access-list <n> remark` sur un commutateur', () => {
  it('est acceptee et rendue', async () => {
    const sw = await commutateur();

    expect(await tape(sw, ...LISTE)).toBe('');
    expect(await tape(sw, 'do show running-config | include access-list')
      .then(vu => vu.split('\n'))).toEqual(LISTE);
  });
});

describe('TEMOIN : la forme nommee', () => {
  it('acceptait deja `remark` et l accepte encore', async () => {
    const r = await routeur();

    await tape(r, 'ip access-list extended FILTRE',
      'remark Bloquer telnet', 'deny tcp any any eq 23',
      'remark Tout le reste passe', 'permit ip any any', 'exit');

    const vu = await tape(r, 'do show running-config');

    expect(vu).toContain(' remark Bloquer telnet');
    expect(vu).toContain(' remark Tout le reste passe');
  });
});
