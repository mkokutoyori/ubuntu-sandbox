/*
 * Le correcteur orthographique de nano (`-s PROGRAMME`, `set speller`) sur une vraie machine : le programme est lance PAR LA MACHINE, sur un
 * fichier temporaire `nano.XXXXXX` qui ne contient que la selection quand la marque est posee, puis supprime.  probe-nano-spell.test.ts
 * rejoue le moteur seul contre un vrai nano 7.2 ; ici on mesure le cablage (ligne de commande du terminal, ~/.nanorc, systeme de fichiers).
 *
 * Mesure avec le commit precedent (`speller` rangee dans les reglages et jamais lancee, ligne de lancement coupee aux espaces) : 4 des 5
 * tests tombent.  Avec le moteur mais l'ancien decoupage : 3 des 5 tombent (`-s "sed -i s/a/A/g"` arrivait comme `"sed`, deux tests, et
 * `nano "/tmp/my file.txt"` ouvrait `"/tmp/my`) ; le reglage de ~/.nanorc passe des que le moteur lance le programme, parce que l'analyseur
 * de nanorc lit deja les guillemets.  Le TEMOIN « sans programme, le correcteur interne repond « Error invoking "spell" » » passe dans
 * tous les etats : ni hunspell ni spell ne sont dans la machine.
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
  await pc.executeCommand(`printf 'alpha beta\\ngamma delta\\n' > /tmp/t.txt`);
});

async function type(cmd: string): Promise<void> {
  session.setInput(cmd);
  session.handleKey(key('Enter'));
  await flush();
}

interface EditorMode { type: string; absolutePath: string; nano?: NanoLaunch }
const opened = (): EditorMode => session.inputMode as unknown as EditorMode;

function engineOf(): NanoEngine {
  const launch = opened().nano!;
  const fs = new LinuxEditorFsContext(pc, session.shell ?? undefined);
  const engine = new NanoEngine(fs, '/tmp/t.txt', 'alpha beta\ngamma delta\n', false, false, undefined, false, { settings: launch.settings, rc: launch.rc, menuFlags: launch.menuFlags });
  engine.resize(14, 70);
  return engine;
}

const ctrl = (engine: NanoEngine, letters: string): void => {
  for (const letter of letters) engine.applyKey(editorKey(letter, { ctrl: true }));
};
const footerText = (engine: NanoEngine): string => engine.screen.rows[engine.screen.rows.length - 3].text.trim();
const leftovers = async (): Promise<string[]> => (await pc.executeCommand('ls /tmp')).split(/\s+/).filter((name) => name.startsWith('nano.'));

describe('the alternative spell checker runs on the machine, one measured behaviour per test', () => {
  it('WITNESS: without a program the internal checker answers that "spell" cannot be run', async () => {
    await type('nano /tmp/t.txt');
    const engine = engineOf();
    ctrl(engine, 'ts');
    expect(footerText(engine)).toBe('[ Error invoking "spell" ]');
  });

  it('runs the program of -s on the buffer through a temporary file removed afterwards', async () => {
    await type('nano -s "sed -i s/a/A/g" /tmp/t.txt');
    const engine = engineOf();
    ctrl(engine, 'ts');
    expect(engine.lines).toEqual(['AlphA betA', 'gAmmA deltA']);
    expect(footerText(engine)).toBe('[ Finished checking spelling ]');
    expect(await leftovers()).toEqual([]);
  });

  it('runs the program of "set speller" in ~/.nanorc', async () => {
    await pc.executeCommand(`printf 'set speller "sed -i s/a/A/g"\\n' > ~/.nanorc`);
    await type('nano /tmp/t.txt');
    const engine = engineOf();
    ctrl(engine, 'ts');
    expect(engine.lines).toEqual(['AlphA betA', 'gAmmA deltA']);
  });

  it('hands the program only the selection when the mark is on', async () => {
    await type('nano -s "sed -i s/a/A/g" /tmp/t.txt');
    const engine = engineOf();
    engine.applyKey(editorKey('a', { alt: true }));
    engine.applyKey(editorKey('End'));
    ctrl(engine, 'ts');
    expect(engine.lines).toEqual(['AlphA betA', 'gamma delta']);
  });

  it('reads a quoted file name as one word, as the shell does', async () => {
    await pc.executeCommand(`printf 'one\\n' > "/tmp/my file.txt"`);
    await type('nano "/tmp/my file.txt"');
    expect(opened().absolutePath).toBe('/tmp/my file.txt');
  });
});
