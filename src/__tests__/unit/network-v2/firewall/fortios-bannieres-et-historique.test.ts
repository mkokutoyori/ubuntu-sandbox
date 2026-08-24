/**
 * La banniere s'AFFICHE et s'ACCEPTE, un mot de passe ne se REUTILISE pas.
 *
 * Deux entrees `[durcissement]` de `TODO.md`, dont les premisses sont a
 * corriger :
 *
 *   — « la banniere s'affiche, la session s'ouvre sans rien demander » :
 *     en fait `LoginBanners` est ecrit et LU PAR PERSONNE, donc aucune
 *     banniere ne parait, sur aucune porte.
 *   — « il faudrait garder les N derniers mots de passe, ce qu'aucun
 *     equipement de ce depot ne fait » : le magasin de comptes existe,
 *     il lui manque de garder les N derniers.
 *
 * Ecrite A L'AVEUGLE contre ce que fait un vrai FortiGate :
 *
 *   1. `set pre-login-banner enable` fait paraitre le texte AVANT que
 *      les identifiants soient demandes.
 *   2. Sans le reglage, rien ne parait.
 *   3. `set post-login-banner enable` fait paraitre le texte APRES
 *      l'authentification et demande de l'accepter — un vrai FortiGate
 *      ecrit le texte puis `(Press 'a' to accept):`, transcription lue
 *      sur rancid-discuss 2018-10 et sur les rapports oxidized #2021,
 *      netmiko #2775 et paramiko #2034.
 *   4. Refuser ferme la session : on n'atteint pas l'invite.
 *   5. Accepter — la lettre `a` — ouvre la session normalement.
 *   6. `set reuse-password disable` cesse d'etre refuse.
 *   7. Reprendre le mot de passe PRECEDENT est alors refuse.
 *   8. Un mot de passe jamais employe est accepte.
 *   9. `reuse-password-limit` est le NOMBRE DE REPRISES tolerees pour un
 *      meme mot de passe (0-20, defaut 0), et non une profondeur de
 *      memoire : « Number of times the password for system
 *      administrators or local users can be reused », FortiOS 7.6.0
 *      « Customizable password reuse thresholds ». La profondeur est
 *      `user-history-password-threshold` (3-15, defaut 3), sous
 *      `config system global`, et la limite ne peut pas la depasser.
 *  10. `min-change-characters` compte les caracteres du NOUVEAU mot de
 *      passe qui n'existent pas dans l'ancien — « Minimum number of
 *      unique characters in new password which do not exist in old
 *      password » — et non une difference position par position : un
 *      mot de passe RETOURNE ne change donc aucun caractere.
 *  11. TEMOIN : avec `reuse-password enable` — le defaut — reprendre
 *      l'ancien reste permis, sinon on aurait durci sans le demander.
 *
 * Discrimine par `git stash push -- src/network/` : 10 cas tombent avant
 * correctif. Les 5 qui passent des DEUX cotes sont nommes ici plutot que
 * laisses a decouvrir, aucun ne prouvant le mecanisme :
 *
 *   — « sans le reglage, rien ne parait » : avant correctif AUCUNE
 *     banniere ne paraissait jamais, donc ce cas passait pour la raison
 *     meme qui rendait la fonction absente ; il garde contre un faux
 *     positif, il n'atteste rien.
 *   — « accepter la banniere ouvre la session » : sans acceptation, la
 *     premiere ligne tapee tombait directement sur l'invite du pare-feu.
 *   — « un mot de passe jamais employe est accepte » et « au-dela des
 *     mots gardes, l'ancien sort de la memoire » : avant correctif RIEN
 *     n'etait jamais refuse, donc une acceptation etait indiscernable
 *     d'une absence de controle.
 *   — le TEMOIN, dont c'est l'objet de passer des deux cotes.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { FortiShell } from '@/network/devices/firewall/vendors/fortios/FortiShell';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { LinuxTerminalSession } from '@/terminal/sessions/LinuxTerminalSession';
import type { TerminalSession, KeyEvent } from '@/terminal/sessions/TerminalSession';

const MOT_DE_PASSE = 'SecretInitial1';
const BANNIERE_AVANT = 'ACCES RESERVE AUX PERSONNES AUTORISEES';
const BANNIERE_APRES = 'Toute utilisation est enregistree.';

function key(k: string): KeyEvent {
  return { key: k, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false };
}

const tick = () => new Promise<void>((r) => setTimeout(r, 25));

function run(sh: FortiShell, ...lines: string[]): string {
  let last = '';
  for (const line of lines) last = sh.execute(line);
  return last;
}

interface Cmd { executeCommand(cmd: string): Promise<string> }

const runOn = (d: Cmd, cmds: string[]) =>
  cmds.reduce(async (p, c) => { await p; await d.executeCommand(c); },
    Promise.resolve<unknown>(undefined));

async function laboratoire() {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
  EquipmentRegistry.resetInstance();

  const fw = new FortiGate('firewall-fortinet', 'FGT', 0, 0);
  const sh = fw.getShell();
  const poste = new LinuxPC('linux-pc', 'PC', 200, 0);
  poste.powerOn();
  new Cable('c1').connect(fw.getPort('port1')!, poste.getPorts()[0]);

  run(sh,
    'config system interface',
    'edit "port1"', 'set mode static',
    'set ip 192.168.1.1 255.255.255.0',
    'set allowaccess ping ssh telnet', 'next', 'end',
    'config system admin', 'edit "admin"',
    `set password "${MOT_DE_PASSE}"`, 'next', 'end');

  await runOn(poste, ['ip link set eth0 up', 'ip addr add 192.168.1.50/24 dev eth0']);

  return { fw, sh, poste };
}

function poserBanniere(sh: FortiShell, stage: 'pre' | 'post', texte: string): void {
  run(sh,
    `config system replacemsg admin "${stage}_admin-disclaimer-text"`,
    `set buffer "${texte}"`, 'end',
    'config system global', `set ${stage}-login-banner enable`, 'end');
}

async function ouvrirSsh(poste: LinuxPC): Promise<TerminalSession> {
  const host = new LinuxTerminalSession('h', poste);
  await host.init?.();
  host.setInput('ssh admin@192.168.1.1');
  host.handleKey(key('Enter'));
  for (let i = 0; i < 12 && host.currentInputMode.type !== 'password'; i++) await tick();
  return host;
}

async function repondre(host: TerminalSession, texte: string): Promise<void> {
  if (host.currentInputMode.type === 'password') host.setPasswordBuf(texte);
  else { host.foreground.setInput(texte); host.foreground.setInputBuf(texte); }
  host.handleKey(key('Enter'));
  for (let i = 0; i < 12; i++) await tick();
}

function transcription(host: TerminalSession): string {
  return host.lines.map(l => (typeof l === 'string' ? l : l.text ?? '')).join('\n');
}

function surLePareFeu(host: TerminalSession): boolean {
  return /FGT\b.*#/.test(host.foreground.getPrompt());
}

beforeEach(() => { Logger.reset(); });

describe('les bannieres d administration paraissent', () => {
  it('`pre-login-banner` parait AVANT les identifiants', async () => {
    const { sh, poste } = await laboratoire();
    poserBanniere(sh, 'pre', BANNIERE_AVANT);

    const host = await ouvrirSsh(poste);

    expect(transcription(host)).toContain(BANNIERE_AVANT);
  });

  it('sans le reglage, rien ne parait', async () => {
    const { poste } = await laboratoire();

    const host = await ouvrirSsh(poste);

    expect(transcription(host)).not.toContain(BANNIERE_AVANT);
  });

  it('`post-login-banner` parait APRES l authentification et demande', async () => {
    const { sh, poste } = await laboratoire();
    poserBanniere(sh, 'post', BANNIERE_APRES);

    const host = await ouvrirSsh(poste);
    await repondre(host, MOT_DE_PASSE);

    expect(transcription(host)).toContain(BANNIERE_APRES);
    expect(surLePareFeu(host)).toBe(false);
    expect(host.foreground.getPrompt()).toContain("(Press 'a' to accept)");
  });

  it('refuser la banniere ferme la session', async () => {
    const { sh, poste } = await laboratoire();
    poserBanniere(sh, 'post', BANNIERE_APRES);

    const host = await ouvrirSsh(poste);
    await repondre(host, MOT_DE_PASSE);
    await repondre(host, 'non');

    expect(surLePareFeu(host)).toBe(false);
    expect(host.foreground.getPrompt()).not.toContain('accept');
    expect(transcription(host)).toMatch(/closed|logout|Connection to/i);
  });

  it('accepter la banniere ouvre la session', async () => {
    const { sh, poste } = await laboratoire();
    poserBanniere(sh, 'post', BANNIERE_APRES);

    const host = await ouvrirSsh(poste);
    await repondre(host, MOT_DE_PASSE);
    await repondre(host, 'a');

    expect(surLePareFeu(host)).toBe(true);
  });
});

describe('un mot de passe ne se reutilise pas', () => {
  function politique(sh: FortiShell, ...extra: string[]): string {
    return run(sh,
      'config system password-policy',
      'set status enable',
      'set apply-to admin-password',
      'set minimum-length 8',
      ...extra,
      'end');
  }

  function changer(sh: FortiShell, mot: string): string {
    return run(sh,
      'config system admin', 'edit "admin"', `set password "${mot}"`, 'next', 'end');
  }

  it('`set reuse-password disable` cesse d etre refuse', async () => {
    const { sh } = await laboratoire();

    expect(politique(sh, 'set reuse-password disable'))
      .not.toMatch(/not implemented|Command fail/i);
    expect(run(sh, 'show system password-policy'))
      .toContain('set reuse-password disable');
  });

  it('reprendre le mot de passe PRECEDENT est refuse', async () => {
    const { sh } = await laboratoire();
    politique(sh, 'set reuse-password disable');
    changer(sh, 'SecretDeuxieme2');

    const refus = changer(sh, MOT_DE_PASSE);

    expect(refus).toMatch(/reuse|already been used|previous/i);
  });

  it('un mot de passe jamais employe est accepte', async () => {
    const { sh } = await laboratoire();
    politique(sh, 'set reuse-password disable');

    expect(changer(sh, 'SecretTroisieme3')).not.toMatch(/reuse|already been used/i);
  });

  it('`reuse-password-limit` autorise ce nombre de reprises, pas une de plus',
    async () => {
      const { sh } = await laboratoire();
      politique(sh, 'set reuse-password disable', 'set reuse-password-limit 1');

      changer(sh, 'SecretDeuxieme2');
      const premiereReprise = changer(sh, MOT_DE_PASSE);
      changer(sh, 'SecretTroisieme3');
      const secondeReprise = changer(sh, MOT_DE_PASSE);

      expect(premiereReprise).not.toMatch(/already been used/i);
      expect(secondeReprise).toMatch(/already been used/i);
    });

  it('`min-change-characters` compare au mot de passe PRECEDENT', async () => {
    const { sh } = await laboratoire();
    politique(sh, 'set min-change-characters 5');

    const refus = changer(sh, 'SecretInitial2');

    expect(refus).toMatch(/does not contain/i);
  });

  it('`min-change-characters` compte les caracteres ABSENTS de l ancien', async () => {
    const { sh } = await laboratoire();
    politique(sh, 'set min-change-characters 5');

    const refus = changer(sh, [...MOT_DE_PASSE].reverse().join(''));

    expect(refus).toMatch(/does not contain/i);
  });

  it('`reuse-password-limit` ne depasse pas le nombre de mots gardes', async () => {
    const { sh } = await laboratoire();

    const refus = politique(sh, 'set reuse-password disable',
      'set reuse-password-limit 8');

    expect(refus).toMatch(/user-history-password-threshold/);
  });

  it('au-dela des mots gardes, l ancien sort de la memoire', async () => {
    const { sh } = await laboratoire();
    politique(sh, 'set reuse-password disable');

    for (const mot of ['SecretDeuxieme2', 'SecretTroisieme3', 'SecretQuatrieme4']) {
      changer(sh, mot);
    }

    expect(changer(sh, MOT_DE_PASSE)).not.toMatch(/already been used/i);
  });

  it('`user-history-password-threshold` allonge la memoire', async () => {
    const { sh } = await laboratoire();
    run(sh, 'config system global', 'set user-history-password-threshold 5', 'end');
    politique(sh, 'set reuse-password disable');

    for (const mot of ['SecretDeuxieme2', 'SecretTroisieme3', 'SecretQuatrieme4']) {
      changer(sh, mot);
    }

    expect(changer(sh, MOT_DE_PASSE)).toMatch(/already been used/i);
  });

  it('TEMOIN : avec `reuse-password enable`, reprendre l ancien reste permis',
    async () => {
      const { sh } = await laboratoire();
      politique(sh);
      changer(sh, 'SecretDeuxieme2');

      expect(changer(sh, MOT_DE_PASSE)).not.toMatch(/reuse|already been used/i);
    });
});
