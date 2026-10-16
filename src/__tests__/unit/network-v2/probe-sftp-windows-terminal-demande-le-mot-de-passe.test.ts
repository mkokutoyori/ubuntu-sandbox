/*
 * `sftp alice@hote` tape dans l'invite Windows ouvre une session interactive comme sftp.exe de
 * Win32-OpenSSH : le client tente d'abord les cles, ne demande « alice@hote's password: » que si le
 * serveur le propose, repond « Permission denied, please try again. » apres chaque mot de passe faux
 * (trois essais, NumberOfPasswordPrompts), puis ecrit une seule fois
 * « alice@hote: Permission denied (publickey,password). » avant « Connection closed ».
 *
 * Mesure de depart : la ligne partait vers cmdSftp sans mot de passe (refus ecrit deux fois, aucune
 * tentative dans le journal sshd). Une premiere correction posait l'invite AVANT toute connexion, donc
 * meme pour un compte qui s'authentifie par cle, et abandonnait au premier mot de passe faux.
 *
 * Discrimine contre la premiere correction (git stash des sources, invite prealable) : 3 des 6 cas tombent
 * (nouvel essai, trois essais, cle sans invite) ; les 3 autres passent dans les deux etats : l'invite et le
 * bon mot de passe (temoins : la session s'ouvre dans les deux) et « sans destination » (la ligne sans hote
 * n'est pas interceptee et garde l'usage du client).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, MACAddress, IPAddress, SubnetMask } from '@/network/core/types';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { WindowsTerminalSession } from '@/terminal/sessions/WindowsTerminalSession';
import type { KeyEvent } from '@/terminal/sessions/TerminalSession';

beforeEach(() => {
  resetCounters();
  MACAddress.resetCounter();
  resetDeviceCounters();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

const key = (k: string): KeyEvent => ({ key: k, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false });

async function typedInto(term: WindowsTerminalSession, text: string): Promise<string[]> {
  const before = term.lines.length;
  if (term.currentInputMode.type === 'password') term.setPasswordBuf(text);
  else if (term.currentInputMode.type === 'interactive-text') term.setInputBuf(text);
  else term.setInput(text);
  term.handleKey(key('Enter'));
  for (let i = 0; i < 40; i++) {
    await Promise.resolve();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  return term.lines.slice(before + 1).map((l) => l.text).filter((t) => t.trim() !== '');
}

async function lab() {
  const win = new WindowsPC('windows-pc', 'WIN1', 0, 0);
  const server = new LinuxServer('linux-server', 'SRV');
  const sw = new GenericSwitch('switch-generic', 'SW');
  new Cable('c1').connect(win.getPorts()[0], sw.getPorts()[0]);
  new Cable('c2').connect(server.getPorts()[0], sw.getPorts()[1]);
  const mask = new SubnetMask('255.255.255.0');
  win.getPorts()[0].configureIP(new IPAddress('10.94.0.10'), mask);
  server.getPorts()[0].configureIP(new IPAddress('10.94.0.20'), mask);
  win.powerOn();
  server.powerOn();
  await server.executeCommand('useradd -m -s /bin/bash alice');
  await server.executeCommand(`sh -c 'echo "alice:secret" | chpasswd'`);
  await server.executeCommand(`sh -c 'echo contenu > /home/alice/note.txt'`);
  await server.executeCommand('chown alice:alice /home/alice/note.txt');
  return { win, server, term: new WindowsTerminalSession('w1', win) };
}

const promptOf = (term: WindowsTerminalSession): string | undefined =>
  (term.currentInputMode as { promptText?: string }).promptText;

describe('sftp tape dans le terminal Windows', () => {
  it('demande le mot de passe du compte nomme quand le serveur le propose', async () => {
    const { term } = await lab();
    await typedInto(term, 'sftp alice@10.94.0.20');
    expect(promptOf(term)).toBe("alice@10.94.0.20's password: ");
  }, 60_000);

  it('le bon mot de passe ouvre une session qui lit et liste le home distant', async () => {
    const { term } = await lab();
    await typedInto(term, 'sftp alice@10.94.0.20');
    const opening = await typedInto(term, 'secret');
    expect(opening.join('\n')).toContain('Connected to 10.94.0.20.');
    expect(term.getPrompt()).toBe('sftp> ');
    expect((await typedInto(term, 'pwd')).join('\n')).toContain('Remote working directory: /home/alice');
    expect((await typedInto(term, 'ls')).join('\n')).toContain('note.txt');
    await typedInto(term, 'bye');
  }, 90_000);

  it('un mot de passe faux redemande, puis le bon ouvre la session', async () => {
    const { term } = await lab();
    await typedInto(term, 'sftp alice@10.94.0.20');
    const retry = await typedInto(term, 'faux');
    expect(retry).toContain('Permission denied, please try again.');
    expect(promptOf(term)).toBe("alice@10.94.0.20's password: ");
    const opened = await typedInto(term, 'secret');
    expect(opened.join('\n')).toContain('Connected to 10.94.0.20.');
    expect(term.getPrompt()).toBe('sftp> ');
  }, 90_000);

  it('trois mots de passe faux ferment la session avec un seul refus final', async () => {
    const { term } = await lab();
    await typedInto(term, 'sftp alice@10.94.0.20');
    const first = await typedInto(term, 'un');
    const second = await typedInto(term, 'deux');
    const last = await typedInto(term, 'trois');
    const everything = [...first, ...second, ...last];
    expect(everything.filter((line) => line === 'Permission denied, please try again.')).toHaveLength(2);
    expect(everything.filter((line) => line === 'alice@10.94.0.20: Permission denied (publickey,password).')).toHaveLength(1);
    expect(everything).toContain('Connection closed');
    expect(everything.join('\n')).not.toContain('Connected to');
    expect(term.getPrompt()).not.toBe('sftp> ');
  }, 90_000);

  it('une cle autorisee ouvre la session sans jamais demander de mot de passe', async () => {
    const { win, server, term } = await lab();
    await win.executeCommand('ssh-keygen -t ed25519 -N "" -f C:\\Users\\User\\.ssh\\id_ed25519');
    const publicKey = (await win.executeCommand('type C:\\Users\\User\\.ssh\\id_ed25519.pub')).trim();
    await server.executeCommand('mkdir -p /home/alice/.ssh');
    await server.executeCommand(`sh -c 'echo "${publicKey}" > /home/alice/.ssh/authorized_keys'`);
    await server.executeCommand('chmod 700 /home/alice/.ssh && chmod 600 /home/alice/.ssh/authorized_keys');
    await server.executeCommand('chown -R alice:alice /home/alice/.ssh');
    const shown = await typedInto(term, 'sftp alice@10.94.0.20');
    expect(promptOf(term) ?? '').not.toContain('password');
    expect(shown.join('\n')).toContain('Connected to 10.94.0.20.');
    expect(term.getPrompt()).toBe('sftp> ');
  }, 90_000);

  it('sans destination la ligne garde l usage du client', async () => {
    const { term } = await lab();
    const shown = await typedInto(term, 'sftp');
    expect(shown.join('\n')).toContain('usage: sftp');
  }, 60_000);
});
