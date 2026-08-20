/**
 * « Les Sessions sur Cisco : From Zero to Hero » — conformite du
 * tutoriel, partie par partie.
 *
 * Ce fichier suit le PLAN DU TUTORIEL et non la liste des correctifs :
 * c'est le parcours d'un apprenant, du premier `show users` au dernier
 * scenario, sur le routeur ET le commutateur. Il complete trois fichiers
 * qui, eux, sont organises autour de ce qui a ete REPARE :
 *
 *   - `tuto-sessions-cisco.test.ts`            (lignes, delais, `send`)
 *   - `tuto-sessions-journal-et-lignes.test.ts` (journal, VTY, `show ssh`)
 *   - `tuto-sessions-uses-et-chiffrement.test.ts` (`Uses`, algorithmes)
 *
 * Ce qui est couvert ICI et nulle part ailleurs : les types de session
 * (partie 1), l'ISOLATION entre sessions (partie 6.1 et scenario 3), les
 * sessions sortantes (partie 5), l'historique (partie 8), et un balayage
 * du RECAPITULATIF — chaque commande de la table de reference repond.
 *
 * ── Deux ecarts du tutoriel avec une vraie machine ────────────────────
 *
 * Ils sont PINCES comme des refus, pas reproduits : accepter une
 * commande que le materiel rejette apprendrait une faute.
 *
 *   - `show line vty 0 detail` : il n'existe pas de mot-cle `detail`.
 *     Nommer une ligne demande deja le detail ; `summary` est le seul
 *     suffixe accepte.
 *   - `send all` / `send line vty 0` : les formes reelles sont `send *`
 *     et `send vty 0`.
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

async function terminal(d: Machine, id = 't1'): Promise<CiscoTerminalSession> {
  const s = new CiscoTerminalSession(id, d as never);
  await s.init();
  for (let i = 0; i < 40 && s.isBooting; i++) await tick();
  await tick();
  return s;
}

async function tape(s: CiscoTerminalSession, texte: string): Promise<void> {
  s.setInput(texte);
  s.handleKey(key('Enter'));
  for (let i = 0; i < 25; i++) await tick();
}

const vu = (s: CiscoTerminalSession) => s.lines.map((l) => l.text).join('\n');
const refuse = (r: string) => /% Invalid input|% Incomplete|Unknown command/.test(r);

for (const [nom, fabrique] of PLATEFORMES) {
  // ── Partie 1 — c'est quoi une session ─────────────────────────────

  describe(`${nom} — partie 1 : les trois types de session`, () => {
    /**
     * Le tutoriel enonce trois types : console (CTY), VTY et AUX. Les
     * trois doivent EXISTER dans l'inventaire des lignes, sans quoi la
     * distinction qu'il enseigne n'a pas de support.
     */
    it('console, AUX et VTY existent toutes les trois', async () => {
      const d = await priv(fabrique());
      const out = await d.executeCommand('show line');
      expect(out, 'la console').toContain('CTY');
      expect(out, "le port auxiliaire").toContain('AUX');
      expect(out, 'les lignes reseau').toContain('VTY');
    }, 30_000);

    it('la console est la ligne 0, les vty commencent a la ligne 2', async () => {
      const d = await priv(fabrique());
      const lignes = (await d.executeCommand('show line')).split('\n');
      expect(lignes.find((l) => /CTY/.test(l))).toMatch(/^\*?\s*0\s/);
      expect(lignes.find((l) => /AUX/.test(l))).toMatch(/^\s*1\s/);
      expect(lignes.find((l) => /VTY/.test(l))).toMatch(/^\s*2\s/);
    }, 30_000);

    /**
     * §1.3 — une session OCCUPE UNE LIGNE. C'est ce que `Uses` compte,
     * et c'est la ressource dont l'epuisement fait le scenario 1.
     *
     * Routeur seulement : un commutateur n'a pas de registre de sessions
     * parce qu'il n'a pas de pile TCP. Ce n'est pas un trou de
     * couverture mais une difference de plateforme, deja ecrite pour
     * `show ssh` et le serveur HTTP.
     */
    it.skipIf(nom === 'switch')('une session consomme une ligne — `Uses` le compte', async () => {
      const d = await priv(fabrique());
      const reg = (d as unknown as {
        getSshSessionRegistry(): { open(i: Record<string, unknown>): unknown };
      }).getSshSessionRegistry();
      reg.open({ user: 'jb', fromIp: '192.168.1.55', localPort: 22, peerPort: 1 });
      const ligne = (await d.executeCommand('show line')).split('\n')
        .find((l) => /^\s*2\s+VTY/.test(l))!;
      expect(ligne.trim().split(/\s+/).slice(-4)[0]).toBe('1');
    }, 30_000);
  });

  // ── Partie 2 — le nombre de sessions possibles ────────────────────

  describe(`${nom} — partie 2 : combien de sessions`, () => {
    it('`show line console 0` decrit la console, et elle seule', async () => {
      const d = await priv(fabrique());
      const out = await d.executeCommand('show line console 0');
      expect(out).toContain('CTY');
      expect(out).toContain('Line 0,');
      expect(out, 'aucune vty ne doit paraitre').not.toContain('VTY');
    }, 30_000);

    it('cinq VTY par defaut (0 a 4)', async () => {
      const d = await priv(fabrique());
      const n = (await d.executeCommand('show line')).split('\n').filter((l) => /VTY/.test(l)).length;
      expect(n).toBe(5);
    }, 30_000);

    it('`line vty 5 15` porte le total a seize', async () => {
      const d = await priv(fabrique());
      await conf(d, 'line vty 5 15', 'login local', 'transport input ssh');
      const n = (await d.executeCommand('show line')).split('\n').filter((l) => /VTY/.test(l)).length;
      expect(n).toBe(16);
    }, 30_000);

    /**
     * §2.2 — « ce qui se passe si toutes les VTY sont occupees » : la
     * connexion suivante est refusee. C'est la panne du scenario 1.
     */
    it.skipIf(nom === 'switch')('toutes les vty prises, il n\'y a plus de ligne libre', async () => {
      const d = await priv(fabrique());
      const reg = (d as unknown as {
        getSshSessionRegistry(): {
          open(i: Record<string, unknown>): unknown; hasFreeLine(): boolean;
        };
      }).getSshSessionRegistry();
      for (let i = 0; i < 5; i++) {
        expect(reg.open({ user: `u${i}`, fromIp: `10.0.0.${i}`, localPort: 22, peerPort: i }),
          `la ligne ${i} doit s'ouvrir`).toBeTruthy();
      }
      expect(reg.hasFreeLine()).toBe(false);
      expect(reg.open({ user: 'sixieme', fromIp: '10.0.0.9', localPort: 22, peerPort: 9 })).toBeNull();
    }, 30_000);
  });

  // ── Partie 6.1 / scenario 3 — l'isolation des sessions ────────────

  describe(`${nom} — partie 6.1 : les sessions sont ISOLEES`, () => {
    /**
     * Le tutoriel l'affirme deux fois — §6.1 et scenario 3 — et c'est
     * une propriete de SECURITE, pas de confort : un administrateur ne
     * doit pas voir ce qu'un autre tape, ni subir son mode.
     */
    it('le mode d\'une session n\'affecte pas l\'autre', async () => {
      const d = fabrique();
      d.powerOn();
      const a = await terminal(d, 'ta');
      const b = await terminal(d, 'tb');

      await tape(a, 'enable');
      await tape(a, 'configure terminal');
      // A est en configuration ; B ne doit pas y etre.
      await tape(b, 'show privilege');
      expect(vu(b), 'B ne doit pas avoir suivi A').toMatch(/level is 1$/m);
      await tape(b, 'configure terminal');
      expect(vu(b), 'B doit devoir passer par enable').toContain('% Invalid input');
    }, 30_000);

    it('le niveau de privilege est propre a chaque session', async () => {
      const d = fabrique();
      d.powerOn();
      const a = await terminal(d, 'ta');
      const b = await terminal(d, 'tb');
      await tape(a, 'enable');
      await tape(a, 'show privilege');
      expect(vu(a)).toMatch(/level is 15$/m);
      await tape(b, 'show privilege');
      expect(vu(b)).toMatch(/level is 1$/m);
    }, 30_000);

    /**
     * L'historique n'est pas partage — et c'est le COMMUTATEUR qui ne
     * le tenait pas : son `snapshotVtyState` copiait `cmdHistory` et son
     * `applyVtyState` ne le restaurait jamais, donc le shell accumulait
     * les commandes de toutes les sessions et chaque instantane
     * recapturait ce tas commun. Une session ouverte apres une autre
     * HERITAIT de son historique. Le routeur, lui, restaurait depuis
     * toujours — d'ou un defaut invisible tant qu'on ne comparait pas
     * les deux plateformes.
     */
    it('l\'historique n\'est pas partage', async () => {
      const d = fabrique();
      d.powerOn();
      const a = await terminal(d, 'ta');
      const b = await terminal(d, 'tb');
      await tape(a, 'enable');
      await tape(a, 'show users');
      await tape(b, 'enable');
      await tape(b, 'show line');
      await tape(b, 'show history');
      const fin = b.lines.slice(-6).map((l) => l.text).join('\n');
      expect(fin, 'B doit voir SES commandes').toContain('show line');
      expect(fin, "la commande de A ne doit pas etre dans l'historique de B")
        .not.toContain('show users');
    }, 30_000);

    it('chaque session tient son propre tampon de saisie', async () => {
      const d = fabrique();
      d.powerOn();
      const a = await terminal(d, 'ta');
      const b = await terminal(d, 'tb');
      a.setInput('show running-config');
      expect(b.input, 'la frappe de A ne doit pas paraitre chez B').toBe('');
    }, 30_000);

    /**
     * La contrepartie, et c'est elle qui rend l'isolation utile plutot
     * qu'absurde : la CONFIGURATION, elle, est partagee. Sans ce cas on
     * aurait pu « isoler » en donnant a chaque session sa propre
     * machine.
     */
    it('mais la CONFIGURATION est commune — c\'est la meme machine', async () => {
      const d = fabrique();
      d.powerOn();
      const a = await terminal(d, 'ta');
      const b = await terminal(d, 'tb');
      await tape(a, 'enable');
      await tape(a, 'configure terminal');
      await tape(a, 'hostname PARTAGE');
      await tape(a, 'end');
      await tape(b, 'enable');
      await tape(b, 'show running-config | include hostname');
      expect(vu(b)).toContain('PARTAGE');
    }, 30_000);
  });

  // ── Partie 8 — l'historique des commandes ─────────────────────────

  describe(`${nom} — partie 8 : l'historique`, () => {
    it('`show history` rend les commandes dans l\'ordre', async () => {
      const d = await priv(fabrique());
      await d.executeCommand('show users');
      await d.executeCommand('show line');
      const h = await d.executeCommand('show history');
      expect(h.indexOf('show users')).toBeLessThan(h.indexOf('show line'));
    }, 30_000);

    it('la taille par defaut annoncee est de dix commandes', async () => {
      const d = await priv(fabrique());
      expect(await d.executeCommand('show line vty 0')).toContain('history size is 10');
    }, 30_000);

    it('`terminal history size` ne change QUE la session courante', async () => {
      const d = await priv(fabrique());
      await d.executeCommand('terminal history size 50');
      expect(await d.executeCommand('show terminal')).toContain('history size is 50');
      // La ligne, elle, n'a pas bouge : `terminal ...` est per-session.
      expect(await d.executeCommand('show line vty 0')).toContain('history size is 10');
    }, 30_000);
  });

  // ── Le recapitulatif : chaque commande de la table repond ─────────

  describe(`${nom} — recapitulatif : la table de reference`, () => {
    const VUES = [
      'show users', 'show who', 'show ssh', 'show line', 'show line vty 0',
      'show tcp brief', 'show sessions', 'show terminal', 'show history',
      'show archive log config all',
    ];
    it.each(VUES)('`%s` repond', async (cmd) => {
      const d = await priv(fabrique());
      expect(refuse(await d.executeCommand(cmd)), cmd).toBe(false);
    }, 30_000);

    const SESSION = [
      'terminal monitor', 'terminal no monitor', 'terminal length 0',
      'terminal length 24', 'terminal width 132', 'terminal history size 50',
    ];
    it.each(SESSION)('`%s` est acceptee', async (cmd) => {
      const d = await priv(fabrique());
      expect(refuse(await d.executeCommand(cmd)), cmd).toBe(false);
    }, 30_000);

    const LIGNE = [
      'exec-timeout 15 0', 'exec-timeout 0 0', 'absolute-timeout 480',
      'session-timeout 5', 'escape-character 27', 'escape-character none',
      'history size 20', 'no history', 'logging synchronous',
      'transport input ssh', 'login local', 'privilege level 15',
    ];
    it.each(LIGNE)('`%s` est acceptee sous `line vty 0 4`', async (cmd) => {
      const d = await priv(fabrique());
      await d.executeCommand('configure terminal');
      await d.executeCommand('line vty 0 4');
      const r = await d.executeCommand(cmd);
      await d.executeCommand('end');
      expect(refuse(r), cmd).toBe(false);
    }, 30_000);

    const ADMIN = ['clear line vty 1', 'send *', 'resume 1', 'disconnect 1', 'disconnect all'];
    it.each(ADMIN)('`%s` repond sans etre refusee', async (cmd) => {
      const d = await priv(fabrique());
      expect(refuse(await d.executeCommand(cmd)), cmd).toBe(false);
    }, 30_000);

    /**
     * Les deux formes que le tutoriel ecrit et qu'aucune machine
     * n'accepte. Les pincer ici, dans le balayage du recapitulatif, est
     * le seul endroit ou un lecteur du tutoriel les cherchera.
     */
    const INVENTEES = ['show line vty 0 detail', 'send all', 'send line vty 0'];
    it.each(INVENTEES)('`%s` est REFUSEE — elle n\'existe sur aucune machine', async (cmd) => {
      const d = await priv(fabrique());
      expect(refuse(await d.executeCommand(cmd)), cmd).toBe(true);
    }, 30_000);
  });
}

// ── Partie 5 — les sessions sortantes ────────────────────────────────

describe('partie 5 : ouvrir une session vers un autre equipement', () => {
  it('`show sessions` est vide au depart', async () => {
    const d = await priv(new CiscoRouter('R1', 0, 0));
    expect(await d.executeCommand('show sessions')).toContain('No connections open');
  }, 30_000);

  it('`resume` sans connexion le dit, il n\'invente pas de session', async () => {
    const d = await priv(new CiscoRouter('R1', 0, 0));
    expect(await d.executeCommand('resume')).toContain('No connection');
    expect(await d.executeCommand('resume 1')).toContain('No connection');
  }, 30_000);

  it('`disconnect` sans connexion le dit aussi', async () => {
    const d = await priv(new CiscoRouter('R1', 0, 0));
    expect(await d.executeCommand('disconnect 1')).toContain('No information');
  }, 30_000);

  /**
   * §5.7 — le caractere d'echappement est celui qui SUSPEND une session
   * sortante. `none` la supprime : on ne peut plus revenir sans fermer.
   */
  it('`escape-character` gouverne ce que le bloc de detail annonce', async () => {
    const d = await priv(new CiscoRouter('R1', 0, 0));
    expect(await d.executeCommand('show line vty 0')).toContain('^^x');
    await conf(d, 'line vty 0 4', 'escape-character none');
    expect(await d.executeCommand('show line vty 0')).not.toContain('^^x');
  }, 30_000);
});

// ── Partie 10 — les scenarios pratiques ──────────────────────────────

describe('partie 10 : les scenarios', () => {
  /**
   * Scenario 2 — « Jean-Baptiste fait une operation longue, va-t-il
   * etre deconnecte ? » Non : `exec-timeout` compte l'INACTIVITE, pas
   * la duree d'execution. C'est `absolute-timeout` qui borne une
   * session active, et les deux doivent rester distincts dans la vue.
   */
  it('scenario 2 — inactivite et duree absolue sont DEUX delais distincts', async () => {
    const d = await priv(new CiscoRouter('R1', 0, 0));
    await conf(d, 'line vty 0 4', 'exec-timeout 5 0', 'absolute-timeout 480');
    const out = await d.executeCommand('show line vty 0');
    expect(out, "l'inactivite").toContain('00:05:00');
    expect(out, 'la duree maximale').toContain('Session limit is 480 minutes.');
  }, 30_000);

  /**
   * Scenario 3 — « je veux voir en temps reel ce que fait l'autre » :
   * IMPOSSIBLE par conception. Ce que le tutoriel propose a la place,
   * c'est la trace APRES coup — et elle, elle doit exister.
   */
  it('scenario 3 — la trace des commandes de configuration existe', async () => {
    const d = await priv(new CiscoRouter('R1', 0, 0));
    await conf(d, 'archive', 'log config', 'logging enable');
    await conf(d, 'hostname TRACE-MOI');
    const journal = await d.executeCommand('show archive log config all');
    expect(journal).toContain('hostname TRACE-MOI');
  }, 30_000);

  it('scenario 1 — le diagnostic complet : voir, couper, prevenir', async () => {
    const d = await priv(new CiscoRouter('R1', 0, 0));
    const reg = (d as unknown as {
      getSshSessionRegistry(): {
        open(i: Record<string, unknown>): unknown; hasFreeLine(): boolean;
      };
    }).getSshSessionRegistry();
    for (let i = 0; i < 5; i++) {
      reg.open({ user: '', fromIp: `192.168.1.${55 + i}`, localPort: 22, peerPort: i });
    }
    // 1. voir : les sessions sont la, avec leur adresse source. C'est
    // par cette commande que commence le diagnostic du scenario, et elle
    // rendait quatre lignes CONSTANTES — une console seule, toujours.
    expect(await d.executeCommand('show users')).toContain('192.168.1.55');
    expect(reg.hasFreeLine(), 'plus une ligne libre').toBe(false);
    // 2. couper.
    expect(await d.executeCommand('clear line vty 0')).toContain('[confirm]');
    expect(reg.hasFreeLine(), 'une ligne est liberee').toBe(true);
    // 3. prevenir : la parade permanente, et elle doit tenir au rechargement.
    await conf(d, 'line vty 0 4', 'exec-timeout 15 0');
    expect(await d.executeCommand('show running-config')).toContain(' exec-timeout 15 0');
  }, 30_000);
});
