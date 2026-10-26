/*
 * Le paquet nano d'Ubuntu sur une vraie machine : `/etc/nanorc` et les fichiers de `/usr/share/nano` sont livres par l'image
 * (NanoPackageFiles.ts, exportes octet pour octet par scripts/oracle/export_nano_package.py), lus par nano a chaque lancement sans
 * aucun `~/.nanorc`, et colorent le texte.  nano-package-oracle.test.ts et probe-nano-package.test.ts rejouent le moteur seul contre
 * un vrai nano 7.2 qui lit ces memes fichiers ; ici on mesure le cablage machine.
 *
 * Mesure avec une image sans ces fichiers (le commit precedent) : 4 des 6 tests tombent (`/etc/nanorc` absent, dossier
 * `/usr/share/nano`, lien `debian.nanorc`, couleurs d'un fichier C sans rc).  Les deux qui passent avant comme apres sont des TEMOINS :
 * le texte sans motif reconnu n'est pas colore (syntaxe `default`, aucune regle ne s'applique) et un `~/.nanorc` qui definit sa propre
 * syntaxe gagne sur le paquet (la derniere definition l'emporte, et le rc est lu apres /etc/nanorc).
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
import { NANO_PACKAGE_FILES } from '@/network/devices/linux/editors/nano/NanoPackageFiles';

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
  await pc.executeCommand('printf "int x;\\n" > /tmp/t.c; printf "alpha beta\\n" > /tmp/t.txt');
});

async function type(cmd: string): Promise<void> {
  session.setInput(cmd);
  session.handleKey(key('Enter'));
  await flush();
}

interface EditorMode { type: string; absolutePath: string; nano?: NanoLaunch }
const opened = (): EditorMode => session.inputMode as unknown as EditorMode;

function engineOf(launch: NanoLaunch, path: string, content: string): NanoEngine {
  const fs = new LinuxEditorFsContext(pc, session.shell ?? undefined);
  const engine = new NanoEngine(fs, path, content, false, false, undefined, false, { settings: launch.settings, rc: launch.rc, menuFlags: launch.menuFlags });
  engine.resize(24, 80);
  return engine;
}

const paintsOfFirstTextRow = (engine: NanoEngine): string[] =>
  engine.screen.rows[1].spans.filter((span) => span.paint !== undefined).map((span) => `${span.from}-${span.to}:${paintKey(span.paint!)}`);

describe('the files of the nano package on a machine, one measured behaviour per test', () => {
  it('ships /etc/nanorc exactly as the package does', async () => {
    const shipped = NANO_PACKAGE_FILES.find((file) => file.path === '/etc/nanorc')!.content;
    expect((await pc.executeCommand('cat /etc/nanorc')).trimEnd()).toBe(shipped.trimEnd());
  });

  it('ships the syntax directory with its two sub-directories', async () => {
    expect((await pc.executeCommand('ls /usr/share/nano')).split(/\s+/)).toEqual(expect.arrayContaining(['c.nanorc', 'python.nanorc', 'sh.nanorc', 'extra', 'debian']));
    expect((await pc.executeCommand('ls /usr/share/nano/extra')).split(/\s+/)).toEqual(expect.arrayContaining(['ada.nanorc', 'spec.nanorc']));
  });

  it('ships debian.nanorc and haskell.nanorc as links, like the package', async () => {
    const listing = await pc.executeCommand('ls -l /usr/share/nano/debian.nanorc /usr/share/nano/haskell.nanorc');
    expect(listing).toContain('/usr/share/nano/debian.nanorc -> debian/debian.nanorc');
    expect(listing).toContain('/usr/share/nano/haskell.nanorc -> extra/haskell.nanorc');
  });

  it('colours a C file with no nanorc of the user', async () => {
    await type('nano /tmp/t.c');
    expect(paintsOfFirstTextRow(engineOf(opened().nano!, '/tmp/t.c', 'int x;\n'))).toEqual(['0-3:2/-/']);
  });

  it('WITNESS: a text file nothing in the package matches is not coloured', async () => {
    await type('nano /tmp/t.txt');
    expect(paintsOfFirstTextRow(engineOf(opened().nano!, '/tmp/t.txt', 'alpha beta\n'))).toEqual([]);
  });

  it('WITNESS: a syntax of ~/.nanorc defined after the package wins on the same extension', async () => {
    await pc.executeCommand(`printf 'syntax "mine" "\\\\.c$"\\ncolor red "x"\\n' > ~/.nanorc`);
    await type('nano /tmp/t.c');
    expect(paintsOfFirstTextRow(engineOf(opened().nano!, '/tmp/t.c', 'int x;\n'))).toEqual(['4-5:1/-/']);
  });
});
