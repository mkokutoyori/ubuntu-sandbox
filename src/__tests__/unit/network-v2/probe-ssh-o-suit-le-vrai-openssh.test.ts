/*
 * `ssh -o` traite ses mots-cles comme le client OpenSSH : un mot-cle
 * inconnu est refuse, une valeur hors de son domaine aussi, la casse et
 * les trois ecritures (`-o Cle=v`, `-o "Cle v"`, `-oCle=v`) sont
 * equivalentes, et Tab propose les mots-cles que le client connait.
 *
 * L'AUTORITE : OpenSSH 8.9p1 (Ubuntu 22.04) et 8.6p1 (Win32-OpenSSH),
 * `readconf.c` — la table `keywords[]` (124 noms en 8.9, 121 en 8.6),
 * `parse_token` (« %s: line %d: Bad configuration option: %s », le mot-cle
 * est passe en minuscules par `lowercase(keyword)`), `process_config_line`
 * (« %s line %d: no argument after keyword "%s" », « %s line %d:
 * unsupported option "%s". » pour une valeur hors des `multistate_*`,
 * « keyword %s extra arguments at end of line ») et `ssh.c` : `-o` appelle
 * `process_config_line` avec le fichier « command-line » et la ligne 0, puis
 * `exit(255)` sur un refus. ssh_config(5) donne l'ecriture des noms que Tab
 * propose ; bash-completion ajoute `=` sans espace.
 *
 * Ecrite a l'aveugle contre ces sources, avant de lire les consommateurs de
 * `-o`. Le laboratoire est un poste Linux, un serveur Linux et un poste
 * Windows. 17 des 21 cas tombent avant le correctif. Passent des deux cotes
 * les TEMOINS : un mot-cle connu ecrit dans une autre casse, `accept-new`
 * comme valeur de StrictHostKeyChecking, l'absence de question avec
 * `StrictHostKeyChecking=no`, et le mot-cle que la page de manuel cache
 * (`Protocol`), accepte et jamais propose.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, MACAddress } from '@/network/core/types';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { LinuxTerminalSession } from '@/terminal/sessions/LinuxTerminalSession';
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

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

interface Lab {
  readonly pc1: LinuxPC;
  readonly win: WindowsPC;
  readonly linuxTerm: LinuxTerminalSession;
  readonly windowsTerm: WindowsTerminalSession;
}

async function lab(): Promise<Lab> {
  const pc1 = new LinuxPC('linux-pc', 'PC1', 0, 0);
  const pc2 = new LinuxPC('linux-pc', 'PC2', 100, 0);
  const win = new WindowsPC('windows-pc', 'WIN1', 200, 0);
  const sw = new GenericSwitch('switch-generic', 'SW1', 8, 50, 50);
  for (const machine of [pc1, pc2, win]) machine.powerOn();
  new Cable('c1').connect(pc1.getPort('eth0')!, sw.getPort('eth0')!);
  new Cable('c2').connect(pc2.getPort('eth0')!, sw.getPort('eth1')!);
  new Cable('c3').connect(win.getPort('eth0')!, sw.getPort('eth2')!);
  await pc1.executeCommand('ifconfig eth0 10.0.0.1 netmask 255.255.255.0');
  await pc2.executeCommand('ifconfig eth0 10.0.0.2 netmask 255.255.255.0');
  await win.executeCommand('netsh interface ip set address "Ethernet 0" static 10.0.0.3 255.255.255.0');
  return {
    pc1, win,
    linuxTerm: new LinuxTerminalSession('t1', pc1),
    windowsTerm: new WindowsTerminalSession('w1', win),
  };
}

async function typed(term: LinuxTerminalSession | WindowsTerminalSession, text: string): Promise<string[]> {
  const before = term.lines.length;
  term.setInput(text);
  if (term instanceof LinuxTerminalSession) term.setInputBuf(text);
  term.handleKey(key('Enter'));
  await settle();
  return term.lines.slice(before + 1).map((l) => l.text).filter((t) => t.trim() !== '');
}

async function completed(term: LinuxTerminalSession, text: string): Promise<{ input: string; suggestions: readonly string[] | null }> {
  (term as unknown as { tabSuggestions: unknown }).tabSuggestions = null;
  term.setInput(text);
  term.setInputBuf(text);
  term.handleKey(key('Tab'));
  await settle();
  return { input: term.input, suggestions: term.tabSuggestions };
}

describe('a keyword the client does not know is refused', () => {
  it('the message names the keyword in lower case and the command exits 255', async () => {
    const { pc1 } = await lab();
    const out = await pc1.executeCommand('ssh -o Foo=bar user@10.0.0.2; echo $?');

    expect(out.split('\n')).toEqual(['command-line: line 0: Bad configuration option: foo', '255']);
  });

  it('typed in the terminal, the same line', async () => {
    const { linuxTerm } = await lab();

    expect(await typed(linuxTerm, 'ssh -o Foo=bar user@10.0.0.2')).toEqual(['command-line: line 0: Bad configuration option: foo']);
  });

  it('a keyword without a value says so, before it says the keyword is unknown', async () => {
    const { pc1 } = await lab();

    expect(await pc1.executeCommand('ssh -o Foo user@10.0.0.2')).toBe('command-line line 0: no argument after keyword "foo"');
  });

  it('a known keyword written in any case is not refused — WITNESS', async () => {
    const { pc1 } = await lab();
    const out = await pc1.executeCommand('ssh -o compression=yes -o BATCHMODE=yes user@10.0.0.2 true');

    expect(out).not.toContain('Bad configuration option');
  });

  it('a keyword after the destination is read too', async () => {
    const { pc1 } = await lab();

    expect(await pc1.executeCommand('ssh user@10.0.0.2 -o Foo=bar true')).toBe('command-line: line 0: Bad configuration option: foo');
  });
});

describe('a value outside the domain of its keyword is refused', () => {
  it('StrictHostKeyChecking=maybe', async () => {
    const { pc1 } = await lab();

    expect(await pc1.executeCommand('ssh -o StrictHostKeyChecking=maybe user@10.0.0.2'))
      .toBe('command-line line 0: unsupported option "maybe".');
  });

  it('BatchMode=perhaps', async () => {
    const { pc1 } = await lab();

    expect(await pc1.executeCommand('ssh -o BatchMode=perhaps user@10.0.0.2'))
      .toBe('command-line line 0: unsupported option "perhaps".');
  });

  it('an extra word after the value', async () => {
    const { pc1 } = await lab();

    expect(await pc1.executeCommand('ssh -o "BatchMode yes no" user@10.0.0.2'))
      .toBe('command-line line 0: keyword batchmode extra arguments at end of line');
  });

  it('accept-new is a value of StrictHostKeyChecking — WITNESS', async () => {
    const { pc1 } = await lab();
    const out = await pc1.executeCommand('ssh -o StrictHostKeyChecking=accept-new user@10.0.0.2 true');

    expect(out).not.toContain('unsupported option');
  });
});

describe('the release decides which keywords exist', () => {
  it('SessionType is a keyword of 8.9 and not of 8.6', async () => {
    const { pc1, windowsTerm } = await lab();

    expect(await pc1.executeCommand('ssh -o SessionType=none user@10.0.0.2 true')).not.toContain('Bad configuration option');
    expect(await typed(windowsTerm, 'ssh -o SessionType=none admin@10.0.0.2'))
      .toEqual(['command-line: line 0: Bad configuration option: sessiontype']);
  });

  it('the Windows terminal refuses an unknown keyword like the Linux one', async () => {
    const { windowsTerm } = await lab();

    expect(await typed(windowsTerm, 'ssh -o Foo=bar admin@10.0.0.2')).toEqual(['command-line: line 0: Bad configuration option: foo']);
  });
});

describe('the three ways to write an option mean the same thing', () => {
  async function firstContact(spelling: string): Promise<string[]> {
    const { linuxTerm } = await lab();
    return typed(linuxTerm, `ssh ${spelling} user@10.0.0.2`);
  }

  it('-o Key=value, -o "Key value" and -oKey=value give the same transcript', async () => {
    const separate = await firstContact('-o StrictHostKeyChecking=no');
    const spaced = await firstContact('-o "StrictHostKeyChecking no"');
    const attached = await firstContact('-oStrictHostKeyChecking=no');

    expect(separate.length).toBeGreaterThan(0);
    expect(spaced).toEqual(separate);
    expect(attached).toEqual(separate);
  });

  it('StrictHostKeyChecking=no skips the question — WITNESS', async () => {
    const shown = await firstContact('-o StrictHostKeyChecking=no');

    expect(shown.join('\n')).not.toContain('Are you sure you want to continue connecting');
  });

  it('StrictHostKeyChecking=no adds the unknown host and says so', async () => {
    const shown = await firstContact('-o StrictHostKeyChecking=no');

    expect(shown).toEqual(["Warning: Permanently added '10.0.0.2' (ssh-ed25519) to the list of known hosts."]);
  });

  it('the first value of a keyword wins', async () => {
    const twice = await firstContact('-o StrictHostKeyChecking=no -o StrictHostKeyChecking=yes');
    const once = await firstContact('-o StrictHostKeyChecking=no');

    expect(twice).toEqual(once);
  });
});

describe('Tab completes the keywords the client knows', () => {
  it('a unique keyword takes an equals sign and no space', async () => {
    const { linuxTerm } = await lab();

    expect((await completed(linuxTerm, 'ssh -o Strict')).input).toBe('ssh -o StrictHostKeyChecking=');
  });

  it('several keywords: the common prefix, then the list', async () => {
    const { linuxTerm } = await lab();

    expect((await completed(linuxTerm, 'ssh -o Pro')).input).toBe('ssh -o Proxy');
    const listed = await completed(linuxTerm, 'ssh -o Proxy');
    expect(listed.suggestions).toEqual(['ProxyCommand=', 'ProxyJump=', 'ProxyUseFdpass=']);
  });

  it('a keyword of 8.9 is offered by the Ubuntu client', async () => {
    const { linuxTerm } = await lab();

    expect((await completed(linuxTerm, 'ssh -o SessionT')).input).toBe('ssh -o SessionType=');
  });

  it('a keyword the man page hides is accepted but not offered', async () => {
    const { linuxTerm, pc1 } = await lab();

    expect((await completed(linuxTerm, 'ssh -o Protoc')).input).toBe('ssh -o Protoc');
    expect(await pc1.executeCommand('ssh -o Protocol=2 user@10.0.0.2 true')).not.toContain('Bad configuration option');
  });

  it('scp and sftp offer the same keywords', async () => {
    const { linuxTerm } = await lab();

    expect((await completed(linuxTerm, 'scp -o Strict')).input).toBe('scp -o StrictHostKeyChecking=');
    expect((await completed(linuxTerm, 'sftp -o Strict')).input).toBe('sftp -o StrictHostKeyChecking=');
  });

  it('the attached form completes too', async () => {
    const { linuxTerm } = await lab();

    expect((await completed(linuxTerm, 'ssh -oStrict')).input).toBe('ssh -oStrictHostKeyChecking=');
  });
});
