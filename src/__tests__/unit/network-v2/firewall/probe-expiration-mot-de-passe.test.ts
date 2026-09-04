/**
 * Un mot de passe d'administrateur n'expirait jamais.
 *
 * `config system password-policy` porte `expire-status` et `expire-day`
 * — la reference 6.0.4 les declare (« Enable/disable password
 * expiration », « Number of days after which passwords expire (1 - 999
 * days, default = 90) ») — et les DEUX etaient acceptes, rendus par
 * `show system password-policy`, donc rejoues a l'import d'une
 * topologie, et lus par PERSONNE. La commande la plus visible d'une
 * politique de mots de passe ne faisait rien, en silence.
 *
 * Elle ne POUVAIT pas etre lue : `PasswordHistory` retenait le SECRET
 * et pas la DATE, donc rien sur la machine ne savait quand un mot de
 * passe avait ete pose. C'est la brique qui manquait, et c'est une
 * ligne : `remember` prend l'instant et `changedAt` le rend.
 *
 * **Le reste du chemin existait deja**, et c'est ce qui rend le
 * correctif petit : `requiresPasswordChange` est ce que la session de
 * connexion consulte pour forcer la saisie d'un nouveau mot de passe —
 * le mecanisme qui, au premier demarrage, oblige a en choisir un. Un
 * mot de passe expire emprunte le MEME chemin, et c'est ce que fait une
 * vraie machine : elle n'INTERDIT pas la connexion, elle la fait suivre
 * d'un changement obligatoire ; un cas l'epingle, sans quoi un
 * correctif trop large aurait verrouille le compte.
 *
 * `expire-day` gagne l'`availableWhen` que la reference decrit
 * explicitement (« This option only appears when expire-status is
 * enabled »), et l'expiration n'est armee que si la politique elle-meme
 * est active — `status disable` rend toute la politique inerte, y
 * compris cette moitie-la.
 *
 * Discrimine par `git stash push -- src/network/` : 2 des 9 cas
 * tombent, et c'est exact plutot que decevant — le defaut etait
 * UNIQUE, un reglage lu par personne, donc un seul cas peut l'observer
 * et tout le reste garde qu'on ne l'a pas paye trop cher. Les 7
 * restants sont nommes ici plutot que laisses a decouvrir :
 *
 *   - « le compte est utilisable des sa creation » est le TEMOIN ;
 *   - « la politique est acceptee et rendue » passait deja, et c'est
 *     l'enonce meme du defaut : accepte, rendu, lu par personne ;
 *   - « sans expiration », « avant le delai », « une politique
 *     desactivee » et « changer le mot de passe repart du jour meme »
 *     passaient par VACUITE, aucun mot de passe n'expirant jamais ;
 *     ils valent desormais pour le commutateur, le delai, la garde de
 *     `status` et la remise a zero ;
 *   - « un mot de passe expire AUTHENTIFIE encore » est la garde qui
 *     exige qu'on n'ait pas verrouille le compte au passage — c'est ce
 *     qu'une vraie machine fait, et c'est justement ce qu'un correctif
 *     trop large aurait casse.
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

const JOUR_MS = 24 * 60 * 60 * 1000;

function laboratoire(...politique: string[]) {
  const fw = new FortiGate('firewall-fortinet', 'FGT', 0, 0);
  const sh = fw.getShell() as FortiShell;

  if (politique.length > 0) run(sh, 'config system password-policy', ...politique, 'end');
  run(sh, 'config system admin', 'edit "bob"', 'set password "Abcdef1!"',
    'set accprofile "super_admin"', 'next', 'end');

  return { fw, sh };
}

function avance(fw: FortiGate, jours: number): void {
  fw.getSystemClock().set(fw.now() + jours * JOUR_MS);
}

describe('expiration du mot de passe administrateur', () => {
  it('le compte est utilisable des sa creation', () => {
    const { fw } = laboratoire();

    expect(fw.authenticateAdmin('bob', 'Abcdef1!')).toBe(true);
    expect(fw.adminMustChoosePassword('bob')).toBe(false);
  });

  it('la politique est acceptee et rendue', () => {
    const { sh } = laboratoire('set status enable', 'set expire-status enable',
      'set expire-day 5');

    expect(sh.execute('show system password-policy'))
      .toContain('set expire-day 5');
  });

  it('sans expiration, le mot de passe ne vieillit pas', () => {
    const { fw } = laboratoire('set status enable');
    avance(fw, 400);

    expect(fw.adminMustChoosePassword('bob')).toBe(false);
  });

  it('avant le delai, le mot de passe est encore bon', () => {
    const { fw } = laboratoire('set status enable', 'set expire-status enable',
      'set expire-day 5');
    avance(fw, 4);

    expect(fw.adminMustChoosePassword('bob')).toBe(false);
  });

  it('passe le delai, un nouveau mot de passe est exige', () => {
    const { fw } = laboratoire('set status enable', 'set expire-status enable',
      'set expire-day 5');
    avance(fw, 6);

    expect(fw.adminMustChoosePassword('bob')).toBe(true);
  });

  it('un mot de passe expire AUTHENTIFIE encore', () => {
    const { fw } = laboratoire('set status enable', 'set expire-status enable',
      'set expire-day 5');
    avance(fw, 6);

    expect(fw.authenticateAdmin('bob', 'Abcdef1!')).toBe(true);
  });

  it('changer le mot de passe repart du jour meme', () => {
    const { fw, sh } = laboratoire('set status enable', 'set expire-status enable',
      'set expire-day 5');
    avance(fw, 6);
    run(sh, 'config system admin', 'edit "bob"', 'set password "Zyxwvu2@"',
      'next', 'end');

    expect(fw.adminMustChoosePassword('bob')).toBe(false);
  });

  it('une politique desactivee n_arme pas l_expiration', () => {
    const { fw } = laboratoire('set status disable', 'set expire-status enable',
      'set expire-day 5');
    avance(fw, 400);

    expect(fw.adminMustChoosePassword('bob')).toBe(false);
  });

  it('expire-day n_est offert que sous expire-status', () => {
    const { sh } = laboratoire();
    sh.execute('config system password-policy');

    expect(sh.execute('set ?')).not.toContain('expire-day');
    sh.execute('set expire-status enable');
    expect(sh.execute('set ?')).toContain('expire-day');
  });
});
