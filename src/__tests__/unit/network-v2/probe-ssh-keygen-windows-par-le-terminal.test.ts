/*
 * `ssh-keygen` tape dans l'invite de commandes Windows pose ses questions
 * comme Win32-OpenSSH 8.6p1.
 *
 * L'AUTORITE :
 * - OpenSSH 8.6p1, `ssh-keygen.c` (`ask_filename`) : le fichier propose
 *   s'ecrit « %s/%s », le repertoire de l'utilisateur puis `.ssh/id_rsa` ;
 *   `hostfile.c` cree `~/.ssh`, soit ce meme repertoire suivi de
 *   « /.ssh », et l'annonce « Created directory '<rep>'. » ;
 * - la documentation Microsoft (« Key-based authentication in OpenSSH for
 *   Windows », source MicrosoftDocs/windowsserverdocs) montre la meme
 *   jonction : « Enter file in which to save the key
 *   (C:\Users\username/.ssh/id_ecdsa): ». Cette page ajoute un point apres
 *   les chemins et donne Ed25519 par defaut : c'est une version plus
 *   ancienne pour le point et plus recente pour le type ; le client 8.6p1,
 *   construit avec LibreSSL, ecrit sans point et genere du RSA ;
 * - cmd.exe passe `""` comme un argument vide.
 *
 * Ecrite a l'aveugle contre ces sources, avant de brancher le terminal.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, MACAddress } from '@/network/core/types';
import { WindowsPC } from '@/network/devices/WindowsPC';
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

const PROFILE = 'C:\\Users\\User';

function windows(): WindowsPC {
  const pc = new WindowsPC('windows-pc', 'WIN1', 0, 0);
  pc.powerOn();
  return pc;
}

const key = (k: string): KeyEvent => ({ key: k, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false });

async function typedInto(term: WindowsTerminalSession, text: string): Promise<string[]> {
  const before = term.lines.length;
  if (term.currentInputMode.type === 'password') term.setPasswordBuf(text);
  else term.setInput(text);
  term.handleKey(key('Enter'));
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  return term.lines.slice(before + 1).map((l) => l.text).filter((t) => t.trim() !== '');
}

const promptOf = (term: WindowsTerminalSession): string | undefined =>
  (term.currentInputMode as { promptText?: string }).promptText;

describe('the questions asked in the terminal', () => {
  it('RSA is announced, then the profile joined to .ssh/id_rsa with a slash', async () => {
    const term = new WindowsTerminalSession('w1', windows());
    const shown = await typedInto(term, 'ssh-keygen');

    expect(shown[0]).toBe('Generating public/private rsa key pair.');
    expect(promptOf(term)).toBe(`Enter file in which to save the key (${PROFILE}/.ssh/id_rsa): `);
  }, 60_000);

  it('Enter creates the .ssh directory, announced the same way, then asks the passphrase', async () => {
    const term = new WindowsTerminalSession('w2', windows());
    await typedInto(term, 'ssh-keygen');
    const shown = await typedInto(term, '');

    expect(shown).toContain(`Created directory '${PROFILE}/.ssh'.`);
    expect(promptOf(term)).toBe('Enter passphrase (empty for no passphrase): ');
  }, 60_000);

  it('two empty passphrases save the key where the prompt said', async () => {
    const pc = windows();
    const term = new WindowsTerminalSession('w3', pc);
    await typedInto(term, 'ssh-keygen');
    await typedInto(term, '');
    await typedInto(term, '');
    const shown = await typedInto(term, '');

    expect(shown).toContain(`Your identification has been saved in ${PROFILE}/.ssh/id_rsa`);
    expect((await pc.executeCommand('type %USERPROFILE%\\.ssh\\id_rsa.pub')).trim().startsWith('ssh-rsa ')).toBe(true);
  }, 60_000);

  it('cmd passes "" as an empty passphrase: nothing is asked — WITNESS', async () => {
    const pc = windows();
    const term = new WindowsTerminalSession('w4', pc);
    await typedInto(term, 'ssh-keygen -t ed25519 -N "" -f C:\\k');

    expect(term.currentInputMode.type).toBe('normal');
    expect((await pc.executeCommand('type C:\\k.pub')).trim().startsWith('ssh-ed25519 ')).toBe(true);
  });
});

describe('the command, without a terminal', () => {
  it('-l without -f offers the same default file', async () => {
    const out = await windows().executeCommand('ssh-keygen -l');

    expect(out).toContain(`Enter file in which the key is (${PROFILE}/.ssh/id_rsa): `);
  });

  it('-R names known_hosts under the same joined path', async () => {
    const pc = windows();
    await pc.executeCommand('mkdir %USERPROFILE%\\.ssh');
    await pc.executeCommand('echo 10.0.0.9 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIabcdefghijklmnopqrstuvwxyz0123456789AB> %USERPROFILE%\\.ssh\\known_hosts');

    expect(await pc.executeCommand('ssh-keygen -R 10.0.0.9')).toContain(`${PROFILE}/.ssh/known_hosts updated.`);
  });
});
