/**
 * Scénario 1 — Authentification locale et niveaux de privilège Cisco :
 * ce que l'utilisateur voit à l'écran, du prompt de login jusqu'au
 * prompt de commande, à travers les différents niveaux de privilège.
 *
 * Couvre, avec le vrai moteur (pas de simulation superficielle) :
 *  - `enable` / `enable N` : véritable prompt "Password:" gated par
 *    `enable secret` (niveau 15) et `enable password level N`
 *    (niveaux intermédiaires), avec grant immédiat si rien n'est
 *    configuré pour ce niveau (comportement réel IOS : pas de mot de
 *    passe configuré = pas de contrôle).
 *  - `privilege exec level N <commande>` : octroi RÉEL d'une commande
 *    précise à un niveau intermédiaire — refusée avant l'octroi avec
 *    exactement `% Invalid input detected at '^' marker.` (même
 *    formatage que "commande inconnue", car du point de vue de l'IOS
 *    réel une commande hors du niveau courant n'est simplement pas
 *    dans l'arbre de commandes visible).
 *  - Connexion "console" (le terminal local ouvert par double-clic) :
 *    bannière "User Access Verification" / "Username:" / "Password:"
 *    quand `line console 0` exige `login local`, avec le niveau de
 *    privilège de la session dérivé du compte authentifié — 3 échecs
 *    consécutifs affichent `% Login invalid` puis `% Bad passwords` et
 *    ferment le terminal.
 *  - `show privilege` reflète toujours le niveau réel (pas seulement
 *    1 ou 15) ; le prompt change immédiatement après `hostname`.
 *
 * Portée assumée : l'authentification interactive multi-étapes
 * (Username puis Password, avec retour en arrière après échec) est un
 * concept de session terminal, pas du dispatch synchrone
 * `device.executeCommand()` — donc testée via `CiscoTerminalSession`
 * réel (comme les flux SSH sortants existants), pendant que la
 * validation statique de configuration (comptes, règles de privilège)
 * reste testée via `device.executeCommand()` direct. Pas de blocage
 * anti-force-brute ici (login block-for) — scénario 5 séparé. Pas de
 * bannières (motd/login/exec) — scénario 3 séparé.
 *
 * TDD: written against the real device + terminal-session classes,
 * before any of `enable` password-gating, numeric privilege-level
 * command gating, or console Username:/Password: login exists
 * (confirmed via the architecture research: `enable` currently grants
 * privileged EXEC unconditionally; `privilege exec level N <cmd>` is
 * parsed but has zero runtime effect; no "User Access Verification"
 * flow exists anywhere in the source).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { CiscoTerminalSession } from '@/terminal/sessions';
import type { KeyEvent } from '@/terminal/sessions/TerminalSession';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  EquipmentRegistry.resetInstance();
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

function key(k: string): KeyEvent {
  return { key: k, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false };
}
const tick = () => new Promise<void>((r) => setTimeout(r, 15));
async function waitBoot(session: CiscoTerminalSession): Promise<void> {
  for (let i = 0; i < 40; i++) {
    if (!session.isBooting) return;
    await tick();
  }
}
async function waitForMode(
  session: CiscoTerminalSession,
  pred: (mode: string) => boolean,
  ms = 2000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (pred(session.currentInputMode.type)) return;
    await tick();
  }
}
function lastLines(session: CiscoTerminalSession, n = 20): string[] {
  return session.lines.slice(-n).map((l) => l.text);
}
async function submitText(session: CiscoTerminalSession, value: string): Promise<void> {
  session.setInputBuf(value);
  session.handleKey(key('Enter'));
  await waitForMode(session, () => true, 50).catch(() => {});
  await tick();
}
async function submitPassword(session: CiscoTerminalSession, value: string): Promise<void> {
  session.setPasswordBuf(value);
  session.handleKey(key('Enter'));
  await tick();
}
async function type(session: CiscoTerminalSession, cmd: string): Promise<void> {
  session.setInput(cmd);
  session.handleKey(key('Enter'));
  await tick();
}

async function cfg(d: CiscoRouter | CiscoSwitch): Promise<CiscoRouter | CiscoSwitch> {
  await d.executeCommand('enable');
  await d.executeCommand('configure terminal');
  return d;
}

describe('Scénario 1 — enable / enable N : véritable gate par mot de passe', () => {
  it('sans enable secret/password configuré, "enable" octroie le niveau 15 immédiatement (comportement réel IOS par défaut)', async () => {
    const r = new CiscoRouter('R1', 0, 0);
    r.powerOn();
    const session = new CiscoTerminalSession('t1', r);
    await session.init();
    await waitBoot(session);

    await type(session, 'enable');
    expect(session.currentInputMode.type).toBe('normal');
    await type(session, 'show privilege');
    expect(lastLines(session)).toContain('Current privilege level is 15');
  });

  it('avec enable secret configuré, "enable" affiche un vrai prompt Password: et grant seulement si le mot de passe est correct', async () => {
    const r = new CiscoRouter('R1', 0, 0);
    r.powerOn();
    await cfg(r);
    await r.executeCommand('enable secret Enable@2025');
    await r.executeCommand('end');

    const session = new CiscoTerminalSession('t1', r);
    await session.init();
    await waitBoot(session);

    await type(session, 'enable');
    await waitForMode(session, (m) => m === 'password');
    expect(session.currentInputMode.type).toBe('password');

    await submitPassword(session, 'Enable@2025');
    expect(session.currentInputMode.type).toBe('normal');
    await type(session, 'show privilege');
    expect(lastLines(session)).toContain('Current privilege level is 15');
  });

  it('un mauvais enable secret affiche "% Access denied" et ne change pas le niveau de privilège', async () => {
    const r = new CiscoRouter('R1', 0, 0);
    r.powerOn();
    await cfg(r);
    await r.executeCommand('enable secret Enable@2025');
    await r.executeCommand('end');

    const session = new CiscoTerminalSession('t1', r);
    await session.init();
    await waitBoot(session);

    await type(session, 'enable');
    await waitForMode(session, (m) => m === 'password');
    await submitPassword(session, 'WrongPassword');

    expect(lastLines(session).some((l) => l.includes('% Access denied'))).toBe(true);
    await type(session, 'show privilege');
    expect(lastLines(session)).toContain('Current privilege level is 1');
  });

  it('"enable 15" se comporte comme "enable" nu (même enable secret)', async () => {
    const r = new CiscoRouter('R1', 0, 0);
    r.powerOn();
    await cfg(r);
    await r.executeCommand('enable secret Enable@2025');
    await r.executeCommand('end');

    const session = new CiscoTerminalSession('t1', r);
    await session.init();
    await waitBoot(session);

    await type(session, 'enable 15');
    await waitForMode(session, (m) => m === 'password');
    await submitPassword(session, 'Enable@2025');
    await type(session, 'show privilege');
    expect(lastLines(session)).toContain('Current privilege level is 15');
  });

  it('"enable N" (niveau intermédiaire) gated par "enable password level N", indépendant de enable secret', async () => {
    const r = new CiscoRouter('R1', 0, 0);
    r.powerOn();
    await cfg(r);
    await r.executeCommand('enable secret Enable@2025');
    await r.executeCommand('enable password level 7 Level7@2025');
    await r.executeCommand('end');

    const session = new CiscoTerminalSession('t1', r);
    await session.init();
    await waitBoot(session);

    await type(session, 'enable 7');
    await waitForMode(session, (m) => m === 'password');
    await submitPassword(session, 'Level7@2025');
    expect(session.currentInputMode.type).toBe('normal');

    // Real IOS: intermediate levels still show '>', only 15 shows '#'.
    expect(session.getPrompt().endsWith('>')).toBe(true);
    await type(session, 'show privilege');
    expect(lastLines(session)).toContain('Current privilege level is 7');
  });

  it('"enable N" sans mot de passe configuré pour ce niveau octroie directement (comportement permissif par défaut)', async () => {
    const r = new CiscoRouter('R1', 0, 0);
    r.powerOn();
    const session = new CiscoTerminalSession('t1', r);
    await session.init();
    await waitBoot(session);

    await type(session, 'enable 7');
    expect(session.currentInputMode.type).toBe('normal');
    await type(session, 'show privilege');
    expect(lastLines(session)).toContain('Current privilege level is 7');
  });
});

describe("Scénario 1 — privilege exec level N <commande> : octroi réel d'une commande précise", () => {
  async function switchAtLevel7(): Promise<CiscoTerminalSession> {
    const sw = new CiscoSwitch('switch-cisco', 'SW1', 8, 0, 0);
    sw.powerOn();
    await cfg(sw);
    await sw.executeCommand('privilege exec level 7 show running-config');
    await sw.executeCommand('privilege exec level 7 show interfaces');
    await sw.executeCommand('enable password level 7 Level7@2025');
    await sw.executeCommand('end');

    const session = new CiscoTerminalSession('t1', sw);
    await session.init();
    await waitBoot(session);
    await type(session, 'enable 7');
    await waitForMode(session, (m) => m === 'password');
    await submitPassword(session, 'Level7@2025');
    return session;
  }

  it('une commande NON octroyée au niveau 7 est refusée avec exactement le format "commande inconnue"', async () => {
    const session = await switchAtLevel7();
    // "reload" is genuinely never granted (only show running-config / show
    // interfaces are) -- a real, never-touched privileged-only command.
    await type(session, 'reload');
    const rl = lastLines(session);
    expect(rl.some((l) => l.includes("% Invalid input detected at '^' marker."))).toBe(true);
  });

  it('une commande explicitement octroyée par "privilege exec level 7" fonctionne réellement au niveau 7', async () => {
    const session = await switchAtLevel7();
    await type(session, 'show running-config');
    const lines = lastLines(session, 40);
    // A real running-config dump, not an error -- proves the command
    // actually executed (not just accepted-and-ignored).
    expect(lines.some((l) => l.includes('version') || l.includes('hostname') || l.includes('!'))).toBe(true);
    expect(lines.some((l) => l.includes('% Invalid input'))).toBe(false);
  });

  it("show running-config est refusée exactement avec le format caret AVANT tout octroi (niveau 7 nu)", async () => {
    const sw = new CiscoSwitch('switch-cisco', 'SW1', 8, 0, 0);
    sw.powerOn();
    await cfg(sw);
    await sw.executeCommand('enable password level 7 Level7@2025');
    await sw.executeCommand('end');
    const session = new CiscoTerminalSession('t1', sw);
    await session.init();
    await waitBoot(session);
    await type(session, 'enable 7');
    await waitForMode(session, (m) => m === 'password');
    await submitPassword(session, 'Level7@2025');

    await type(session, 'show running-config');
    const lines = lastLines(session);
    expect(lines[lines.length - 1]).toContain("% Invalid input detected at '^' marker.");
  });

  it('niveau 15 (admin) garde un accès complet, indépendamment des règles privilege exec level 7', async () => {
    const sw = new CiscoSwitch('switch-cisco', 'SW1', 8, 0, 0);
    sw.powerOn();
    await cfg(sw);
    await sw.executeCommand('privilege exec level 7 show running-config');
    await sw.executeCommand('enable secret Admin@2025');
    await sw.executeCommand('end');
    const session = new CiscoTerminalSession('t1', sw);
    await session.init();
    await waitBoot(session);
    await type(session, 'enable');
    await waitForMode(session, (m) => m === 'password');
    await submitPassword(session, 'Admin@2025');

    await type(session, 'show running-config');
    const lines = lastLines(session, 40);
    expect(lines.some((l) => l.includes('% Invalid input'))).toBe(false);
  });
});

describe('Scénario 1 — connexion console : User Access Verification / Username: / Password:', () => {
  async function labWithAccounts(): Promise<CiscoSwitch> {
    const sw = new CiscoSwitch('switch-cisco', 'SW1', 8, 0, 0);
    sw.powerOn();
    await cfg(sw);
    await sw.executeCommand('username admin privilege 15 secret Admin@2025');
    await sw.executeCommand('username operateur privilege 7 secret Oper@2025');
    await sw.executeCommand('username lecture privilege 1 secret Read@2025');
    await sw.executeCommand('line console 0');
    await sw.executeCommand('login local');
    await sw.executeCommand('exit');
    await sw.executeCommand('hostname SW-MANDENG-01');
    await sw.executeCommand('end');
    return sw;
  }

  it("sans 'line console 0 / login' configuré, la connexion console ne demande AUCUN identifiant (comportement par défaut existant, non régressé)", async () => {
    const sw = new CiscoSwitch('switch-cisco', 'SW1', 8, 0, 0);
    sw.powerOn();
    const session = new CiscoTerminalSession('t1', sw);
    await session.init();
    await waitBoot(session);
    expect(session.currentInputMode.type).toBe('normal');
    expect(lastLines(session).some((l) => l.includes('User Access Verification'))).toBe(false);
  });

  it("avec 'login local' sur la console, une nouvelle session affiche 'User Access Verification' puis Username: puis Password:", async () => {
    const sw = await labWithAccounts();
    const session = new CiscoTerminalSession('t2', sw);
    await session.init();
    await waitBoot(session);

    expect(lastLines(session).some((l) => l.includes('User Access Verification'))).toBe(true);
    expect(session.currentInputMode.type).toBe('interactive-text');
  });

  it('des identifiants corrects (admin, niveau 15) ouvrent une session au prompt "#"', async () => {
    const sw = await labWithAccounts();
    const session = new CiscoTerminalSession('t2', sw);
    await session.init();
    await waitBoot(session);

    await submitText(session, 'admin');
    await waitForMode(session, (m) => m === 'password');
    await submitPassword(session, 'Admin@2025');

    expect(session.currentInputMode.type).toBe('normal');
    expect(session.getPrompt()).toBe('SW-MANDENG-01#');
    await type(session, 'show privilege');
    expect(lastLines(session)).toContain('Current privilege level is 15');
  });

  it("des identifiants corrects (operateur, niveau 7) ouvrent une session au prompt '>' avec le niveau 7 réel", async () => {
    const sw = await labWithAccounts();
    const session = new CiscoTerminalSession('t2', sw);
    await session.init();
    await waitBoot(session);

    await submitText(session, 'operateur');
    await waitForMode(session, (m) => m === 'password');
    await submitPassword(session, 'Oper@2025');

    expect(session.currentInputMode.type).toBe('normal');
    expect(session.getPrompt()).toBe('SW-MANDENG-01>');
    await type(session, 'show privilege');
    expect(lastLines(session)).toContain('Current privilege level is 7');
  });

  it("une commande de niveau 15 refusée à l'opérateur (niveau 7) produit exactement le format caret", async () => {
    const sw = await labWithAccounts();
    const session = new CiscoTerminalSession('t2', sw);
    await session.init();
    await waitBoot(session);
    await submitText(session, 'operateur');
    await waitForMode(session, (m) => m === 'password');
    await submitPassword(session, 'Oper@2025');

    await type(session, 'show running-config');
    const lines = lastLines(session);
    expect(lines[lines.length - 1]).toContain("% Invalid input detected at '^' marker.");
  });

  it("l'opérateur (niveau 7) peut s'élever à 'enable 15' avec le bon mot de passe enable", async () => {
    const sw = await labWithAccounts();
    await sw.executeCommand('enable');
    await sw.executeCommand('configure terminal');
    await sw.executeCommand('enable secret Enable@2025');
    await sw.executeCommand('end');

    const session = new CiscoTerminalSession('t2', sw);
    await session.init();
    await waitBoot(session);
    await submitText(session, 'operateur');
    await waitForMode(session, (m) => m === 'password');
    await submitPassword(session, 'Oper@2025');

    await type(session, 'enable 15');
    await waitForMode(session, (m) => m === 'password');
    await submitPassword(session, 'Enable@2025');

    expect(session.getPrompt()).toBe('SW-MANDENG-01#');
    await type(session, 'show privilege');
    expect(lastLines(session)).toContain('Current privilege level is 15');
  });

  it('un mauvais mot de passe (1er échec) affiche "% Login invalid" et redemande Username:', async () => {
    const sw = await labWithAccounts();
    const session = new CiscoTerminalSession('t2', sw);
    await session.init();
    await waitBoot(session);

    await submitText(session, 'admin');
    await waitForMode(session, (m) => m === 'password');
    await submitPassword(session, 'WrongPassword');

    expect(lastLines(session).some((l) => l.includes('% Login invalid'))).toBe(true);
    await waitForMode(session, (m) => m === 'interactive-text');
    expect(session.currentInputMode.type).toBe('interactive-text');
  });

  it("un compte inexistant produit exactement le même message '% Login invalid' (pas de distinction compte/mot de passe)", async () => {
    const sw = await labWithAccounts();
    const session = new CiscoTerminalSession('t2', sw);
    await session.init();
    await waitBoot(session);

    await submitText(session, 'inconnu');
    await waitForMode(session, (m) => m === 'password');
    await submitPassword(session, 'whatever');

    const lines = lastLines(session);
    expect(lines.some((l) => l.includes('% Login invalid'))).toBe(true);
    expect(lines.some((l) => /login|username/i.test(l) && l.includes('exist'))).toBe(false);
  });

  it("3 échecs consécutifs affichent '% Login invalid' à chaque fois puis '% Bad passwords' et ferment le terminal", async () => {
    const sw = await labWithAccounts();
    // Give this one more room: three full username+password round trips,
    // each with its own polling wait.
    const session = new CiscoTerminalSession('t2', sw);
    let closed = false;
    session.onRequestClose(() => { closed = true; });
    await session.init();
    await waitBoot(session);

    for (let i = 0; i < 3; i++) {
      await submitText(session, 'admin');
      await waitForMode(session, (m) => m === 'password');
      await submitPassword(session, 'WrongPassword');
      if (i < 2) await waitForMode(session, (m) => m === 'interactive-text');
    }

    const lines = lastLines(session, 30);
    expect(lines.filter((l) => l.includes('% Login invalid')).length).toBe(3);
    expect(lines.some((l) => l.includes('% Bad passwords'))).toBe(true);
    await tick();
    expect(closed).toBe(true);
  }, 15000);

  it('le prompt change immédiatement après "hostname", sans rechargement (régression)', async () => {
    const sw = new CiscoSwitch('switch-cisco', 'SW1', 8, 0, 0);
    sw.powerOn();
    const session = new CiscoTerminalSession('t1', sw);
    await session.init();
    await waitBoot(session);
    expect(session.getPrompt()).toBe('SW1>');

    await type(session, 'enable');
    await type(session, 'configure terminal');
    await type(session, 'hostname SW-MANDENG-01');
    await type(session, 'end');
    expect(session.getPrompt()).toBe('SW-MANDENG-01#');
  });
});
