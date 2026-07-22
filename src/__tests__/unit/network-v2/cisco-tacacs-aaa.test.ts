/**
 * Scénario 6 — AAA avec TACACS+ : configuration, flux d'authentification
 * et UI.
 *
 * Portée assumée (voir recherche d'architecture préalable) :
 *  - Le simulateur possède déjà un vrai moteur TACACS+ (client + serveur,
 *    TCP/49, chiffrement type Vigenère MD5-pad, testé dans
 *    `tacacs-protocol.test.ts`) et un `AaaAuthenticator` qui contacte
 *    déjà réellement ce moteur — mais AUCUNE des surfaces de login
 *    interactives (console, `ssh` bash) ne le consultait : elles
 *    authentifiaient toujours directement contre le credential store
 *    local, quel que soit `aaa new-model`. C'est ce trou d'intégration
 *    que ce scénario comble, côté CONSOLE (la surface SSH reste un écart
 *    documenté — voir plus bas).
 *  - Le scénario décrit un serveur TACACS+ `tac_plus` hébergé sur un
 *    serveur Linux ; ce simulateur n'a pas (et n'a jamais eu) de démon
 *    TACACS+ hébergé sur Linux ni de commande CLI pour transformer un
 *    routeur en serveur AAA — seule l'API interne `TacacsServerAgent`
 *    (déjà testée, déjà réelle) existe. Les tests ci-dessous configurent
 *    donc le CÔTÉ SERVEUR directement via cette API (même pattern que
 *    `tacacs-protocol.test.ts`), et pilotent le CÔTÉ CLIENT (le NAS —
 *    sujet réel des critères de réussite du scénario) entièrement via de
 *    vraies commandes CLI IOS.
 *  - `show tacacs` avec statistiques réellement incrémentées (opens/
 *    closes/failed, last timeout, consecutive failures) n'est PAS
 *    couvert : ce n'est pas dans les critères de réussite officiels, et
 *    l'écart pré-existe déjà côté RADIUS (`show radius statistics`
 *    souffre du même problème — les stats internes de
 *    `RadiusClientAgent`/`TacacsClientAgent` ne sont jamais resynchronisées
 *    vers `CiscoSecurityConfig`). Gap documenté, pas dans ce fichier.
 *  - AAA côté SSH entrant (les 3 chemins distincts identifiés par la
 *    recherche : `LinuxTerminalSession`, `LinuxSshClient`, `sshLauncher`)
 *    n'est pas câblé vers `AaaAuthenticator` non plus — écart documenté,
 *    même logique que les gaps Switch déjà acceptés aux scénarios
 *    précédents. Seule la console (qui affiche exactement le "User
 *    Access Verification" / "Username:" / "Password:" du scénario) est
 *    couverte ici.
 *  - `hwtacacs` (Huawei) n'existe pas du tout dans le simulateur —
 *    scope Cisco uniquement, comme le principal exemple du scénario.
 *
 * Critères de réussite officiels couverts :
 *  1. `test aaa group X user pass legacy` produit exactement "User was
 *     successfully authenticated." ou "User was NOT successfully
 *     authenticated.".
 *  2. `Command authorization failed.` s'affiche immédiatement (session
 *     NON fermée) quand TACACS+ refuse une commande précise.
 *  3. Le fallback local en cas d'indisponibilité TACACS+ est silencieux
 *     côté UI.
 *
 * TDD : écrit avant l'implémentation.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, MACAddress, resetCounters } from '@/network/core/types';
import { CiscoTerminalSession } from '@/terminal/sessions';
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

// ─── Shared UI-driving helpers (same contract as prior scenarios) ─────

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
  ms = 3000,
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
async function waitForLine(session: TerminalSession, pred: (l: string) => boolean, ms = 3000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (lastLines(session, 200).some(pred)) return;
    await tick();
  }
}
/**
 * The broker-driven interactive flow (`runFlowViaBroker`) clears
 * `currentInputMode` back to 'normal' the INSTANT the password is
 * submitted -- that only means "no pending UI input request right now",
 * not "the flow has finished". Since the AAA authentication itself runs
 * as a genuinely async `execute` step afterwards (a real TCP round trip,
 * possibly bounded by `tacacs server ... timeout N`), tests must wait
 * for that real time to elapse before asserting on post-login state or
 * issuing a follow-up command -- `currentInputMode === 'normal'` alone
 * is not a safe completion signal here.
 */
async function settleAaaLogin(ms = 400): Promise<void> {
  await new Promise<void>((r) => setTimeout(r, ms));
}
async function cfg(d: CiscoRouter): Promise<CiscoRouter> {
  await d.executeCommand('enable');
  await d.executeCommand('configure terminal');
  return d;
}

const MASK = '255.255.255.0';
const NAS_IP = '10.0.0.1';
const AAA_IP = '10.0.0.2';
const UNREACHABLE_IP = '10.0.0.99';

/** NAS + a real TACACS+ AAA server, directly cabled. */
async function buildLab(): Promise<{ nas: CiscoRouter; aaaSrv: CiscoRouter }> {
  const nas = new CiscoRouter('NAS', 0, 0);
  const aaaSrv = new CiscoRouter('AAA', 0, 0);
  const sw = new CiscoSwitch('switch-cisco', 'SW', 4, 0, 0);
  new Cable('a').connect(nas.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/1')!);
  new Cable('b').connect(aaaSrv.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/2')!);
  nas.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress(NAS_IP), new SubnetMask(MASK));
  aaaSrv.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress(AAA_IP), new SubnetMask(MASK));
  return { nas, aaaSrv };
}

/** Base TACACS+ AAA config on the NAS: server + group + `aaa new-model`. Login/authorization method lists are added per test. */
async function configureNasTacacs(nas: CiscoRouter, opts: { serverIp?: string; timeoutSec?: number } = {}): Promise<void> {
  await cfg(nas);
  await nas.executeCommand('aaa new-model');
  await nas.executeCommand('tacacs server TACACS-MANDENG');
  await nas.executeCommand(`address ipv4 ${opts.serverIp ?? AAA_IP}`);
  await nas.executeCommand('port 49');
  await nas.executeCommand('key Tacacs@2025');
  await nas.executeCommand(`timeout ${opts.timeoutSec ?? 5}`);
  await nas.executeCommand('exit');
  await nas.executeCommand('aaa group server tacacs+ TACACS-GROUP');
  await nas.executeCommand('server name TACACS-MANDENG');
  await nas.executeCommand('exit');
  await nas.executeCommand('end');
}

describe('§A — configuration TACACS+ (serveur, port, timeout, groupe, méthodes) et running-config', () => {
  it("'tacacs server NAME' / 'address ipv4' / 'port' / 'key' / 'timeout' sont tous réellement stockés", async () => {
    const { nas } = await buildLab();
    await configureNasTacacs(nas, { timeoutSec: 8 });
    const rc = await nas.executeCommand('show running-config');
    expect(rc).toContain('tacacs server TACACS-MANDENG');
    expect(rc).toMatch(new RegExp(`address ipv4 ${AAA_IP}`));
    expect(rc).toContain('key Tacacs@2025');
    expect(rc).toContain('timeout 8');
    expect(rc).toContain('aaa group server tacacs+ TACACS-GROUP');
    expect(rc).toContain('server name TACACS-MANDENG');
    expect(rc).toContain('aaa new-model');
  });

  it("'aaa authentication login default group X local' / 'aaa authorization commands 15 ...' / 'aaa accounting ...' sont stockées et rendues", async () => {
    const { nas } = await buildLab();
    await configureNasTacacs(nas);
    await cfg(nas);
    await nas.executeCommand('aaa authentication login default group TACACS-GROUP local');
    await nas.executeCommand('aaa authorization exec default group TACACS-GROUP local');
    await nas.executeCommand('aaa authorization commands 15 default group TACACS-GROUP local');
    await nas.executeCommand('aaa accounting exec default start-stop group TACACS-GROUP');
    await nas.executeCommand('aaa accounting commands 15 default start-stop group TACACS-GROUP');
    await nas.executeCommand('end');
    const rc = await nas.executeCommand('show running-config');
    expect(rc).toMatch(/aaa authentication login default group TACACS-GROUP local/);
    expect(rc).toMatch(/aaa authorization exec default group TACACS-GROUP local/);
    expect(rc).toMatch(/aaa authorization commands 15 default group TACACS-GROUP local/);
    expect(rc).toMatch(/aaa accounting exec default start-stop group TACACS-GROUP/);
    expect(rc).toMatch(/aaa accounting commands 15 default start-stop group TACACS-GROUP/);
  });
});

describe('§B — authentification console via TACACS+ : succès accorde le niveau de privilège renvoyé par le serveur', () => {
  it("un utilisateur TACACS+ valide obtient directement le niveau 15 ('Router#') sans jamais toucher au compte local", async () => {
    const { nas, aaaSrv } = await buildLab();
    aaaSrv.getTacacsServer().setEnabled(true);
    aaaSrv.getTacacsServer().setSharedSecret('Tacacs@2025');
    aaaSrv.getTacacsServer().addUser('netadmin', 'Admin@2025', 15);
    await configureNasTacacs(nas);
    await cfg(nas);
    await nas.executeCommand('aaa authentication login default group TACACS-GROUP local');
    await nas.executeCommand('line console 0');
    await nas.executeCommand('login local');
    await nas.executeCommand('end');

    const session = new CiscoTerminalSession('t1', nas);
    await session.init();
    await waitBoot(session);
    await submitText(session, 'netadmin');
    await waitForMode(session, (m) => m === 'password');
    await submitPassword(session, 'Admin@2025');
    await waitForMode(session, (m) => m === 'normal');
    await settleAaaLogin();

    await type(session, 'show privilege');
    expect(lastLines(session)).toContain('Current privilege level is 15');
  }, 10000);

  it('un mauvais mot de passe TACACS+ est rejeté normalement (pas de faux positif)', async () => {
    const { nas, aaaSrv } = await buildLab();
    aaaSrv.getTacacsServer().setEnabled(true);
    aaaSrv.getTacacsServer().setSharedSecret('Tacacs@2025');
    aaaSrv.getTacacsServer().addUser('netadmin', 'Admin@2025', 15);
    await configureNasTacacs(nas);
    await cfg(nas);
    await nas.executeCommand('aaa authentication login default group TACACS-GROUP local');
    await nas.executeCommand('line console 0');
    await nas.executeCommand('login local');
    await nas.executeCommand('end');

    const session = new CiscoTerminalSession('t1', nas);
    await session.init();
    await waitBoot(session);
    await submitText(session, 'netadmin');
    await waitForMode(session, (m) => m === 'password');
    await submitPassword(session, 'WrongPassword');
    await waitForLine(session, (l) => l.includes('% Login invalid'));
    expect(lastLines(session).some((l) => l.includes('% Login invalid'))).toBe(true);
  }, 10000);
});

describe('§C — serveur TACACS+ injoignable + fallback local : bascule silencieuse côté UI', () => {
  it("un compte LOCAL authentifie normalement quand le groupe TACACS+ est injoignable, sans aucun message d'erreur intermédiaire", async () => {
    const { nas } = await buildLab();
    // Server IP with no device behind it at all -- genuinely unreachable.
    await configureNasTacacs(nas, { serverIp: UNREACHABLE_IP, timeoutSec: 1 });
    await cfg(nas);
    await nas.executeCommand('username localadmin privilege 15 secret Local@2025');
    await nas.executeCommand('aaa authentication login default group TACACS-GROUP local');
    await nas.executeCommand('line console 0');
    await nas.executeCommand('login local');
    await nas.executeCommand('end');

    const session = new CiscoTerminalSession('t1', nas);
    await session.init();
    await waitBoot(session);
    await submitText(session, 'localadmin');
    await waitForMode(session, (m) => m === 'password');
    await submitPassword(session, 'Local@2025');
    // The unreachable TACACS+ server genuinely times out after the
    // configured 1-second `timeout` before AaaAuthenticator falls back to
    // `local` -- settle for longer than that real delay before checking.
    await settleAaaLogin(1800);

    const lines = lastLines(session);
    // Silent fallback: reaches the normal prompt directly -- no failure,
    // no lockout, no trace of TACACS+ having been down.
    expect(lines.some((l) => l.includes('% Login invalid'))).toBe(false);
    expect(lines.some((l) => l.includes('% Authentication failed'))).toBe(false);
    expect(lines.some((l) => l.includes('% Bad passwords'))).toBe(false);
    expect(session.currentInputMode.type).toBe('normal');
    await type(session, 'show privilege');
    expect(lastLines(session)).toContain('Current privilege level is 15');
  }, 10000);
});

describe('§D — serveur TACACS+ injoignable SANS fallback local : verrouillage immédiat', () => {
  it("'% Authentication failed' apparaît immédiatement (pas de boucle de 3 tentatives) et la session se ferme", async () => {
    const { nas } = await buildLab();
    await configureNasTacacs(nas, { serverIp: UNREACHABLE_IP, timeoutSec: 1 });
    await cfg(nas);
    await nas.executeCommand('username admin privilege 15 secret Admin@2025');
    // No `local` in the method list -- group is the ONLY method.
    await nas.executeCommand('aaa authentication login default group TACACS-GROUP');
    await nas.executeCommand('line console 0');
    await nas.executeCommand('login local');
    await nas.executeCommand('end');

    const session = new CiscoTerminalSession('t1', nas);
    let closed = false;
    session.onRequestClose(() => { closed = true; });
    await session.init();
    await waitBoot(session);
    await submitText(session, 'admin');
    await waitForMode(session, (m) => m === 'password');
    await submitPassword(session, 'Admin@2025');
    await waitForLine(session, (l) => l.includes('% Authentication failed'), 4000);

    const lines = lastLines(session);
    expect(lines.some((l) => l.includes('% Authentication failed'))).toBe(true);
    // No retry loop -- unlike the local 3-strikes flow, this never shows
    // "% Login invalid" nor asks for a 2nd Username:.
    expect(lines.some((l) => l.includes('% Login invalid'))).toBe(false);
    await tick();
    expect(closed).toBe(true);
  }, 10000);
});

describe("§E — 'test aaa group X user pass legacy'", () => {
  async function buildTestAaaLab(): Promise<{ nas: CiscoRouter; session: CiscoTerminalSession }> {
    const { nas, aaaSrv } = await buildLab();
    aaaSrv.getTacacsServer().setEnabled(true);
    aaaSrv.getTacacsServer().setSharedSecret('Tacacs@2025');
    aaaSrv.getTacacsServer().addUser('netadmin', 'Admin@2025', 15);
    await configureNasTacacs(nas);
    const session = new CiscoTerminalSession('t1', nas);
    await session.init();
    await waitBoot(session);
    // `test aaa` is a privileged-EXEC-only command.
    await type(session, 'enable');
    return { nas, session };
  }

  it("des identifiants valides produisent exactement 'Attempting authentication test...' puis 'User was successfully authenticated.'", async () => {
    const { session } = await buildTestAaaLab();
    await type(session, 'test aaa group TACACS-GROUP netadmin Admin@2025 legacy');
    await waitForLine(session, (l) => l.includes('successfully authenticated'), 4000);
    const lines = lastLines(session);
    expect(lines.some((l) => l.includes('Attempting authentication test to server-group TACACS-GROUP using TACACS+'))).toBe(true);
    expect(lines.some((l) => l === 'User was successfully authenticated.')).toBe(true);
  }, 10000);

  it("un mauvais mot de passe produit exactement 'User was NOT successfully authenticated.'", async () => {
    const { session } = await buildTestAaaLab();
    await type(session, 'test aaa group TACACS-GROUP netadmin WrongPwd legacy');
    await waitForLine(session, (l) => l.includes('NOT successfully authenticated'), 4000);
    expect(lastLines(session).some((l) => l === 'User was NOT successfully authenticated.')).toBe(true);
  }, 10000);
});

describe('§F — aaa authorization commands : TACACS+ refuse une commande précise', () => {
  async function buildAuthzLab(permittedCommands: string[]): Promise<{ nas: CiscoRouter; session: CiscoTerminalSession }> {
    const { nas, aaaSrv } = await buildLab();
    aaaSrv.getTacacsServer().setEnabled(true);
    aaaSrv.getTacacsServer().setSharedSecret('Tacacs@2025');
    aaaSrv.getTacacsServer().addUser('netadmin', 'Admin@2025', 15, permittedCommands);
    await configureNasTacacs(nas);
    await cfg(nas);
    await nas.executeCommand('aaa authentication login default group TACACS-GROUP local');
    await nas.executeCommand('aaa authorization commands 15 default group TACACS-GROUP local');
    await nas.executeCommand('line console 0');
    await nas.executeCommand('login local');
    await nas.executeCommand('end');

    const session = new CiscoTerminalSession('t1', nas);
    await session.init();
    await waitBoot(session);
    await submitText(session, 'netadmin');
    await waitForMode(session, (m) => m === 'password');
    await submitPassword(session, 'Admin@2025');
    await waitForMode(session, (m) => m === 'normal');
    await settleAaaLogin();
    return { nas, session };
  }

  it("'Command authorization failed.' s'affiche immédiatement pour une commande hors liste, et la session reste connectée", async () => {
    const { session } = await buildAuthzLab(['show version']);
    let closed = false;
    session.onRequestClose(() => { closed = true; });

    await type(session, 'show running-config');
    await waitForLine(session, (l) => l.includes('Command authorization failed.'));
    expect(lastLines(session)).toContain('Command authorization failed.');
    expect(lastLines(session).some((l) => l.includes('hostname'))).toBe(false);
    expect(closed).toBe(false);

    // The session is still usable -- an authorized command still works.
    await type(session, 'show version');
    expect(lastLines(session).some((l) => /Cisco IOS/i.test(l))).toBe(true);
  }, 10000);

  it('une commande autorisée par TACACS+ (ou toute commande, si permittedCommands est vide) exécute normalement', async () => {
    const { session } = await buildAuthzLab([]);
    await type(session, 'show running-config');
    await waitForLine(session, (l) => l.includes('hostname'));
    expect(lastLines(session).some((l) => l.includes('Command authorization failed.'))).toBe(false);
  }, 10000);
});
