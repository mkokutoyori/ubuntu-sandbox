/**
 * Les niveaux de privilège, vérifiés là où ils DÉCIDENT.
 *
 * Écrite après une sonde profonde demandée par l'utilisateur. Le premier
 * relevé, superficiel, donnait le mécanisme pour bon : `configure
 * terminal` était bien refusé au niveau 7. Trois défauts sérieux se
 * cachaient derrière, tous présents sur les deux plateformes.
 *
 * 1. **Une escalade de privilège par `end`.** Une session montée à
 *    `enable 10` a le droit d'entrer en configuration si l'opérateur le
 *    lui a donné ; son `end` la déposait en mode privilégié COMPLET.
 *    `reload` et `write memory` — réservés au niveau 15 — passaient
 *    alors, pendant que `show privilege` continuait d'annoncer 10 : le
 *    mode et le niveau se contredisaient sur la même session au même
 *    instant, et c'est le mode qui décidait. La machine à états ne
 *    remonte que la hiérarchie des MODES, elle ne connaît pas le niveau.
 * 2. **`privilege exec level N` n'agissait que dans un sens.** Il
 *    AJOUTAIT au socle du niveau 1 les commandes privilégiées accordées,
 *    et ne retirait jamais celles qu'on avait HISSÉES :
 *    `privilege exec level 7 ping` était accepté, rendu dans la
 *    configuration, et `ping` restait disponible au niveau 1. La moitié
 *    du chapitre « qui a le droit de faire quoi » ne faisait rien.
 * 3. **`disable <niveau>` n'existait pas** — donc la seconde moitié de
 *    l'escalade temporaire (monter à 15, puis REDESCENDRE) répondait au
 *    caret et laissait l'opérateur à 15 en croyant en être redescendu.
 *
 * Ce qui a été mesuré et trouvé JUSTE, donc laissé tel quel : la porte
 * `enable` demande et vérifie réellement le mot de passe sur le chemin
 * du terminal (dernier bloc). Le chemin scripté `executeCommand` ne
 * demande rien, et c'est assumé — rien ne pourrait répondre à une invite
 * là où personne ne tape.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoTerminalSession } from '@/terminal/sessions';
import type { KeyEvent } from '@/terminal/sessions/TerminalSession';
import { MACAddress, resetCounters } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  EquipmentRegistry.resetInstance();
  Logger.clear();
});

const tick = () => new Promise((r) => setTimeout(r, 0));
const key = (k: string): KeyEvent =>
  ({ key: k, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false }) as KeyEvent;

const REFUS = '% Invalid input';
type Machine = CiscoSwitch | CiscoRouter;

const PLATEFORMES: Array<[string, () => Machine]> = [
  ['switch', () => new CiscoSwitch('SW1')],
  ['routeur', () => new CiscoRouter('R1', 0, 0)],
];

/** Une machine avec le jeu de rôles du tutoriel : 7 technicien, 10 admin, 15 complet. */
async function roles(fabrique: () => Machine): Promise<Machine> {
  const d = fabrique();
  d.powerOn();
  for (const c of [
    'enable', 'configure terminal',
    'privilege exec level 7 show running-config',
    'privilege exec level 7 ping',
    'privilege exec level 10 configure terminal',
    'privilege exec level 10 write memory',
    'privilege exec level 15 reload',
    'enable secret level 7 Tech7',
    'enable secret level 10 Adm10',
    'enable secret Admin15',
    'end', 'disable',
  ]) await d.executeCommand(c);
  return d;
}

for (const [nom, fabrique] of PLATEFORMES) {
  describe(`${nom} — un niveau AUTORISE ce qui lui revient`, () => {
    it('le socle du niveau 1 reste disponible', async () => {
      const d = await roles(fabrique);
      expect(await d.executeCommand('show version')).toContain('Cisco IOS Software');
      expect(await d.executeCommand('show privilege')).toContain('level is 1');
    }, 30_000);

    it('une commande DESCENDUE au niveau 7 y devient disponible', async () => {
      const d = await roles(fabrique);
      // Niveau 15 de naissance : elle n'existe pas au niveau 1.
      expect(await d.executeCommand('show running-config')).toContain(REFUS);
      await d.executeCommand('enable 7');
      expect(await d.executeCommand('show running-config')).toContain('Current configuration');
    }, 30_000);

    it('chaque palier ouvre exactement ce qui lui a été donné', async () => {
      const d = await roles(fabrique);
      await d.executeCommand('enable 7');
      expect(await d.executeCommand('configure terminal'), 'ct à 7').toContain(REFUS);
      expect(await d.executeCommand('reload'), 'reload à 7').toContain(REFUS);

      await d.executeCommand('enable 10');
      expect(await d.executeCommand('show privilege')).toContain('level is 10');
      expect(await d.executeCommand('configure terminal'), 'ct à 10').toContain('Enter configuration');
      await d.executeCommand('end');
      expect(await d.executeCommand('reload'), 'reload à 10').toContain(REFUS);

      await d.executeCommand('enable');
      expect(await d.executeCommand('show privilege')).toContain('level is 15');
      expect(await d.executeCommand('reload cancel'), 'reload à 15').toContain('Reload cancelled');
    }, 30_000);
  });

  describe(`${nom} — un niveau BLOQUE ce qu'on lui a retiré`, () => {
    /**
     * Le cas que la première sonde avait manqué : `ping` est une
     * commande de niveau 1 par nature. La hisser à 7 doit la RETIRER du
     * niveau 1, sans quoi la commande `privilege` ne sert qu'à
     * descendre.
     */
    it('une commande HISSÉE au niveau 7 disparaît du niveau 1', async () => {
      const d = await roles(fabrique);
      expect(await d.executeCommand('ping 10.0.0.1')).toContain(REFUS);
      await d.executeCommand('enable 7');
      expect(await d.executeCommand('ping 10.0.0.1')).not.toContain(REFUS);
    }, 30_000);

    /**
     * L'escalade. `end` déposait la session en mode privilégié complet
     * quel que soit le niveau d'où elle venait — et `show privilege`
     * continuait d'annoncer le bon niveau, donc rien ne le signalait.
     */
    it('`end` depuis la configuration ne fait pas monter au niveau 15', async () => {
      const d = await roles(fabrique);
      await d.executeCommand('enable 10');
      await d.executeCommand('configure terminal');
      await d.executeCommand('end');
      expect(await d.executeCommand('show privilege')).toContain('level is 10');
      expect(await d.executeCommand('reload'), 'reload après end').toContain(REFUS);
      expect(await d.executeCommand('erase startup-config'), 'erase après end').toContain(REFUS);
    }, 30_000);

    it('`exit` depuis la configuration non plus', async () => {
      const d = await roles(fabrique);
      await d.executeCommand('enable 10');
      await d.executeCommand('configure terminal');
      await d.executeCommand('exit');
      expect(await d.executeCommand('reload')).toContain(REFUS);
    }, 30_000);

    /**
     * La règle la plus LONGUE décide, comme dans l'arbre d'IOS. Sans ce
     * choix, l'ordre d'insertion trancherait — donc le comportement
     * dépendrait de l'ordre de frappe de l'opérateur.
     */
    it('la règle la plus précise l\'emporte sur la plus générale', async () => {
      const d = fabrique();
      d.powerOn();
      for (const c of ['enable', 'configure terminal',
        'privilege exec level 5 show',
        'privilege exec level 12 show running-config',
        'end', 'disable', 'enable 5']) await d.executeCommand(c);
      expect(await d.executeCommand('show version'), 'show générique à 5').not.toContain(REFUS);
      expect(await d.executeCommand('show running-config'), 'la règle longue gagne').toContain(REFUS);
    }, 30_000);
  });

  describe(`${nom} — redescendre est une manœuvre à part entière`, () => {
    it('`disable <niveau>` ramène au palier demandé', async () => {
      const d = await roles(fabrique);
      await d.executeCommand('enable');
      expect(await d.executeCommand('show privilege')).toContain('level is 15');
      await d.executeCommand('disable 7');
      expect(await d.executeCommand('show privilege')).toContain('level is 7');
      expect(await d.executeCommand('reload')).toContain(REFUS);
    }, 30_000);

    it('`disable` nu ramène au niveau 1', async () => {
      const d = await roles(fabrique);
      await d.executeCommand('enable');
      await d.executeCommand('disable');
      expect(await d.executeCommand('show privilege')).toContain('level is 1');
    }, 30_000);

    /**
     * `disable` ne fait jamais MONTER — sinon ce serait un `enable` sans
     * mot de passe, c'est-à-dire la porte qu'on vient de poser, ouverte
     * par une autre commande.
     */
    it('`disable` ne fait jamais monter', async () => {
      const d = await roles(fabrique);
      await d.executeCommand('enable 7');
      expect(await d.executeCommand('disable 15')).toContain(REFUS);
      expect(await d.executeCommand('show privilege')).toContain('level is 7');
    }, 30_000);
  });
}

describe('la porte `enable` demande et vérifie le mot de passe', () => {
  async function sessionAuNiveau1(): Promise<{ d: CiscoRouter; s: CiscoTerminalSession }> {
    const d = new CiscoRouter('R1', 0, 0);
    d.powerOn();
    for (const c of ['enable', 'configure terminal',
      'enable secret TresSecret', 'enable secret level 7 Sept', 'end', 'disable',
    ]) await d.executeCommand(c);
    const s = new CiscoTerminalSession('t1', d as never);
    await s.init();
    for (let i = 0; i < 40 && s.isBooting; i++) await tick();
    await tick();
    return { d, s };
  }

  async function tape(s: CiscoTerminalSession, cmd: string): Promise<void> {
    s.setInput(cmd);
    s.handleKey(key('Enter'));
    for (let i = 0; i < 30 && s.currentInputMode.type === 'normal'; i++) await tick();
  }

  /**
   * Le niveau tel que LA SESSION le voit. Une session de terminal porte
   * son propre etat de vty : interroger l'appareil par
   * `executeCommand` lit une AUTRE session, celle de la console
   * scriptee, qui n'a pas tape le mot de passe. Mes deux premiers cas
   * posaient la question au mauvais objet et rendaient donc toujours 1 —
   * ils auraient passe pour la mauvaise raison si la porte avait ete
   * cassee dans l'autre sens.
   */
  async function niveauVuParLaSession(s: CiscoTerminalSession): Promise<string> {
    const avant = s.lines.length;
    s.setInput('show privilege');
    s.handleKey(key('Enter'));
    for (let i = 0; i < 30; i++) await tick();
    return s.lines.slice(avant).map((l) => l.text).join('\n');
  }

  it('`enable` ouvre une invite au lieu d\'accorder tout de suite', async () => {
    const { s } = await sessionAuNiveau1();
    await tape(s, 'enable');
    expect(s.currentInputMode.type).toBe('password');
  }, 30_000);

  it('un mauvais mot de passe est REFUSÉ et le niveau ne bouge pas', async () => {
    const { s } = await sessionAuNiveau1();
    await tape(s, 'enable');
    s.setPasswordBuf('pas-le-bon');
    s.handleKey(key('Enter'));
    for (let i = 0; i < 30; i++) await tick();
    expect(s.lines.map((l) => l.text).join('\n')).toContain('% Access denied');
    expect(await niveauVuParLaSession(s)).toContain('level is 1');
  }, 30_000);

  it('le bon mot de passe ouvre — la porte n\'est pas une souricière', async () => {
    const { s } = await sessionAuNiveau1();
    await tape(s, 'enable');
    s.setPasswordBuf('TresSecret');
    s.handleKey(key('Enter'));
    for (let i = 0; i < 30; i++) await tick();
    expect(await niveauVuParLaSession(s)).toContain('level is 15');
  }, 30_000);

  it('`enable 7` vérifie le secret DE CE NIVEAU, pas celui de 15', async () => {
    const { s } = await sessionAuNiveau1();
    await tape(s, 'enable 7');
    s.setPasswordBuf('TresSecret');
    s.handleKey(key('Enter'));
    for (let i = 0; i < 30; i++) await tick();
    expect(await niveauVuParLaSession(s)).toContain('level is 1');

    await tape(s, 'enable 7');
    s.setPasswordBuf('Sept');
    s.handleKey(key('Enter'));
    for (let i = 0; i < 30; i++) await tick();
    expect(await niveauVuParLaSession(s)).toContain('level is 7');
  }, 30_000);
});
