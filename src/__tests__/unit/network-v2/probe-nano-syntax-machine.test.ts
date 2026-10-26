/*
 * La coloration syntaxique de nano sur une vraie machine : `/etc/nanorc` et `~/.nanorc` sont lus dans le systeme de fichiers de la
 * machine avec l'utilisateur de la session, la syntaxe est choisie sur le chemin COMPLET du fichier ouvert (le repertoire de travail
 * de la session compte) et un `include` lit les fichiers de la machine.  nano-syntax-oracle.test.ts et probe-nano-syntax.test.ts
 * rejouent le moteur seul contre un vrai nano 7.2 ; ici on mesure le cablage.
 *
 * Mesure avec un moteur qui lit les syntaxes sans les evaluer (le commit precedent) : 5 des 6 tests tombent (couleurs de
 * ~/.nanorc, /etc/nanorc, include, chemin relatif resolu par le repertoire de travail, erreur d'extendsyntax).  Seul passe avant
 * comme apres le TEMOIN « sans nanorc aucune rangee n'est coloree ».
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { LinuxTerminalSession } from '@/terminal/sessions/LinuxTerminalSession';
import type { KeyEvent } from '@/terminal/sessions/TerminalSession';
import type { NanoLaunch } from '@/network/devices/linux/editors/editorLaunch';
import { NanoEngine } from '@/network/devices/linux/editors/NanoEngine';
import { LinuxEditorFsContext } from '@/terminal/sessions/LinuxEditorFsContext';
import { paintKey } from '@/network/devices/linux/editors/screen/EditorScreen';

function key(k: string): KeyEvent {
  return { key: k, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false };
}
const flush = () => new Promise<void>((r) => setTimeout(r, 5));

let pc: LinuxPC;
let session: LinuxTerminalSession;
beforeEach(async () => {
  EquipmentRegistry.resetInstance();
  pc = new LinuxPC('linux-pc', 'PC1', 0, 0);
  pc.powerOn();
  session = new LinuxTerminalSession('term-1', pc);
  await pc.executeCommand('printf "alpha beta\\nalpha\\n" > /tmp/t.txt');
});

async function type(cmd: string): Promise<void> {
  session.setInput(cmd);
  session.handleKey(key('Enter'));
  await flush();
}

interface EditorMode { type: string; absolutePath: string; nano?: NanoLaunch }
const opened = (): EditorMode => session.inputMode as unknown as EditorMode;

function engineOf(launch: NanoLaunch, path = '/tmp/t.txt'): NanoEngine {
  const fs = new LinuxEditorFsContext(pc, session.shell ?? undefined);
  const engine = new NanoEngine(fs, path, 'alpha beta\nalpha\n', false, false, undefined, false, { settings: launch.settings, rc: launch.rc, menuFlags: launch.menuFlags });
  engine.resize(24, 80);
  return engine;
}

const paintsOfFirstTextRow = (engine: NanoEngine): string[] =>
  engine.screen.rows[1].spans.filter((span) => span.paint !== undefined).map((span) => `${span.from}-${span.to}:${paintKey(span.paint!)}`);

describe('nano syntax colouring on a machine, one measured behaviour per test', () => {
  it('WITNESS: without a nanorc no cell of the text is coloured', async () => {
    await type('nano /tmp/t.txt');
    expect(paintsOfFirstTextRow(engineOf(opened().nano!))).toEqual([]);
  });

  it('colours the text with the syntax of ~/.nanorc chosen by the extension', async () => {
    await pc.executeCommand(`printf 'syntax "t" "\\\\.txt$"\\ncolor red "alpha"\\n' > ~/.nanorc`);
    await type('nano /tmp/t.txt');
    expect(paintsOfFirstTextRow(engineOf(opened().nano!))).toEqual(['0-5:1/-/']);
  });

  it('reads the syntaxes of /etc/nanorc when the user has no file of their own', async () => {
    await pc.executeCommand(`sudo bash -c 'printf "syntax \\"t\\" \\"\\\\\\\\.txt\\$\\"\\ncolor green \\"beta\\"\\n" > /etc/nanorc'`);
    await type('nano /tmp/t.txt');
    expect(paintsOfFirstTextRow(engineOf(opened().nano!))).toEqual(['6-10:2/-/']);
  });

  it('follows an include of ~/.nanorc into the machine file system', async () => {
    await pc.executeCommand(`printf 'syntax "i" "\\\\.txt$"\\ncolor blue "alpha"\\n' > ~/more.nanorc`);
    await pc.executeCommand(`printf 'include "~/more.nanorc"\\n' > ~/.nanorc`);
    await type('nano /tmp/t.txt');
    expect(paintsOfFirstTextRow(engineOf(opened().nano!))).toEqual(['0-5:4/-/']);
  });

  it('chooses the syntax on the full path of a file typed relative to the working directory', async () => {
    await pc.executeCommand(`printf 'syntax "tmp" "^/tmp/.*\\\\.txt$"\\ncolor red "alpha"\\n' > ~/.nanorc`);
    await type('cd /tmp');
    await type('nano t.txt');
    expect(paintsOfFirstTextRow(engineOf(opened().nano!, 't.txt'))).toEqual(['0-5:1/-/']);
  });

  it('reports the syntax a rc extends when it does not exist, like nano', async () => {
    await pc.executeCommand(`printf 'extendsyntax nosuch color red "alpha"\\n' > ~/.nanorc`);
    await type('nano /tmp/t.txt');
    expect(opened().nano!.rc!.errors).toEqual(['Error in /home/user/.nanorc on line 1: Could not find syntax "nosuch" to extend']);
  });
});
