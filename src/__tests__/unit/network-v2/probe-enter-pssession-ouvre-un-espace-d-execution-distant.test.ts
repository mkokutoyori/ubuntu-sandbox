/**
 * Enter-PSSession ouvre une session interactive SUR l'ordinateur distant : ce que l'on tape traverse le cable en
 * WinRM (TCP 5985) et s'execute dans un interpreteur de la machine distante ; l'invite porte le nom de l'ordinateur
 * tel qu'il a ete tape puis l'invite de la machine distante, qui s'ouvre dans le dossier Documents du compte ; les
 * fichiers crees, le dossier courant et la completion sont ceux de cette machine ; `exit` et `Exit-PSSession` la
 * referment ; un cable debranche la rompt et ramene a l'invite locale.
 *
 * Mesure de depart (dbc913e8d + W8 + W9), deux WindowsPC relies par un commutateur, WinRM configure sur le serveur :
 * `Enter-PSSession SRV1 -Credential Administrator:admin` authentifiait par WinRM puis rendait un marqueur
 * `_enterRemotePS` que rien ne lisait ; l'invite ne changeait pas et chaque commande suivante s'executait sur la
 * machine LOCALE (`$env:COMPUTERNAME` rendait CLIENT1, un fichier cree apparaissait en local) ; un compte qui n'est
 * pas administrateur du serveur « entrait » quand meme ; la machine distante etait retrouvee en parcourant la
 * topologie (`findHostByAddress`) au lieu de passer par le cable ; `Exit-PSSession` n'existait pas ; aucune trame ne
 * portait une commande ; une reponse de plus d'un segment TCP etait coupee (`JSON.parse` sur chaque segment).
 *
 * Autorites. Microsoft Learn, Enter-PSSession (5.1) : « During the session, the commands that you type run on the
 * remote computer » ; l'exemple 2 cree un fichier distant que `dir` ne trouve pas en local ; « To end the interactive
 * session ... use the Exit-PSSession cmdlet, or type exit » ; le profil distant est utilise ; il faut etre membre du
 * groupe Administrateurs de l'ordinateur distant ; Exit-PSSession fait partie des commandes que la configuration de
 * session distante doit offrir, c'est donc une commande DISTANTE (le serveur la traduit en `exit`). Transcription
 * capturee, blog Microsoft Scripting Guy du 2013-12-11 (« Use PowerShell to Create Remote Session ») :
 * `[dc1]: PS C:\Users\Administrator\Documents>`, `sl c:\` donne `[dc1]: PS C:\>`, `exit` ramene a `PS C:\>` ; le
 * dossier de depart est donc Documents du profil. Sources de PowerShell 7.4.6 : ConsoleHost.cs
 * (`HandleRemoteRunspaceStateChanged` : un runspace pousse qui passe a Closing, Closed, Broken ou Disconnected est
 * depile, d'ou le retour a l'invite locale quand le cable est coupe) ; RemotingErrorIdStrings.resx
 * (`ReceiveExCallBackError` : « Processing data from remote server {0} failed with the following error message:
 * {1} »). Le texte {1} d'un lien coupe en cours de session n'est pas atteignable : on reprend celui de WinRM pour un
 * ordinateur injoignable.
 *
 * Sur les 37 cas, 32 tombent avant la correction. Les 5 qui passent des deux cotes sont des NON-REGRESSIONS : les
 * refus (mauvais mot de passe, WinRM non configure, cable debranche, aucun billet Kerberos, nom introuvable) etaient
 * deja refuses ; le meme laboratoire porte les cas de succes qui prouvent qu'il est sain. Les trames sont comptees
 * par DIFFERENCE : la meme commande `hostname` coute 0 trame a l'invite locale et au moins 4 dans la session, et une
 * reponse plus grande coute plus de trames qu'une courte.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { WindowsServer } from '@/network/devices/WindowsServer';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { WindowsTerminalSession } from '@/terminal/sessions/WindowsTerminalSession';
import type { KeyEvent } from '@/terminal/sessions/TerminalSession';
import { ShellFactory } from '@/shell/ShellFactory';
import { installDefaultShells } from '@/shell/registerDefaults';

const key = (name: string): KeyEvent => ({ key: name, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false });

async function settle(times = 12): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
    await new Promise<void>(resolve => setTimeout(resolve, 0));
  }
}

class Console {
  private constructor(private readonly session: WindowsTerminalSession) {}

  static async open(machine: WindowsPC): Promise<Console> {
    const session = new WindowsTerminalSession('a', machine);
    await session.init();
    return new Console(session);
  }

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

  async runAll(...lines: string[]): Promise<void> {
    for (const line of lines) await this.run(line);
  }

  async tab(typed: string): Promise<string> {
    this.session.setInputBuf(typed);
    this.session.handleKey(key('Tab'));
    await settle();
    return this.session.getInputBuf();
  }
}

beforeEach(() => {
  EquipmentRegistry.getInstance().clear();
});

const ADMIN = '-Credential Administrator:admin';

interface Lab {
  readonly server: WindowsServer;
  readonly client: WindowsPC;
  readonly console: Console;
  readonly cable: Cable;
}

async function lab(opts: { quickconfig?: boolean } = {}): Promise<Lab> {
  const server = new WindowsServer('SRV1');
  const client = new WindowsPC('windows-pc', 'CLIENT1', 0, 0);
  const sw = new GenericSwitch('switch-generic', 'SW1');
  new Cable('c-srv').connect(server.getPorts()[0], sw.getPorts()[0]);
  const cable = new Cable('c-client');
  cable.connect(client.getPorts()[0], sw.getPorts()[1]);
  const mask = new SubnetMask('255.255.255.0');
  server.getPorts()[0].configureIP(new IPAddress('192.168.20.10'), mask);
  client.getPorts()[0].configureIP(new IPAddress('192.168.20.20'), mask);
  client.addHostsEntry('192.168.20.10', 'SRV1');
  if (opts.quickconfig !== false) await server.executeCmdCommand('winrm quickconfig');
  const shell = await Console.open(client);
  await shell.run('powershell');
  return { server, client, console: shell, cable };
}

const REMOTE_HOME = '[SRV1]: PS C:\\Users\\Administrator\\Documents> ';

describe('Enter-PSSession opens an interactive session on the remote computer', () => {
  it('shows the computer name and the profile folder of the remote account as the prompt', async () => {
    const { console: shell } = await lab();
    expect(await shell.run(`Enter-PSSession -ComputerName SRV1 ${ADMIN}`)).toBe('');
    expect(shell.prompt).toBe(REMOTE_HOME);
  });

  it('names the computer as it was typed, not as it calls itself', async () => {
    const { console: shell } = await lab();
    await shell.run(`Enter-PSSession srv1 ${ADMIN}`);
    expect(shell.prompt).toBe('[srv1]: PS C:\\Users\\Administrator\\Documents> ');
  });

  it('runs what is typed on the remote computer', async () => {
    const { console: shell } = await lab();
    await shell.run(`Enter-PSSession SRV1 ${ADMIN}`);
    expect(await shell.run('$env:COMPUTERNAME')).toBe('SRV1');
    expect(await shell.run('hostname')).toBe('SRV1');
  });

  it('keeps the commands local before the session and after it', async () => {
    const { console: shell } = await lab();
    expect(await shell.run('$env:COMPUTERNAME')).toBe('CLIENT1');
    await shell.run(`Enter-PSSession SRV1 ${ADMIN}`);
    await shell.run('exit');
    expect(await shell.run('$env:COMPUTERNAME')).toBe('CLIENT1');
  });

  it('lists the remote tree and not the local one', async () => {
    const { console: shell, server } = await lab();
    server.getFileSystem().mkdirp('C:\\OnlyOnServer');
    await shell.run(`Enter-PSSession SRV1 ${ADMIN}`);
    expect(await shell.run('Get-ChildItem C:\\ -Name')).toContain('OnlyOnServer');
    await shell.run('exit');
    expect(await shell.run('Get-ChildItem C:\\ -Name')).not.toContain('OnlyOnServer');
  });

  it('creates files on the remote computer and leaves the local disk alone', async () => {
    const { console: shell, server, client } = await lab();
    await shell.run(`Enter-PSSession SRV1 ${ADMIN}`);
    await shell.run('Set-Content note.txt hello');
    expect(server.getFileSystem().exists('C:\\Users\\Administrator\\Documents\\note.txt')).toBe(true);
    expect(client.getFileSystem().exists('C:\\Users\\Administrator\\Documents\\note.txt')).toBe(false);
    await shell.run('exit');
    expect(await shell.run('Test-Path C:\\Users\\Administrator\\Documents\\note.txt')).toBe('False');
  });

  it('moves around the remote tree and shows the new location', async () => {
    const { console: shell } = await lab();
    await shell.run(`Enter-PSSession SRV1 ${ADMIN}`);
    await shell.run('Set-Location C:\\');
    expect(shell.prompt).toBe('[SRV1]: PS C:\\> ');
    await shell.run('cd Windows');
    expect(shell.prompt).toBe('[SRV1]: PS C:\\Windows> ');
    expect(await shell.run('(Get-Location).Path')).toBe('C:\\Windows');
  });

  it('keeps the remote location between two commands', async () => {
    const { console: shell, server } = await lab();
    server.getFileSystem().mkdirp('C:\\OnlyOnServer');
    await shell.run(`Enter-PSSession SRV1 ${ADMIN}`);
    await shell.run('cd C:\\OnlyOnServer');
    expect(await shell.run('(Get-Location).Path')).toBe('C:\\OnlyOnServer');
    expect(shell.prompt).toBe('[SRV1]: PS C:\\OnlyOnServer> ');
  });

  it('shows the prompt function of the remote session, still prefixed with the computer name', async () => {
    const { console: shell } = await lab();
    await shell.run(`Enter-PSSession SRV1 ${ADMIN}`);
    await shell.run("function prompt { 'RP> ' }");
    expect(shell.prompt).toBe('[SRV1]: RP> ');
  });

  it('answers whoami with the account the session runs as', async () => {
    const { console: shell } = await lab();
    await shell.run(`Enter-PSSession SRV1 ${ADMIN}`);
    expect((await shell.run('whoami')).toLowerCase()).toBe('srv1\\administrator');
  });

  it('is entered with the alias etsn and a quoted computer name', async () => {
    const { console: shell } = await lab();
    await shell.run(`etsn -ComputerName "SRV1" ${ADMIN}`);
    expect(shell.prompt).toBe(REMOTE_HOME);
  });

  it('takes the credential from a variable', async () => {
    const { console: shell } = await lab();
    await shell.run("$cred = New-Object System.Management.Automation.PSCredential('Administrator', (ConvertTo-SecureString 'admin' -AsPlainText -Force))");
    await shell.run('Enter-PSSession SRV1 -Credential $cred');
    expect(shell.prompt).toBe(REMOTE_HOME);
  });

  it('does not move the location of the local prompt', async () => {
    const { console: shell } = await lab();
    const local = shell.prompt;
    await shell.run(`Enter-PSSession SRV1 ${ADMIN}`);
    await shell.run('cd C:\\Windows');
    await shell.run('exit');
    expect(shell.prompt).toBe(local);
  });
});

describe('Tab in the session completes from the remote computer', () => {
  it('completes a path of the remote disk', async () => {
    const { console: shell, server } = await lab();
    server.getFileSystem().mkdirp('C:\\OnlyOnServer');
    await shell.run(`Enter-PSSession SRV1 ${ADMIN}`);
    expect(await shell.tab('Get-ChildItem C:\\OnlyOn')).toBe('Get-ChildItem C:\\OnlyOnServer\\');
  });

  it('completes an environment variable of the remote computer', async () => {
    const { console: shell, server } = await lab();
    server.setEnvVar('ONLYONSERVER', '1');
    await shell.run(`Enter-PSSession SRV1 ${ADMIN}`);
    expect((await shell.tab('$env:ONLYONS')).toLowerCase()).toBe('$env:onlyonserver');
  });

  it('completes from the local computer again once the session is over', async () => {
    const { console: shell, server } = await lab();
    server.getFileSystem().mkdirp('C:\\OnlyOnServer');
    await shell.run(`Enter-PSSession SRV1 ${ADMIN}`);
    expect(await shell.tab('Get-ChildItem C:\\OnlyOn')).toBe('Get-ChildItem C:\\OnlyOnServer\\');
    await shell.run('exit');
    expect(await shell.tab('Get-ChildItem C:\\OnlyOn')).toBe('Get-ChildItem C:\\OnlyOn');
  });

  it('offers nothing once the cable is pulled', async () => {
    const { console: shell, server, cable } = await lab();
    server.getFileSystem().mkdirp('C:\\OnlyOnServer');
    await shell.run(`Enter-PSSession SRV1 ${ADMIN}`);
    expect(await shell.tab('Get-ChildItem C:\\OnlyOn')).toBe('Get-ChildItem C:\\OnlyOnServer\\');
    cable.disconnect();
    expect(await shell.tab('Get-ChildItem C:\\OnlyOn')).toBe('Get-ChildItem C:\\OnlyOn');
  });
});

describe('a statement that spans several lines in the session', () => {
  it('shows the continuation prompt of the remote without the computer name, then runs on the remote', async () => {
    const { console: shell } = await lab();
    await shell.run(`Enter-PSSession SRV1 ${ADMIN}`);
    await shell.run('foreach ($i in 1..2) {');
    expect(shell.prompt).toBe('>> ');
    await shell.run('"$env:COMPUTERNAME $i"');
    const out = await shell.run('}');
    expect(out).toBe('SRV1 1\nSRV1 2');
    expect(shell.prompt).toBe(REMOTE_HOME);
  });
});

describe('leaving the session', () => {
  it('goes back to the local prompt with exit', async () => {
    const { console: shell } = await lab();
    const local = shell.prompt;
    await shell.run(`Enter-PSSession SRV1 ${ADMIN}`);
    expect(await shell.run('exit')).toBe('');
    expect(shell.prompt).toBe(local);
  });

  it('goes back to the local prompt with Exit-PSSession, whatever its case', async () => {
    const { console: shell } = await lab();
    const local = shell.prompt;
    await shell.run(`Enter-PSSession SRV1 ${ADMIN}`);
    expect(shell.prompt).toBe(REMOTE_HOME);
    await shell.run('exit-pssession');
    expect(shell.prompt).toBe(local);
  });

  it('stays in the session when the line only starts with Exit-PSSession', async () => {
    const { console: shell } = await lab();
    await shell.run(`Enter-PSSession SRV1 ${ADMIN}`);
    await shell.run('Exit-PSSession-not');
    expect(shell.prompt).toBe(REMOTE_HOME);
  });

  it('closes the connection on the server', async () => {
    const { console: shell, server } = await lab();
    await shell.run(`Enter-PSSession SRV1 ${ADMIN}`);
    expect(await server.executeCmdCommand('netstat -an')).toMatch(/192\.168\.20\.10:5985\s+192\.168\.20\.20:\d+\s+ESTABLISHED/);
    await shell.run('exit');
    await settle();
    expect(await server.executeCmdCommand('netstat -an')).not.toMatch(/192\.168\.20\.10:5985\s+192\.168\.20\.20:\d+\s+ESTABLISHED/);
  });
});

describe('what is typed in the session crosses the cable', () => {
  it('costs frames on the wire, where the same command at the local prompt costs none', async () => {
    const { console: shell, cable } = await lab();
    const before = cable.getStats().framesTransmitted;
    await shell.run('hostname');
    const local = cable.getStats().framesTransmitted - before;
    await shell.run(`Enter-PSSession SRV1 ${ADMIN}`);
    const entered = cable.getStats().framesTransmitted;
    await shell.run('hostname');
    const remote = cable.getStats().framesTransmitted - entered;
    expect(local).toBe(0);
    expect(remote).toBeGreaterThanOrEqual(4);
  });

  it('costs more frames for a larger answer than for a short one', async () => {
    const { console: shell, cable } = await lab();
    await shell.run(`Enter-PSSession SRV1 ${ADMIN}`);
    const measure = async (line: string): Promise<number> => {
      const start = cable.getStats().framesTransmitted;
      await shell.run(line);
      return cable.getStats().framesTransmitted - start;
    };
    const short = await measure('Write-Output ok');
    const long = await measure("Write-Output ('x' * 6000)");
    expect(long).toBeGreaterThan(short + 4);
  });

  it('brings back an answer bigger than one segment in full', async () => {
    const { console: shell } = await lab();
    await shell.run(`Enter-PSSession SRV1 ${ADMIN}`);
    const out = await shell.run('1..600 | ForEach-Object { "$env:COMPUTERNAME row $_" }');
    const rows = out.split('\n');
    expect(rows).toHaveLength(600);
    expect(rows[0]).toBe('SRV1 row 1');
    expect(rows[599]).toBe('SRV1 row 600');
  });

  it('costs no frame for an empty line', async () => {
    const { console: shell, cable } = await lab();
    await shell.run(`Enter-PSSession SRV1 ${ADMIN}`);
    const typed = cable.getStats().framesTransmitted;
    await shell.run('hostname');
    const start = cable.getStats().framesTransmitted;
    await shell.run('');
    expect(start - typed).toBeGreaterThan(0);
    expect(cable.getStats().framesTransmitted - start).toBe(0);
  });

  it('costs no frame once the session is over', async () => {
    const { console: shell, cable } = await lab();
    await shell.run(`Enter-PSSession SRV1 ${ADMIN}`);
    const inSession = cable.getStats().framesTransmitted;
    await shell.run('hostname');
    const afterCommand = cable.getStats().framesTransmitted;
    await shell.run('exit');
    await settle();
    const start = cable.getStats().framesTransmitted;
    await shell.run('hostname');
    expect(afterCommand - inSession).toBeGreaterThan(0);
    expect(cable.getStats().framesTransmitted - start).toBe(0);
  });
});

describe('a session that cannot be opened leaves the local prompt alone', () => {
  it('refuses an account that is not an administrator of the remote computer', async () => {
    const { console: shell } = await lab();
    const local = shell.prompt;
    const out = await shell.run('Enter-PSSession SRV1 -Credential bob');
    expect(out).toContain('Connecting to remote server SRV1 failed with the following error message');
    expect(out).toContain('Access is denied.');
    expect(shell.prompt).toBe(local);
    expect(await shell.run('$env:COMPUTERNAME')).toBe('CLIENT1');
  });

  it('refuses a wrong password', async () => {
    const { console: shell } = await lab();
    const local = shell.prompt;
    const out = await shell.run('Enter-PSSession SRV1 -Credential Administrator:wrong');
    expect(out).toContain('Connecting to remote server SRV1 failed with the following error message');
    expect(shell.prompt).toBe(local);
  });

  it('refuses a computer whose WinRM service was never configured', async () => {
    const { console: shell } = await lab({ quickconfig: false });
    const local = shell.prompt;
    const out = await shell.run(`Enter-PSSession SRV1 ${ADMIN}`);
    expect(out).toContain('WinRM cannot complete the operation');
    expect(shell.prompt).toBe(local);
  });

  it('refuses a computer behind an unplugged cable', async () => {
    const { console: shell, cable } = await lab();
    cable.disconnect();
    const local = shell.prompt;
    const out = await shell.run(`Enter-PSSession SRV1 ${ADMIN}`);
    expect(out).toContain('WinRM cannot complete the operation');
    expect(shell.prompt).toBe(local);
  });

  it('refuses to open a session without credentials where no Kerberos ticket can vouch for the user', async () => {
    const { console: shell } = await lab();
    const local = shell.prompt;
    const out = await shell.run('Enter-PSSession SRV1');
    expect(out).toContain('Connecting to remote server SRV1 failed with the following error message');
    expect(shell.prompt).toBe(local);
  });

  it('refuses a name that resolves nowhere', async () => {
    const { console: shell } = await lab();
    const local = shell.prompt;
    const out = await shell.run(`Enter-PSSession NOWHERE ${ADMIN}`);
    expect(out).toContain('Connecting to remote server NOWHERE failed with the following error message');
    expect(shell.prompt).toBe(local);
  });
});

describe('a session whose cable is pulled', () => {
  it('reports the broken connection and does not run the line on the local machine', async () => {
    const { console: shell, cable } = await lab();
    await shell.run(`Enter-PSSession SRV1 ${ADMIN}`);
    cable.disconnect();
    const out = await shell.run('$env:COMPUTERNAME');
    expect(out).toContain('Processing data from remote server SRV1 failed with the following error message');
    expect(out).toContain('WinRM cannot complete the operation');
    expect(out).not.toContain('CLIENT1');
  });

  it('drops back to the local prompt, as the console host does when the remote runspace breaks', async () => {
    const { console: shell, cable } = await lab();
    const local = shell.prompt;
    await shell.run(`Enter-PSSession SRV1 ${ADMIN}`);
    expect(shell.prompt).toBe(REMOTE_HOME);
    cable.disconnect();
    await shell.run('hostname');
    expect(shell.prompt).toBe(local);
  });

  it('runs the next line on the local machine once the session is gone', async () => {
    const { console: shell, cable } = await lab();
    await shell.run(`Enter-PSSession SRV1 ${ADMIN}`);
    expect(await shell.run('$env:COMPUTERNAME')).toBe('SRV1');
    cable.disconnect();
    await shell.run('hostname');
    expect(await shell.run('$env:COMPUTERNAME')).toBe('CLIENT1');
  });
});

describe('the session over a shell that is not the terminal', () => {
  it('hands the remote session back as a child shell to whoever drives the PowerShell', async () => {
    const { client } = await lab();
    installDefaultShells();
    const powershell = ShellFactory.create('powershell', { device: client, user: 'User', connection: 'ssh' });
    powershell.activate();
    const result = await powershell.processLine(`Enter-PSSession SRV1 ${ADMIN}`);
    expect(result.childShell).toBeDefined();
    expect(result.childShell!.getPrompt()).toBe(REMOTE_HOME);
    expect((await result.childShell!.processLine('hostname')).output).toEqual(['SRV1']);
  });
});
