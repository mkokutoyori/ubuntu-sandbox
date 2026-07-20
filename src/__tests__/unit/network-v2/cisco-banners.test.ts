/**
 * Scénario 3 — Bannières Cisco : MOTD, login, exec et leur affichage UI.
 *
 * Couvre, avec le vrai moteur (pas de simulation superficielle) :
 *  - `banner <kind> <délimiteur>` SEUL sur la ligne (rien après le
 *    délimiteur) ouvre une véritable capture interactive multi-lignes,
 *    comme le vrai IOS — jusqu'ici totalement absent (le parseur ne
 *    gérait que la forme mono-ligne `banner motd #TEXTE#`, et renvoyait
 *    même une erreur `% Invalid input` pour la forme délimiteur-seul).
 *  - `show running-config` affiche toujours `^C...^C` comme délimiteur,
 *    quel que soit le caractère réellement utilisé à la saisie (vrai
 *    comportement IOS — l'implémentation précédente affichait un `^`
 *    littéral, jamais `^C`).
 *  - Ordre d'affichage réel lors d'une connexion console avec login
 *    local : MOTD (déjà affiché avant ce scénario) → banner login (juste
 *    avant "User Access Verification") → Username:/Password: → banner
 *    exec (uniquement après authentification RÉUSSIE, jamais après un
 *    échec) → prompt de commande.
 *  - Ordre d'affichage réel via SSH entrant : MOTD affiché, banner login
 *    JAMAIS affiché (SSH2 authentifie avant tout échange de bannière —
 *    déjà correct dans le scénario, confirmé ici), banner exec affiché
 *    après connexion réussie.
 *  - Aucune substitution de variable dans les bannières (`$(hostname)`
 *    reste du texte littéral).
 *
 * Portée assumée : Telnet entrant n'a AUCUNE session interactive dans ce
 * simulateur aujourd'hui (`LinuxCommandExecutor.runTelnetClient` ne fait
 * qu'imprimer un message statique "Connected to..." et ne construit
 * jamais de session imbriquée) — construire cette session de zéro serait
 * un chantier disproportionné pour ce scénario ; laissé comme lacune
 * assumée et non simulée (cf. précédent du Scénario 1 pour `login` nu
 * sur la console). Les points de contrôle "affichage via Telnet" du
 * scénario ne sont donc pas testés au niveau session ici.
 *
 * TDD: écrit avant l'implémentation des mécanismes listés ci-dessus
 * (confirmé absent par la recherche d'architecture : `banner login`/
 * `banner exec` ne sont référencés nulle part sous `src/terminal/`, la
 * capture multi-lignes n'existe pas, et le rendu utilisait `^` au lieu
 * de `^C`).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, MACAddress, resetCounters } from '@/network/core/types';
import { CiscoTerminalSession } from '@/terminal/sessions';
import { LinuxTerminalSession } from '@/terminal/sessions/LinuxTerminalSession';
import type { KeyEvent, TerminalSession } from '@/terminal/sessions/TerminalSession';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  EquipmentRegistry.resetInstance();
  resetCounters();
  MACAddress.resetCounter();
  resetDeviceCounters();
  Logger.reset();
});

// ─── Shared UI-driving helpers (same contract as Scénarios 1-2) ───────

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
  session: TerminalSession,
  pred: (mode: string) => boolean,
  ms = 2000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (pred(session.currentInputMode.type)) return;
    await tick();
  }
}
function lastLines(session: TerminalSession, n = 40): string[] {
  return session.lines.slice(-n).map((l) => l.text);
}
async function submitText(session: TerminalSession, value: string): Promise<void> {
  session.setInputBuf(value);
  session.handleKey(key('Enter'));
  await waitForMode(session, () => true, 50).catch(() => {});
  await tick();
}
async function submitPassword(session: TerminalSession, value: string): Promise<void> {
  session.setPasswordBuf(value);
  session.handleKey(key('Enter'));
  await tick();
}
async function type(session: TerminalSession, cmd: string): Promise<void> {
  session.setInput(cmd);
  session.handleKey(key('Enter'));
  await tick();
}
async function cfg(d: CiscoRouter | CiscoSwitch): Promise<CiscoRouter | CiscoSwitch> {
  await d.executeCommand('enable');
  await d.executeCommand('configure terminal');
  return d;
}

describe('Scénario 3 — capture interactive multi-lignes de "banner <kind> <délimiteur>"', () => {
  it('taper "banner motd #" seul ouvre une capture réelle : plusieurs lignes tapées, terminée par une ligne contenant le délimiteur', async () => {
    const r = new CiscoRouter('R1', 0, 0);
    r.powerOn();
    const session = new CiscoTerminalSession('t1', r);
    await session.init();
    await waitBoot(session);
    await type(session, 'enable');
    await type(session, 'configure terminal');

    await type(session, 'banner motd #');
    // The prompt goes blank while capturing -- no visible prompt text.
    expect(session.currentInputMode.type).toBe('interactive-text');

    await submitText(session, 'AVERTISSEMENT : SYSTEME PRIVE');
    await submitText(session, 'Acces non autorise interdit.');
    await submitText(session, '#');

    expect(session.currentInputMode.type).toBe('normal');
    await type(session, 'end');
    const rc = await r.executeCommand('show running-config');
    expect(rc).toContain('AVERTISSEMENT : SYSTEME PRIVE');
    expect(rc).toContain('Acces non autorise interdit.');
  });

  it('la forme mono-ligne "banner motd #TEXTE#" continue de fonctionner sans capture interactive (régression)', async () => {
    const r = new CiscoRouter('R1', 0, 0);
    r.powerOn();
    const session = new CiscoTerminalSession('t1', r);
    await session.init();
    await waitBoot(session);
    await type(session, 'enable');
    await type(session, 'configure terminal');

    await type(session, 'banner motd #WELCOME#');
    // Stayed synchronous -- no interactive capture triggered.
    expect(session.currentInputMode.type).toBe('normal');
    await type(session, 'end');
    const rc = await r.executeCommand('show running-config');
    expect(rc).toContain('WELCOME');
  });

  it('la capture multi-lignes fonctionne identiquement pour "banner login #" et "banner exec #"', async () => {
    const r = new CiscoRouter('R1', 0, 0);
    r.powerOn();
    const session = new CiscoTerminalSession('t1', r);
    await session.init();
    await waitBoot(session);
    await type(session, 'enable');
    await type(session, 'configure terminal');

    await type(session, 'banner login #');
    await submitText(session, 'Authentification requise.');
    await submitText(session, '#');
    expect(session.currentInputMode.type).toBe('normal');

    await type(session, 'banner exec #');
    await submitText(session, 'Bienvenue, acces autorise.');
    await submitText(session, '#');
    expect(session.currentInputMode.type).toBe('normal');

    await type(session, 'end');
    const rc = await r.executeCommand('show running-config');
    expect(rc).toContain('Authentification requise.');
    expect(rc).toContain('Bienvenue, acces autorise.');
  });
});

describe("Scénario 3 — show running-config affiche toujours ^C...^C comme délimiteur", () => {
  it('un banner configuré avec le délimiteur # est rendu avec ^C, pas avec le délimiteur original', async () => {
    const r = new CiscoRouter('R1', 0, 0);
    await cfg(r);
    await r.executeCommand('banner motd #WELCOME#');
    await r.executeCommand('end');
    const rc = await r.executeCommand('show running-config');
    expect(rc).toContain('banner motd ^CWELCOME^C');
    expect(rc).not.toContain('banner motd #WELCOME#');
  });
});

describe('Scénario 3 — ordre réel des bannières sur la console (login local)', () => {
  async function labWithBanners(): Promise<CiscoRouter> {
    const r = new CiscoRouter('R1', 0, 0);
    r.powerOn();
    await cfg(r);
    await r.executeCommand('username admin privilege 15 secret Admin@2025');
    await r.executeCommand('banner motd #SYSTEME PRIVE - MANDENG#');
    await r.executeCommand('banner login #AUTHENTIFICATION REQUISE#');
    await r.executeCommand('banner exec #BIENVENUE ACCES AUTORISE#');
    await r.executeCommand('line console 0');
    await r.executeCommand('login local');
    await r.executeCommand('exit');
    await r.executeCommand('end');
    return r;
  }

  it("l'ordre est MOTD -> banner login -> User Access Verification -> Username:/Password:", async () => {
    const r = await labWithBanners();
    const session = new CiscoTerminalSession('t1', r);
    await session.init();
    await waitBoot(session);

    const lines = lastLines(session, 100);
    const motdIdx = lines.findIndex((l) => l.includes('SYSTEME PRIVE - MANDENG'));
    const loginBannerIdx = lines.findIndex((l) => l.includes('AUTHENTIFICATION REQUISE'));
    const uavIdx = lines.findIndex((l) => l.includes('User Access Verification'));
    expect(motdIdx).toBeGreaterThanOrEqual(0);
    expect(loginBannerIdx).toBeGreaterThan(motdIdx);
    expect(uavIdx).toBeGreaterThan(loginBannerIdx);
  });

  it('le banner exec est affiché APRÈS une authentification réussie, juste avant le prompt de commande', async () => {
    const r = await labWithBanners();
    const session = new CiscoTerminalSession('t1', r);
    await session.init();
    await waitBoot(session);

    await submitText(session, 'admin');
    await waitForMode(session, (m) => m === 'password');
    await submitPassword(session, 'Admin@2025');

    expect(session.currentInputMode.type).toBe('normal');
    expect(lastLines(session).some((l) => l.includes('BIENVENUE ACCES AUTORISE'))).toBe(true);
  });

  it("le banner exec n'est JAMAIS affiché après un échec d'authentification", async () => {
    const r = await labWithBanners();
    const session = new CiscoTerminalSession('t1', r);
    await session.init();
    await waitBoot(session);

    await submitText(session, 'admin');
    await waitForMode(session, (m) => m === 'password');
    await submitPassword(session, 'WrongPassword');

    expect(lastLines(session).some((l) => l.includes('% Login invalid'))).toBe(true);
    expect(lastLines(session).some((l) => l.includes('BIENVENUE ACCES AUTORISE'))).toBe(false);
  });
});

describe('Scénario 3 — ordre réel des bannières via SSH entrant', () => {
  const MASK = '255.255.255.0';
  const PC_IP = '10.0.0.1';
  const CISCO_IP = '10.0.0.6';

  async function buildSshLab(): Promise<{ pc: LinuxPC; cisco: CiscoRouter }> {
    const pc = new LinuxPC('linux-pc', 'pc1', 0, 0);
    const cisco = new CiscoRouter('ciscoR', 0, 0);
    const sw = new GenericSwitch('switch-generic', 'sw', 8, 0, 0);
    new Cable('c1').connect(pc.getPorts()[0], sw.getPorts()[0]);
    new Cable('c2').connect(cisco.getPorts()[0], sw.getPorts()[1]);
    pc.getPorts()[0].configureIP(new IPAddress(PC_IP), new SubnetMask(MASK));
    for (const cmd of [
      'enable', 'configure terminal', 'interface GigabitEthernet0/0',
      `ip address ${CISCO_IP} ${MASK}`, 'no shutdown', 'end',
    ]) await cisco.executeCommand(cmd);
    return { pc, cisco };
  }

  async function sshLogin(term: LinuxTerminalSession, host: string, password: string): Promise<void> {
    await type(term, `ssh admin@${host}`);
    if (term.currentInputMode.type === 'password') await submitPassword(term, password);
  }

  it('MOTD est affiché, banner login est ABSENT (SSH2 authentifie avant tout échange de bannière), banner exec est affiché après connexion', async () => {
    const { pc, cisco } = await buildSshLab();
    await cfg(cisco);
    await cisco.executeCommand('username admin privilege 15 secret Admin@2025');
    await cisco.executeCommand('banner motd #SYSTEME PRIVE - MANDENG#');
    await cisco.executeCommand('banner login #AUTHENTIFICATION REQUISE#');
    await cisco.executeCommand('banner exec #BIENVENUE ACCES AUTORISE#');
    await cisco.executeCommand('ip domain-name lab.local');
    await cisco.executeCommand('crypto key generate rsa modulus 2048');
    await cisco.executeCommand('line vty 0 4');
    await cisco.executeCommand('login local');
    await cisco.executeCommand('transport input ssh');
    await cisco.executeCommand('end');

    const term = new LinuxTerminalSession('t1', pc);
    await term.init();
    await sshLogin(term, CISCO_IP, 'Admin@2025');

    const lines = lastLines(term, 100);
    expect(lines.some((l) => l.includes('SYSTEME PRIVE - MANDENG'))).toBe(true);
    expect(lines.some((l) => l.includes('AUTHENTIFICATION REQUISE'))).toBe(false);
    expect(lines.some((l) => l.includes('BIENVENUE ACCES AUTORISE'))).toBe(true);
  });
});

describe("Scénario 3 — aucune substitution de variable dans les bannières", () => {
  it('"$(hostname)" dans un banner exec reste du texte littéral, pas remplacé par le hostname réel', async () => {
    const r = new CiscoRouter('R1', 0, 0);
    await cfg(r);
    await r.executeCommand('hostname MANDENG-RTR');
    await r.executeCommand('banner exec #Connexion etablie sur $(hostname)#');
    await r.executeCommand('end');
    const rc = await r.executeCommand('show running-config');
    expect(rc).toContain('Connexion etablie sur $(hostname)');
    expect(rc).not.toContain('Connexion etablie sur MANDENG-RTR');
  });
});
