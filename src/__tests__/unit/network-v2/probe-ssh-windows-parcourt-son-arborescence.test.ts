/**
 * Navigation d'un Windows par ssh : la session cmd, la session PowerShell, la commande sans terminal et le
 * repertoire local de sftp.
 *
 * Mesure de depart (6c86125ec) : un LinuxPC et deux WindowsPC sur un commutateur, serveur 10.0.0.3, compte User, client
 * Linux (`ssh -o StrictHostKeyChecking=no User@10.0.0.3`) puis client Windows (`ssh User@10.0.0.3`), mot de passe
 * saisi au terminal. Dans la session cmd distante, la porte `cd` du sous-shell ssh appliquait la regle de bash :
 * `cd` seul se taisait, `cd ..`, `cd /d D:\Data` et `cd D:` repondaient « cd: no such file or directory », et
 * `cd c:\windows\SYSTEM32` rangeait la casse tapee. Dans PowerShell, `cd ..` laissait le prompt et
 * `(Get-Location).Path` sur l'ancien dossier, et `cd nonexistent` ne disait rien. Sans terminal, `powershell -Command
 * pwd` et `Set-Location C:\Windows; (Get-Location).Path` repondaient « is not recognized as an internal or external
 * command » : la ligne n'arrivait jamais a PowerShell. Le client sftp d'un terminal Windows partait du profil au lieu
 * du repertoire d'ou le terminal l'avait lance (`put fichier` cherchait le fichier dans le profil), et `lls` listait
 * le repertoire du terminal et non celui que `lcd` avait choisi.
 *
 * Autorites : celles du probe de cmd (Microsoft Learn, `cd`, `pushd`, « System Error Codes ») ; pour PowerShell les
 * sources de PowerShell 7.4.6 (SessionStateLocationAPIs, FileSystemProvider) ; pour sftp les commandes locales du
 * client OpenSSH (`lcd`, `lpwd`, `lls`). Le serveur decide : la session ouverte par `ssh` sur un Windows demarre dans
 * le dossier du profil du compte, quel que soit le dernier repertoire du terminal appelant.
 *
 * Sur les 52 cas, 27 tombent avant la correction. Les 25 qui passent dans les deux etats sont des NON-REGRESSIONS du
 * chemin qui marchait deja : l'atterrissage dans le profil, `D:` puis `C:`, la pile de `pushd`, `dir` apres un
 * changement de dossier, la reconnexion qui repart du profil, `cd /d C:\Windows & cd` et `dir /b D:\` sans terminal,
 * PowerShell qui demarre dans le dossier de cmd, `Push-Location`/`Pop-Location`, un PowerShell qui ne rend pas son
 * dossier a cmd, un sftp qui laisse en paix le repertoire du terminal, et la regle d'un shell de connexion POSIX qui
 * reste celle de bash (`cd` demande le nouveau dossier, completion readline et prompt bash). Les deux cas de la porte
 * `cd` qui tombent sont ceux d'un shell qui n'est pas POSIX et d'un interprete empile sur le serveur : la ligne doit
 * partir telle quelle.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { WindowsTerminalSession } from '@/terminal/sessions/WindowsTerminalSession';
import { LinuxTerminalSession } from '@/terminal/sessions/LinuxTerminalSession';
import type { KeyEvent, TerminalSession } from '@/terminal/sessions/TerminalSession';
import { SshInteractiveSubShell } from '@/terminal/subshells/SshInteractiveSubShell';
import type { ISshSession } from '@/network/protocols/ssh/session/ISshSession';
import type { ISshShellChannel } from '@/network/protocols/ssh/channels/ISshChannel';

const key = (name: string): KeyEvent => ({ key: name, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false });

async function settle(times = 10): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
    await new Promise<void>(resolve => setTimeout(resolve, 0));
  }
}

class Terminal {
  constructor(private readonly session: TerminalSession) {}

  get prompt(): string {
    return this.session.getPrompt();
  }

  async run(line: string): Promise<string> {
    const before = this.session.lines.length;
    this.session.setInput(line);
    this.session.setInputBuf(line);
    this.session.handleKey(key('Enter'));
    await settle();
    return this.session.lines.slice(before + 1).map(entry => entry.text).join('\n');
  }

  async answer(text: string): Promise<string> {
    const before = this.session.lines.length;
    const mode = this.session.currentInputMode.type;
    if (mode === 'password') this.session.setPasswordBuf(text);
    else if (mode === 'interactive-text') this.session.setInputBuf(text);
    else this.session.setInput(text);
    this.session.handleKey(key('Enter'));
    await settle(40);
    return this.session.lines.slice(before + 1).map(entry => entry.text).join('\n');
  }

  get question(): string | undefined {
    return (this.session.currentInputMode as { promptText?: string }).promptText;
  }

  async openSftp(target: string, password: string): Promise<void> {
    await this.answer(`sftp ${target}`);
    if (this.question?.startsWith('Are you sure')) await this.answer('yes');
    await this.answer(password);
  }

  async login(line: string, password: string): Promise<void> {
    const first = await this.run(line);
    if (/Are you sure you want to continue connecting/.test(first)) await this.run('yes');
    if (this.session.currentInputMode.type === 'password') {
      this.session.setPasswordBuf(password);
      this.session.handleKey(key('Enter'));
      await settle(20);
    }
  }
}

beforeEach(() => {
  EquipmentRegistry.getInstance().clear();
});

async function lan(): Promise<{ linuxA: LinuxPC; winA: WindowsPC; winB: WindowsPC }> {
  const linuxA = new LinuxPC('linux-pc', 'linuxA', 0, 0);
  const winA = new WindowsPC('windows-pc', 'winA', 0, 0);
  const winB = new WindowsPC('windows-pc', 'winB', 0, 0);
  const sw = new GenericSwitch('switch-generic', 'core-sw', 16, 0, 0);
  [linuxA, winA, winB].forEach((device, index) => new Cable(`c${index}`).connect(device.getPorts()[0], sw.getPorts()[index]));
  const mask = new SubnetMask('255.255.255.0');
  linuxA.getPorts()[0].configureIP(new IPAddress('10.0.0.1'), mask);
  winA.getPorts()[0].configureIP(new IPAddress('10.0.0.3'), mask);
  winB.getPorts()[0].configureIP(new IPAddress('10.0.0.4'), mask);
  linuxA.setHostname('linuxA');
  return { linuxA, winA, winB };
}

async function fromLinux(): Promise<Terminal> {
  const { linuxA } = await lan();
  const terminal = new Terminal(await openTerminal(new LinuxTerminalSession('l1', linuxA)));
  await terminal.login('ssh -o StrictHostKeyChecking=no User@10.0.0.3', 'user');
  return terminal;
}

async function fromWindows(): Promise<Terminal> {
  const { winB } = await lan();
  const terminal = new Terminal(await openTerminal(new WindowsTerminalSession('w2', winB)));
  await terminal.login('ssh User@10.0.0.3', 'user');
  return terminal;
}

async function openTerminal<T extends TerminalSession>(session: T): Promise<T> {
  await session.init();
  return session;
}

const CLIENTS = [
  ['a Linux terminal', fromLinux],
  ['a Windows terminal', fromWindows],
] as const;

for (const [client, connect] of CLIENTS) {
  describe(`cmd over ssh from ${client}`, () => {
    it('lands in the profile directory of the account', async () => {
      const remote = await connect();
      expect(remote.prompt).toBe('C:\\Users\\User>');
    });

    it('prints the remote directory for cd without an argument', async () => {
      const remote = await connect();
      expect(await remote.run('cd')).toBe('C:\\Users\\User');
    });

    it('moves the remote directory and says nothing', async () => {
      const remote = await connect();
      expect(await remote.run('cd ..')).toBe('');
      expect(remote.prompt).toBe('C:\\Users>');
      expect(await remote.run('cd')).toBe('C:\\Users');
      expect(await remote.run('cd \\')).toBe('');
      expect(remote.prompt).toBe('C:\\>');
    });

    it('moves with cd /d across drives', async () => {
      const remote = await connect();
      expect(await remote.run('cd /d D:\\Data')).toBe('');
      expect(remote.prompt).toBe('D:\\Data>');
      expect(await remote.run('cd /d C:\\Windows')).toBe('');
      expect(remote.prompt).toBe('C:\\Windows>');
    });

    it('names a missing path once and stays where it was', async () => {
      const remote = await connect();
      expect(await remote.run('cd nonexistent')).toBe('The system cannot find the path specified.');
      expect(remote.prompt).toBe('C:\\Users\\User>');
    });

    it('prints the directory of another drive without leaving the current one', async () => {
      const remote = await connect();
      expect(await remote.run('cd D:')).toBe('D:\\');
      expect(remote.prompt).toBe('C:\\Users\\User>');
    });

    it('switches drive with D: and returns with C:', async () => {
      const remote = await connect();
      await remote.run('D:');
      expect(remote.prompt).toBe('D:\\>');
      await remote.run('C:');
      expect(remote.prompt).toBe('C:\\Users\\User>');
    });

    it('stores the directory with the case of the disk', async () => {
      const remote = await connect();
      await remote.run('cd c:\\windows\\SYSTEM32');
      expect(remote.prompt).toBe('C:\\Windows\\System32>');
    });

    it('keeps its own pushd stack', async () => {
      const remote = await connect();
      await remote.run('pushd C:\\Windows');
      expect(await remote.run('pushd')).toBe('C:\\Users\\User');
      await remote.run('popd');
      expect(remote.prompt).toBe('C:\\Users\\User>');
    });

    it('lists the directory it moved to', async () => {
      const remote = await connect();
      await remote.run('cd /d D:\\Data');
      expect(await remote.run('dir /b')).toBe('File Not Found');
      expect(await remote.run('dir')).toContain('Directory of D:\\Data');
    });

    it('starts the next login in the profile directory again', async () => {
      const remote = await connect();
      await remote.run('cd /d C:\\Windows');
      await remote.run('exit');
      await remote.login(client === 'a Linux terminal'
        ? 'ssh -o StrictHostKeyChecking=no User@10.0.0.3'
        : 'ssh User@10.0.0.3', 'user');
      expect(remote.prompt).toBe('C:\\Users\\User>');
    });
  });

  describe(`PowerShell over ssh from ${client}`, () => {
    it('starts in the directory cmd was in and shows it in the prompt', async () => {
      const remote = await connect();
      await remote.run('cd /d C:\\Windows');
      await remote.run('powershell');
      expect(remote.prompt).toBe('PS C:\\Windows> ');
    });

    it('moves with cd and cd ..', async () => {
      const remote = await connect();
      await remote.run('powershell');
      expect(await remote.run('cd ..')).toBe('');
      expect(remote.prompt).toBe('PS C:\\Users> ');
      expect(await remote.run('cd C:\\Windows')).toBe('');
      expect(remote.prompt).toBe('PS C:\\Windows> ');
    });

    it('reports the location with pwd', async () => {
      const remote = await connect();
      await remote.run('powershell');
      await remote.run('cd C:\\Windows');
      expect(await remote.run('(Get-Location).Path')).toBe('C:\\Windows');
    });

    it('pushes and pops locations', async () => {
      const remote = await connect();
      await remote.run('powershell');
      await remote.run('Push-Location C:\\Windows');
      expect(remote.prompt).toBe('PS C:\\Windows> ');
      await remote.run('Pop-Location');
      expect(remote.prompt).toBe('PS C:\\Users\\User> ');
    });

    it('does not carry its location back to cmd', async () => {
      const remote = await connect();
      await remote.run('powershell');
      await remote.run('cd C:\\Windows');
      await remote.run('exit');
      expect(remote.prompt).toBe('C:\\Users\\User>');
    });

    it('refuses a missing path and stays where it was', async () => {
      const remote = await connect();
      await remote.run('powershell');
      const output = await remote.run('cd nonexistent');
      expect(output).toContain("Cannot find path 'nonexistent' because it does not exist.");
      expect(remote.prompt).toBe('PS C:\\Users\\User> ');
    });
  });
}

describe('commands run over ssh without a terminal', () => {
  async function exec(from: 'linux' | 'windows', command: string): Promise<string> {
    const { linuxA, winB } = await lan();
    const client = from === 'linux' ? linuxA : winB;
    const quote = from === 'linux' ? `'${command}'` : `"${command}"`;
    const prefix = from === 'linux' ? 'ssh -o StrictHostKeyChecking=no' : 'ssh';
    return (await client.executeCommand(`${prefix} User@10.0.0.3 ${quote}`, 'user\n')).replace(/\s+$/, '');
  }

  for (const from of ['linux', 'windows'] as const) {
    it(`runs cd and prints the directory (${from})`, async () => {
      expect(await exec(from, 'cd /d C:\\Windows & cd')).toBe('C:\\Windows');
    });

    it(`starts every command in the profile directory (${from})`, async () => {
      expect(await exec(from, 'cd')).toBe('C:\\Users\\User');
    });

    it(`runs a one-shot PowerShell pwd (${from})`, async () => {
      const output = await exec(from, 'powershell -Command pwd');
      expect(output).toContain('C:\\Users\\User');
      expect(output).toContain('Path');
    });

    it(`runs a one-shot PowerShell location change (${from})`, async () => {
      expect(await exec(from, 'powershell -Command "Set-Location C:\\Windows; (Get-Location).Path"')).toBe('C:\\Windows');
    });

    it(`lists a drive over ssh (${from})`, async () => {
      expect(await exec(from, 'dir /b D:\\')).toBe('Backup\nData\nProjects\nShared');
    });
  }
});

describe('the local directory of sftp', () => {
  async function sftpFromWindows(...prelude: string[]): Promise<Terminal> {
    const { winB } = await lan();
    const terminal = new Terminal(await openTerminal(new WindowsTerminalSession('w2', winB)));
    await terminal.run('cd Documents');
    for (const line of prelude) await terminal.run(line);
    await terminal.openSftp('User@10.0.0.3', 'user');
    return terminal;
  }

  it('starts in the directory the client was launched from', async () => {
    const terminal = await sftpFromWindows();
    expect(await terminal.answer('lpwd')).toBe('Local working directory: C:\\Users\\User\\Documents');
  });

  it('lists the local directory it moved to', async () => {
    const terminal = await sftpFromWindows();
    await terminal.answer('lcd ..');
    expect(await terminal.answer('lpwd')).toBe('Local working directory: C:\\Users\\User');
    expect(await terminal.answer('lls')).toContain('Directory of C:\\Users\\User\n');
  });

  it('sends a file of the directory it started in and prints the meter of a terminal', async () => {
    const terminal = await sftpFromWindows('echo payload> up.txt');
    const output = await terminal.answer('put up.txt');
    expect(output).toContain('Uploading up.txt to /C:/Users/User/up.txt');
    expect(output).toContain('100%');
    expect(await terminal.answer('ls')).toContain('up.txt');
  });

  it('leaves the directory of the terminal alone', async () => {
    const terminal = await sftpFromWindows();
    await terminal.answer('lcd C:\\Windows');
    await terminal.answer('bye');
    expect(terminal.prompt).toBe('C:\\Users\\User\\Documents>');
  });
});

describe('the cd gate of the interactive ssh sub-shell', () => {
  function recordingShell(options: { posix: boolean; nested: boolean }): { shell: SshInteractiveSubShell; sent: string[] } {
    const sent: string[] = [];
    const channel = {
      isPosixShell: () => options.posix,
      runLine: async (line: string) => {
        sent.push(line);
        return { stdout: '', stderr: '', exitCode: 0, prompt: 'remote> ', nested: options.nested };
      },
      onData: () => () => undefined,
      onClose: () => undefined,
      supportsInlineHelp: () => false,
    } as unknown as ISshShellChannel;
    const shell = new SshInteractiveSubShell({ disconnect: () => undefined } as unknown as ISshSession, channel, 'user', '10.0.0.9');
    return { shell, sent };
  }

  it('asks a POSIX login shell for the new directory after cd', async () => {
    const { shell, sent } = recordingShell({ posix: true, nested: false });
    await shell.processLine('cd /tmp');
    expect(sent).toEqual(['cd /tmp && pwd']);
  });

  it('sends cd verbatim when the login shell is not POSIX', async () => {
    const { shell, sent } = recordingShell({ posix: false, nested: false });
    await shell.processLine('cd /d D:\\Data');
    expect(sent).toEqual(['cd /d D:\\Data']);
  });

  it('sends cd verbatim to an interpreter stacked on the server', async () => {
    const { shell, sent } = recordingShell({ posix: true, nested: true });
    await shell.processLine('python3');
    await shell.processLine('cd /tmp');
    expect(sent).toEqual(['python3', 'cd /tmp']);
  });

  it('offers readline completion and a bash prompt only to a POSIX login shell', async () => {
    const posix = recordingShell({ posix: true, nested: false }).shell;
    const other = recordingShell({ posix: false, nested: false }).shell;
    const stacked = recordingShell({ posix: true, nested: true });
    await stacked.shell.processLine('python3');
    expect(posix.completionStyle()).toBe('readline');
    expect(other.completionStyle()).toBe('cycling');
    expect(stacked.shell.completionStyle()).toBe('cycling');
    expect(other.getPromptParts()).toBeNull();
    expect(stacked.shell.getPromptParts()).toBeNull();
    expect(posix.getPromptParts()).not.toBeNull();
  });
});
