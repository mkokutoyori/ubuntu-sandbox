/**
 * Le plan de gestion a une porte, et `allowaccess` la gouverne.
 *
 * §6.8 du carnet nommait le point : « l'authentification d'un compte
 * administrateur a l'ouverture de session n'est pas branchee sur une
 * vraie connexion SSH au pare-feu — le pare-feu n'a pas encore de
 * serveur SSH ». La mesure de depart trouve le defaut plus large :
 * `set allowaccess ssh|telnet|http|https|snmp` est STOCKE et lu par
 * personne (seul `ping` est consulte), et les sept reglages de
 * `config system global` qui gouvernent cette porte — `admin-ssh-port`,
 * `admin-telnet-port`, `admin-port`, `admin-sport`,
 * `admin-lockout-threshold`, `admin-lockout-duration`, `admintimeout` —
 * ne sont transmis a personne.
 *
 * Ecrite A L'AVEUGLE contre ce qu'un vrai FortiGate fait, verifie
 * contre la documentation Fortinet :
 *
 *   1. **`ssh admin@<pare-feu>` ouvre une VRAIE session** depuis un
 *      `LinuxPC` du depot, et les trames sont comptees sur le cable.
 *      Aucun raccourci d'objet a objet.
 *   2. **Une interface sans `allowaccess ssh` JETTE le paquet**, alors
 *      meme que le compte et le mot de passe sont bons — c'est le
 *      reglage d'interface qui decide, pas le compte, et la
 *      documentation Fortinet decrit un rejet SILENCIEUX : le client
 *      n'obtient aucun refus, il n'obtient rien, donc pas meme une
 *      invite de mot de passe.
 *   3. **`admin-ssh-port` deplace vraiment la porte** : le port declare
 *      ecoute et le 22 ne repond plus.
 *   4. **`trusthost` refuse a la CONNEXION**, pas au mot de passe : la
 *      documentation Fortinet decrit le paquet jete avant que le
 *      serveur ne le voie (`ssh_exchange_identification: Connection
 *      closed by remote host`).
 *   5. **La session porte la CLI FortiOS** — `get system status` repond
 *      a travers le fil, et le mode configuration tient d'une ligne a
 *      l'autre.
 *   6. **Chaque session a sa propre CLI** : deux sessions n'entrent pas
 *      dans le meme mode configuration.
 *
 * Discrimination (`git stash push -- src/network/`) : 7 des 14 cas
 * tombent avant correctif. Les 7 autres sont nommes ici plutot que
 * laisses a decouvrir, et aucun ne prouve le mecanisme :
 *   - « une interface sans `ssh` refuse », « le retirer referme la
 *     porte », « le port 22 ne repond plus » et « une source hors des
 *     hotes de confiance » passaient parce que RIEN n'ecoutait, donc
 *     toute connexion echouait de toute facon ;
 *   - « chaque session a sa propre CLI » passait parce qu'aucune
 *     session ne s'ouvrait ;
 *   - les deux cas de `ping` sont les temoins de non-regression, dont
 *     l'objet est que la porte nouvelle ne casse pas la porte ancienne.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { FortiShell } from '@/network/devices/firewall/vendors/fortios/FortiShell';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { getDefaultEventBus } from '@/events/EventBus';
import { LinuxTerminalSession } from '@/terminal/sessions/LinuxTerminalSession';
import type { TerminalSession, KeyEvent } from '@/terminal/sessions/TerminalSession';
import { pingOnSimulatedClock } from '../../../support/fastPing';

interface Cmd { executeCommand(cmd: string): Promise<string> }

const runOn = (d: Cmd, cmds: string[]) =>
  cmds.reduce(async (p, c) => { await p; await d.executeCommand(c); }, Promise.resolve<unknown>(undefined));

function run(sh: FortiShell, ...lines: string[]): string {
  let last = '';
  for (const line of lines) last = sh.execute(line);
  return last;
}

function key(k: string): KeyEvent {
  return { key: k, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false };
}

const tick = () => new Promise<void>((r) => setTimeout(r, 25));

async function sshLogin(
  host: TerminalSession, line: string, password: string,
): Promise<void> {
  host.setInput(line);
  host.handleKey(key('Enter'));
  for (let i = 0; i < 10 && host.currentInputMode.type !== 'password'; i++) await tick();
  if (host.currentInputMode.type === 'password') {
    host.setPasswordBuf(password);
    host.handleKey(key('Enter'));
  }
  for (let i = 0; i < 10; i++) await tick();
}

async function typeLine(host: TerminalSession, line: string): Promise<void> {
  const foreground = host.foreground;
  foreground.setInput(line);
  foreground.setInputBuf(line);
  host.handleKey(key('Enter'));
  for (let i = 0; i < 10; i++) await tick();
}

function landedOnFirewall(host: TerminalSession): boolean {
  return /FGT\b.*#/.test(host.foreground.getPrompt());
}

function transcript(host: TerminalSession): string {
  return host.lines.map((l) => l.text).join('\n');
}

async function countDispatchedFrames(fn: () => Promise<void>): Promise<number> {
  let count = 0;
  const unsub = getDefaultEventBus().subscribe('cable.frame.dispatched', () => { count++; });
  try { await fn(); } finally { unsub(); }
  return count;
}

async function laboratoire(allowaccess = 'ping ssh') {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
  EquipmentRegistry.resetInstance();

  const fw = new FortiGate('firewall-fortinet', 'FGT', 0, 0);
  const sh = fw.getShell();
  const poste = new LinuxPC('linux-pc', 'PC', -150, 0);
  poste.powerOn();

  new Cable('a').connect(poste.getPort('eth0')!, fw.getPort('port1')!);

  run(sh,
    'config system interface',
    'edit "port1"', 'set mode static',
    'set ip 192.168.1.1 255.255.255.0', `set allowaccess ${allowaccess}`, 'next', 'end');

  run(sh, 'config system admin', 'edit "admin"',
    'set password "Secret123"', 'set accprofile "super_admin"', 'next', 'end');

  await runOn(poste, ['ip link set eth0 up', 'ip addr add 192.168.1.10/24 dev eth0']);

  return { fw, sh, poste };
}

beforeEach(() => { Logger.reset(); });

describe('le pare-feu heberge un vrai serveur SSH', () => {
  it('`ssh admin@<pare-feu>` ouvre une session et les trames traversent le cable', async () => {
    const { poste } = await laboratoire();
    const host = new LinuxTerminalSession('h', poste);
    await host.init?.();

    const frames = await countDispatchedFrames(
      () => sshLogin(host, 'ssh admin@192.168.1.1', 'Secret123'));

    expect(frames).toBeGreaterThan(0);
    expect(landedOnFirewall(host)).toBe(true);
  });

  it('un mot de passe faux ne fait atterrir sur aucune session', async () => {
    const { poste } = await laboratoire();
    const host = new LinuxTerminalSession('h', poste);
    await host.init?.();

    await sshLogin(host, 'ssh admin@192.168.1.1', 'MAUVAIS');

    expect(landedOnFirewall(host)).toBe(false);
    expect(transcript(host)).toMatch(/Permission denied/);
  });

  it('la session porte la CLI FortiOS et repond a travers le fil', async () => {
    const { poste } = await laboratoire();
    const host = new LinuxTerminalSession('h', poste);
    await host.init?.();
    await sshLogin(host, 'ssh admin@192.168.1.1', 'Secret123');

    await typeLine(host, 'get system status');

    expect(transcript(host)).toMatch(/Version:\s*FortiGate/);
  });

  it('le mode configuration tient d`une ligne a l`autre', async () => {
    const { poste } = await laboratoire();
    const host = new LinuxTerminalSession('h', poste);
    await host.init?.();
    await sshLogin(host, 'ssh admin@192.168.1.1', 'Secret123');

    await typeLine(host, 'config system global');

    expect(host.foreground.getPrompt()).toMatch(/\(global\)\s*#/);
    await typeLine(host, 'end');
  });

  it('chaque session a sa propre CLI', async () => {
    const { fw, poste } = await laboratoire();
    const host = new LinuxTerminalSession('h', poste);
    await host.init?.();
    await sshLogin(host, 'ssh admin@192.168.1.1', 'Secret123');
    await typeLine(host, 'config system global');

    expect(fw.getShell().getPrompt()).toMatch(/FGT\s*#/);
    expect(fw.getShell().getPrompt()).not.toMatch(/global/);
  });
});

describe('`allowaccess` est une vraie porte', () => {
  it('une interface sans `ssh` refuse la connexion', async () => {
    const { poste } = await laboratoire('ping');
    const host = new LinuxTerminalSession('h', poste);
    await host.init?.();

    await sshLogin(host, 'ssh admin@192.168.1.1', 'Secret123');

    expect(landedOnFirewall(host)).toBe(false);
    expect(transcript(host)).not.toMatch(/password/i);
  });

  it('l`ajouter ouvre la porte sur la meme machine', async () => {
    const { sh, poste } = await laboratoire('ping');
    const refuse = new LinuxTerminalSession('h', poste);
    await refuse.init?.();
    await sshLogin(refuse, 'ssh admin@192.168.1.1', 'Secret123');
    expect(landedOnFirewall(refuse)).toBe(false);

    run(sh, 'config system interface', 'edit "port1"',
      'set allowaccess ping ssh', 'next', 'end');

    const host = new LinuxTerminalSession('h2', poste);
    await host.init?.();
    await sshLogin(host, 'ssh admin@192.168.1.1', 'Secret123');
    expect(landedOnFirewall(host)).toBe(true);
  });

  it('le retirer referme la porte', async () => {
    const { sh, poste } = await laboratoire();
    run(sh, 'config system interface', 'edit "port1"',
      'set allowaccess ping', 'next', 'end');

    const host = new LinuxTerminalSession('h', poste);
    await host.init?.();
    await sshLogin(host, 'ssh admin@192.168.1.1', 'Secret123');

    expect(landedOnFirewall(host)).toBe(false);
  });

  it('`ping` reste servi quand seule la porte SSH est ouverte', async () => {
    const { poste } = await laboratoire('ping ssh');

    expect(await pingOnSimulatedClock(poste, 'ping -c 1 192.168.1.1'))
      .toMatch(/, 0% packet loss/);
  });

  it('`ping` reste refuse quand il n`est pas declare', async () => {
    const { poste } = await laboratoire('ssh');

    expect(await pingOnSimulatedClock(poste, 'ping -c 1 192.168.1.1'))
      .toMatch(/, 100% packet loss/);
  });
});

describe('`config system global` gouverne la porte', () => {
  it('`admin-ssh-port` deplace vraiment le service', async () => {
    const { sh, poste } = await laboratoire();
    run(sh, 'config system global', 'set admin-ssh-port 2222', 'end');

    const host = new LinuxTerminalSession('h', poste);
    await host.init?.();
    await sshLogin(host, 'ssh -p 2222 admin@192.168.1.1', 'Secret123');

    expect(landedOnFirewall(host)).toBe(true);
  });

  it('le port 22 ne repond plus une fois le service deplace', async () => {
    const { sh, poste } = await laboratoire();
    run(sh, 'config system global', 'set admin-ssh-port 2222', 'end');

    const host = new LinuxTerminalSession('h', poste);
    await host.init?.();
    await sshLogin(host, 'ssh admin@192.168.1.1', 'Secret123');

    expect(landedOnFirewall(host)).toBe(false);
  });
});

describe('`allowaccess telnet` ouvre la meme CLI', () => {
  it('une session telnet authentifiee atteint la CLI', async () => {
    const { poste } = await laboratoire('ping telnet');
    const host = new LinuxTerminalSession('h', poste);
    await host.init?.();

    await typeLine(host, 'telnet 192.168.1.1');
    await typeLine(host, 'admin');
    await typeLine(host, 'Secret123');

    expect(landedOnFirewall(host)).toBe(true);
  });

  it('sans `telnet` declare, la connexion n`aboutit pas', async () => {
    const { poste } = await laboratoire('ping ssh');
    const host = new LinuxTerminalSession('h', poste);
    await host.init?.();

    await typeLine(host, 'telnet 192.168.1.1');

    expect(transcript(host)).not.toMatch(/[Ll]ogin:/);
  });

  it('`admin-telnet-port` deplace le service', async () => {
    const { sh, poste } = await laboratoire('ping telnet');
    run(sh, 'config system global', 'set admin-telnet-port 2323', 'end');

    const host = new LinuxTerminalSession('h', poste);
    await host.init?.();
    await typeLine(host, 'telnet 192.168.1.1 2323');
    await typeLine(host, 'admin');
    await typeLine(host, 'Secret123');

    expect(landedOnFirewall(host)).toBe(true);
  });
});

describe('`trusthost` refuse a la connexion', () => {
  it('une source hors des hotes de confiance ne peut pas ouvrir de session', async () => {
    const { sh, poste } = await laboratoire();
    run(sh, 'config system admin', 'edit "admin"',
      'set trusthost1 10.9.9.0 255.255.255.0', 'next', 'end');

    const host = new LinuxTerminalSession('h', poste);
    await host.init?.();
    await sshLogin(host, 'ssh admin@192.168.1.1', 'Secret123');

    expect(landedOnFirewall(host)).toBe(false);
  });

  it('une source couverte ouvre la session avec la meme configuration', async () => {
    const { sh, poste } = await laboratoire();
    run(sh, 'config system admin', 'edit "admin"',
      'set trusthost1 192.168.1.0 255.255.255.0', 'next', 'end');

    const host = new LinuxTerminalSession('h', poste);
    await host.init?.();
    await sshLogin(host, 'ssh admin@192.168.1.1', 'Secret123');

    expect(landedOnFirewall(host)).toBe(true);
  });
});
