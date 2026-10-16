/*
 * `sftp alice@hote` tape dans le terminal Linux : comme OpenSSH, le client tente d'abord les cles,
 * ne demande « alice@hote's password: » que si le serveur le propose, redemande apres un mot de passe
 * faux (« Permission denied, please try again. », trois essais) puis ecrit un seul refus final.
 *
 * Mesure de depart : le terminal posait l'invite AVANT toute connexion (meme pour un compte qui
 * s'authentifie par cle) et abandonnait au premier mot de passe faux.
 *
 * Discrimine contre l'etat d'avant (git stash des sources, invite prealable) : 3 des 4 cas tombent (nouvel
 * essai, trois essais, cle sans invite) ; « le bon mot de passe ouvre la session » passe dans les deux etats
 * (temoin : la session s'ouvre dans les deux, l'invite seule change de place).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, MACAddress, IPAddress, SubnetMask } from '@/network/core/types';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { LinuxTerminalSession } from '@/terminal/sessions/LinuxTerminalSession';
import type { KeyEvent } from '@/terminal/sessions/TerminalSession';

beforeEach(() => {
  resetCounters();
  MACAddress.resetCounter();
  resetDeviceCounters();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

const key = (k: string): KeyEvent => ({ key: k, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false });

async function typedInto(term: LinuxTerminalSession, text: string): Promise<string[]> {
  const before = term.lines.length;
  const mode = term.currentInputMode.type;
  if (mode === 'password') term.setPasswordBuf(text);
  else if (mode === 'interactive-text') term.setInputBuf(text);
  else term.setInput(text);
  term.handleKey(key('Enter'));
  for (let i = 0; i < 40; i++) {
    await Promise.resolve();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  return term.lines.slice(before + 1).map((l) => l.text).filter((t) => t.trim() !== '');
}

async function lab() {
  const pc = new LinuxPC('linux-pc', 'PC1');
  const server = new LinuxServer('linux-server', 'SRV');
  const sw = new GenericSwitch('switch-generic', 'SW');
  new Cable('c1').connect(pc.getPorts()[0], sw.getPorts()[0]);
  new Cable('c2').connect(server.getPorts()[0], sw.getPorts()[1]);
  const mask = new SubnetMask('255.255.255.0');
  pc.getPorts()[0].configureIP(new IPAddress('10.95.0.10'), mask);
  server.getPorts()[0].configureIP(new IPAddress('10.95.0.20'), mask);
  pc.powerOn();
  server.powerOn();
  await server.executeCommand('useradd -m -s /bin/bash alice');
  await server.executeCommand(`sh -c 'echo "alice:secret" | chpasswd'`);
  await server.executeCommand(`sh -c 'echo contenu > /home/alice/note.txt'`);
  await server.executeCommand('chown alice:alice /home/alice/note.txt');
  return { pc, server, term: new LinuxTerminalSession('t1', pc) };
}

const promptOf = (term: LinuxTerminalSession): string =>
  (term.currentInputMode as { promptText?: string }).promptText ?? '';

describe('sftp tape dans le terminal Linux', () => {
  it('le bon mot de passe ouvre une session qui lit et liste le home distant', async () => {
    const { term } = await lab();
    await typedInto(term, 'sftp alice@10.95.0.20');
    expect(promptOf(term)).toBe("alice@10.95.0.20's password: ");
    const opening = await typedInto(term, 'secret');
    expect(opening.join('\n')).toContain('Connected to 10.95.0.20.');
    expect(term.getPrompt()).toBe('sftp> ');
    expect((await typedInto(term, 'ls')).join('\n')).toContain('note.txt');
    await typedInto(term, 'bye');
  }, 90_000);

  it('un mot de passe faux redemande, puis le bon ouvre la session', async () => {
    const { term } = await lab();
    await typedInto(term, 'sftp alice@10.95.0.20');
    const retry = await typedInto(term, 'faux');
    expect(retry).toContain('Permission denied, please try again.');
    expect(promptOf(term)).toBe("alice@10.95.0.20's password: ");
    expect((await typedInto(term, 'secret')).join('\n')).toContain('Connected to 10.95.0.20.');
  }, 90_000);

  it('trois mots de passe faux ferment la session avec un seul refus final', async () => {
    const { term } = await lab();
    await typedInto(term, 'sftp alice@10.95.0.20');
    const everything = [
      ...(await typedInto(term, 'un')), ...(await typedInto(term, 'deux')), ...(await typedInto(term, 'trois')),
    ];
    expect(everything.filter((line) => line === 'Permission denied, please try again.')).toHaveLength(2);
    expect(everything.filter((line) => line === 'alice@10.95.0.20: Permission denied (publickey,password).')).toHaveLength(1);
    expect(everything.join('\n')).not.toContain('Connected to');
    expect(term.getPrompt()).not.toBe('sftp> ');
  }, 90_000);

  it('une cle autorisee ouvre la session sans jamais demander de mot de passe', async () => {
    const { pc, server, term } = await lab();
    await pc.executeCommand("ssh-keygen -t ed25519 -N '' -f ~/.ssh/id_ed25519");
    const publicKey = (await pc.executeCommand('cat ~/.ssh/id_ed25519.pub')).trim();
    await server.executeCommand('mkdir -p /home/alice/.ssh');
    await server.executeCommand(`sh -c 'echo "${publicKey}" > /home/alice/.ssh/authorized_keys'`);
    await server.executeCommand('chmod 700 /home/alice/.ssh && chmod 600 /home/alice/.ssh/authorized_keys');
    await server.executeCommand('chown -R alice:alice /home/alice/.ssh');
    const shown = await typedInto(term, 'sftp alice@10.95.0.20');
    expect(promptOf(term)).not.toContain('password');
    expect(shown.join('\n')).toContain('Connected to 10.95.0.20.');
    expect(term.getPrompt()).toBe('sftp> ');
  }, 90_000);
});
