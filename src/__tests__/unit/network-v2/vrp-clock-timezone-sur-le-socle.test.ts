/**
 * VRP : `clock timezone` acceptait a peu pres n'importe quoi.
 *
 * Mesure de depart, en vue systeme d'un routeur Huawei : `clock timezone`
 * seul, `clock timezone zorglub`, `clock timezone Paris add` — tous
 * acceptes, tous rendant la chaine VIDE, c'est-a-dire un succes.
 * `clock timezone Paris zorglub 01:00` etait accepte AVEC un decalage
 * positif, parce que le gestionnaire lisait « tout ce qui n'est pas
 * `minus` » comme `add` : un mot inconnu devenait donc une direction.
 * `clock timezone Paris add 25:00` passait aussi, 25 heures etant une
 * heure que `\\d{1,2}` accepte. Et un mot en trop derriere une commande
 * valide etait ignore en silence.
 *
 * Deux consequences au-dela du refus. **La configuration rendue ne
 * reproduisait pas ce que VRP ecrit** : `clock timezone Paris add 1:00`
 * la ou une vraie machine ecrit `add 01:00:00` — le commentaire du
 * gestionnaire citait pourtant cette forme exacte, et le rendu, trois
 * fichiers plus loin, la contredisait. Cela depasse l'affichage, la
 * configuration rendue etant rejouee a l'import d'une topologie. Et
 * **`undo clock timezone` etait accepte sans rien annuler** : le fuseau
 * survivait a sa propre annulation.
 *
 * **Sur le COMMUTATEUR, la commande etait acceptee et n'avait aucun
 * effet du tout** — `display clock` repondait UTC apres l'avoir posee.
 * Les deux plateformes partagent desormais la meme famille, donc le meme
 * verdict.
 *
 * La famille passe au socle, ou la grammaire est DECLAREE :
 * `clock timezone <nom> {add|minus} HH:MM:SS`. Le gestionnaire du trie
 * qui la lisait a la main est supprime, et le rendu appelle la meme
 * fonction que l'analyse — deux formes du meme decalage ne peuvent plus
 * diverger.
 *
 * **Corrige dans le pont, et c'etait necessaire** : un enregistrement
 * GOURMAND du trie (`registerGreedy('clock', …)`) accepte tout ce qui
 * commence par son mot-cle, donc il masquait le refus du socle — les
 * cinq formes fautives restaient acceptees apres la migration.
 * `VrpSocle.refusalBeforeTrie()` pose la question AVANT le trie, et
 * seulement quand le socle a reconnu le chemin : argument mal forme,
 * commande incomplete dont deux mots-cles sont deja consommes, ou mot en
 * trop derriere une commande qu'il connait entierement. Toute autre
 * issue laisse la main au trie, ce que `clock datetime` verifie.
 *
 * Discrimine par `git stash` des fichiers touches : 8 des 11 cas
 * tombent. Les 3 qui passent des deux cotes sont nommes ici plutot que
 * laisses a decouvrir — `clock datetime`, le TEMOIN qui montre que le
 * trie garde ce qu'il est seul a connaitre, et les deux poses nominales
 * (`add` et `minus`), qui marchaient deja et servent de non-regression.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { HuaweiSwitch } from '@/network/devices/HuaweiSwitch';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => { resetCounters(); resetDeviceCounters(); Logger.reset(); });

async function routeur(): Promise<HuaweiRouter> {
  const r = new HuaweiRouter('R1');
  r.powerOn();
  await r.executeCommand('system-view');
  return r;
}

const fuseau = async (r: HuaweiRouter | HuaweiSwitch) =>
  (await r.executeCommand('display clock'));

describe('VRP : la grammaire de `clock timezone` est declaree', () => {
  it('TEMOIN — `clock datetime` reste au trie', async () => {
    const r = await routeur();

    expect(await r.executeCommand('clock datetime 10:00:00 2026-01-01')).toBe('');
  });

  it('sans argument, la commande est incomplete', async () => {
    const r = await routeur();

    expect(await r.executeCommand('clock timezone')).toContain('Incomplete command');
  });

  it('un nom seul est incomplet — il manque la direction et le decalage', async () => {
    const r = await routeur();

    expect(await r.executeCommand('clock timezone Paris')).toContain('Incomplete command');
  });

  it('une direction inconnue est refusee au lieu de valoir `add`', async () => {
    const r = await routeur();

    expect(await r.executeCommand('clock timezone Paris zorglub 01:00'))
      .toContain('Wrong parameter');
  });

  it('un decalage hors plage est refuse', async () => {
    const r = await routeur();

    expect(await r.executeCommand('clock timezone Paris add 25:00')).toContain('Wrong parameter');
    expect(await r.executeCommand('clock timezone Paris add 01:70')).toContain('Wrong parameter');
  });

  it('un mot en trop est refuse au lieu d etre jete', async () => {
    const r = await routeur();

    expect(await r.executeCommand('clock timezone Paris add 01:00 extra'))
      .toContain('Wrong parameter');
  });

  it('une forme valide est posee et lue par `display clock`', async () => {
    const r = await routeur();

    expect(await r.executeCommand('clock timezone Paris add 01:00')).toBe('');

    await r.executeCommand('return');
    expect(await fuseau(r)).toContain('Time Zone(Paris) : UTC add 01:00:00');
  });

  it('`minus` decale bien dans l autre sens', async () => {
    const r = await routeur();
    await r.executeCommand('clock timezone Halifax minus 04:00');

    await r.executeCommand('return');
    expect(await fuseau(r)).toContain('Time Zone(Halifax) : UTC minus 04:00:00');
  });

  it('la configuration rendue est celle que VRP ecrit', async () => {
    const r = await routeur();
    await r.executeCommand('clock timezone Paris add 01:00');

    expect(await r.executeCommand('display current-configuration'))
      .toContain('clock timezone Paris add 01:00:00');
  });

  it('`undo clock timezone` revient a UTC', async () => {
    const r = await routeur();
    await r.executeCommand('clock timezone Paris add 01:00');

    expect(await r.executeCommand('undo clock timezone')).toBe('');

    await r.executeCommand('return');
    expect(await fuseau(r)).toContain('Time Zone(UTC)');
  });

  it('le COMMUTATEUR pose vraiment le fuseau, et refuse pareil', async () => {
    const sw = new HuaweiSwitch('switch-huawei', 'SW');
    sw.powerOn();
    await sw.executeCommand('system-view');

    expect(await sw.executeCommand('clock timezone Paris zorglub 01:00'))
      .toContain('Wrong parameter');
    await sw.executeCommand('clock timezone Paris add 01:00');

    await sw.executeCommand('return');
    expect(await fuseau(sw)).toContain('Time Zone(Paris) : UTC add 01:00:00');
  });
});
