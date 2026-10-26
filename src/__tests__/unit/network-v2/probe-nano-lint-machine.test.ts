/*
 * Le linter et le formateur des syntaxes de nano sur une vraie machine : la commande declaree par `linter` / `formatter` (celle du
 * paquet Ubuntu ou celle d'un `~/.nanorc`) est lancee PAR LA MACHINE, avec son shell, son repertoire courant et son systeme de fichiers ;
 * le fichier temporaire du formateur est cree, passe en dernier argument, puis supprime.  nano-lint-oracle (probe-nano-lint.test.ts)
 * rejoue le moteur seul contre un vrai nano 7.2 ; ici on mesure le cablage.
 *
 * Mesure avec le commit precedent (^Y et ^O repondaient toujours « No ... is defined ») : 4 des 6 tests tombent (pyflakes absent de la
 * machine, linter d'un rc, formateur d'un rc, gofmt absent de la machine).  Les deux qui passent avant comme apres sont des TEMOINS :
 * le texte sans linter, et l'absence de fichier `nano.*` dans /tmp apres un formateur absent.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { LinuxTerminalSession } from '@/terminal/sessions/LinuxTerminalSession';
import type { KeyEvent } from '@/terminal/sessions/TerminalSession';
import type { NanoLaunch } from '@/network/devices/linux/editors/editorLaunch';
import { NanoEngine } from '@/network/devices/linux/editors/NanoEngine';
import { editorKey } from '@/network/devices/linux/editors/EditorKeyInput';
import { LinuxEditorFsContext } from '@/terminal/sessions/LinuxEditorFsContext';

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
});

async function type(cmd: string): Promise<void> {
  session.setInput(cmd);
  session.handleKey(key('Enter'));
  await flush();
}

interface EditorMode { type: string; absolutePath: string; nano?: NanoLaunch }
const opened = (): EditorMode => session.inputMode as unknown as EditorMode;

async function open(path: string, text: string): Promise<NanoEngine> {
  await pc.executeCommand(`printf '${text}' > ${path}`);
  await type(`nano ${path}`);
  const launch = opened().nano!;
  const fs = new LinuxEditorFsContext(pc, session.shell ?? undefined);
  const engine = new NanoEngine(fs, path, `${text.replaceAll('\\n', '\n')}`, false, false, undefined, false, { settings: launch.settings, rc: launch.rc, menuFlags: launch.menuFlags });
  engine.resize(14, 70);
  return engine;
}

const ctrl = (engine: NanoEngine, letters: string): void => {
  for (const letter of letters) engine.applyKey(editorKey(letter, { ctrl: true }));
};
const footerText = (engine: NanoEngine): string => engine.screen.rows[engine.screen.rows.length - 3].text.trim();

describe('the linter and the formatter of the syntaxes run on the machine, one measured behaviour per test', () => {
  it('WITNESS: a text file without linter answers that none is defined', async () => {
    const engine = await open('/tmp/t.txt', 'alpha\\n');
    ctrl(engine, 'ty');
    expect(footerText(engine)).toBe('[ No linter is defined for this type of file ]');
  });

  it('runs the linter of the Ubuntu syntax: pyflakes is not on the machine', async () => {
    const engine = await open('/tmp/t.py', 'import os\\n');
    ctrl(engine, 'ty');
    expect(footerText(engine)).toBe("[ Error invoking 'pyflakes' ]");
  });

  it('shows the messages of a linter declared in ~/.nanorc and puts the cursor where they point', async () => {
    await pc.executeCommand(`printf 'syntax "t" "\\\\.txt$"\\nlinter grep -Hn TODO\\ncolor red "ZZZ"\\n' > ~/.nanorc`);
    const engine = await open('/tmp/t.txt', 'alpha\\nTODO one\\nbeta\\nTODO two\\n');
    await pc.executeCommand('cd /tmp');
    ctrl(engine, 'ty');
    expect(engine.screen.rows[0].text.trim()).toBe('Linting -- /tmp/t.txt');
    expect(footerText(engine)).toBe('[ one ]');
    expect(engine.cursorLine).toBe(1);
  });

  it('formats the buffer with a formatter declared in ~/.nanorc, through a temporary file removed afterwards', async () => {
    await pc.executeCommand(`printf 'syntax "t" "\\\\.txt$"\\nformatter sed -i s/a/A/g\\ncolor red "ZZZ"\\n' > ~/.nanorc`);
    const engine = await open('/tmp/t.txt', 'alpha\\nbeta\\n');
    ctrl(engine, 'to');
    expect(engine.lines).toEqual(['AlphA', 'betA']);
    expect(footerText(engine)).toBe('[ Buffer has been processed ]');
    expect((await pc.executeCommand('ls /tmp')).split(/\s+/).filter((name) => name.startsWith('nano.'))).toEqual([]);
  });

  it('runs the formatter of the Ubuntu syntax: gofmt is not on the machine', async () => {
    const engine = await open('/tmp/t.go', 'package main\\n');
    ctrl(engine, 'to');
    expect(footerText(engine)).toBe("[ Error invoking 'gofmt' ]");
  });

  it('WITNESS: a formatter that cannot be run leaves no temporary file behind', async () => {
    const engine = await open('/tmp/t.go', 'package main\\n');
    ctrl(engine, 'to');
    expect((await pc.executeCommand('ls /tmp')).split(/\s+/).filter((name) => name.startsWith('nano.'))).toEqual([]);
  });
});
