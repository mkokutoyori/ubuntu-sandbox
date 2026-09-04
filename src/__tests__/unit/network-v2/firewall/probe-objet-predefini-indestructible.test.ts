/**
 * Un objet predefini ne se supprime pas, et le lot precedent venait de
 * rendre ce defaut ATTEIGNABLE.
 *
 * Tant que les services et adresses predefinis n'etaient pas dans
 * l'arbre de configuration, `delete HTTP` repondait « does not exist »
 * et il n'y avait rien a proteger. Les y avoir semes ouvre la porte :
 * mesure aussitot apres, `config firewall service custom` / `delete
 * HTTP` REUSSIT en silence — trente-quatre services restent sur
 * trente-cinq — et `purge` vide la table entiere, adresse `all`
 * comprise. Sur une vraie machine ces entrees viennent de l'image du
 * micrologiciel et ne peuvent pas etre supprimees.
 *
 * **La declaration existait deja et n'avait qu'un lecteur.**
 * `spec.predefined` liste les cles protegees et n'etait consultee que
 * par la remise a l'etat d'usine, qui les epargne pour les recreer. Le
 * meme predicat garde desormais `delete` et `purge` — une ecriture,
 * trois lecteurs — plutot qu'une seconde liste a tenir d'accord.
 *
 * **L'ordre des deux refus n'est pas indifferent** : une entree
 * predefinie est refusee AVANT le controle des references, parce
 * qu'elle est indestructible qu'on la designe ou non dans une
 * politique — repondre « utilisee par d'autres entrees » enverrait
 * l'operateur retirer une reference qui ne changerait rien.
 *
 * Le texte du refus est celui de ce simulateur et non une phrase de
 * FortiOS : la documentation etablit que ces entrees ne se suppriment
 * pas, aucune transcription attestee ne donne le message exact, et
 * l'inventer aurait remplace un silence par une phrase fausse.
 *
 * Discrimine par `git stash push -- src/network/` : 4 des 6 cas
 * tombent. Les 2 restants sont nommes ici plutot que laisses a
 * decouvrir :
 *
 *   - « un objet ordinaire se supprime encore » et « une entree
 *     referencee est refusee pour sa reference » sont les deux gardes
 *     de non-regression : ils disent que la protection n'a pas deborde
 *     sur ce que `delete` faisait deja correctement.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import type { FortiShell } from '@/network/devices/firewall/vendors/fortios/FortiShell';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

function run(sh: FortiShell, ...lines: string[]): string {
  let last = '';
  for (const line of lines) last = sh.execute(line);
  return last;
}

function laboratoire() {
  const fw = new FortiGate('firewall-fortinet', 'FGT', 0, 0);
  const sh = fw.getShell() as FortiShell;
  run(sh, 'config firewall address',
    'edit "a1"', 'set subnet 10.1.0.0 255.255.0.0', 'next',
    'edit "a2"', 'set subnet 10.2.0.0 255.255.0.0', 'next', 'end');
  return { fw, sh };
}

describe('un objet predefini est indestructible', () => {
  it('`delete` d un service predefini est refuse', () => {
    const { fw, sh } = laboratoire();

    const sortie = run(sh, 'config firewall service custom', 'delete HTTP');
    sh.execute('end');

    expect(sortie).toContain('predefined and cannot be deleted');
    expect(sh.execute('show firewall service custom')).toContain('edit "HTTP"');
    expect(fw.getObjectStore().getService('HTTP')).toBeDefined();
  });

  it('`delete` d une adresse predefinie est refuse hors de toute reference', () => {
    const { sh } = laboratoire();

    const sortie = run(sh, 'config firewall address', 'delete all');
    sh.execute('end');

    expect(sortie).toContain('predefined and cannot be deleted');
    expect(sh.execute('show firewall address')).toContain('edit "all"');
  });

  it('`purge` garde les entrees predefinies et retire les autres', () => {
    const { sh } = laboratoire();

    run(sh, 'config firewall address', 'purge');
    sh.execute('end');

    const vue = sh.execute('show firewall address');
    expect(vue).toContain('edit "all"');
    expect(vue).not.toContain('edit "a1"');
    expect(vue).not.toContain('edit "a2"');
  });

  it('`purge` laisse les services predefinis en place', () => {
    const { fw, sh } = laboratoire();
    run(sh, 'config firewall service custom', 'edit "MIEN"',
      'set tcp-portrange 9999', 'next', 'end');

    run(sh, 'config firewall service custom', 'purge');
    sh.execute('end');

    const vue = sh.execute('show firewall service custom');
    expect(vue).toContain('edit "ALL"');
    expect(vue).not.toContain('edit "MIEN"');
    expect(fw.getObjectStore().getService('MIEN')).toBeUndefined();
  });

  it('un objet ordinaire se supprime encore', () => {
    const { fw, sh } = laboratoire();

    run(sh, 'config firewall address', 'delete a1');
    sh.execute('end');

    expect(sh.execute('show firewall address')).not.toContain('edit "a1"');
    expect(fw.getObjectStore().getAddress('a1')).toBeUndefined();
  });

  it('une entree referencee est refusee pour sa reference', () => {
    const { sh } = laboratoire();
    run(sh, 'config firewall addrgrp', 'edit "grp"',
      'set member "a1"', 'next', 'end');

    const sortie = run(sh, 'config firewall address', 'delete a1');
    sh.execute('end');

    expect(sortie).toContain('used by other entries');
  });
});
