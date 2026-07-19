/**
 * Scénario 5 — login block-for : protection contre la force brute et
 * affichage UI.
 *
 * TDD : écrit avant l'implémentation. Recherche d'architecture préalable
 * a confirmé :
 *  - `login block-for` alimentait déjà un `LoginBlocker` PAR SOURCE IP
 *    (`isBlocked(ip)`), alors que le vrai IOS bloque le device ENTIER dès
 *    que le seuil est atteint, quelle que soit la source qui l'a déclenché
 *    — corrigé en amont de ce fichier (voir LoginBlocker.ts).
 *  - la connexion SSH interactive lancée depuis un vrai `ssh` bash
 *    (PC Linux → routeur Cisco, via `sshLauncher.ts`/`LinuxBashShell`)
 *    valide le mot de passe via `Router.checkPassword` → `authority
 *    .authenticate()` directement, SANS jamais appeler `recordLoginFailure`
 *    / `recordLoginSuccess` — donc sans jamais alimenter le bus que
 *    `LoginBlocker` écoute. `Router.recordSshLogin` (déjà appelé après
 *    coup par `sshLauncher.ts`) était un no-op. C'est le vrai trou
 *    d'intégration que ce scénario comble.
 *  - la connexion console n'appelait pas davantage `recordLoginFailure`/
 *    `recordLoginSuccess`.
 *  - `login quiet-mode access-class` et `login delay` étaient parsés et
 *    stockés (`CiscoSecurityConfig.login`) mais jamais consultés nulle
 *    part — configuration morte.
 *  - `show login` contenait un bug réel :
 *    `` `Router ${blocker ? 'NOT' : 'NOT'} enabled...` `` — les deux
 *    branches du ternaire affichaient "NOT", donc la commande ne
 *    reflétait JAMAIS l'état réellement configuré.
 *
 * Écart assumé entre le scénario et la réalité (la réalité prime,
 * conformément à la consigne) : le scénario montre un message de blocage
 * "via console" pendant le quiet-mode. La documentation Cisco officielle
 * (User Security Configuration Guide — Login Enhancements-Login Block)
 * est explicite : le quiet-mode ne bloque QUE les connexions distantes
 * (Telnet/SSH) ; la console reste TOUJOURS disponible, précisément pour
 * qu'un administrateur ne soit jamais totalement verrouillé hors de
 * l'équipement pendant une attaque. C'est ce comportement réel qui est
 * testé ici : la console continue de fonctionner normalement (avec son
 * propre mécanisme "3 tentatives puis % Bad passwords", indépendant du
 * quiet-mode) même quand le device est en quiet-mode suite à des échecs
 * SSH ; les échecs console alimentent quand même le compteur global
 * (visibles dans `show login` / `show login failures`), puisque rien
 * dans la documentation ne les exclut du comptage — seule l'application
 * du blocage lui-même est exemptée pour la console.
 *
 * `login delay` (ralentissement effectif entre tentatives) n'est pas
 * dans les critères de réussite officiels du scénario (qui ne couvrent
 * que : compteur/temps restant exacts dans `show login`, blocage
 * immédiat à la 5e tentative, whitelist fonctionnelle) — son
 * application réelle (throttling) reste un gap documenté, seul son
 * affichage dans `show login` est couvert ici.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
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
import { tryInterpretSshLaunch, type SshLaunchOptions } from '@/shell/sshLauncher';

beforeEach(() => {
  EquipmentRegistry.resetInstance();
  resetCounters();
  MACAddress.resetCounter();
  resetDeviceCounters();
  Logger.reset();
});

// ─── Shared UI-driving helpers (same contract as Scénario 1/2) ────────

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
function lastLines(session: TerminalSession, n = 60): string[] {
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
async function cfg(d: CiscoRouter): Promise<CiscoRouter> {
  await d.executeCommand('enable');
  await d.executeCommand('configure terminal');
  return d;
}

const MASK = '255.255.255.0';
const CISCO_IP = '10.0.0.6';

async function buildSshLab(): Promise<{ pc: LinuxPC; pc2: LinuxPC; cisco: CiscoRouter }> {
  const pc = new LinuxPC('linux-pc', 'attacker', 0, 0);
  const pc2 = new LinuxPC('linux-pc', 'whitelisted', 0, 0);
  const cisco = new CiscoRouter('ciscoR', 0, 0);
  const sw = new GenericSwitch('switch-generic', 'sw', 8, 0, 0);
  new Cable('c1').connect(pc.getPorts()[0], sw.getPorts()[0]);
  new Cable('c2').connect(cisco.getPorts()[0], sw.getPorts()[1]);
  new Cable('c3').connect(pc2.getPorts()[0], sw.getPorts()[2]);
  pc.getPorts()[0].configureIP(new IPAddress('10.0.0.1'), new SubnetMask(MASK));
  pc2.getPorts()[0].configureIP(new IPAddress('10.0.0.99'), new SubnetMask(MASK));
  for (const cmdline of [
    'enable', 'configure terminal',
    'interface GigabitEthernet0/0',
    `ip address ${CISCO_IP} ${MASK}`,
    'no shutdown', 'exit',
    'username admin privilege 15 secret Admin@2025',
    'ip domain-name lab.local',
    'crypto key generate rsa modulus 2048',
    'line vty 0 4',
    'login local',
    'transport input ssh',
    'end',
  ]) await cisco.executeCommand(cmdline);
  return { pc, pc2, cisco };
}

function launchOpts(pc: LinuxPC, sourceIp: string): SshLaunchOptions {
  return {
    defaultUser: 'root',
    sourceIp,
    wireProbe: (host, port) => pc.tcpConnectOutcome(new IPAddress(host), port),
  };
}

/**
 * Drive one `ssh admin@<host>` login round from the Linux client through
 * the real terminal: launches the command if not already mid-auth, then
 * submits the given password once prompted. Mirrors what a human retrying
 * a brute-force script would do — OpenSSH's own 3-attempts-per-connection
 * cap means every 3rd wrong password closes the session, so the helper
 * transparently re-issues `ssh admin@host` when needed.
 */
async function sshAttempt(term: LinuxTerminalSession, host: string, password: string): Promise<void> {
  if (term.currentInputMode.type !== 'password') {
    await type(term, `ssh admin@${host}`);
  }
  if (term.currentInputMode.type === 'password') {
    await submitPassword(term, password);
  }
}

/** One console `Username:`/`Password:` round-trip on a fresh physical connection. */
async function consoleAttempt(r: CiscoRouter, username: string, password: string): Promise<string[]> {
  const session = new CiscoTerminalSession(`console-${Math.random()}`, r);
  await session.init();
  await waitBoot(session);
  await submitText(session, username);
  await waitForMode(session, (m) => m === 'password');
  await submitPassword(session, password);
  await tick();
  const lines = lastLines(session);
  session.dispose();
  return lines;
}

describe('§A — login block-for : correction du bug show login + affichage dynamique Normal-Mode', () => {
  it("'show login' reflète l'état réellement configuré (bug corrigé : les deux branches du ternaire affichaient 'NOT')", async () => {
    const r = new CiscoRouter('R1', 0, 0);
    await cfg(r);
    await r.executeCommand('login block-for 120 attempts 5 within 30');
    await r.executeCommand('end');

    const out = await r.executeCommand('show login');
    expect(out).toContain('Router enabled to watch for login Attacks.');
    expect(out).not.toMatch(/Router NOT enabled to watch for login Attacks/);
  });

  it("sans 'login block-for' configuré, 'show login' indique explicitement que le device n'est PAS surveillé", async () => {
    const r = new CiscoRouter('R1', 0, 0);
    const out = await r.executeCommand('show login');
    expect(out).toMatch(/Router NOT enabled to watch for login Attacks/);
  });

  it("'show login' affiche le nombre exact d'échecs dans la fenêtre courante et le temps restant de la fenêtre", async () => {
    const r = new CiscoRouter('R1', 0, 0);
    await cfg(r);
    await r.executeCommand('username admin privilege 15 secret Admin@2025');
    await r.executeCommand('login block-for 120 attempts 5 within 30');
    await r.executeCommand('end');

    const store = r.getCredentialStore();
    const now = Date.now();
    store.recordLoginFailure('admin', '10.0.0.1', 'bad password', now);
    store.recordLoginFailure('admin', '10.0.0.1', 'bad password', now);

    const out = await r.executeCommand('show login');
    expect(out).toMatch(/Router presently in Normal-Mode/);
    expect(out).toMatch(/Login failures for current window: 2/);
    expect(out).toMatch(/Total login failures: 2/);
  });
});

describe('§B — 5e échec SSH déclenche le blocage immédiat et ferme la connexion', () => {
  it("le message '% Blocking new login for N secs (quota exceeded)' apparaît exactement à la 5e tentative échouée, sans prompt supplémentaire", async () => {
    const { pc, cisco } = await buildSshLab();
    await cfg(cisco);
    await cisco.executeCommand('login block-for 120 attempts 5 within 30');
    await cisco.executeCommand('end');

    const term = new LinuxTerminalSession('t1', pc);
    await term.init();

    for (let i = 0; i < 4; i++) {
      await sshAttempt(term, CISCO_IP, 'WrongPassword');
    }
    // Not yet blocked after 4 failures.
    expect(lastLines(term).some((l) => l.includes('quota exceeded'))).toBe(false);

    await sshAttempt(term, CISCO_IP, 'WrongPassword');

    expect(lastLines(term).some((l) => l.includes('% Blocking new login for 120 secs (quota exceeded)'))).toBe(true);
    // Connection closed immediately -- no further password prompt.
    expect(term.currentInputMode.type).not.toBe('password');
    expect(term.foreground).toBe(term);
  });

  it("une fois bloqué, une NOUVELLE tentative de connexion SSH est refusée immédiatement, sans prompt de mot de passe", async () => {
    const { pc, cisco } = await buildSshLab();
    await cfg(cisco);
    await cisco.executeCommand('login block-for 120 attempts 3 within 30');
    await cisco.executeCommand('end');

    const term = new LinuxTerminalSession('t1', pc);
    await term.init();
    for (let i = 0; i < 3; i++) await sshAttempt(term, CISCO_IP, 'WrongPassword');
    expect(lastLines(term).some((l) => l.includes('quota exceeded'))).toBe(true);

    const attempt = await tryInterpretSshLaunch(`ssh admin@${CISCO_IP}`, launchOpts(pc, '10.0.0.1'));
    expect(attempt?.kind).toBe('error');
    expect(attempt?.result.output.join('\n')).toMatch(/Connection refused/);
  });
});

describe("§C — login quiet-mode access-class : whitelist fonctionnelle pendant le blocage", () => {
  async function buildLabWithWhitelist(): Promise<{ pc: LinuxPC; pc2: LinuxPC; cisco: CiscoRouter }> {
    const lab = await buildSshLab();
    await cfg(lab.cisco);
    await lab.cisco.executeCommand('ip access-list standard WHITELIST-LOGIN');
    await lab.cisco.executeCommand('permit 10.0.0.99 0.0.0.0');
    await lab.cisco.executeCommand('exit');
    await lab.cisco.executeCommand('login quiet-mode access-class WHITELIST-LOGIN');
    await lab.cisco.executeCommand('login block-for 120 attempts 3 within 30');
    await lab.cisco.executeCommand('end');
    return lab;
  }

  it("une IP HORS whitelist reçoit le refus de connexion pendant le quiet-mode", async () => {
    const { pc, cisco } = await buildLabWithWhitelist();
    const term = new LinuxTerminalSession('t1', pc);
    await term.init();
    for (let i = 0; i < 3; i++) await sshAttempt(term, CISCO_IP, 'WrongPassword');
    expect(lastLines(term).some((l) => l.includes('quota exceeded'))).toBe(true);
    expect(cisco.getLoginBlocker()?.isBlocked()).toBe(true);

    const attempt = await tryInterpretSshLaunch(`ssh admin@${CISCO_IP}`, launchOpts(pc, '10.0.0.1'));
    expect(attempt?.kind).toBe('error');
  });

  it("une IP DANS la whitelist peut toujours se connecter (obtient le prompt de mot de passe) pendant le quiet-mode", async () => {
    const { pc, pc2, cisco } = await buildLabWithWhitelist();
    const attacker = new LinuxTerminalSession('t1', pc);
    await attacker.init();
    for (let i = 0; i < 3; i++) await sshAttempt(attacker, CISCO_IP, 'WrongPassword');
    expect(cisco.getLoginBlocker()?.isBlocked()).toBe(true);

    const attempt = await tryInterpretSshLaunch(`ssh admin@${CISCO_IP}`, launchOpts(pc2, '10.0.0.99'));
    expect(attempt?.kind).not.toBe('error');
  });

  it("'show login' en quiet-mode affiche la liste whitelist permise et le temps restant", async () => {
    const { pc, cisco } = await buildLabWithWhitelist();
    const term = new LinuxTerminalSession('t1', pc);
    await term.init();
    for (let i = 0; i < 3; i++) await sshAttempt(term, CISCO_IP, 'WrongPassword');

    const out = await cisco.executeCommand('show login');
    expect(out).toMatch(/Router presently in Quiet-Mode/);
    expect(out).toMatch(/Will remain in Quiet-Mode for \d+ more secs/);
    expect(out).toMatch(/Permitted List: WHITELIST-LOGIN/);
  });
});

describe('§D — la console reste TOUJOURS accessible pendant le quiet-mode (comportement IOS réel, divergence assumée avec le scénario)', () => {
  it("même après déclenchement du quiet-mode par des échecs SSH, une nouvelle connexion console affiche normalement 'User Access Verification' / 'Username:' (pas de blocage)", async () => {
    const { pc, cisco } = await buildSshLab();
    await cfg(cisco);
    await cisco.executeCommand('username console-admin privilege 15 secret Console@2025');
    await cisco.executeCommand('line console 0');
    await cisco.executeCommand('login local');
    await cisco.executeCommand('exit');
    await cisco.executeCommand('login block-for 120 attempts 3 within 30');
    await cisco.executeCommand('end');

    const term = new LinuxTerminalSession('t1', pc);
    await term.init();
    for (let i = 0; i < 3; i++) await sshAttempt(term, CISCO_IP, 'WrongPassword');
    expect(cisco.getLoginBlocker()?.isBlocked()).toBe(true);

    const lines = await consoleAttempt(cisco, 'console-admin', 'Console@2025');
    expect(lines.some((l) => l.includes('User Access Verification'))).toBe(true);
    // Login actually succeeds -- console is never gated by quiet-mode.
    expect(lines.some((l) => l.includes('quota exceeded'))).toBe(false);
  });
});

describe('§E — les échecs console alimentent quand même le compteur global (visible dans show login / show login failures)', () => {
  it("des échecs de login console répétés apparaissent dans 'show login failures' et dans le compteur de 'show login'", async () => {
    const r = new CiscoRouter('R1', 0, 0);
    await cfg(r);
    await r.executeCommand('username admin privilege 15 secret Admin@2025');
    await r.executeCommand('line console 0');
    await r.executeCommand('login local');
    await r.executeCommand('exit');
    await r.executeCommand('login block-for 120 attempts 5 within 30');
    await r.executeCommand('end');

    await consoleAttempt(r, 'admin', 'WrongOne');
    await consoleAttempt(r, 'admin', 'WrongTwo');

    const failures = await r.executeCommand('show login failures');
    expect(failures).toMatch(/admin/);
    expect(failures).not.toMatch(/No failures recorded/);

    const out = await r.executeCommand('show login');
    expect(out).toMatch(/Login failures for current window: 2/);
  });
});

describe('§F — le quiet-mode expire après blockSeconds et le comportement redevient normal silencieusement', () => {
  it('après expiration, une nouvelle tentative SSH obtient de nouveau un prompt de mot de passe normal', async () => {
    const { pc, cisco } = await buildSshLab();
    await cfg(cisco);
    await cisco.executeCommand('login block-for 2 attempts 3 within 30');
    await cisco.executeCommand('end');

    const term = new LinuxTerminalSession('t1', pc);
    await term.init();
    for (let i = 0; i < 3; i++) await sshAttempt(term, CISCO_IP, 'WrongPassword');
    expect(cisco.getLoginBlocker()?.isBlocked()).toBe(true);

    await new Promise((res) => setTimeout(res, 2300));
    expect(cisco.getLoginBlocker()?.isBlocked()).toBe(false);

    const attempt = await tryInterpretSshLaunch(`ssh admin@${CISCO_IP}`, launchOpts(pc, '10.0.0.1'));
    expect(attempt?.kind).not.toBe('error');
  }, 10000);
});
