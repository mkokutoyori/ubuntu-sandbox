/*
 * cmd.exe est un langage : `if`, `for`, `goto`, `call`, `set /a`, `exit /b`,
 * les etiquettes, l'expansion retardee et les modificateurs `%~dp0` se
 * comportent comme sur Windows, a l'invite comme dans un fichier .bat.
 *
 * Mesure de depart, sur une machine Windows neuve : `for %i in (1 2 3) do @echo
 * %i`, `if exist a.txt echo yes`, `goto`, `title`... repondaient « 'for' is not
 * recognized as an internal or external command » ; `set /a Y=2+3` ne
 * calculait rien et `echo %Y%` restait litteral ; `%errorlevel%`, `%date%`,
 * `%time%`, `%random%` aussi ; `echo` seul rendait une ligne vide au lieu de
 * « ECHO is on. » ; un fichier .bat n'etait execute que par le sous-shell
 * `CmdSubShell`, par une boucle de lignes qui ne savait ni brancher ni
 * boucler et qui n'affichait jamais les commandes d'un script sans
 * `@echo off`.
 *
 * L'AUTORITE — l'aide integree de cmd (`if /?`, `for /?`, `set /?`, `goto /?`,
 * `call /?`, `setlocal /?`, `shift /?`, `exit /?`), dont les dispositions
 * sont reprises de la memoire : `if` avec `/i`, `not`, `==`, EQU NEQ LSS LEQ
 * GTR GEQ, `exist`, `defined`, `errorlevel`, `else` sur la ligne de la
 * parenthese fermante ; `for` avec /l /f /d /r, `delims`, `tokens`, `skip`,
 * `eol`, `usebackq` ; l'expansion des `%variables%` a la LECTURE de tout le
 * bloc entre parentheses, celle des `!variables!` a l'execution sous
 * `setlocal enabledelayedexpansion` ; `%~dp0` et les modificateurs de `for` ;
 * `set /a` avec les operateurs C, les affectations composees et les nombres
 * 0x / 0 ; une commande qui s'affiche precedee de l'invite tant que l'echo est
 * actif, avec une ligne vide devant. Aucune transcription de Windows n'est
 * atteignable d'ici : les textes d'erreur (« The system cannot find the batch
 * label specified - X ») sont ceux de la memoire d'un cmd reel.
 *
 * Ecrite a l'aveugle, sur `executeCmdCommand` (la machine), pour que
 * l'invite, SSH et le sous-shell passent par le meme interprete. 47 des 48 cas
 * tombent avant (git stash push -- src) ; le seul qui passe des deux cotes est
 * « une variable indefinie reste litterale a l'invite », que l'ancien
 * `expandEnvVars` tenait deja. Quatre corrections de MA propre sonde, ecrites
 * plutot qu'effacees : `for` imbrique rend la ligne de la boucle interne tant
 * que l'echo est actif (un `@` la tait), `1<<4` doit etre entre guillemets
 * comme sur un vrai cmd (`<` y est une redirection), `>nul` ne cache pas le
 * message d'erreur (stderr) de `dir` — il faut `>nul 2>&1` —, et `type` rend
 * le contenu avec son saut de ligne final.
 *
 * Trouve en chemin, et ferme : les redirections de cmd ne valaient que pour
 * `echo` — `dir > out.txt`, `type a > b`, `hostname > h.txt` ecrivaient le TEXTE
 * DES ARGUMENTS dans le fichier —, `2>nul` n'etait compris qu'en fin de ligne,
 * `<` n'existait pas, et `echo "a && b"` rendait `a && b` au lieu de
 * `"a && b"` : les guillemets font partie de ce que cmd imprime.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { CmdSubShell } from '@/terminal/subshells/CmdSubShell';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

async function lab(): Promise<WindowsPC> {
  const pc = new WindowsPC('windows-pc', 'WIN-BAT');
  pc.setCurrentUser('Administrator');
  const steps = [
    'mkdir C:\\lab', 'mkdir C:\\lab\\sub', 'echo one> C:\\lab\\a.txt', 'echo two> C:\\lab\\b.txt',
    'echo log> C:\\lab\\c.log', 'echo deep> C:\\lab\\sub\\d.txt', 'cd C:\\lab',
  ];
  for (const step of steps) await pc.executeCmdCommand(step);
  return pc;
}

const lines = (out: string): string[] => (out === '' ? [] : out.split('\n'));

function writeBatch(pc: WindowsPC, name: string, body: readonly string[]): void {
  pc.getFileSystem().createFile(`C:\\lab\\${name}`, body.join('\r\n') + '\r\n');
}

async function runBatch(body: readonly string[], args = ''): Promise<string[]> {
  const pc = await lab();
  writeBatch(pc, 't.bat', body);
  return lines(await pc.executeCmdCommand(`t.bat${args === '' ? '' : ` ${args}`}`));
}

async function typed(...commands: string[]): Promise<string[]> {
  const pc = await lab();
  let last = '';
  for (const command of commands) last = await pc.executeCmdCommand(command);
  return lines(last);
}

describe('for at the prompt', () => {
  it('walks a list separated by spaces, commas and semicolons', async () => {
    expect(await typed('for %i in (1 2 3) do @echo %i')).toEqual(['1', '2', '3']);
    expect(await typed('for %i in (a,b;c) do @echo %i')).toEqual(['a', 'b', 'c']);
  });

  it('counts with /l: start, step, end', async () => {
    expect(await typed('for /l %i in (1,1,3) do @echo n%i')).toEqual(['n1', 'n2', 'n3']);
    expect(await typed('for /l %i in (3,-1,1) do @echo %i')).toEqual(['3', '2', '1']);
    expect(await typed('for /l %i in (1,2,6) do @echo %i')).toEqual(['1', '3', '5']);
  });

  it('expands a wildcard against the files of the current directory', async () => {
    expect(await typed('for %f in (*.txt) do @echo %f')).toEqual(['a.txt', 'b.txt']);
  });

  it('lists only the directories with /d', async () => {
    expect(await typed('for /d %d in (*) do @echo %d')).toEqual(['sub']);
  });

  it('walks a tree with /r and prints full paths', async () => {
    expect(await typed('for /r C:\\lab %f in (*.txt) do @echo %f'))
      .toEqual(['C:\\lab\\a.txt', 'C:\\lab\\b.txt', 'C:\\lab\\sub\\d.txt']);
  });

  it('nests loops', async () => {
    expect(await typed('for %i in (1 2) do @for %j in (a b) do @echo %i%j')).toEqual(['1a', '1b', '2a', '2b']);
  });

  it('echoes each command with the prompt, preceded by a blank line, while echo is on', async () => {
    expect(await typed('for %i in (1 2) do echo %i'))
      .toEqual(['', 'C:\\lab>echo 1', '1', '', 'C:\\lab>echo 2', '2']);
  });

  it('applies the path modifiers of a for variable', async () => {
    expect(await typed('for %i in (C:\\lab\\a.txt) do @echo %~nxi %~dpi %~xi %~ni'))
      .toEqual(['a.txt C:\\lab\\ .txt a']);
  });

  it('keeps a redirection of the body inside the loop', async () => {
    const pc = await lab();
    await pc.executeCmdCommand('for %i in (a b c) do @echo %i>> out.txt');

    expect((await pc.executeCmdCommand('type out.txt')).replace(/\n$/, '')).toBe('a\nb\nc');
  });
});

describe('for /f', () => {
  it('splits a quoted string on delims and maps tokens to successive variables', async () => {
    expect(await typed('for /f "tokens=1,2 delims=," %a in ("x,y,z") do @echo %a-%b')).toEqual(['x-y']);
  });

  it('reads a file line by line and takes the first blank-separated token', async () => {
    const pc = await lab();
    pc.getFileSystem().createFile('C:\\lab\\data.txt', 'red 1\r\ngreen 2\r\nblue 3\r\n');

    expect(lines(await pc.executeCmdCommand('for /f %a in (data.txt) do @echo %a'))).toEqual(['red', 'green', 'blue']);
  });

  it('skips lines and keeps the rest with tokens=*', async () => {
    const pc = await lab();
    pc.getFileSystem().createFile('C:\\lab\\data.txt', 'head\r\nred 1\r\ngreen 2\r\n');

    expect(lines(await pc.executeCmdCommand('for /f "skip=1 tokens=*" %a in (data.txt) do @echo [%a]')))
      .toEqual(['[red 1]', '[green 2]']);
  });

  it('ignores lines that start with the eol character', async () => {
    const pc = await lab();
    pc.getFileSystem().createFile('C:\\lab\\data.txt', ';skipped\r\nkept\r\n');

    expect(lines(await pc.executeCmdCommand('for /f %a in (data.txt) do @echo %a'))).toEqual(['kept']);
  });

  it('reads a quoted file name under usebackq', async () => {
    const pc = await lab();
    pc.getFileSystem().createFile('C:\\lab\\my data.txt', 'solo\r\n');

    expect(lines(await pc.executeCmdCommand('for /f "usebackq" %a in ("my data.txt") do @echo %a'))).toEqual(['solo']);
  });

  it('runs a single-quoted command and loops over its output', async () => {
    expect(await typed("for /f \"tokens=1\" %a in ('echo hi there') do @echo %a")).toEqual(['hi']);
  });
});

describe('if', () => {
  it('tests the existence of a file, a directory and their absence', async () => {
    expect(await typed('if exist a.txt echo yes')).toEqual(['yes']);
    expect(await typed('if exist C:\\lab\\sub echo dir')).toEqual(['dir']);
    expect(await typed('if not exist zz.txt echo no')).toEqual(['no']);
    expect(await typed('if exist zz.txt echo SHOULD-NOT-PRINT')).toEqual([]);
  });

  it('takes the else branch of a parenthesised form', async () => {
    expect(await typed('if exist a.txt (echo y) else (echo n)')).toEqual(['y']);
    expect(await typed('if exist zz.txt (echo y) else (echo n)')).toEqual(['n']);
  });

  it('compares strings, with /i ignoring the case', async () => {
    expect(await typed('if "a"=="a" echo eq')).toEqual(['eq']);
    expect(await typed('if "a"=="A" echo SHOULD-NOT-PRINT')).toEqual([]);
    expect(await typed('if /i "a"=="A" echo ci')).toEqual(['ci']);
    expect(await typed('if "a"=="b" (echo x) else (echo y)')).toEqual(['y']);
  });

  it('compares numbers numerically and strings alphabetically', async () => {
    expect(await typed('if 10 GTR 9 echo gt')).toEqual(['gt']);
    expect(await typed('if 10 LSS 9 echo SHOULD-NOT-PRINT')).toEqual([]);
    expect(await typed('if 5 EQU 5 echo equ')).toEqual(['equ']);
    expect(await typed('if 5 NEQ 6 echo neq')).toEqual(['neq']);
    expect(await typed('if abc LSS abd echo str')).toEqual(['str']);
  });

  it('tests a variable with defined', async () => {
    expect(await typed('set X=1', 'if defined X echo d')).toEqual(['d']);
    expect(await typed('if not defined NOPE echo nd')).toEqual(['nd']);
  });

  it('tests errorlevel as "at least"', async () => {
    expect(await typed('dir C:\\nope', 'if errorlevel 1 echo failed')).toEqual(['failed']);
    expect(await typed('echo x', 'if errorlevel 1 echo SHOULD-NOT-PRINT')).toEqual([]);
  });
});

describe('set', () => {
  it('computes with set /a and keeps the result in the variable', async () => {
    const pc = await lab();
    await pc.executeCmdCommand('set /a x=2+3*4');

    expect(await pc.executeCmdCommand('echo %x%')).toBe('14');
  });

  it('prints the result of an expression at the prompt, not an assignment', async () => {
    expect(await typed('set /a 7/2')).toEqual(['3']);
  });

  it('supports compound assignment, grouping, shifts, bitwise operators and hexadecimal', async () => {
    const pc = await lab();
    await pc.executeCmdCommand('set /a x=5');
    await pc.executeCmdCommand('set /a x+=2');
    await pc.executeCmdCommand('set /a "y=(1+2)*3"');
    await pc.executeCmdCommand('set /a "z=1<<4"');
    await pc.executeCmdCommand('set /a h=0x10');
    await pc.executeCmdCommand('set /a m=7%3');

    expect(await pc.executeCmdCommand('echo %x% %y% %z% %h% %m%')).toBe('7 9 16 16 1');
  });

  it('sets a quoted value, removes a variable with an empty value, and ignores the case of the name', async () => {
    const pc = await lab();
    await pc.executeCmdCommand('set "Y=a b"');
    expect(await pc.executeCmdCommand('echo %y%')).toBe('a b');
    await pc.executeCmdCommand('set Y=');

    expect(await pc.executeCmdCommand('set Y')).toBe('Environment variable Y not defined');
  });

  it('leaves the variable and sets errorlevel 1 when set /p has no input', async () => {
    const pc = await lab();
    await pc.executeCmdCommand('set A=keep');
    await pc.executeCmdCommand('set /p A=Name: ');

    expect(await pc.executeCmdCommand('echo %A% %errorlevel%')).toBe('keep 1');
  });
});

describe('dynamic variables and expansion', () => {
  it('expands %errorlevel% to the last result', async () => {
    const pc = await lab();
    await pc.executeCmdCommand('echo ok');
    const ok = await pc.executeCmdCommand('echo %errorlevel%');
    await pc.executeCmdCommand('dir C:\\nope');

    expect(ok).toBe('0');
    expect(await pc.executeCmdCommand('echo %errorlevel%')).toBe('1');
  });

  it('expands %date%, %time% and %random%', async () => {
    const pc = await lab();

    expect(await pc.executeCmdCommand('echo %date%')).toMatch(/^[A-Z][a-z]{2} \d\d\/\d\d\/\d{4}$/);
    expect(await pc.executeCmdCommand('echo %time%')).toMatch(/^ ?\d{1,2}:\d\d:\d\d\.\d\d$/);
    const random = Number(await pc.executeCmdCommand('echo %random%'));
    expect(random).toBeGreaterThanOrEqual(0);
    expect(random).toBeLessThanOrEqual(32767);
  });

  it('substitutes and slices with %VAR:a=b% and %VAR:~n,m%', async () => {
    const pc = await lab();
    await pc.executeCmdCommand('set S=hello world');

    expect(await pc.executeCmdCommand('echo %S:world=there%')).toBe('hello there');
    expect(await pc.executeCmdCommand('echo %S:~6,3%')).toBe('wor');
    expect(await pc.executeCmdCommand('echo %S:~-5%')).toBe('world');
  });

  it('leaves an undefined variable literal at the prompt', async () => {
    expect(await typed('echo %NOPE%')).toEqual(['%NOPE%']);
  });

  it('answers ECHO is on. to a bare echo, and prints the text after echo.', async () => {
    expect(await typed('echo')).toEqual(['ECHO is on.']);
    expect(await typed('echo.hi')).toEqual(['hi']);
  });
});

describe('a batch file', () => {
  it('loops with goto and a counter', async () => {
    expect(await runBatch([
      '@echo off', 'set /a n=0', ':loop', 'set /a n+=1', 'if %n% LSS 4 goto loop', 'echo n=%n%',
    ])).toEqual(['n=4']);
  });

  it('stops at goto :eof', async () => {
    expect(await runBatch(['@echo off', 'echo first', 'goto :eof', 'echo SHOULD-NOT-PRINT'])).toEqual(['first']);
  });

  it('calls a label with arguments and comes back', async () => {
    expect(await runBatch([
      '@echo off', 'call :greet World', 'echo back', 'goto :eof', ':greet', 'echo Hello %1', 'exit /b 0',
    ])).toEqual(['Hello World', 'back']);
  });

  it('hands the exit code of exit /b to the caller', async () => {
    const pc = await lab();
    writeBatch(pc, 't.bat', ['@echo off', 'exit /b 3']);
    await pc.executeCmdCommand('t.bat');

    expect(await pc.executeCmdCommand('echo %errorlevel%')).toBe('3');
  });

  it('reads %1, %2, %* and shifts', async () => {
    expect(await runBatch(['@echo off', 'echo %1-%2-%*', 'shift', 'echo %1'], 'x y z')).toEqual(['x-y-x y z', 'y']);
  });

  it('knows its own place: %0 and %~dp0', async () => {
    expect(await runBatch(['@echo off', 'echo %~dp0', 'echo %~nx0'])).toEqual(['C:\\lab\\', 't.bat']);
  });

  it('confines a variable to setlocal and restores it at endlocal', async () => {
    expect(await runBatch([
      '@echo off', 'set V=outer', 'setlocal', 'set V=inner', 'echo %V%', 'endlocal', 'echo %V%',
    ])).toEqual(['inner', 'outer']);
  });

  it('reads %variables% when a whole block is read, and !variables! when each command runs', async () => {
    expect(await runBatch([
      '@echo off', 'setlocal enabledelayedexpansion', 'set a=1',
      'if 1==1 (', '  set a=2', '  echo !a! %a%', ')',
    ])).toEqual(['2 1']);
  });

  it('runs a multi-line if with else', async () => {
    expect(await runBatch([
      '@echo off', 'if exist a.txt (', '  echo present', ') else (', '  echo absent', ')',
      'if exist zz.txt (', '  echo present', ') else (', '  echo absent', ')',
    ])).toEqual(['present', 'absent']);
  });

  it('runs a multi-line for body', async () => {
    expect(await runBatch([
      '@echo off', 'for %%i in (1 2) do (', '  echo start %%i', '  echo end %%i', ')',
    ])).toEqual(['start 1', 'end 1', 'start 2', 'end 2']);
  });

  it('expands an undefined variable to nothing', async () => {
    expect(await runBatch(['@echo off', 'echo [%NOPE%]'])).toEqual(['[]']);
  });

  it('chains with && and || inside a block', async () => {
    expect(await runBatch(['@echo off', 'if 1==1 (echo a && echo b)', 'dir C:\\nope >nul 2>&1 || echo failed']))
      .toEqual(['a', 'b', 'failed']);
  });

  it('echoes every command with the prompt unless @echo off, a blank line before each', async () => {
    expect(await runBatch(['echo hello', 'echo world']))
      .toEqual(['', 'C:\\lab>echo hello', 'hello', '', 'C:\\lab>echo world', 'world']);
  });

  it('echoes nothing after @echo off, not even that line', async () => {
    expect(await runBatch(['@echo off', 'echo hello'])).toEqual(['hello']);
  });

  it('reports a missing label and stops', async () => {
    expect(await runBatch(['@echo off', 'goto nolabel', 'echo SHOULD-NOT-PRINT']))
      .toEqual(['The system cannot find the batch label specified - nolabel']);
  });

  it('is run through call, with or without the extension, from the prompt as from the sub-shell', async () => {
    const pc = await lab();
    writeBatch(pc, 't.bat', ['@echo off', 'echo ran']);
    const { subShell } = CmdSubShell.create(pc);

    expect(await pc.executeCmdCommand('call t.bat')).toBe('ran');
    expect(await pc.executeCmdCommand('t')).toBe('ran');
    expect((await subShell.processLine('t.bat')).output.join('\n')).toBe('ran');
  });

  it('skips REM and :: comments, and a label is not a command', async () => {
    expect(await runBatch(['@echo off', 'rem hidden', ':: hidden too', ':here', 'echo shown'])).toEqual(['shown']);
  });
});
