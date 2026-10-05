/*
 * La completion par Tab des chemins, sur PowerShell ET sur cmd : depuis la
 * racine `\`, a la suite d'un accent grave, dans la reponse a un
 * `Read-Host`, dans les noms de cle du registre, et dans les chemins entre
 * guillemets qui contiennent une espace.
 *
 * Mesure de depart : `cd \Al` + Tab ne completait rien sous PowerShell — le
 * dossier a lister etait coupe AVANT sa derniere barre, donc `\Al` listait le
 * repertoire courant — et sous cmd il REECRIVAIT la ligne en `cd Alpha`, en
 * perdant la barre ou le lecteur : `cd C:\Al` devenait `cd Alpha`, et
 * `dir C:\Alpha\no` devenait `dir notes.txt`. `cmd` et PowerShell avaient
 * chacun SON completeur de chemin, aucun des deux ne gerait `~`, un joker, un
 * nom de cle de registre ou `Env:`. Sur la ligne de continuation d'un accent
 * grave, `  -Rec` etait pris pour un NOM DE COMMANDE (le contexte des lignes
 * precedentes etait perdu), donc ni parametre ni chemin n'etaient proposes.
 * Un chemin entre guillemets avec espace (`cd 'C:\Program Files\To`) etait
 * recolle sur son dernier mot, `Files\To`, et la ligne devenait illisible.
 * Dans une invite `Read-Host`, Tab inserait un nom de cmdlet dans la reponse
 * (`?` dans la reponse masquee d'un `-AsSecureString`, ou le nom d'une
 * commande dans la reponse en clair), et l'invite s'affichait sans les deux
 * points que PowerShell ajoute. Une commande sans sortie (`$x = 5`) laissait
 * une ligne vide derriere elle, que PowerShell n'ecrit pas.
 *
 * L'AUTORITE — la documentation Microsoft : `Read-Host -Prompt` « PowerShell
 * appends a colon to the text that you enter » (Read-Host, about_Read-Host) ;
 * la completion de chemin de PowerShell (TabExpansion2 / CompleteFilename) :
 * dossiers suivis de `\`, chemin entre apostrophes si le nom contient une
 * espace ou un caractere special, dossiers seuls pour `Set-Location` et
 * `Push-Location` (de memoire : aucune transcription n'est atteignable d'ici),
 * `~` developpe en dossier personnel, jokers acceptes, les barres obliques
 * rendues en barres inverses. Pour cmd.exe : la completion (CompletionChar)
 * ne rend que le nom, entoure de guillemets s'il contient une espace, sans
 * barre finale sur un dossier, et `cd` ne parcourt que les dossiers. Aucun
 * des deux n'ajoute de completion dans `Read-Host` : PowerShell y laisse la
 * touche Tab inerte. Ce simulateur COMPLETE la reponse comme un chemin
 * lorsqu'elle en a la forme (une barre, un lecteur, un `~`) et rend Tab
 * inerte sur une reponse masquee — un ecart choisi, parce qu'une reponse a
 * `Read-Host` est presque toujours un chemin dans les scenarios de labo.
 *
 * Ecrite a l'aveugle, sur trois chemins qui aboutissent aux memes completeurs :
 * le sous-shell (`getCompletions`), le terminal graphique PowerShell, le
 * terminal graphique cmd.
 *
 * 33 des 41 cas tombent avant (git stash push -- src/network src/terminal
 * src/powershell src/shell). Les 8 qui passent des deux cotes : cinq TEMOINS
 * (un chemin derriere un lecteur, `.\` et `..\`, le nom de commande de la
 * premiere ligne, la completion d'une commande sous cmd, le retour a la
 * completion de commandes une fois la reponse donnee) ; une NON-REGRESSION
 * (le nom de commande d'une ligne de continuation, qui est un mot seul) ; le
 * cas de la liste de la racine d'un lecteur, qui passait deja grace au
 * lecteur ; et une reponse qui n'a pas la forme d'un chemin, qui ne
 * completait rien parce qu'aucune commande ne commence par ce mot.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { WindowsTerminalSession } from '@/terminal/sessions/WindowsTerminalSession';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';
import type { KeyEvent } from '@/terminal/sessions/TerminalSession';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

const BACKTICK = '`';
const key = (name: string, shiftKey = false): KeyEvent => ({ key: name, ctrlKey: false, altKey: false, metaKey: false, shiftKey });
const settle = () => new Promise<void>(resolve => setTimeout(resolve, 60));

function labMachine(): WindowsPC {
  const pc = new WindowsPC('windows-pc', 'WIN');
  pc.setCurrentUser('Administrator');
  const fs = pc.getFileSystem();
  fs.mkdirp('C:\\Alpha\\Sub');
  fs.mkdirp('C:\\Alpha\\Deep\\Er');
  fs.mkdirp('C:\\Beta');
  fs.mkdirp('C:\\Program Files\\Tool Kit');
  fs.createFile('C:\\Alpha\\notes.txt', 'n');
  fs.createFile('C:\\Alpha\\notes.md', 'n');
  fs.createFile('C:\\Alpha\\readme.txt', 'n');
  fs.createFile('C:\\Beta\\data.csv', 'd');
  fs.mkdirp('C:\\Users\\Administrator\\Documents');
  fs.mkdirp('C:\\Users\\Administrator\\Downloads');
  fs.createFile('C:\\Users\\Administrator\\todo.txt', 't');
  return pc;
}

async function engine(cwd = 'C:\\Users\\Administrator') {
  const pc = labMachine();
  const { subShell } = PowerShellSubShell.create(pc);
  await subShell.processLine(`Set-Location ${cwd}`);
  return subShell;
}

async function terminal(cwd = 'C:\\Users\\Administrator') {
  const pc = labMachine();
  pc.powerOn();
  const session = new WindowsTerminalSession('term-1', pc);
  await session.init?.();
  session.setInput('powershell');
  session.handleKey(key('Enter'));
  await settle();
  session.setInputBuf(`Set-Location ${cwd}`);
  session.handleKey(key('Enter'));
  await settle();
  return session;
}

function tab(session: WindowsTerminalSession, typed: string, presses = 1): string {
  session.setInputBuf(typed);
  for (let press = 0; press < presses; press++) session.handleKey(key('Tab'));
  return session.getInputBuf();
}

async function enter(session: WindowsTerminalSession, line: string): Promise<void> {
  session.setInputBuf(line);
  session.handleKey(key('Enter'));
  await settle();
}

describe('path completion from the engine', () => {
  it('completes from the root of the drive with a leading backslash', async () => {
    const ps = await engine();
    expect(ps.getCompletions('Get-ChildItem \\Alp')).toEqual(['\\Alpha\\']);
  });

  it('lists the root with a lone backslash', async () => {
    const ps = await engine();
    const found = ps.getCompletions('Get-ChildItem \\');
    expect(found).toContain('\\Alpha\\');
    expect(found).toContain('\\Beta\\');
    expect(found).toContain('\\Users\\');
  });

  it('completes the root for Set-Location and cd, directories only', async () => {
    const ps = await engine();
    expect(ps.getCompletions('cd \\Al')).toEqual(['\\Alpha\\']);
    expect(ps.getCompletions('Set-Location \\Alpha\\')).toEqual(['\\Alpha\\Deep\\', '\\Alpha\\Sub\\']);
  });

  it('completes with a forward slash from the root and answers with backslashes', async () => {
    const ps = await engine();
    expect(ps.getCompletions('Get-ChildItem /Alp')).toEqual(['\\Alpha\\']);
  });

  it('lists the drive root after C:\\', async () => {
    const ps = await engine();
    const found = ps.getCompletions('Get-ChildItem C:\\');
    expect(found).toContain('C:\\Alpha\\');
    expect(found).toContain("'C:\\Program Files\\'");
  });

  it('completes below a drive-rooted directory — WITNESS', async () => {
    const ps = await engine();
    expect(ps.getCompletions('Get-ChildItem C:\\Alp')).toEqual(['C:\\Alpha\\']);
    expect(ps.getCompletions('Get-ChildItem C:\\Alpha\\n')).toEqual(['C:\\Alpha\\notes.md', 'C:\\Alpha\\notes.txt']);
  });

  it('completes relative names, .\\ and ..\\ — WITNESS', async () => {
    const ps = await engine();
    expect(ps.getCompletions('Get-ChildItem Doc')).toEqual(['Documents\\']);
    expect(ps.getCompletions('Get-ChildItem .\\Do')).toEqual(['.\\Documents\\', '.\\Downloads\\']);
    expect(ps.getCompletions('Get-ChildItem ..\\Administrator\\to')).toEqual(['..\\Administrator\\todo.txt']);
  });

  it('expands ~ to the home directory', async () => {
    const ps = await engine('C:\\Alpha');
    expect(ps.getCompletions('Get-ChildItem ~\\Do')).toEqual(['~\\Documents\\', '~\\Downloads\\']);
  });

  it('keeps the quote when a name has a space', async () => {
    const ps = await engine();
    expect(ps.getCompletions('Get-ChildItem C:\\Program')).toEqual([
      "'C:\\Program Files\\'", "'C:\\Program Files (x86)\\'", 'C:\\ProgramData\\',
    ]);
    expect(ps.getCompletions("Get-ChildItem 'C:\\Program Files\\To")).toEqual(["'C:\\Program Files\\Tool Kit\\'"]);
  });

  it('offers only directories to Set-Location and files too to Get-Content', async () => {
    const ps = await engine('C:\\Alpha');
    expect(ps.getCompletions('Set-Location n')).toEqual([]);
    expect(ps.getCompletions('Get-Content n')).toEqual(['notes.md', 'notes.txt']);
  });

  it('completes a wildcard pattern', async () => {
    const ps = await engine('C:\\Alpha');
    expect(ps.getCompletions('Get-ChildItem *.tx')).toEqual(['notes.txt', 'readme.txt']);
  });

  it('completes after a parameter that takes a path', async () => {
    const ps = await engine();
    expect(ps.getCompletions('Get-ChildItem -Path \\Be')).toEqual(['\\Beta\\']);
    expect(ps.getCompletions('Get-Content -LiteralPath C:\\Beta\\d')).toEqual(['C:\\Beta\\data.csv']);
  });

  it('completes a path inside a subexpression or after a pipe', async () => {
    const ps = await engine();
    expect(ps.getCompletions('Get-Process | Out-File \\Al')).toEqual(['\\Alpha\\']);
    expect(ps.getCompletions('(Get-Content \\Alpha\\rea')).toEqual(['\\Alpha\\readme.txt']);
  });
});

describe('provider paths', () => {
  it('completes registry keys', async () => {
    const ps = await engine();
    expect(ps.getCompletions('Get-ChildItem HKLM:\\SOFTW')).toEqual(['HKLM:\\SOFTWARE\\']);
    expect(ps.getCompletions('Set-Location HKLM:\\SOFTWARE\\Micro')).toEqual(['HKLM:\\SOFTWARE\\Microsoft\\']);
    expect(ps.getCompletions('Get-ChildItem HKCU:\\')).toContain('HKCU:\\Software\\');
  });

  it('completes the environment drive', async () => {
    const ps = await engine();
    expect(ps.getCompletions('Get-ChildItem Env:\\COMPUTERN')).toEqual(['Env:\\COMPUTERNAME']);
  });
});

describe('a command split by a trailing backtick', () => {
  it('completes a parameter on the continuation line', async () => {
    const ps = await engine();
    await ps.processLine(`Get-ChildItem ${BACKTICK}`);

    expect(ps.getCompletions('  -Rec')).toEqual(['-Recurse']);
  });

  it('completes a path value on the continuation line', async () => {
    const ps = await engine();
    await ps.processLine(`Get-ChildItem -Path ${BACKTICK}`);

    expect(ps.getCompletions('  \\Alp')).toEqual(['\\Alpha\\']);
  });

  it('completes the value of a parameter named on the line before', async () => {
    const ps = await engine();
    await ps.processLine(`Get-ChildItem -Path \\Alpha ${BACKTICK}`);
    await ps.processLine(`  -Filter n* ${BACKTICK}`);

    expect(ps.getCompletions('  -Rec')).toEqual(['-Recurse']);
  });

  it('still completes a command name on the first line — WITNESS', async () => {
    const ps = await engine();

    expect(ps.getCompletions('Get-ChildItem -Rec')).toEqual(['-Recurse']);
    expect(ps.getCompletions('Get-Childi')).toContain('Get-ChildItem');
  });

  it('completes a command name on the continuation line of a pipeline split after a pipe', async () => {
    const ps = await engine();
    await ps.processLine('Get-Process |');

    expect(ps.getCompletions('  Sort-Obj')).toEqual(['Sort-Object']);
  });
});

describe('values that PowerShell enumerates', () => {
  it('completes the values of a common parameter', async () => {
    const ps = await engine();
    expect(ps.getCompletions('Get-ChildItem -ErrorAction S')).toEqual(['SilentlyContinue', 'Stop', 'Suspend']);
    expect(ps.getCompletions('Get-ChildItem -ErrorAction Ig')).toEqual(['Ignore']);
  });

  it('completes a command name at command position when the word is a path', async () => {
    const ps = await engine();
    expect(ps.getCompletions('.\\Doc')).toEqual(['.\\Documents\\']);
    expect(ps.getCompletions('\\Alp')).toEqual(['\\Alpha\\']);
  });
});

describe('Tab in the graphical Windows terminal, PowerShell', () => {
  it('completes a path from the root', async () => {
    const session = await terminal();

    expect(tab(session, 'cd \\Alp')).toBe('cd \\Alpha\\');
  });

  it('completes a parameter behind the >> prompt', async () => {
    const session = await terminal();
    await enter(session, `Get-ChildItem ${BACKTICK}`);

    expect(session.currentInputMode).toMatchObject({ type: 'interactive-text', promptText: '>> ' });
    expect(tab(session, '  -Rec')).toBe('  -Recurse');
  });

  it('completes a path behind the >> prompt', async () => {
    const session = await terminal();
    await enter(session, `Get-ChildItem -Path ${BACKTICK}`);

    expect(tab(session, '  \\Alp')).toBe('  \\Alpha\\');
  });

  it('cycles through the candidates of a directory and comes back with Shift+Tab', async () => {
    const session = await terminal();
    session.setInputBuf('cd \\Alpha\\');
    session.handleKey(key('Tab'));
    const first = session.getInputBuf();
    session.handleKey(key('Tab'));
    const second = session.getInputBuf();
    session.handleKey(key('Tab', true));

    expect(first).toBe('cd \\Alpha\\Deep\\');
    expect(second).toBe('cd \\Alpha\\Sub\\');
    expect(session.getInputBuf()).toBe(first);
  });

  it('replaces the whole quoted token, spaces included, not just its last word', async () => {
    const session = await terminal();

    expect(tab(session, "cd 'C:\\Program Files\\To")).toBe("cd 'C:\\Program Files\\Tool Kit\\'");
    expect(tab(session, 'Get-ChildItem C:\\Program')).toBe("Get-ChildItem 'C:\\Program Files\\'");
  });

  it('prints no blank line after a command that has nothing to show', async () => {
    const session = await terminal();
    await enter(session, '$quiet = 5');
    const last = session.lines[session.lines.length - 1];

    expect(last.type).toBe('prompt');
    expect(last.text).toBe('$quiet = 5');
  });
});

describe('Tab at a Read-Host prompt', () => {
  async function prompted(line: string) {
    const session = await terminal();
    await enter(session, line);
    return session;
  }

  it('is waiting for the answer, behind a prompt that ends with a colon', async () => {
    const session = await prompted('$answer = Read-Host "Database path"');

    expect(session.currentInputMode).toMatchObject({ type: 'interactive-text', promptText: 'Database path: ' });
  });

  it('completes the answer as a path instead of inserting a cmdlet name', async () => {
    const session = await prompted('$answer = Read-Host "Database path"');

    expect(tab(session, 'C:\\Alp')).toBe('C:\\Alpha\\');
  });

  it('completes a path with a space as one answer, without quotes', async () => {
    const session = await prompted('$answer = Read-Host "Install dir"');

    expect(tab(session, 'C:\\Program F')).toBe('C:\\Program Files\\');
    session.setInputBuf('C:\\Program Files\\To');
    session.handleKey(key('Tab'));
    expect(session.getInputBuf()).toBe('C:\\Program Files\\Tool Kit\\');
  });

  it('leaves an answer that is not a path alone', async () => {
    const session = await prompted('$answer = Read-Host "Name"');

    expect(tab(session, 'Alpha')).toBe('Alpha');
    expect(tab(session, 'Zorglub\\x')).toBe('Zorglub\\x');
  });

  it('does not type into a masked answer', async () => {
    const session = await prompted('$secret = Read-Host -AsSecureString "SafeMode password"');
    session.setInputBuf('');
    session.handleKey(key('Tab'));

    expect(session.currentInputMode.type).toBe('password');
    expect(session.getInputBuf()).toBe('');
  });

  it('does not type into the masked answer asked inside a forest installation command', async () => {
    const session = await terminal();
    await enter(session, `Install-ADDSForest -DomainName corp.local ${BACKTICK}`);
    await enter(session, `  -SafeModeAdministratorPassword (Read-Host -AsSecureString "DSRM password")`);
    session.setInputBuf('');
    session.handleKey(key('Tab'));

    expect(session.currentInputMode).toMatchObject({ type: 'password', promptText: 'DSRM password: ' });
    expect(session.getInputBuf()).toBe('');
  });

  it('echoes the answer after the prompt and delivers the completed value', async () => {
    const session = await prompted('$answer = Read-Host "Database path"');
    tab(session, 'C:\\Alp');
    session.handleKey(key('Enter'));
    await settle();
    const echoed = session.lines.filter(line => line.type === 'prompt').slice(-1)[0];
    await enter(session, '$answer');

    expect(`${echoed.promptText}${echoed.text}`).toBe('Database path: C:\\Alpha\\');
    expect(session.lines[session.lines.length - 1].text).toBe('C:\\Alpha\\');
  });

  it('gives the terminal back to command completion once answered — WITNESS', async () => {
    const session = await prompted('$answer = Read-Host "Name"');
    session.setInputBuf('Bob');
    session.handleKey(key('Enter'));
    await settle();

    expect(tab(session, 'Get-Childi')).toBe('Get-ChildItem');
  });
});

describe('Tab at the cmd prompt', () => {
  async function cmdTerminal(cwd = 'C:\\Users\\Administrator') {
    const pc = labMachine();
    pc.powerOn();
    const session = new WindowsTerminalSession('term-1', pc);
    await session.init?.();
    session.setInput(`cd /d ${cwd}`);
    session.handleKey(key('Enter'));
    await settle();
    return session;
  }

  function cmdTab(session: WindowsTerminalSession, typed: string): string {
    session.setInput(typed);
    session.handleKey(key('Tab'));
    return session.input;
  }

  it('keeps the root backslash and the drive when completing', async () => {
    const session = await cmdTerminal();

    expect(cmdTab(session, 'cd \\Alp')).toBe('cd \\Alpha');
    expect(cmdTab(session, 'cd C:\\Alp')).toBe('cd C:\\Alpha');
    expect(cmdTab(session, 'cd .\\Doc')).toBe('cd .\\Documents');
  });

  it('completes a file below a drive-rooted directory', async () => {
    const session = await cmdTerminal();

    expect(cmdTab(session, 'type C:\\Alpha\\rea')).toBe('type C:\\Alpha\\readme.txt');
  });

  it('wraps a name with a space in double quotes, and finishes inside a quoted path', async () => {
    const session = await cmdTerminal();

    expect(cmdTab(session, 'cd "C:\\Program Files\\To')).toBe('cd "C:\\Program Files\\Tool Kit"');
  });

  it('offers directories only to cd', async () => {
    const session = await cmdTerminal();

    expect(cmdTab(session, 'cd C:\\Alpha\\n')).toBe('cd C:\\Alpha\\n');
    expect(cmdTab(session, 'type C:\\Alpha\\n')).toBe('type C:\\Alpha\\notes.');
  });

  it('still completes a command name at the first word — WITNESS', async () => {
    const session = await cmdTerminal();

    expect(cmdTab(session, 'ech')).toBe('echo ');
  });
});
