/*
 * Les commandes internes de cmd qui manquaient — `cmd /c`, `pushd`/`popd`,
 * `path`, `title`, `pause`, `timeout`, `choice` — et un flux d'entree
 * standard pour les commandes qui en lisent : `<`, `|`, `(a & b) | sort`.
 *
 * Mesure de depart : `cmd /c echo hi`, `pushd`, `popd`, `path`, `title`,
 * `timeout`, `choice`, `pause` repondaient « is not recognized as an internal
 * or external command » ; `sort` n'existait pas comme filtre de pipe
 * (`type f | sort` rendait le texte tel quel) ; `sort < f`, `findstr x < f`,
 * `more < f` renvoyaient « The system cannot find the file specified » ; un
 * groupe `( … ) | cmd` n'etait pas lu ; `findstr`, `find` et leur filtre de pipe
 * etaient deux implementations (l'une lisait des fichiers, l'autre un texte)
 * et `grep` — qui n'est pas une commande Windows — etait servi comme filtre de
 * pipe. `pathping` n'existait que dans le terminal graphique : par SSH ou dans
 * un script, « is not recognized ».
 *
 * L'AUTORITE — l'aide integree de cmd (`pushd /?`, `popd /?`, `path /?`,
 * `timeout /?`, `choice /?`, `find /?`, `findstr /?`, `sort /?`, `more /?`) lue
 * de memoire : `pushd` empile le repertoire courant puis change, sans
 * argument il liste la pile ; `path` sans argument imprime `PATH=…`, `path ;`
 * le vide (« No Path set ») ; `timeout /t N [/nobreak]` attend N secondes ;
 * `choice` rend l'errorlevel de l'indice du choix, et le choix par defaut de
 * `/d` apres `/t` ; `cmd /c` execute puis rend la main, dans un environnement
 * enfant dont rien ne remonte. Aucune transcription n'est atteignable d'ici : les
 * phrases (« Waiting for N seconds, press a key to continue ... »,
 * « Press any key to continue . . . ») sont celles de la memoire d'un cmd reel.
 * `timeout` n'attend pas : la livraison des trames est synchrone et le temps
 * virtuel n'avance que par les minuteurs du simulateur.
 *
 * Ecrite a l'aveugle, sur `executeCmdCommand`. 24 des 26 cas tombent avant (git
 * stash push -- src). Les 2 qui passent des deux cotes : « keeps nothing of
 * the child » (avant, `cmd /c` n'existait pas : aucune variable n'etait posee
 * et le repertoire ne bougeait pas — l'absence de commande satisfait la
 * garantie sans la tenir ; apres, le temoin est le cas « runs a command »),
 * et « counts the lines of a listing » (`dir /b | find /c`, que l'ancien
 * filtre de pipe savait deja : non-regression du filtre unifie).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

async function lab(): Promise<WindowsPC> {
  const pc = new WindowsPC('windows-pc', 'WIN-INT');
  pc.setCurrentUser('Administrator');
  for (const step of ['mkdir C:\\lab', 'mkdir C:\\lab\\sub', 'cd C:\\lab', 'echo one> a.txt']) await pc.executeCmdCommand(step);
  pc.getFileSystem().createFile('C:\\lab\\fruit.txt', 'pear\r\napple\r\nfig\r\n');
  return pc;
}

const lines = (out: string): string[] => (out === '' ? [] : out.split('\n'));

async function typed(...commands: string[]): Promise<string[]> {
  const pc = await lab();
  let last = '';
  for (const command of commands) last = await pc.executeCmdCommand(command);
  return lines(last);
}

describe('cmd /c', () => {
  it('runs a command and hands back its output', async () => {
    expect(await typed('cmd /c echo hi')).toEqual(['hi']);
    expect(await typed('cmd /c "echo a && echo b"')).toEqual(['a', 'b']);
  });

  it('runs a loop', async () => {
    expect(await typed('cmd /c "for %i in (1 2) do @echo %i"')).toEqual(['1', '2']);
  });

  it('keeps nothing of the child: variables and the directory stay as they were', async () => {
    const pc = await lab();
    await pc.executeCmdCommand('cmd /c "set Q=1"');
    await pc.executeCmdCommand('cmd /c cd C:\\lab\\sub');

    expect(await pc.executeCmdCommand('echo %Q%')).toBe('%Q%');
    expect(await pc.executeCmdCommand('cd')).toBe('C:\\lab');
  });

  it('hands back the exit code of the child', async () => {
    const pc = await lab();
    await pc.executeCmdCommand('cmd /c exit 3');

    expect(await pc.executeCmdCommand('echo %errorlevel%')).toBe('3');
  });
});

describe('pushd and popd', () => {
  it('changes directory and comes back', async () => {
    const pc = await lab();
    await pc.executeCmdCommand('pushd C:\\lab\\sub');
    const inside = await pc.executeCmdCommand('cd');
    await pc.executeCmdCommand('popd');

    expect(inside).toBe('C:\\lab\\sub');
    expect(await pc.executeCmdCommand('cd')).toBe('C:\\lab');
  });

  it('lists the stack, the most recent first, when called without an argument', async () => {
    const pc = await lab();
    await pc.executeCmdCommand('pushd C:\\lab\\sub');
    await pc.executeCmdCommand('pushd C:\\');

    expect(lines(await pc.executeCmdCommand('pushd'))).toEqual(['C:\\lab\\sub', 'C:\\lab']);
  });

  it('refuses a missing directory and stays put', async () => {
    const pc = await lab();

    expect(await pc.executeCmdCommand('pushd C:\\nope')).toBe('The system cannot find the path specified.');
    expect(await pc.executeCmdCommand('cd')).toBe('C:\\lab');
  });

  it('does nothing on an empty stack', async () => {
    expect(await typed('popd')).toEqual([]);
    expect(await typed('popd', 'cd')).toEqual(['C:\\lab']);
  });
});

describe('path, title, pause', () => {
  it('prints the search path as PATH=…, and sets it', async () => {
    const pc = await lab();
    const shown = await pc.executeCmdCommand('path');
    await pc.executeCmdCommand('path C:\\lab;%PATH%');

    expect(shown.startsWith('PATH=')).toBe(true);
    expect(shown.length).toBeGreaterThan('PATH='.length);
    expect(await pc.executeCmdCommand('echo %PATH%')).toMatch(/^C:\\lab;/);
  });

  it('clears the search path with a lone semicolon', async () => {
    const pc = await lab();
    await pc.executeCmdCommand('path ;');

    expect(await pc.executeCmdCommand('path')).toBe('No Path set');
  });

  it('accepts a window title silently', async () => {
    expect(await typed('title Hello')).toEqual([]);
  });

  it('asks for a key, without waiting for one', async () => {
    expect(await typed('pause')).toEqual(['Press any key to continue . . .']);
  });
});

describe('timeout and choice', () => {
  it('announces the wait, with or without /nobreak', async () => {
    expect(await typed('timeout /t 1')).toEqual(['Waiting for 1 seconds, press a key to continue ...']);
    expect(await typed('timeout 2')).toEqual(['Waiting for 2 seconds, press a key to continue ...']);
    expect(await typed('timeout /t 3 /nobreak')).toEqual(['Waiting for 3 seconds, press CTRL+C to quit ...']);
  });

  it('refuses a duration that is not a number', async () => {
    expect((await typed('timeout /t abc'))[0]).toBe('ERROR: Invalid value for timeout specified. Valid range is -1 to 99999.');
  });

  it('takes the default choice after the delay and returns its index as errorlevel', async () => {
    const pc = await lab();

    expect(await pc.executeCmdCommand('choice /c yn /d y /t 1')).toBe('[Y,N]?Y');
    expect(await pc.executeCmdCommand('echo %errorlevel%')).toBe('1');
    expect(await pc.executeCmdCommand('choice /c yn /m "Go on" /d n /t 1')).toBe('Go on [Y,N]?N');
    expect(await pc.executeCmdCommand('echo %errorlevel%')).toBe('2');
  });
});

describe('a stream on standard input', () => {
  it('feeds sort through a pipe and through <', async () => {
    expect(await typed('type fruit.txt | sort')).toEqual(['apple', 'fig', 'pear']);
    expect(await typed('sort < fruit.txt')).toEqual(['apple', 'fig', 'pear']);
    expect(await typed('sort /r < fruit.txt')).toEqual(['pear', 'fig', 'apple']);
  });

  it('feeds findstr and find', async () => {
    expect(await typed('findstr p < fruit.txt')).toEqual(['pear', 'apple']);
    expect(await typed('type fruit.txt | findstr /i "FIG"')).toEqual(['fig']);
    expect(await typed('type fruit.txt | find "pea"')).toEqual(['pear']);
    expect(await typed('type fruit.txt | find /v "pear"')).toEqual(['apple', 'fig']);
    expect(await typed('type fruit.txt | find /c "p"')).toEqual(['2']);
  });

  it('feeds more', async () => {
    expect(await typed('more < fruit.txt')).toEqual(['pear', 'apple', 'fig']);
  });

  it('reads the output of a group on the left of a pipe', async () => {
    expect(await typed('(echo b & echo a) | sort')).toEqual(['a', 'b']);
  });

  it('chains several filters', async () => {
    expect(await typed('type fruit.txt | findstr p | sort')).toEqual(['apple', 'pear']);
  });

  it('counts the lines of a listing', async () => {
    expect(await typed('dir /b | find /c ".txt"')).toEqual(['2']);
  });

  it('keeps a pipe whose left side is a command with a redirection', async () => {
    const pc = await lab();
    await pc.executeCmdCommand('type fruit.txt | sort > sorted.txt');

    expect((await pc.executeCmdCommand('type sorted.txt')).replace(/\n$/, '')).toBe('apple\nfig\npear');
  });

  it('numbers lines with findstr /n and prefixes several files with their name', async () => {
    expect(await typed('findstr /n a fruit.txt')).toEqual(['1:pear', '2:apple']);
    expect(await typed('findstr one a.txt fruit.txt')).toEqual(['a.txt:one']);
  });

  it('keeps the literal phrase of findstr /c:', async () => {
    expect(await typed('findstr /c:"ap" fruit.txt')).toEqual(['apple']);
  });

  it('does not serve grep, which is not a Windows command', async () => {
    expect((await typed('type fruit.txt | grep p'))[0]).toContain("'grep' is not recognized as an internal or external command");
  });
});

describe('pathping where there is no graphical terminal', () => {
  it('answers by executeCommand as it does in the terminal', async () => {
    const pc = await lab();
    const out = await pc.executeCommand('pathping -n -h 2 -q 1 -p 50 127.0.0.1');

    expect(out).toContain('Tracing route to');
    expect(out).toContain('Trace complete.');
  });
});
