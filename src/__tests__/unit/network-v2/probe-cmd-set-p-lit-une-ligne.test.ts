/*
 * `set /p variable=invite` lit une ligne : au terminal, par l'invite de la
 * fenetre ; dans un script ou par SSH, sur l'entree standard du scenario.
 *
 * Mesure de depart : `set /p who=Who? ` rendait le code 1 sans rien demander
 * et sans toucher la variable — l'hote de l'interpreteur n'avait pas de
 * lecteur de ligne, et la session d'un terminal Windows n'en offrait pas au
 * peripherique. Une reponse vide, elle, SUPPRIMAIT la variable.
 *
 * L'AUTORITE — l'aide `set /?` de cmd : « The /P switch allows you to set the
 * value of a variable to a line of input entered by the user. Displays the
 * specified promptString before reading the line of input. The promptString
 * can be empty. » Une reponse vide laisse la variable inchangee et pose
 * ERRORLEVEL a 1 (comportement connu de cmd, que l'aide ne dit pas).
 * Ce qu'un cmd reel ecrit sur la sortie d'un `set /p` lu sur un tube — le
 * texte de l'invite, sans saut de ligne — le chemin du scenario l'ecrit AVEC
 * un saut de ligne : l'interpreteur compose sa sortie ligne par ligne. Au
 * terminal, c'est l'invite de la fenetre qui la montre, et la sortie ne la
 * repete pas.
 *
 * Ecrite a l'aveugle, sur trois chemins : le peripherique (entree standard du
 * scenario), le terminal graphique (cmd) et l'interpreteur de scripts.
 *
 * 7 des 10 cas tombent avant (git stash push -- src/network src/terminal
 * src/shell src/cmd). Les 3 qui passent des deux cotes passent par ABSENCE :
 * sans lecteur de ligne, « rien a lire », « reponse vide » et l'abandon par
 * Ctrl+C laissaient trivialement la variable intacte avec le code 1. Ils
 * gardent la garantie apres le correctif, ou une reponse vide supprimait la
 * variable.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { WindowsTerminalSession } from '@/terminal/sessions/WindowsTerminalSession';
import type { KeyEvent } from '@/terminal/sessions/TerminalSession';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

const key = (name: string): KeyEvent => ({ key: name, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false });
const settle = () => new Promise<void>(resolve => setTimeout(resolve, 60));

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

function machine(): WindowsPC {
  const pc = new WindowsPC('windows-pc', 'WIN-SP');
  pc.setCurrentUser('Administrator');
  return pc;
}

describe('on the scenario standard input', () => {
  it('reads the answer into the variable', async () => {
    const pc = machine();
    await pc.executeCommand('set /p who=Who? ', 'Bob');

    expect(await pc.executeCmdCommand('echo %who%')).toBe('Bob');
  });

  it('answers 0 when a line was read', async () => {
    const pc = machine();
    await pc.executeCommand('set /p who=Who? ', 'Bob');

    expect(await pc.executeCmdCommand('echo %errorlevel%')).toBe('0');
  });

  it('reads one line per set /p, in order', async () => {
    const pc = machine();
    await pc.executeCommand('set /p a=A? & set /p b=B?', 'one\ntwo');

    expect(await pc.executeCmdCommand('echo %a%-%b%')).toBe('one-two');
  });

  it('answers 1 and leaves the variable alone when nothing can be read', async () => {
    const pc = machine();
    await pc.executeCmdCommand('set who=Ann');
    await pc.executeCommand('set /p who=Who? ');

    expect(await pc.executeCmdCommand('echo %who% %errorlevel%')).toBe('Ann 1');
  });

  it('answers 1 and leaves the variable alone on an empty answer', async () => {
    const pc = machine();
    await pc.executeCmdCommand('set who=Ann');
    await pc.executeCommand('set /p who=Who? ', '');

    expect(await pc.executeCmdCommand('echo %who% %errorlevel%')).toBe('Ann 1');
  });
});

describe('in the graphical terminal', () => {
  async function terminal(): Promise<WindowsTerminalSession> {
    const pc = machine();
    pc.powerOn();
    const session = new WindowsTerminalSession('term-1', pc);
    await session.init?.();
    return session;
  }

  async function enter(session: WindowsTerminalSession, line: string): Promise<void> {
    session.setInput(line);
    session.handleKey(key('Enter'));
    await settle();
  }

  it('shows the prompt and waits for the answer', async () => {
    const session = await terminal();
    await enter(session, 'set /p "who=Who? "');

    expect(session.currentInputMode).toMatchObject({ type: 'interactive-text', promptText: 'Who? ' });
  });

  it('puts the typed line in the variable', async () => {
    const session = await terminal();
    await enter(session, 'set /p "who=Who? "');
    session.setInputBuf('Eve');
    session.handleKey(key('Enter'));
    await settle();
    await enter(session, 'echo %who%');

    expect(session.lines[session.lines.length - 1].text).toBe('Eve');
  });

  it('keeps the prompt and the answer on one line of the screen', async () => {
    const session = await terminal();
    await enter(session, 'set /p "who=Who? "');
    session.setInputBuf('Eve');
    session.handleKey(key('Enter'));
    await settle();
    const echoed = session.lines.filter(line => line.type === 'prompt').slice(-1)[0];

    expect(`${echoed.promptText}${echoed.text}`).toBe('Who? Eve');
  });

  it('is abandoned by Ctrl+C without touching the variable', async () => {
    const session = await terminal();
    await enter(session, 'set who=Ann');
    await enter(session, 'set /p "who=Who? "');
    session.handleKey({ ...key('c'), ctrlKey: true });
    await settle();
    await enter(session, 'echo %who%');

    expect(session.lines[session.lines.length - 1].text).toBe('Ann');
  });
});

describe('inside a script', () => {
  it('reads from the same stream and feeds if errorlevel', async () => {
    const pc = machine();
    pc.getFileSystem().createFile('C:\\ask.bat', '@echo off\r\nset /p who=Who? \r\nif errorlevel 1 (echo none) else (echo hello %who%)\r\n');

    expect(await pc.executeCommand('C:\\ask.bat', 'Zoe')).toBe('Who?\nhello Zoe');
    expect(await pc.executeCommand('C:\\ask.bat', '')).toBe('Who?\nnone');
  });
});
