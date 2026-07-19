/**
 * Scénario 2 — Configuration et comportement des lignes console, VTY et AUX.
 *
 * Couvre, avec le vrai moteur (pas de simulation superficielle) :
 *  - `line aux 0` : `no exec` / `transport input none` réellement stockés
 *    et persistés dans `show running-config` (jusqu'ici silencieusement
 *    ignorés — aucun stockage n'existait pour AUX).
 *  - `logging synchronous` : stocké et rendu dans la configuration, ET
 *    comportement réel — un message asynchrone (syslog/monitor) est
 *    différé tant que l'utilisateur a une commande en cours de saisie,
 *    plutôt que d'interrompre visuellement la ligne.
 *  - `privilege level N` sur une ligne (console ou VTY) : override RÉEL
 *    du privilège du compte authentifié via `login local` — comportement
 *    IOS réel confirmé (la ligne prime sur le compte quand elle est
 *    configurée ; à défaut, le privilège du compte s'applique, comme au
 *    Scénario 1).
 *  - `transport input ssh` bloque effectivement Telnet entrant, avec
 *    exactement `% Connection refused by remote host`.
 *  - `access-class` restreint les IP autorisées à ouvrir une session SSH.
 *  - `exec-timeout` : déconnexion RÉELLE après inactivité, aussi bien sur
 *    la console (retour à l'écran de login) que sur une VTY distante
 *    (fermeture de la session SSH, visible côté client).
 *  - `show line vty <first> <last>` reflète le exec-timeout réellement
 *    configuré sur cette ligne (pas une table statique déconnectée de la
 *    configuration).
 *
 * Portée assumée : le seul terminal interactif réellement exposé par
 * l'UI est la console (terminal ouvert par double-clic) ; l'accès VTY
 * distant est testé via le mécanisme SSH imbriqué existant
 * (`adoptRemoteChild` / `prepareAsRemoteUser`), qui est le point
 * d'intégration réel pour "être connecté sur la ligne VTY" dans ce
 * simulateur — pas une nouvelle UI de terminal VTY dédiée.
 *
 * Écart assumé entre le scénario et la réalité (suivant la consigne :
 * en cas de divergence, la réalité prime) : le scénario écrit le message
 * de déconnexion par timeout VTY sous la forme
 * `[Connection to X closed by foreign host]` (phrasé historique du
 * client telnet BSD). La connexion configurée dans ce scénario est SSH,
 * et le vrai client OpenSSH (et déjà toute la suite de tests SSH
 * existante de ce dépôt) affiche `Connection to X closed.` — c'est ce
 * message, déjà établi partout ailleurs dans la base de code, qui est
 * testé ici.
 *
 * TDD: écrit avant l'implémentation. Confirmé absent/lacunaire par la
 * recherche d'architecture : stockage AUX totalement absent, champ
 * `loggingSynchronous` accepté par le parseur mais jamais persisté
 * (`VtyLineConfigInit` ne l'a pas), `privilege level N` de ligne stocké
 * mais jamais lu au login (`prepareAsRemoteUser` accorde 15 en dur, et
 * `buildConsoleLoginSteps` n'utilise que le privilège du compte), aucun
 * mécanisme d'exec-timeout nulle part dans la couche terminal, `show
 * line` totalement statique.
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
import { tryInterpretSshLaunch, type SshLaunchOptions } from '@/shell/sshLauncher';

/**
 * Emit one line through the SAME background-async-job mechanism real
 * syslog/monitor/debug subscriptions use (`startMonitorSubscription` /
 * `startDebugSubscription` in `CiscoTerminalSession`) -- proving the
 * generic "logging synchronous" defer behaviour against the real
 * delivery path, without depending on the separate `terminal monitor`
 * on/off gate (an unrelated VTY-only toggle in real IOS; the console
 * receives log messages by default).
 */
function emitAsyncLine(session: TerminalSession, text: string): void {
  session.startAsyncCommand({
    mode: 'background',
    kind: 'subscription',
    command: 'syslog',
    run: (ctx) => {
      ctx.sink.line(text);
      return Promise.resolve();
    },
  });
}

beforeEach(() => {
  EquipmentRegistry.resetInstance();
  resetCounters();
  MACAddress.resetCounter();
  resetDeviceCounters();
  Logger.reset();
});

// ─── Shared UI-driving helpers (same contract as Scénario 1) ──────────

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
function lastLines(session: TerminalSession, n = 30): string[] {
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

// ─── Small routed lab: one Linux PC + one Cisco router ─────────────────

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
    'enable', 'configure terminal',
    'interface GigabitEthernet0/0',
    `ip address ${CISCO_IP} ${MASK}`,
    'no shutdown', 'end',
  ]) await cisco.executeCommand(cmd);
  return { pc, cisco };
}

function launchOpts(pc: LinuxPC, sourceIp = PC_IP): SshLaunchOptions {
  return {
    defaultUser: 'root',
    sourceIp,
    wireProbe: (host, port) => pc.tcpConnectOutcome(new IPAddress(host), port),
  };
}

/** Drive `ssh admin@<ip>` from the Linux client through the real terminal. */
async function sshLogin(term: LinuxTerminalSession, host: string, password: string): Promise<void> {
  await type(term, `ssh admin@${host}`);
  if (term.currentInputMode.type === 'password') {
    await submitPassword(term, password);
  }
}

describe('Scénario 2 — line aux 0 : stockage réel + running-config', () => {
  it("'no exec' et 'transport input none' sous 'line aux 0' sont réellement stockés (pas silencieusement ignorés)", async () => {
    const r = new CiscoRouter('R1', 0, 0);
    await cfg(r);
    await r.executeCommand('line aux 0');
    await r.executeCommand('no exec');
    await r.executeCommand('transport input none');
    await r.executeCommand('end');

    const rc = await r.executeCommand('show running-config');
    expect(rc).toContain('line aux 0');
    expect(rc).toMatch(/no exec/);
    expect(rc).toMatch(/transport input none/);
  });

  it("la configuration AUX n'interfère pas avec la ligne console ou VTY sélectionnée", async () => {
    const r = new CiscoRouter('R1', 0, 0);
    await cfg(r);
    await r.executeCommand('line console 0');
    await r.executeCommand('login local');
    await r.executeCommand('line aux 0');
    await r.executeCommand('no exec');
    await r.executeCommand('line vty 0 4');
    await r.executeCommand('exec-timeout 5 0');
    await r.executeCommand('end');

    const rc = await r.executeCommand('show running-config');
    expect(rc).toMatch(/line console 0[\s\S]*login local/);
    expect(rc).toMatch(/exec-timeout 5 0/);
    expect(rc).toContain('no exec');
  });
});

describe('Scénario 2 — logging synchronous : stockage + non-interruption réelle de la saisie', () => {
  it("'logging synchronous' sous 'line console 0' est persisté dans show running-config", async () => {
    const r = new CiscoRouter('R1', 0, 0);
    await cfg(r);
    await r.executeCommand('line console 0');
    await r.executeCommand('login local');
    await r.executeCommand('logging synchronous');
    await r.executeCommand('end');

    const rc = await r.executeCommand('show running-config');
    expect(rc).toMatch(/line console 0[\s\S]*logging synchronous/);
  });

  it('SANS logging synchronous, un message asynchrone interrompt immédiatement une commande en cours de saisie', async () => {
    const r = new CiscoRouter('R1', 0, 0);
    r.powerOn();
    await cfg(r);
    await r.executeCommand('username admin privilege 15 secret Admin@2025');
    await r.executeCommand('line console 0');
    await r.executeCommand('login local');
    await r.executeCommand('end');

    const session = new CiscoTerminalSession('t1', r);
    await session.init();
    await waitBoot(session);
    await submitText(session, 'admin');
    await waitForMode(session, (m) => m === 'password');
    await submitPassword(session, 'Admin@2025');

    // Start typing a command but do NOT press Enter yet.
    session.setInput('show ip int');
    await tick();

    emitAsyncLine(session, '*Jul  1 08:42:15.123: %LINK-3-UPDOWN: Interface GigabitEthernet0/1, changed state to up');
    await tick();

    expect(lastLines(session).some((l) => l.includes('%LINK-3-UPDOWN'))).toBe(true);
  });

  it('AVEC logging synchronous, le message asynchrone est différé tant que la commande est en cours de saisie, puis affiché après soumission', async () => {
    const r = new CiscoRouter('R1', 0, 0);
    r.powerOn();
    await cfg(r);
    await r.executeCommand('username admin privilege 15 secret Admin@2025');
    await r.executeCommand('line console 0');
    await r.executeCommand('login local');
    await r.executeCommand('logging synchronous');
    await r.executeCommand('end');

    const session = new CiscoTerminalSession('t1', r);
    await session.init();
    await waitBoot(session);
    await submitText(session, 'admin');
    await waitForMode(session, (m) => m === 'password');
    await submitPassword(session, 'Admin@2025');

    session.setInput('show ip int');
    await tick();

    emitAsyncLine(session, '*Jul  1 08:42:15.123: %LINK-3-UPDOWN: Interface GigabitEthernet0/1, changed state to up');
    await tick();

    // Still typing -- the async line must NOT have interrupted the buffer yet.
    expect(lastLines(session).some((l) => l.includes('%LINK-3-UPDOWN'))).toBe(false);
    expect(session.input).toBe('show ip int');

    // Submitting the command flushes the deferred line.
    session.handleKey(key('Enter'));
    await tick();
    expect(lastLines(session).some((l) => l.includes('%LINK-3-UPDOWN'))).toBe(true);
  });
});

describe('Scénario 2 — privilege level N sur la ligne : override réel du privilège du compte', () => {
  it("'privilege level 15' sur 'line console 0' accorde le niveau 15 même à un compte configuré à un niveau inférieur", async () => {
    const r = new CiscoRouter('R1', 0, 0);
    r.powerOn();
    await cfg(r);
    await r.executeCommand('username operateur privilege 1 secret Oper@2025');
    await r.executeCommand('line console 0');
    await r.executeCommand('login local');
    await r.executeCommand('privilege level 15');
    await r.executeCommand('end');

    const session = new CiscoTerminalSession('t1', r);
    await session.init();
    await waitBoot(session);
    await submitText(session, 'operateur');
    await waitForMode(session, (m) => m === 'password');
    await submitPassword(session, 'Oper@2025');

    await type(session, 'show privilege');
    expect(lastLines(session)).toContain('Current privilege level is 15');
  });

  it("SANS 'privilege level' sur la ligne, le privilège du compte s'applique normalement (régression du Scénario 1)", async () => {
    const r = new CiscoRouter('R1', 0, 0);
    r.powerOn();
    await cfg(r);
    await r.executeCommand('username operateur privilege 7 secret Oper@2025');
    await r.executeCommand('line console 0');
    await r.executeCommand('login local');
    await r.executeCommand('end');

    const session = new CiscoTerminalSession('t1', r);
    await session.init();
    await waitBoot(session);
    await submitText(session, 'operateur');
    await waitForMode(session, (m) => m === 'password');
    await submitPassword(session, 'Oper@2025');

    await type(session, 'show privilege');
    expect(lastLines(session)).toContain('Current privilege level is 7');
  });

  it("'privilege level 1' sur 'line vty 0 4' limite un compte admin (niveau 15) au niveau 1 via SSH entrant", async () => {
    const { pc, cisco } = await buildSshLab();
    await cfg(cisco);
    await cisco.executeCommand('username admin privilege 15 secret Admin@2025');
    await cisco.executeCommand('ip domain-name lab.local');
    await cisco.executeCommand('crypto key generate rsa modulus 2048');
    await cisco.executeCommand('line vty 0 4');
    await cisco.executeCommand('login local');
    await cisco.executeCommand('transport input ssh');
    await cisco.executeCommand('privilege level 1');
    await cisco.executeCommand('end');

    const term = new LinuxTerminalSession('t1', pc);
    await term.init();
    await sshLogin(term, CISCO_IP, 'Admin@2025');

    await type(term, 'show privilege');
    expect(lastLines(term)).toContain('Current privilege level is 1');
  });

  it("SANS 'privilege level' sur la VTY, le privilège du compte s'applique via SSH (régression du flux SSH entrant existant)", async () => {
    const { pc, cisco } = await buildSshLab();
    await cfg(cisco);
    await cisco.executeCommand('username admin privilege 15 secret Admin@2025');
    await cisco.executeCommand('ip domain-name lab.local');
    await cisco.executeCommand('crypto key generate rsa modulus 2048');
    await cisco.executeCommand('line vty 0 4');
    await cisco.executeCommand('login local');
    await cisco.executeCommand('transport input ssh');
    await cisco.executeCommand('end');

    const term = new LinuxTerminalSession('t1', pc);
    await term.init();
    await sshLogin(term, CISCO_IP, 'Admin@2025');

    await type(term, 'show privilege');
    expect(lastLines(term)).toContain('Current privilege level is 15');
  });
});

describe('Scénario 2 — transport input ssh bloque Telnet', () => {
  it("'transport input ssh' sur la VTY cible produit exactement '% Connection refused by remote host' pour une tentative Telnet sortante depuis un autre routeur Cisco", async () => {
    const target = new CiscoRouter('target', 0, 0);
    const attacker = new CiscoRouter('attacker', 0, 0);
    const sw = new GenericSwitch('switch-generic', 'sw', 8, 0, 0);
    new Cable('c1').connect(target.getPorts()[0], sw.getPorts()[0]);
    new Cable('c2').connect(attacker.getPorts()[0], sw.getPorts()[1]);
    for (const cmd of [
      'enable', 'configure terminal', 'interface GigabitEthernet0/0',
      `ip address ${CISCO_IP} ${MASK}`, 'no shutdown', 'end',
    ]) await target.executeCommand(cmd);
    for (const cmd of [
      'enable', 'configure terminal', 'interface GigabitEthernet0/0',
      'ip address 10.0.0.7 255.255.255.0', 'no shutdown', 'end',
    ]) await attacker.executeCommand(cmd);
    await cfg(target);
    await target.executeCommand('line vty 0 4');
    await target.executeCommand('transport input ssh');
    await target.executeCommand('end');

    const out = await attacker.executeCommand(`telnet ${CISCO_IP}`);
    expect(out).toContain('% Connection refused by remote host');
  });
});

describe('Scénario 2 — access-class restreint les IP autorisées en SSH', () => {
  it("une IP hors de l'access-class reçoit exactement le refus de connexion SSH côté client", async () => {
    const { pc, cisco } = await buildSshLab();
    await cfg(cisco);
    await cisco.executeCommand('access-list 10 permit 192.168.99.0 0.0.0.255');
    await cisco.executeCommand('line vty 0 4');
    await cisco.executeCommand('access-class 10 in');
    await cisco.executeCommand('end');

    const attempt = await tryInterpretSshLaunch(`ssh admin@${CISCO_IP}`, launchOpts(pc, PC_IP));
    expect(attempt?.kind).toBe('error');
    expect(attempt?.result.output.join('\n')).toMatch(/Connection refused/);
  });

  it("une IP dans l'access-class peut se connecter normalement (prompt de mot de passe)", async () => {
    const { pc, cisco } = await buildSshLab();
    await cfg(cisco);
    await cisco.executeCommand('access-list 10 permit 10.0.0.0 0.0.0.255');
    await cisco.executeCommand('line vty 0 4');
    await cisco.executeCommand('access-class 10 in');
    await cisco.executeCommand('end');

    const attempt = await tryInterpretSshLaunch(`ssh admin@${CISCO_IP}`, launchOpts(pc, PC_IP));
    expect(attempt?.kind).not.toBe('error');
  });
});

describe('Scénario 2 — exec-timeout : déconnexion réelle après inactivité', () => {
  it("sur la console, après expiration de l'exec-timeout, la session se réinitialise et réaffiche 'User Access Verification' / Username:", async () => {
    const r = new CiscoRouter('R1', 0, 0);
    r.powerOn();
    await cfg(r);
    await r.executeCommand('username admin privilege 15 secret Admin@2025');
    await r.executeCommand('line console 0');
    await r.executeCommand('login local');
    await r.executeCommand('exec-timeout 0 1');
    await r.executeCommand('end');

    const session = new CiscoTerminalSession('t1', r);
    await session.init();
    await waitBoot(session);
    await submitText(session, 'admin');
    await waitForMode(session, (m) => m === 'password');
    await submitPassword(session, 'Admin@2025');
    expect(session.currentInputMode.type).toBe('normal');

    // No activity for longer than the 1-second exec-timeout.
    await new Promise((res) => setTimeout(res, 1400));

    expect(lastLines(session).some((l) => l.includes('User Access Verification'))).toBe(true);
    expect(session.currentInputMode.type).toBe('interactive-text');
  }, 10000);

  it("l'activité (une commande) réarme le minuteur -- pas de déconnexion tant que des commandes arrivent régulièrement", async () => {
    const r = new CiscoRouter('R1', 0, 0);
    r.powerOn();
    await cfg(r);
    await r.executeCommand('username admin privilege 15 secret Admin@2025');
    await r.executeCommand('line console 0');
    await r.executeCommand('login local');
    await r.executeCommand('exec-timeout 0 3');
    await r.executeCommand('end');

    const session = new CiscoTerminalSession('t1', r);
    await session.init();
    await waitBoot(session);
    await submitText(session, 'admin');
    await waitForMode(session, (m) => m === 'password');
    await submitPassword(session, 'Admin@2025');

    // The ORIGINAL login banner is still within scrollback at this point
    // -- count occurrences now so a re-triggered (timed-out) login isn't
    // masked by that first, legitimate one still being in view.
    const bannerCountBeforeWaits = lastLines(session, 200).filter((l) => l.includes('User Access Verification')).length;

    // Each individual gap between activity is well under the 3-second
    // exec-timeout -- only cumulative elapsed time (which re-arming must
    // NOT count against) would trip a broken implementation.
    await new Promise((res) => setTimeout(res, 900));
    await type(session, 'show privilege');
    await new Promise((res) => setTimeout(res, 900));
    await type(session, 'show privilege');

    expect(session.currentInputMode.type).toBe('normal');
    const bannerCountAfter = lastLines(session, 200).filter((l) => l.includes('User Access Verification')).length;
    expect(bannerCountAfter).toBe(bannerCountBeforeWaits);
  }, 10000);

  it("sur une VTY distante (SSH imbriqué), après expiration de l'exec-timeout, la session distante se ferme et le client affiche 'Connection to X closed.'", async () => {
    const { pc, cisco } = await buildSshLab();
    await cfg(cisco);
    await cisco.executeCommand('username admin privilege 15 secret Admin@2025');
    await cisco.executeCommand('ip domain-name lab.local');
    await cisco.executeCommand('crypto key generate rsa modulus 2048');
    await cisco.executeCommand('line vty 0 4');
    await cisco.executeCommand('login local');
    await cisco.executeCommand('transport input ssh');
    await cisco.executeCommand('exec-timeout 0 1');
    await cisco.executeCommand('end');

    const term = new LinuxTerminalSession('t1', pc);
    await term.init();
    await sshLogin(term, CISCO_IP, 'Admin@2025');
    expect(term.foreground.getPrompt()).toMatch(/ciscoR[#>]/);

    await new Promise((res) => setTimeout(res, 1400));

    expect(lastLines(term).some((l) => l.includes(`Connection to ${CISCO_IP} closed.`))).toBe(true);
    // The nested remote child is gone -- we're back on the local Linux prompt.
    expect(term.foreground).toBe(term);
  }, 10000);
});

describe('Scénario 2 — show line reflète le exec-timeout réel de la ligne', () => {
  it("'show line vty 0 4' affiche le timeout réellement configuré, pas une valeur statique déconnectée", async () => {
    const r = new CiscoRouter('R1', 0, 0);
    await cfg(r);
    await r.executeCommand('line vty 0 4');
    await r.executeCommand('exec-timeout 5 0');
    await r.executeCommand('end');

    const out = await r.executeCommand('show line vty 0 4');
    expect(out).toContain('00:05:00');
  });
});
