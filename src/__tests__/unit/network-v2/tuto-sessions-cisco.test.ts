/**
 * Le tutoriel « Les Sessions sur Cisco », rejoue laboratoire par
 * laboratoire sur les DEUX plateformes.
 *
 * Ce que la mesure a trouve avant ce fichier — l'essentiel du tutoriel
 * fonctionnait deja (`show users`, `show who`, `show ssh`,
 * `show tcp brief`, `show sessions`, `resume`, `disconnect`,
 * `clear line`, `terminal length/width/history`, `exec-timeout`,
 * `access-class`, `transport input`, `line vty 5 15`,
 * `show archive log config`), et cinq points ne fonctionnaient pas :
 *
 * 1. **`show line <n>` ignorait son argument** et listait toutes les
 *    lignes — une reponse fausse a une question precise.
 * 2. **Le bloc de detail d'une ligne n'existait pas.** La commande
 *    rendait un tableau `Tty Line Speed Timeout` qui n'existe dans
 *    AUCUNE version d'IOS : une mise en page inventee, la ou le vrai
 *    bloc est ce qui dit a un operateur pourquoi sa session va tomber.
 * 3. **`absolute-timeout` etait refusee** — la seule commande qui borne
 *    la duree d'une session ACTIVE.
 * 4. **`escape-character` etait refusee.**
 * 5. **`send` n'existait pas** : le mot partait en resolution DNS, la
 *    machine prenant le nom d'une de ses propres commandes pour un nom
 *    d'hote. Et `session-timeout` / `history size` etaient acceptees,
 *    rangees sous des noms qu'aucun champ ne portait, donc perdues sans
 *    un mot — y compris a la relecture d'une topologie.
 *
 * ── Deux ecarts du tutoriel avec une vraie machine ────────────────────
 *
 * Ils sont pinces ici plutot que reproduits, parce qu'un simulateur qui
 * accepte une commande que le materiel refuse apprend une faute :
 *
 * - **`show line vty 0 detail`** : il n'existe pas de mot-cle `detail`.
 *   La syntaxe reelle est `show line [n [m]] | [{aux|console|tty|vty} n
 *   [m]] [summary]` — NOMMER une ligne demande deja le detail, et
 *   `summary` est le seul suffixe accepte.
 * - **`send all` et `send line vty 0`** : les formes reelles sont
 *   `send *` et `send vty 0`.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
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

type Machine = CiscoRouter | CiscoSwitch;
const PLATEFORMES: Array<[string, () => Machine]> = [
  ['routeur', () => new CiscoRouter('R1', 0, 0)],
  ['switch', () => new CiscoSwitch('SW1')],
];

async function priv(d: Machine): Promise<Machine> {
  d.powerOn();
  await d.executeCommand('enable');
  return d;
}

async function conf(d: Machine, ...cmds: string[]): Promise<void> {
  await d.executeCommand('configure terminal');
  for (const c of cmds) await d.executeCommand(c);
  await d.executeCommand('end');
}

for (const [nom, fabrique] of PLATEFORMES) {
  // ── Partie 3 — voir les sessions ──────────────────────────────────

  describe(`${nom} — partie 3 : voir les sessions`, () => {
    it('`show users` et `show who` sont deux orthographes d\'une vue', async () => {
      const d = await priv(fabrique());
      const users = await d.executeCommand('show users');
      const who = await d.executeCommand('show who');
      expect(users).toContain('Line');
      expect(users).toContain('Idle');
      expect(who).toBe(users);
    }, 30_000);

    it('`show users` marque la session courante d\'une etoile', async () => {
      const d = await priv(fabrique());
      expect(await d.executeCommand('show users')).toMatch(/^\*/m);
    }, 30_000);

    it('`show line` liste console, AUX et les vty, avec la colonne Modem', async () => {
      const d = await priv(fabrique());
      const out = await d.executeCommand('show line');
      // L'en-tete reel porte `Modem` entre `A` et `Roty` ; il manquait.
      expect(out).toContain('Tty Typ');
      expect(out).toContain('Modem');
      expect(out).toContain('Roty');
      expect(out).toContain('AccO');
      expect(out).toContain('AccI');
      expect(out).toContain('Overruns');
      expect(out).toContain('CTY');
      expect(out).toContain('AUX');
      expect(out).toContain('VTY');
    }, 30_000);

    it('`show line vty 0` rend la ligne de resume PUIS le bloc de detail', async () => {
      const d = await priv(fabrique());
      const out = await d.executeCommand('show line vty 0');
      expect(out).toContain('Tty Typ');
      // Le bloc, avec les intitules reels d'IOS.
      expect(out).toContain('Line 2, Location: ""');
      expect(out).toContain('Special Chars: Escape');
      expect(out).toContain('Timeouts:      Idle EXEC    Idle Session');
      expect(out).toContain('Session limit is not set.');
      expect(out).toContain('Time since activation: never');
      expect(out).toContain('History is enabled, history size is 10.');
      expect(out).toContain('Allowed input transports are');
    }, 30_000);

    it('`show line <n>` ne repond QUE sur la ligne demandee', async () => {
      const d = await priv(fabrique());
      const out = await d.executeCommand('show line 2');
      expect(out).toContain('Line 2,');
      // La console est la ligne 0 : elle ne doit pas paraitre.
      expect(out).not.toContain('CTY');
      expect(out).not.toContain('Line 0,');
    }, 30_000);

    it('`summary` est le seul suffixe : il coupe le detail', async () => {
      const d = await priv(fabrique());
      const out = await d.executeCommand('show line vty 0 4 summary');
      expect(out).toContain('VTY');
      expect(out).not.toContain('Session limit');
    }, 30_000);

    /**
     * Le mot-cle `detail` du tutoriel n'existe sur aucune machine. Le
     * refuser est le comportement reel — l'accepter apprendrait une
     * commande que le materiel rejette.
     */
    it('`show line vty 0 detail` est REFUSE, comme sur une vraie machine', async () => {
      const d = await priv(fabrique());
      expect(await d.executeCommand('show line vty 0 detail')).toContain('% Invalid input');
    }, 30_000);

    it('une CONSOLE n\'accepte aucun transport entrant', async () => {
      const d = await priv(fabrique());
      const out = await d.executeCommand('show line 0');
      expect(out).toContain('Allowed input transports are none.');
    }, 30_000);

    it('`show ssh` et `show tcp brief` repondent', async () => {
      const d = await priv(fabrique());
      expect(await d.executeCommand('show ssh')).toMatch(/SSH|connections/i);
      expect(await d.executeCommand('show tcp brief')).toContain('Local Address');
    }, 30_000);
  });

  // ── Partie 4 — les delais ─────────────────────────────────────────

  describe(`${nom} — partie 4 : les delais`, () => {
    it('`exec-timeout 15 0` se lit dans le bloc de detail', async () => {
      const d = await priv(fabrique());
      await conf(d, 'line vty 0 4', 'exec-timeout 15 0');
      expect(await d.executeCommand('show line vty 0')).toContain('00:15:00');
    }, 30_000);

    /**
     * `exec-timeout 0 0` veut dire JAMAIS, pas zero seconde. Rendre
     * `00:00:00` ferait lire une ligne qui tombe immediatement —
     * l'inverse exact de ce que l'operateur a demande.
     */
    it('`exec-timeout 0 0` se lit `never`, pas `00:00:00`', async () => {
      const d = await priv(fabrique());
      await conf(d, 'line vty 0 4', 'exec-timeout 0 0');
      const out = await d.executeCommand('show line vty 0');
      expect(out).toMatch(/Idle EXEC[\s\S]*?never/);
      expect(out).not.toContain('00:00:00');
    }, 30_000);

    it('`absolute-timeout 480` est acceptee, rendue et affichee', async () => {
      const d = await priv(fabrique());
      await conf(d, 'line vty 0 4', 'absolute-timeout 480');
      expect(await d.executeCommand('show running-config')).toContain(' absolute-timeout 480');
      expect(await d.executeCommand('show line vty 0')).toContain('Session limit is 480 minutes.');
    }, 30_000);

    it('`session-timeout 5` est rendue et affichee — elle etait perdue', async () => {
      const d = await priv(fabrique());
      await conf(d, 'line vty 0 4', 'session-timeout 5');
      expect(await d.executeCommand('show running-config')).toContain(' session-timeout 5');
      expect(await d.executeCommand('show line vty 0')).toContain('00:05:00');
    }, 30_000);

    it('une valeur non numerique est refusee au lieu d\'etre rangee', async () => {
      const d = await priv(fabrique());
      await d.executeCommand('configure terminal');
      await d.executeCommand('line vty 0 4');
      expect(await d.executeCommand('absolute-timeout abc')).toContain('% Invalid input');
      await d.executeCommand('end');
    }, 30_000);
  });

  // ── Partie 5 — sessions sortantes et echappement ──────────────────

  describe(`${nom} — partie 5 : sessions sortantes`, () => {
    it('`show sessions` repond quand aucune n\'est ouverte', async () => {
      const d = await priv(fabrique());
      expect(await d.executeCommand('show sessions')).toContain('No connections open');
    }, 30_000);

    it('`resume` et `disconnect` repondent sans connexion', async () => {
      const d = await priv(fabrique());
      expect(await d.executeCommand('resume 1')).toContain('No connection');
      expect(await d.executeCommand('disconnect 1')).toContain('No information');
    }, 30_000);

    it('`escape-character 27` est acceptee, rendue, et affichee `^[`', async () => {
      const d = await priv(fabrique());
      await conf(d, 'line vty 0 4', 'escape-character 27');
      expect(await d.executeCommand('show running-config')).toContain(' escape-character 27');
      expect(await d.executeCommand('show line vty 0')).toContain('^[');
    }, 30_000);

    it('`escape-character none` supprime la suspension de session', async () => {
      const d = await priv(fabrique());
      await conf(d, 'line vty 0 4', 'escape-character none');
      const out = await d.executeCommand('show line vty 0');
      expect(out).toMatch(/Special Chars[\s\S]*?none/);
      expect(out).not.toContain('^^x');
    }, 30_000);

    it('la sequence par defaut se lit `^^x` — Ctrl+Shift+6 puis X', async () => {
      const d = await priv(fabrique());
      expect(await d.executeCommand('show line vty 0')).toContain('^^x');
    }, 30_000);
  });

  // ── Partie 6 — parametres de session ──────────────────────────────

  describe(`${nom} — partie 6 : parametres de session`, () => {
    it('`terminal length 0` et `terminal width 132` prennent effet', async () => {
      const d = await priv(fabrique());
      await d.executeCommand('terminal length 0');
      await d.executeCommand('terminal width 132');
      const out = await d.executeCommand('show terminal');
      expect(out).toContain('Length: 0 lines, Width: 132 columns');
    }, 30_000);

    it('`terminal history size 50` prend effet', async () => {
      const d = await priv(fabrique());
      await d.executeCommand('terminal history size 50');
      expect(await d.executeCommand('show terminal')).toContain('history size is 50');
    }, 30_000);

    it('`terminal monitor` / `terminal no monitor` sont acceptees', async () => {
      const d = await priv(fabrique());
      expect(await d.executeCommand('terminal monitor')).not.toContain('% Invalid');
      expect(await d.executeCommand('terminal no monitor')).not.toContain('% Invalid');
    }, 30_000);

    it('`show history` rend les commandes tapees', async () => {
      const d = await priv(fabrique());
      await d.executeCommand('show users');
      expect(await d.executeCommand('show history')).toContain('show users');
    }, 30_000);

    it('`history size 20` sur la ligne est rendue et affichee', async () => {
      const d = await priv(fabrique());
      await conf(d, 'line vty 0 4', 'history size 20');
      expect(await d.executeCommand('show running-config')).toContain(' history size 20');
      expect(await d.executeCommand('show line vty 0')).toContain('history size is 20');
    }, 30_000);

    /**
     * `no history` COUPE l'historique ; ce n'est pas `history size 0`,
     * qui en demande un de taille nulle. Les deux etaient confondus dans
     * le neant : ni l'un ni l'autre n'etait range.
     */
    it('`no history` coupe l\'historique et se distingue de `history size 0`', async () => {
      const d = await priv(fabrique());
      await conf(d, 'line vty 0 4', 'no history');
      expect(await d.executeCommand('show running-config')).toContain(' no history');
      expect(await d.executeCommand('show line vty 0')).toContain('History is disabled.');
    }, 30_000);
  });

  // ── Partie 7 — gerer les sessions des autres ──────────────────────

  describe(`${nom} — partie 7 : gerer les sessions des autres`, () => {
    it('`clear line vty 0` demande confirmation', async () => {
      const d = await priv(fabrique());
      expect(await d.executeCommand('clear line vty 0')).toContain('[confirm]');
    }, 30_000);

    it('`clear line 0` refuse — on ne coupe pas sa propre console', async () => {
      const d = await priv(fabrique());
      expect(await d.executeCommand('clear line 0')).toContain('% Not allowed to clear that line');
    }, 30_000);

    it('`send` EXISTE — le mot ne part plus en resolution DNS', async () => {
      const d = await priv(fabrique());
      const out = await d.executeCommand('send *');
      expect(out).not.toContain('Translating');
      expect(out).not.toContain('Unknown command');
    }, 30_000);

    /**
     * Les formes du tutoriel (`send all`, `send line vty 0`) n'existent
     * sur aucune machine : les accepter apprendrait une faute.
     */
    it('`send all` est refuse — la forme reelle est `send *`', async () => {
      const d = await priv(fabrique());
      expect(await d.executeCommand('send all')).toContain('% Invalid input');
      expect(await d.executeCommand('send line vty 0')).toContain('% Invalid input');
    }, 30_000);
  });

  // ── Partie 10 — scenarios ─────────────────────────────────────────

  describe(`${nom} — partie 10 : scenarios`, () => {
    /**
     * Scenario 1 du tutoriel : la parade permanente est un
     * `exec-timeout`, et elle doit SURVIVRE au rechargement de la
     * topologie — sinon la panne revient a la premiere reouverture.
     */
    it('scenario 1 — les reglages de ligne survivent a un aller-retour', async () => {
      const source = await priv(fabrique());
      await conf(source, 'line vty 0 4', 'exec-timeout 15 0', 'absolute-timeout 480',
        'session-timeout 5', 'escape-character 27', 'history size 20',
        'transport input ssh', 'login local');
      const rendu = (await source.executeCommand('show running-config'))
        .split('\n');
      const debut = rendu.findIndex((l) => l.startsWith('line vty 0 4'));
      expect(debut).toBeGreaterThanOrEqual(0);
      const bloc: string[] = [rendu[debut]];
      for (let i = debut + 1; i < rendu.length && rendu[i].startsWith(' '); i++) bloc.push(rendu[i]);

      const rechargee = await priv(fabrique());
      await rechargee.executeCommand('configure terminal');
      for (const l of bloc) await rechargee.executeCommand(l.trim());
      await rechargee.executeCommand('end');

      const apres = await rechargee.executeCommand('show running-config');
      for (const attendu of [' exec-timeout 15 0', ' absolute-timeout 480',
        ' session-timeout 5', ' escape-character 27', ' history size 20']) {
        expect(apres, `${attendu} doit survivre`).toContain(attendu);
      }
    }, 30_000);

    it('scenario 4 — `access-class` sur les vty est rendue et affichee', async () => {
      const d = await priv(fabrique());
      await conf(d, 'ip access-list standard BLOQUER', 'permit 192.168.0.0 0.0.255.255',
        'exit', 'line vty 0 4', 'access-class BLOQUER in');
      expect(await d.executeCommand('show running-config')).toContain(' access-class BLOQUER in');
      expect(await d.executeCommand('show line vty 0'))
        .toContain('Access class BLOQUER applied to incoming connections.');
    }, 30_000);

    it('partie 2 — `line vty 5 15` cree vraiment onze lignes de plus', async () => {
      const d = await priv(fabrique());
      const avant = (await d.executeCommand('show line')).split('\n').filter((l) => l.includes('VTY')).length;
      await conf(d, 'line vty 5 15');
      const apres = (await d.executeCommand('show line')).split('\n').filter((l) => l.includes('VTY')).length;
      expect(avant).toBe(5);
      expect(apres).toBe(16);
    }, 30_000);
  });
}

// ── Partie 7.2 — `send` livre pour de bon ────────────────────────────

describe('`send` porte le message a une session vivante', () => {
  async function console1(d: CiscoRouter): Promise<CiscoTerminalSession> {
    const s = new CiscoTerminalSession('t1', d as never);
    await s.init();
    for (let i = 0; i < 40 && s.isBooting; i++) await tick();
    await tick();
    return s;
  }
  const tape = async (s: CiscoTerminalSession, t: string) => {
    s.setInput(t); s.handleKey(key('Enter'));
    for (let i = 0; i < 25; i++) await tick();
  };
  const texte = async (s: CiscoTerminalSession, t: string) => {
    (s as unknown as { setInputBuf(v: string): void }).setInputBuf(t);
    s.handleKey(key('Enter'));
    for (let i = 0; i < 25; i++) await tick();
  };
  const vu = (s: CiscoTerminalSession) => s.lines.map((l) => l.text).join('\n');

  it('`send *` ouvre la saisie puis LIVRE le message', async () => {
    const d = new CiscoRouter('R1', 0, 0);
    d.powerOn();
    const s = await console1(d);
    await tape(s, 'enable');
    await tape(s, 'send *');
    expect(vu(s)).toContain('Enter message, end with CTRL/Z; abort with CTRL/C:');
    expect(s.currentInputMode.type).toBe('interactive-text');

    await texte(s, 'Maintenance dans 10 minutes.');
    await texte(s, '^Z');

    const ecran = vu(s);
    expect(ecran).toContain('*** Message from tty0 to all terminals: ***');
    expect(ecran).toContain('Maintenance dans 10 minutes.');
    // La saisie est terminee : on est revenu a l'invite.
    expect(s.currentInputMode.type).toBe('normal');
  }, 30_000);

  it('un message sur plusieurs lignes arrive entier', async () => {
    const d = new CiscoRouter('R1', 0, 0);
    d.powerOn();
    const s = await console1(d);
    await tape(s, 'enable');
    await tape(s, 'send *');
    await texte(s, 'Premiere ligne.');
    await texte(s, 'Deuxieme ligne.');
    await texte(s, '^Z');
    const ecran = vu(s);
    expect(ecran).toContain('Premiere ligne.');
    expect(ecran).toContain('Deuxieme ligne.');
  }, 30_000);

  /**
   * Le temoin : `send vty 3` ne doit PAS arriver sur la console, qui est
   * la ligne 0. Sans lui, une livraison a tout le monde et une livraison
   * ciblee seraient indiscernables.
   */
  it('`send vty 3` ne touche pas la console — le message est CIBLE', async () => {
    const d = new CiscoRouter('R1', 0, 0);
    d.powerOn();
    const s = await console1(d);
    await tape(s, 'enable');
    await tape(s, 'send vty 3');
    await texte(s, 'Pour la vty 3 seulement.');
    await texte(s, '^Z');
    expect(vu(s)).not.toContain('Pour la vty 3 seulement.\n***');
    expect(vu(s)).not.toContain('*** Message from tty0 to all terminals: ***');
  }, 30_000);
});
