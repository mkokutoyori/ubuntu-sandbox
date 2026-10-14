/**
 * Mesure de depart (rapport utilisateur, cmd.exe d'un PC Windows) : `sSH alice@192.168.10.3`
 * affichait la banniere Ubuntu, deux lignes vides puis « Connection to 192.168.10.3 closed. »,
 * trois fois de suite, sans jamais demander de mot de passe ni ouvrir de shell. Windows resout
 * les noms de commande sans tenir compte de la casse et accepte le suffixe `.exe` ; le terminal
 * le savait pour router `ssh` vers la session interactive, mais `parseSshCommandLine` exigeait
 * `ssh` en minuscules, rendait `null`, et la ligne tombait sur le chemin non interactif de
 * l'appareil (banniere puis fermeture).
 *
 * Le motif du mot de commande devient un parametre du parseur (Linux garde la casse stricte,
 * Windows passe `WINDOWS_SSH_COMMAND_WORD`). Six cas, cinq tombent avant la correction (`sSH`,
 * `SSH`, `ssh.exe`, `SSH.EXE` et le shell distant atteint apres le mot de passe) ; le TEMOIN `ssh` en
 * minuscules passe dans les deux etats et prouve que le laboratoire accepte le mot de passe.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { WindowsTerminalSession } from '@/terminal/sessions/WindowsTerminalSession';
import type { KeyEvent, TerminalSession } from '@/terminal/sessions/TerminalSession';

const key = (k: string): KeyEvent => ({ key: k, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false });

async function flush(times = 8): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
    await new Promise<void>((r) => setTimeout(r, 0));
  }
}

async function type(session: TerminalSession, line: string): Promise<void> {
  session.setInput(line);
  session.setInputBuf(line);
  session.handleKey(key('Enter'));
  await flush();
}

async function lab(): Promise<{ term: WindowsTerminalSession }> {
  EquipmentRegistry.getInstance().clear();
  const linux = new LinuxPC('linux-pc', 'linuxA', 0, 0);
  const win = new WindowsPC('windows-pc', 'winA', 0, 0);
  const sw = new GenericSwitch('switch-generic', 'core-sw', 8, 0, 0);
  [linux, win].forEach((d, i) => new Cable(`c${i}`).connect(d.getPorts()[0], sw.getPorts()[i]));
  const mask = new SubnetMask('255.255.255.0');
  linux.getPorts()[0].configureIP(new IPAddress('10.0.0.1'), mask);
  win.getPorts()[0].configureIP(new IPAddress('10.0.0.3'), mask);
  linux.setHostname('linuxA');
  await linux.executeCommand('sudo useradd -m -s /bin/bash alice');
  await linux.executeCommand('echo "alice:admin" | sudo chpasswd');
  const term = new WindowsTerminalSession('w1', win);
  await term.init();
  return { term };
}

const texts = (term: TerminalSession): string[] => term.lines.map((l) => l.text);

describe('ssh typed at a Windows prompt: command word is case-insensitive and may end in .exe', () => {
  it('witness: lowercase ssh asks for the password', async () => {
    const { term } = await lab();
    await type(term, 'ssh alice@10.0.0.1');
    expect(term.currentInputMode.type).toBe('password');
  });

  it.each(['sSH alice@10.0.0.1', 'SSH alice@10.0.0.1', 'ssh.exe alice@10.0.0.1', 'SSH.EXE alice@10.0.0.1'])(
    '%s asks for the password instead of printing the banner and closing', async (line) => {
      const { term } = await lab();
      await type(term, line);
      expect(term.currentInputMode.type).toBe('password');
      expect(texts(term).some((l) => /Connection to 10\.0\.0\.1 closed/.test(l))).toBe(false);
    });

  it('sSH reaches the remote prompt once the password is given', async () => {
    const { term } = await lab();
    await type(term, 'sSH alice@10.0.0.1');
    term.setPasswordBuf('admin');
    term.handleKey(key('Enter'));
    await flush();
    expect(term.getPrompt()).toMatch(/alice@linuxA:~\$/);
  });
});
