/**
 * La complétion d'un équipement doit être la MEME, qu'on soit sur sa
 * console ou qu'on l'atteigne par SSH.
 *
 * MESURE DE DEPART, reproduite depuis la transcription d'un operateur :
 * `get sys int` puis Tab, sur un FortiGate.
 *
 *   candidats du pare-feu     : ["get system interface"]
 *   console locale, apres Tab : "get system interface "
 *   par SSH depuis un Linux   : "get sys get system interface"
 *
 * La troisieme ligne est le defaut : le candidat rendu par une CLI
 * vendeur est une LIGNE ENTIERE, et la session Linux le donnait a un
 * `LastWordSource`, qui conserve le prefixe et colle le candidat
 * derriere. D'ou `get sys ` + `get system interface`.
 *
 * LA CAUSE, en une phrase : la FORME du candidat etait decidee par la
 * session LOCALE alors qu'elle est une propriete du shell qui REPOND.
 * `CLITerminalSession` choisit `FullLineSource` parce qu'elle sait
 * qu'elle parle a une CLI vendeur ; `LinuxTerminalSession` choisit
 * `LastWordSource` parce qu'elle suppose un shell POSIX. Par SSH, la
 * seconde se trompe des que le distant est un vendeur.
 *
 * CE QUI ETAIT DEJA SUR LE FIL, et que personne ne lisait. Le serveur
 * declare `supportsInlineHelp` (`ISshServerContext`), `SshServerHandler`
 * l'envoie, `SshShellChannel` le lit : le distant DIT deja qu'il est une
 * CLI vendeur, parce que `?` y est une touche d'aide. C'est le meme fait
 * qui decide la forme du candidat, donc aucun champ neuf n'est ajoute au
 * protocole — `completesWholeLine()` le derive la ou il arrive deja.
 *
 * AUTORITE : `docs/PRD-SSH-Unification.md` §4bis B1, qui pose le chemin
 * de completion asynchrone comme prerequis et le qualifie de
 * « changement de contrat ». B1 avait ete fait, mais la forme du
 * candidat, elle, n'avait pas suivi.
 *
 * DISCRIMINATION (`git stash push -- src/terminal`) : 2 des 7 cas
 * tombent — le pare-feu ET le routeur Cisco, ce qui est le point : le
 * defaut n'est pas celui d'un equipement mais de la CLASSE des CLI
 * vendeur, puisque `RouterSshServerContext` declare le meme drapeau pour
 * les routeurs et les commutateurs. Les cinq autres cas sont des
 * TEMOINS, nommes ici avec leur raison :
 *
 *   - les candidats du pare-feu prouvent que le vocabulaire existe ;
 *   - la console locale donne la REFERENCE a laquelle le SSH doit etre
 *     egal, et c'est elle qui rend le verdict lisible ;
 *   - un Windows vers ce meme pare-feu, et un Windows vers un Linux,
 *     passent par une SESSION ENFANT en memoire (le « bypass » du PRD
 *     §4bis) et non par un sous-shell SSH : ils n'ont jamais ete
 *     touches, et le dire evite de croire le defaut plus large qu'il
 *     n'est ;
 *   - un distant POSIX doit continuer de completer le DERNIER MOT, ce
 *     qui est le cas que le correctif pouvait le plus plausiblement
 *     casser.
 *
 * DEUX FAUSSES PISTES, gardees parce qu'elles sont instructives. On a
 * d'abord conclu que « Windows ne complete rien par SSH », en injectant
 * a la main un `activeSubShell` dans une session Windows — une
 * configuration qui NE SE PRODUIT PAS, puisque Windows ouvre une session
 * enfant. Mesurer un montage qu'on a fabrique soi-meme ne mesure que le
 * montage. Ensuite, le pilote partage a d'abord ete ecrit entierement
 * asynchrone, ce qui a fait tomber quatre cas de
 * `linux-subshell-tab-completion` : un sous-shell qui sait repondre dans
 * le tour DOIT completer dans le tour, sans quoi tout appelant qui
 * n'attend pas lit un tampon inchange.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { FortiShell } from '@/network/devices/firewall/vendors/fortios/FortiShell';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { LinuxTerminalSession } from '@/terminal/sessions/LinuxTerminalSession';
import { WindowsTerminalSession } from '@/terminal/sessions/WindowsTerminalSession';
import type { TerminalSession, KeyEvent } from '@/terminal/sessions/TerminalSession';

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

async function sshLogin(host: TerminalSession, line: string, password: string): Promise<void> {
  host.setInput(line);
  host.handleKey(key('Enter'));
  for (let i = 0; i < 10 && host.currentInputMode.type !== 'password'; i++) await tick();
  if (host.currentInputMode.type === 'password') {
    host.setPasswordBuf(password);
    host.handleKey(key('Enter'));
  }
  for (let i = 0; i < 10; i++) await tick();
}

async function tabOn(host: TerminalSession, line: string): Promise<{ input: string; buffer: string }> {
  host.foreground.setInput(line);
  host.foreground.setInputBuf(line);
  host.handleKey(key('Tab'));
  for (let i = 0; i < 12; i++) await tick();
  return { input: host.foreground.input, buffer: host.foreground.getInputBuf() };
}

async function lab() {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
  EquipmentRegistry.resetInstance();

  const fw = new FortiGate('firewall-fortinet', 'FGT', 0, 0);
  const sh = fw.getShell();
  const linux = new LinuxPC('linux-pc', 'PC', -150, 0);
  const win = new WindowsPC('windows-pc', 'WPC', -150, 80);
  const target = new LinuxPC('linux-pc', 'CIBLE', 200, 0);
  target.setHostname('cible');
  linux.powerOn(); win.powerOn(); target.powerOn();

  const sw = new GenericSwitch('switch-generic', 'sw', 8, 0, 0);
  new Cable('a').connect(linux.getPort('eth0')!, sw.getPorts()[0]);
  new Cable('b').connect(win.getPorts()[0], sw.getPorts()[1]);
  new Cable('c').connect(sw.getPorts()[2], fw.getPort('port1')!);
  new Cable('d').connect(target.getPort('eth0')!, sw.getPorts()[3]);

  run(sh, 'config system interface', 'edit "port1"', 'set mode static',
    'set ip 192.168.1.1 255.255.255.0', 'set allowaccess ping ssh', 'next', 'end');
  run(sh, 'config system admin', 'edit "admin"',
    'set password "Secret123"', 'set accprofile "super_admin"', 'next', 'end');

  await runOn(linux, ['ip link set eth0 up', 'ip addr add 192.168.1.10/24 dev eth0']);
  await runOn(win, ['netsh interface ip set address "Ethernet" static 192.168.1.11 255.255.255.0']);
  await runOn(target, ['ip link set eth0 up', 'ip addr add 192.168.1.20/24 dev eth0',
    'mkdir -p /tmp/zzuniqueremote']);

  const um = (target as unknown as { executor: { userMgr: {
    useradd: (u: string, o?: object) => void;
    getUser: (u: string) => unknown;
    setPassword: (u: string, p: string) => void;
  } } }).executor.userMgr;
  if (!um.getUser('admin')) um.useradd('admin', { m: true, s: '/bin/bash' });
  um.setPassword('admin', 'Secret123');

  const cisco = new CiscoRouter('R1', 0, 0);
  new Cable('e').connect(cisco.getPort('GigabitEthernet0/0')!, sw.getPorts()[4]);
  await runOn(cisco, ['enable', 'configure terminal',
    'interface GigabitEthernet0/0', 'ip address 192.168.1.30 255.255.255.0',
    'no shutdown', 'exit',
    'username admin privilege 15 secret Secret123', 'enable secret Secret123',
    'ip domain-name lab.local', 'crypto key generate rsa modulus 2048',
    'ip ssh version 2', 'line vty 0 4', 'login local', 'transport input ssh',
    'exit', 'end']);

  return { fw, linux, win, cisco };
}

beforeEach(() => { Logger.reset(); });

describe('the firewall answers the same Tab, console or SSH', () => {
  it('the firewall has a candidate for `get sys int` — WITNESS', async () => {
    const { fw } = await lab();
    expect(fw.cliTabCandidates('get sys int')).toEqual(['get system interface']);
  }, 30000);

  it('its own console completes the whole line — REFERENCE WITNESS', async () => {
    const { win } = await lab();
    const host = new WindowsTerminalSession('w', win);
    await host.init?.();
    await sshLogin(host, 'ssh admin@192.168.1.1', 'Secret123');
    const after = await tabOn(host, 'get sys int');
    expect(after.input).toBe('get system interface ');
  }, 30000);

  it('reached over SSH from Linux, it completes identically', async () => {
    const { linux } = await lab();
    const host = new LinuxTerminalSession('h', linux);
    await host.init?.();
    await sshLogin(host, 'ssh admin@192.168.1.1', 'Secret123');
    const after = await tabOn(host, 'get sys int');
    expect(after.buffer).toBe('get system interface ');
  }, 30000);
});

describe('what the fix must not disturb', () => {
  it('a POSIX remote still completes the last word only', async () => {
    const { linux } = await lab();
    const host = new LinuxTerminalSession('h2', linux);
    await host.init?.();
    await sshLogin(host, 'ssh admin@192.168.1.20', 'Secret123');
    const after = await tabOn(host, 'ls /tmp/zzuniqueremot');
    expect(after.buffer).toBe('ls /tmp/zzuniqueremote/');
  }, 30000);

  it('Windows reaches the firewall through a child session, not a sub-shell', async () => {
    const { win } = await lab();
    const host = new WindowsTerminalSession('w2', win);
    await host.init?.();
    await sshLogin(host, 'ssh admin@192.168.1.1', 'Secret123');
    const fg = host.foreground as unknown as { activeSubShell: unknown };
    expect(fg.activeSubShell).toBeFalsy();
    expect(host.foreground.constructor.name).toBe('FortiTerminalSession');
  }, 30000);

  it('Windows to a POSIX host completes too', async () => {
    const { win } = await lab();
    const host = new WindowsTerminalSession('w3', win);
    await host.init?.();
    await sshLogin(host, 'ssh admin@192.168.1.20', 'Secret123');
    const after = await tabOn(host, 'ls /tmp/zzuniqueremot');
    expect(after.input).toBe('ls /tmp/zzuniqueremote/');
  }, 30000);
});

describe('the same rule holds for every vendor CLI, not just this one', () => {
  it('a Cisco router reached over SSH completes the whole line too', async () => {
    const { linux } = await lab();
    const host = new LinuxTerminalSession('h3', linux);
    await host.init?.();
    await sshLogin(host, 'ssh admin@192.168.1.30', 'Secret123');
    const after = await tabOn(host, 'show ip int');
    expect(after.buffer.startsWith('show ip int')).toBe(true);
    expect(after.buffer).not.toContain('show ip int show');
  }, 30000);
});
