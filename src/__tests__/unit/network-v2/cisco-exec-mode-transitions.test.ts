/**
 * Passer du mode privilégié au mode utilisateur : ce qu'IOS fait
 * vraiment, vérifié contre sa documentation et non de mémoire.
 *
 * Trois comportements, tous contre-intuitifs, tous mesurés faux ici
 * avant ce fichier.
 *
 * 1. **`exit` depuis un mode EXEC TERMINE LA SESSION.** Depuis un mode
 *    de configuration il remonte d'un cran ; depuis `>` comme depuis
 *    `#` il déconnecte, exactement comme `logout`. Ce n'est pas `exit`
 *    qui fait redescendre de `#` à `>`, c'est `disable`, et lui seul.
 *    Le mode utilisateur fermait bien ; le mode privilégié ne faisait
 *    RIEN — la commande rendait la main sans un mot et laissait la
 *    session au niveau 15. Un opérateur qui tape `exit` en croyant
 *    avoir quitté ses droits d'administration les gardait.
 * 2. **`enable` laisse TROIS essais, puis abandonne sur
 *    `% Bad secrets`** et rend la main au mode utilisateur — il ne
 *    ferme pas la ligne, et le nombre d'essais n'est pas réglable. Le
 *    refus était à un seul coup : l'invite ne revenait jamais, il
 *    fallait retaper `enable` à chaque essai, ce qu'aucune machine
 *    réelle ne demande, et `% Bad secrets` n'existait nulle part.
 * 3. **Sans mot de passe d'activation, la console passe et une ligne
 *    RÉSEAU est refusée** (`% No password set`). C'est une distinction
 *    de sécurité et non de commodité : une vty joignable depuis le
 *    réseau ne doit pas offrir le mode privilégié à qui sait taper
 *    `enable`, alors qu'un accès console suppose déjà d'être devant la
 *    machine. Les deux portes se comportaient pareil.
 *
 * Sources : le guide « Configuring Security with Passwords, Privileges,
 * and Logins » et les références de commandes `disable` / `exit`.
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

type Machine = CiscoSwitch | CiscoRouter;
const PLATEFORMES: Array<[string, () => Machine]> = [
  ['switch', () => new CiscoSwitch('SW1')],
  ['routeur', () => new CiscoRouter('R1', 0, 0)],
];

for (const [nom, fabrique] of PLATEFORMES) {
  describe(`${nom} — sortir d'un mode EXEC, c'est se déconnecter`, () => {
    it('`exit` depuis le mode privilégié ferme la session', async () => {
      const d = fabrique();
      d.powerOn();
      await d.executeCommand('enable');
      expect(await d.executeCommand('exit')).toBe('Connection closed.');
    }, 30_000);

    it('`logout` dit la même chose — ce sont deux orthographes d\'un geste', async () => {
      const d = fabrique();
      d.powerOn();
      await d.executeCommand('enable');
      expect(await d.executeCommand('logout')).toBe('Connection closed.');
    }, 30_000);

    it('`exit` depuis le mode utilisateur ferme aussi', async () => {
      const d = fabrique();
      d.powerOn();
      expect(await d.executeCommand('exit')).toBe('Connection closed.');
    }, 30_000);

    /**
     * La contrepartie, et c'est elle qui rend la règle utile : depuis un
     * mode de CONFIGURATION, `exit` remonte d'un cran au lieu de
     * déconnecter. Sans ce cas, on aurait pu « corriger » le premier en
     * fermant la session sur tous les `exit`.
     */
    it('mais `exit` depuis une configuration remonte d\'un cran', async () => {
      const d = fabrique();
      d.powerOn();
      await d.executeCommand('enable');
      await d.executeCommand('configure terminal');
      await d.executeCommand(nom === 'switch' ? 'interface FastEthernet0/1' : 'interface GigabitEthernet0/0');
      expect(await d.executeCommand('exit')).not.toContain('Connection closed');
      // Toujours en configuration : la preuve est qu'une commande de
      // configuration globale y est acceptée.
      expect(await d.executeCommand('hostname APRES-EXIT')).not.toContain('% Invalid input');
      expect(await d.executeCommand('exit')).not.toContain('Connection closed');
    }, 30_000);

    it('`disable` est le SEUL geste qui redescend de `#` à `>`', async () => {
      const d = fabrique();
      d.powerOn();
      await d.executeCommand('enable');
      expect(await d.executeCommand('show privilege')).toContain('level is 15');
      expect(await d.executeCommand('disable')).toBe('');
      expect(await d.executeCommand('show privilege')).toContain('level is 1');
    }, 30_000);
  });
}

describe('`enable` : trois essais, puis `% Bad secrets`', () => {
  async function sessionAuNiveau1(): Promise<{ d: CiscoRouter; s: CiscoTerminalSession }> {
    const d = new CiscoRouter('R1', 0, 0);
    d.powerOn();
    for (const c of ['enable', 'configure terminal', 'enable secret BonSecret', 'end', 'disable']) {
      await d.executeCommand(c);
    }
    const s = new CiscoTerminalSession('t1', d as never);
    await s.init();
    for (let i = 0; i < 40 && s.isBooting; i++) await tick();
    await tick();
    return { d, s };
  }

  async function refuse(s: CiscoTerminalSession): Promise<void> {
    s.setPasswordBuf('mauvais');
    s.handleKey(key('Enter'));
    for (let i = 0; i < 20; i++) await tick();
  }

  it('l\'invite REVIENT après un refus — sans retaper `enable`', async () => {
    const { s } = await sessionAuNiveau1();
    s.setInput('enable');
    s.handleKey(key('Enter'));
    for (let i = 0; i < 20 && s.currentInputMode.type === 'normal'; i++) await tick();
    expect(s.currentInputMode.type).toBe('password');

    await refuse(s);
    expect(s.currentInputMode.type, 'après le 1er refus').toBe('password');
    await refuse(s);
    expect(s.currentInputMode.type, 'après le 2e refus').toBe('password');
  }, 30_000);

  it('le troisième refus abandonne, et le message CHANGE', async () => {
    const { s } = await sessionAuNiveau1();
    s.setInput('enable');
    s.handleKey(key('Enter'));
    for (let i = 0; i < 20 && s.currentInputMode.type === 'normal'; i++) await tick();
    await refuse(s);
    await refuse(s);
    await refuse(s);

    const vu = s.lines.map((l) => l.text).join('\n');
    expect(vu).toContain('% Access denied');
    expect(vu).toContain('% Bad secrets');
    // IOS rend la main au mode utilisateur ; il ne ferme pas la ligne.
    expect(s.currentInputMode.type).toBe('normal');
    expect(vu).not.toContain('Connection closed');
  }, 30_000);

  it('le compteur est PAR invocation : un nouvel `enable` redonne trois essais', async () => {
    const { s } = await sessionAuNiveau1();
    for (const _ of [0, 1]) {
      s.setInput('enable');
      s.handleKey(key('Enter'));
      for (let i = 0; i < 20 && s.currentInputMode.type === 'normal'; i++) await tick();
      await refuse(s);
      expect(s.currentInputMode.type, 'l\'invite revient').toBe('password');
      await refuse(s);
      await refuse(s);
    }
    expect(s.lines.map((l) => l.text).join('\n').match(/% Bad secrets/g)?.length).toBe(2);
  }, 30_000);

  it('le bon mot de passe ouvre au premier essai', async () => {
    const { s } = await sessionAuNiveau1();
    s.setInput('enable');
    s.handleKey(key('Enter'));
    for (let i = 0; i < 20 && s.currentInputMode.type === 'normal'; i++) await tick();
    s.setPasswordBuf('BonSecret');
    s.handleKey(key('Enter'));
    for (let i = 0; i < 20; i++) await tick();
    expect(s.lines.map((l) => l.text).join('\n')).not.toContain('% Access denied');
    s.setInput('show privilege');
    s.handleKey(key('Enter'));
    for (let i = 0; i < 20; i++) await tick();
    expect(s.lines.map((l) => l.text).join('\n')).toContain('level is 15');
  }, 30_000);
});

/**
 * Sans mot de passe d'activation configuré, IOS distingue les deux
 * portes depuis toujours. La console passe — être devant la machine
 * est déjà une autorisation. Une vty est refusée, parce qu'elle est
 * joignable depuis le réseau.
 */
describe('`enable` sans secret : la console passe, la vty est refusée', () => {
  async function planPour(surVty: boolean): Promise<{ steps: Array<{ kind: string; lines?: string[] }> } | null> {
    const d = new CiscoRouter('R1', 0, 0);
    d.powerOn();
    const shell = (d as unknown as {
      getShell: () => {
        interactionPlanFor: (
          l: string, c: { mode: string; device: unknown; onVtyLine: boolean },
        ) => { steps: Array<{ kind: string; lines?: string[] }> } | null;
      };
    }).getShell();
    return shell.interactionPlanFor('enable', { mode: 'user', device: d, onVtyLine: surVty });
  }

  it('depuis la console : aucune invite, le mode privilégié s\'ouvre', async () => {
    expect(await planPour(false)).toBeNull();
    const d = new CiscoRouter('R2', 0, 0);
    d.powerOn();
    await d.executeCommand('enable');
    expect(await d.executeCommand('show privilege')).toContain('level is 15');
  }, 30_000);

  it('depuis une vty : `% No password set`', async () => {
    const plan = await planPour(true);
    expect(plan).not.toBeNull();
    expect(plan!.steps[0].kind).toBe('output');
    expect(plan!.steps[0].lines).toContain('% No password set');
  }, 30_000);

  it('une fois le secret posé, la vty demande le mot de passe au lieu de refuser', async () => {
    const d = new CiscoRouter('R3', 0, 0);
    d.powerOn();
    for (const c of ['enable', 'configure terminal', 'enable secret S', 'end', 'disable']) {
      await d.executeCommand(c);
    }
    const shell = (d as unknown as {
      getShell: () => {
        interactionPlanFor: (
          l: string, c: { mode: string; device: unknown; onVtyLine: boolean },
        ) => { steps: Array<{ kind: string }> } | null;
      };
    }).getShell();
    const plan = shell.interactionPlanFor('enable', { mode: 'user', device: d, onVtyLine: true });
    expect(plan!.steps[0].kind).toBe('password');
  }, 30_000);
});
