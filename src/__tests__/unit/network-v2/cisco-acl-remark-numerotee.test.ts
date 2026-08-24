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
 *   8. Elle PARAIT dans `show access-lists`, a sa place et sans numero
 *      de sequence — demande explicite de l'utilisateur. La forme est
 *      celle que la vue IPv6 de ce depot emploie DEJA
 *      (`showIPv6AccessLists` : `    remark <texte>`), de sorte que les
 *      deux vues ne puissent pas se contredire.
 *   9. La forme NOMMEE parait de la meme facon.
 *  10. `?` offre `remark` a cote de `permit` et `deny`.
 *  11. Un numero hors des quatre plages recoit le refus d'IOS.
 *  12. La forme numerotee est acceptee sur le COMMUTATEUR.
 *  13. TEMOIN : la forme NOMMEE fonctionnait deja et fonctionne encore.
 *  14. TEMOIN : une action inventee reste refusee.
 *
 * Deux discriminations, parce que la fonction a ete livree en deux lots.
 *
 * Contre le depot AVANT le premier lot (l'acceptation de la forme
 * numerotee), `git stash push -- src/network/` fait tomber 5 cas. Les
 * 5 qui passent des DEUX cotes sont nommes ici, et aucun ne prouve la
 * fonction :
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
 *
 * Contre le depot avant le SECOND lot (l'affichage et la declaration
 * des quatre plages), la meme manoeuvre fait tomber 3 cas : les deux
 * affichages et l'aide. « Un numero hors des quatre plages » passe des
 * deux cotes et ne prouve rien du lot : la place etait deja declaree
 * `<1-2699>`, donc 3000 etait deja refuse — par une plage inventee, que
 * ce lot remplace par les quatre vraies.
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

  it('parait dans `show access-lists`, a sa place et sans numero', async () => {
    const r = await routeur();
    await tape(r, ...LISTE);

    const vu = await tape(r, 'do show access-lists 10');

    expect(vu.split('\n')).toEqual([
      'Standard IP access list 10',
      '    remark Autoriser le LAN admin',
      '    10 permit 192.168.20.0, wildcard bits 0.0.0.255',
      '    remark Refuser le reste',
      '    20 deny   any',
    ]);
  });

  it('la forme NOMMEE parait de la meme facon', async () => {
    const r = await routeur();
    await tape(r, 'ip access-list extended FILTRE',
      'remark Bloquer telnet', 'deny tcp any any eq 23', 'exit');

    const vu = await tape(r, 'do show access-lists FILTRE');

    expect(vu.split('\n')).toEqual([
      'Extended IP access list FILTRE',
      '    remark Bloquer telnet',
      '    10 deny tcp any any eq 23',
    ]);
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

  it('`?` offre `remark` a cote de `permit` et `deny`', async () => {
    const r = await routeur();

    const aide = await tape(r, 'access-list 10 ?');

    expect(aide.split('\n')).toEqual([
      '  deny    Specify packets to reject',
      '  permit  Specify packets to forward',
      '  remark  Access list entry comment',
    ]);
  });

  it('un numero hors des quatre plages recoit le refus d IOS', async () => {
    const r = await routeur();

    const refus = await tape(r, 'access-list 3000 remark Rien');

    expect(refus).toContain("% Invalid input detected at '^' marker.");
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
