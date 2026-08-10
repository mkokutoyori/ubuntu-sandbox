/**
 * Ctrl+C n'ouvre pas la porte.
 *
 * Signalé par l'utilisateur : depuis l'interface, Ctrl+C à l'invite de
 * connexion donnait le shell. La cause n'était pas dans le flux de
 * connexion mais dans le traitement GÉNÉRAL de la touche : `Ctrl+C`
 * pendant un flux faisait `flowEngine = null` puis rendait la main au
 * prompt normal. Pour un flux ordinaire — un `ssh` qui demande un mot de
 * passe, une confirmation — c'est le bon comportement. Pour le flux de
 * connexion, « le prompt normal » EST le shell authentifié.
 *
 * Ce que cette sonde vérifie, et la nuance qui compte : il ne suffit pas
 * que la session refuse la commande. Il faut que l'INVITE revienne —
 * sans quoi on aurait remplacé un contournement par une session morte.
 *
 * Les deux formes de `login` sont couvertes parce qu'elles empruntent
 * deux flux différents, et que la seconde n'existait pas du tout :
 * `login` seul (mot de passe de ligne) était déclaré hors périmètre, si
 * bien que le tout premier verrou d'un cours de sécurité était
 * configuré, rendu dans la configuration, et n'invitait à rien.
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

/**
 * Attend BORNÉ que l'invite revienne. Le flux passe par le courtier
 * d'entrée, qui est asynchrone : une seule micro-tâche ne suffit pas.
 * La borne est ce qui garde la sonde discriminante — si la porte ne
 * revient jamais, la boucle s'épuise et l'assertion qui suit échoue.
 */
async function attendInvite(s: CiscoTerminalSession): Promise<void> {
  for (let i = 0; i < 50 && s.currentInputMode.type === 'normal'; i++) await tick();
}
const key = (k: string, ctrl = false): KeyEvent =>
  ({ key: k, ctrlKey: ctrl, shiftKey: false, altKey: false, metaKey: false }) as KeyEvent;

type Machine = CiscoSwitch | CiscoRouter;

async function verrouille(d: Machine, forme: 'local' | 'password'): Promise<void> {
  const cmds = ['enable', 'configure terminal'];
  if (forme === 'local') {
    cmds.push('username jean-baptiste privilege 1 secret MotDePasseJB2024!');
    cmds.push('line console 0', 'login local');
  } else {
    cmds.push('line console 0', 'password MonPremierMotDePasse', 'login');
  }
  cmds.push('exit', 'end');
  for (const c of cmds) await d.executeCommand(c);
}

async function sessionConsole(d: Machine): Promise<CiscoTerminalSession> {
  const s = new CiscoTerminalSession('t1', d as never);
  await s.init();
  for (let i = 0; i < 40 && s.isBooting; i++) await tick();
  await tick();
  return s;
}

function texte(s: CiscoTerminalSession): string {
  return s.lines.map((l) => l.text).join('\n');
}

const PLATEFORMES: Array<[string, () => Machine]> = [
  ['switch', () => new CiscoSwitch('SW1')],
  ['routeur', () => new CiscoRouter('R1', 0, 0)],
];

for (const [nom, fabrique] of PLATEFORMES) {
  describe(`${nom} — la porte de connexion ne se contourne pas`, () => {
    for (const forme of ['local', 'password'] as const) {
      const etiquette = forme === 'local' ? 'login local' : 'login (mot de passe de ligne)';

      it(`\`${etiquette}\` : Ctrl+C RELANCE l'invite au lieu d'ouvrir`, async () => {
        const d = fabrique();
        d.powerOn();
        await verrouille(d, forme);
        const s = await sessionConsole(d);

        // L'invite est bien posée — sans quoi la suite ne prouverait rien.
        expect(texte(s)).toContain('User Access Verification');
        expect(s.currentInputMode.type).not.toBe('normal');

        s.handleKey(key('c', true));
        await attendInvite(s);

        // Le contournement : on se retrouvait au shell. Ce qui doit se
        // produire est que l'invite REVIENNE.
        expect(s.currentInputMode.type).not.toBe('normal');
        expect(texte(s).match(/User Access Verification/g)?.length ?? 0)
          .toBeGreaterThanOrEqual(2);
      }, 30_000);

      it(`\`${etiquette}\` : la session reste NON authentifiée après Ctrl+C`, async () => {
        const d = fabrique();
        d.powerOn();
        await verrouille(d, forme);
        const s = await sessionConsole(d);
        s.handleKey(key('c', true));
        await tick();
        expect((s as unknown as { authenticatedUsername: string | null })
          .authenticatedUsername).toBeNull();
      }, 30_000);
    }

    /**
     * Le témoin. Sans lui, une session qui ne démarre AUCUN flux
     * passerait les cas ci-dessus pour la mauvaise raison — « on n'est
     * pas revenu au prompt normal » est trivialement vrai quand il n'y a
     * jamais eu d'invite.
     */
    it('sans `login` configuré, il n\'y a pas de porte et Ctrl+C reste ordinaire', async () => {
      const d = fabrique();
      d.powerOn();
      const s = await sessionConsole(d);
      expect(texte(s)).not.toContain('User Access Verification');
      s.handleKey(key('c', true));
      await tick();
      expect(s.currentInputMode.type).toBe('normal');
    }, 30_000);

    it('le bon mot de passe ouvre : la porte n\'est pas une souricière', async () => {
      const d = fabrique();
      d.powerOn();
      await verrouille(d, 'password');
      const s = await sessionConsole(d);
      s.setPasswordBuf('MonPremierMotDePasse');
      s.handleKey(key('Enter'));
      for (let i = 0; i < 20 && s.currentInputMode.type !== 'normal'; i++) await tick();
      expect(s.currentInputMode.type).toBe('normal');
      expect(texte(s)).not.toContain('% Login invalid');
    }, 30_000);

    it('un mauvais mot de passe est refusé et l\'invite revient', async () => {
      const d = fabrique();
      d.powerOn();
      await verrouille(d, 'password');
      const s = await sessionConsole(d);
      s.setPasswordBuf('pas-le-bon');
      s.handleKey(key('Enter'));
      for (let i = 0; i < 20; i++) await tick();
      expect(texte(s)).toContain('% Login invalid');
      expect(s.currentInputMode.type).not.toBe('normal');
    }, 30_000);
  });
}
