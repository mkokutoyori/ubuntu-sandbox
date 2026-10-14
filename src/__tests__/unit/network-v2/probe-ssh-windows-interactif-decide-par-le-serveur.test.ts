/**
 * Mesure de depart (suite du rapport « sSH alice@192.168.10.3 ») : la connexion interactive d'un
 * terminal Windows commencait par un controle en memoire (`findHostByAddress`, `sshdAcceptsLogin`,
 * `recordSshLogin`, bannieres composees depuis l'objet distant) avant de rejouer la connexion sur
 * le fil. Le serveur n'etait donc ni seul juge ni seul temoin : un refus pouvait etre prononce
 * sans mot de passe, la connexion etait journalisee deux fois et l'accueil (motd, « Last login »)
 * etait fabrique par le client. Le terminal passe desormais par `openWireSshShell` et le serveur
 * sshd ouvre lui-meme l'enregistrement de session (`who`, `last`, `ps`) et envoie l'accueil.
 *
 * Laboratoire : PC Windows et serveur Linux sur un commutateur, compte alice. Premier lot (sept
 * cas) : deux tombaient avant la correction, une seule ligne « Accepted password » dans auth.log
 * pour une connexion (l'ancien chemin la journalisait deux fois) et le « Last login » de la
 * seconde connexion, venu du serveur et non plus compose par le client ; cinq passaient dans
 * les deux etats (temoin « la session s'ouvre sur l'invite du serveur », refus d'un mot de passe
 * faux, echec journalise seulement apres l'envoi du mot de passe, `-q`, `who`). Second lot (deux
 * cas) : une commande distante saisie dans le terminal (`ssh alice@hote whoami`) passe par la meme
 * connexion et demande le mot de passe ; elle retombait sur la commande de l'appareil, sans
 * invite, et les deux cas tombaient avant.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { WindowsTerminalSession } from '@/terminal/sessions/WindowsTerminalSession';
import type { KeyEvent } from '@/terminal/sessions/TerminalSession';

const key = (k: string): KeyEvent => ({ key: k, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false });

async function flush(times = 8): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
    await new Promise<void>((r) => setTimeout(r, 0));
  }
}

let server: LinuxServer;
let term: WindowsTerminalSession;

async function typeLine(line: string): Promise<void> {
  term.foreground.setInput(line);
  term.foreground.setInputBuf(line);
  term.handleKey(key('Enter'));
  await flush();
}

async function submitPassword(password: string): Promise<void> {
  term.setPasswordBuf(password);
  term.handleKey(key('Enter'));
  await flush();
}

const screen = (): string => term.lines.map((l) => l.text).join('\n');

beforeEach(async () => {
  EquipmentRegistry.getInstance().clear();
  server = new LinuxServer('linux-server', 'srv', 0, 0);
  const win = new WindowsPC('windows-pc', 'winA', 0, 0);
  const sw = new GenericSwitch('switch-generic', 'sw', 8, 0, 0);
  [server, win].forEach((d, i) => new Cable(`c${i}`).connect(d.getPorts()[0], sw.getPorts()[i]));
  const mask = new SubnetMask('255.255.255.0');
  server.getPorts()[0].configureIP(new IPAddress('10.0.0.3'), mask);
  win.getPorts()[0].configureIP(new IPAddress('10.0.0.4'), mask);
  await server.executeCommand('useradd -m -s /bin/bash alice');
  await server.executeCommand('echo "alice:alice" | chpasswd');
  term = new WindowsTerminalSession('w', win);
  await term.init();
});

describe('Windows interactive ssh decided by the server alone', () => {
  it('witness: the session opens on the server prompt', async () => {
    await typeLine('ssh alice@10.0.0.3');
    await submitPassword('alice');
    expect(term.foreground.getPrompt()).toMatch(/^alice@srv:~\$/);
  });

  it('a wrong password is refused', async () => {
    await typeLine('ssh alice@10.0.0.3');
    await submitPassword('wrong');
    expect(term.foreground.getPrompt()).not.toMatch(/^alice@srv/);
  });

  it('auth.log holds a single Accepted line for one login', async () => {
    await typeLine('ssh alice@10.0.0.3');
    await submitPassword('alice');
    const log = await server.executeCommand('cat /var/log/auth.log');
    expect(log.match(/Accepted password for alice/g)).toHaveLength(1);
  });

  it('the server lists alice in who while the session is open', async () => {
    await typeLine('ssh alice@10.0.0.3');
    await submitPassword('alice');
    expect(await server.executeCommand('who')).toMatch(/^alice\s+pts\/\d/m);
  });

  it('the second login is greeted with the server\'s Last login line, the first with none', async () => {
    await typeLine('ssh alice@10.0.0.3');
    await submitPassword('alice');
    expect(screen()).not.toMatch(/Last login/);
    await typeLine('exit');
    await typeLine('ssh alice@10.0.0.3');
    await submitPassword('alice');
    expect(screen().match(/Last login: .* from 10\.0\.0\.4/g)).toHaveLength(1);
  });

  it('a failed password is logged only once it has been sent', async () => {
    await typeLine('ssh alice@10.0.0.3');
    expect(await server.executeCommand('cat /var/log/auth.log')).not.toMatch(/Failed password/);
    await submitPassword('wrong');
    expect(await server.executeCommand('cat /var/log/auth.log')).toMatch(/Failed password for alice from 10\.0\.0\.4/);
  });

  it('a remote command typed in the terminal asks for the password and prints only its output', async () => {
    await typeLine('ssh alice@10.0.0.3 whoami');
    expect(term.currentInputMode.type).toBe('password');
    await submitPassword('alice');
    expect(screen()).toMatch(/^alice$/m);
    expect(screen()).not.toMatch(/Last login|Welcome to/);
    expect(term.foreground.getPrompt()).not.toMatch(/^alice@srv/);
  });

  it('a remote command with a wrong password is refused', async () => {
    await typeLine('ssh alice@10.0.0.3 whoami');
    await submitPassword('wrong');
    expect(screen()).toMatch(/Permission denied/);
    expect(screen()).not.toMatch(/^alice$/m);
  });

  it('-q silences the known_hosts warning', async () => {
    await typeLine('ssh -q alice@10.0.0.3');
    await submitPassword('alice');
    expect(screen()).not.toMatch(/Permanently added/);
  });
});
