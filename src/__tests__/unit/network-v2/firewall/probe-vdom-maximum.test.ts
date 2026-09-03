/**
 * « Max number of virtual domains: 10 » etait un litteral que personne
 * n'appliquait.
 *
 * Mesure de depart : la ligne existe dans `get system status` depuis
 * toujours, et la machine acceptait quinze domaines virtuels sans un
 * mot — elle annoncait donc un maximum qu'elle contredisait elle-meme,
 * au meme instant. Le nombre etait ecrit en dur dans le shell, a un
 * endroit ou aucun chemin de creation ne pouvait le lire.
 *
 * Il vit desormais sur le PROFIL, comme les autres capacites du chassis,
 * et `FortiTableSpec.maxEntries` est le point ou une table declare son
 * plafond. Le refus tombe a `edit`, AVANT la creation, et non au commit :
 * `setActiveVdom` cree le contexte des qu'on entre dedans, donc un
 * controle pose au commit aurait juge un domaine deja ne. Le plafond est
 * une FONCTION du contexte et non une constante, parce qu'une licence le
 * releve — et le message est celui que FortiOS rend pour n'importe
 * quelle table pleine, ce qui rend le mecanisme reutilisable par la
 * suivante.
 *
 * `root` COMPTE dans les dix, ce qu'un cas epingle : neuf domaines
 * ajoutes passent, le dixieme est refuse. La confusion inverse serait
 * invisible tant qu'on ne compte pas.
 *
 * **`execute upd-vd-license` s'arrete la ou la mesure s'arrete.** La
 * commande est declaree, elle exige une cle de 32 caracteres — la
 * reference 6.0.4 le dit — et elle refuse une cle bien formee en NOMMANT
 * ce qui manque : le palier qu'elle accorde (25, 50, 100 ou 500 domaines
 * qui s'AJOUTENT a la base, note technique de Fortinet) est encode dans
 * la cle, et seul le serveur de licences de Fortinet le decode. Accepter
 * n'importe quelle chaine de 32 caracteres reviendrait a choisir le
 * palier au hasard, donc a ranger un critere que rien n'evalue.
 *
 * Discrimine par `git stash push` : 8 des 11 cas tombent. Les 3 autres
 * sont nommes ici plutot que laisses a decouvrir. « neuf domaines
 * ajoutes passent » et « re-editer un domaine existant fonctionne » sont
 * les TEMOINS de non-regression, dont c'est l'objet de passer des deux
 * cotes — sans eux un plafond pose trop bas serait indiscernable d'un
 * plafond juste. Et « le maximum annonce est 10 » passait deja, puisque
 * c'est justement le litteral que la machine affichait sans l'appliquer.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { FortiShell } from '@/network/devices/firewall/vendors/fortios/FortiShell';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

function banc() {
  const fw = new FortiGate('firewall-fortinet', 'FGT', 0, 0);
  return { fw, sh: new FortiShell(fw) };
}

function ajouter(sh: FortiShell, nom: string): string {
  sh.execute('config vdom');
  const verdict = sh.execute(`edit ${nom}`);
  sh.execute(verdict === '' ? 'end' : 'abort');
  if (verdict !== '') sh.execute('end');
  return verdict;
}

describe('le maximum de domaines virtuels', () => {
  it('est annonce a dix par `get system status`', () => {
    expect(banc().sh.execute('get system status'))
      .toContain('Max number of virtual domains: 10');
  });

  it('laisse passer les neuf domaines qui restent a cote de root', () => {
    const { sh } = banc();
    for (let i = 1; i <= 9; i++) expect(ajouter(sh, `v${i}`)).toBe('');
  });

  it('refuse le dixieme ajout, root comptant dans les dix', () => {
    const { sh } = banc();
    for (let i = 1; i <= 9; i++) ajouter(sh, `v${i}`);
    expect(ajouter(sh, 'v10')).toContain('maximum number of entries has been reached');
  });

  it('n\'en cree aucun au-dela de ce qu\'il annonce', () => {
    const { fw, sh } = banc();
    for (let i = 1; i <= 15; i++) ajouter(sh, `v${i}`);
    expect(fw.vdomNames()).toHaveLength(10);
    expect(fw.vdomNames()).toContain('root');
    expect(fw.vdomNames()).not.toContain('v10');
  });

  it('nomme le plafond dans son refus', () => {
    const { sh } = banc();
    for (let i = 1; i <= 9; i++) ajouter(sh, `v${i}`);
    expect(ajouter(sh, 'v10')).toContain('(10)');
  });

  it('le plafond applique est celui que la vue annonce', () => {
    const { fw, sh } = banc();
    const annonce = /Max number of virtual domains: (\d+)/
      .exec(sh.execute('get system status'));
    expect(annonce).not.toBeNull();
    expect(Number.parseInt(annonce![1], 10)).toBe(fw.maxVdoms());
  });

  it('re-editer un domaine EXISTANT reste possible au plafond', () => {
    const { sh } = banc();
    for (let i = 1; i <= 9; i++) ajouter(sh, `v${i}`);
    sh.execute('config vdom');
    expect(sh.execute('edit v3')).toBe('');
    sh.execute('end');
  });

  it('supprimer un domaine libere une place', () => {
    const { fw, sh } = banc();
    for (let i = 1; i <= 9; i++) ajouter(sh, `v${i}`);
    expect(ajouter(sh, 'v10')).not.toBe('');

    sh.execute('config vdom');
    sh.execute('delete v9');
    sh.execute('end');
    expect(ajouter(sh, 'v10')).toBe('');
    expect(fw.vdomNames()).toContain('v10');
  });

  it('`upd-vd-license` sans cle reclame une cle', () => {
    expect(banc().sh.execute('execute upd-vd-license'))
      .toContain('a license key is missing');
  });

  it('refuse une cle qui n\'a pas 32 caracteres', () => {
    const sortie = banc().sh.execute('execute upd-vd-license court');
    expect(sortie).toContain('value parse error');
    expect(sortie).toContain('32-character string');
  });

  it('refuse une cle bien formee en nommant le palier indecodable', () => {
    const sortie = banc().sh
      .execute('execute upd-vd-license 0123456789ABCDEF0123456789ABCDEF');
    expect(sortie).not.toContain('value parse error');
    expect(sortie).toContain('encoded inside the key');
  });
});
