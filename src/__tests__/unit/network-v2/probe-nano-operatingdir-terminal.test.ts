/*
 * Sonde de `-o` de nano dans le terminal local, dans l'executeur non interactif (celui que le SSH atteint quand le
 * lanceur renonce) et sur des liens symboliques.  Les labos de probe-nano-operatingdir.test.ts rejouent le moteur
 * seul contre un vrai nano 7.2 ; ici on mesure le cablage : le nom est resolu contre le repertoire d'operation
 * (relatif au repertoire courant s'il est relatif), un repertoire invalide imprime « Invalid operating directory: X »
 * sans ouvrir l'editeur ni avaler la suite d'une chaine, et un lien qui sort du repertoire est dehors (nano 7.2 :
 * get_full_path appelle realpath).
 *
 * Mesure avec `git stash push -- src/network src/terminal` : 6 des 8 premiers tests tombaient avant ; les deux qui
 * passent avant comme apres : « keeps an absolute file name as it was typed » (non-regression : un nom absolu
 * ignore le repertoire d'operation) et le TEMOIN sans `-o`.  Les trois tests de liens symboliques ont ete ecrits
 * apres coup (canonicalPath) ; sans lui les deux refus tombent (le lien est cru dedans) et le temoin du lien
 * interne passe.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxTerminalSession } from '@/terminal/sessions/LinuxTerminalSession';
import type { KeyEvent } from '@/terminal/sessions/TerminalSession';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { NanoEngine } from '@/network/devices/linux/editors/NanoEngine';
import { launchedFilePath, parseEditorLaunch } from '@/network/devices/linux/editors/editorLaunch';
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
  await pc.executeCommand('mkdir -p /tmp/jail');
  await pc.executeCommand('printf "inside\\n" > /tmp/jail/f.txt');
  await pc.executeCommand('printf "outside\\n" > /tmp/g.txt');
});

async function type(cmd: string): Promise<void> {
  session.setInput(cmd);
  session.handleKey(key('Enter'));
  await flush();
}

const output = (count: number): string => session.lines.slice(-count).map((l) => l.text).join('\n');

interface EditorMode { type: string; absolutePath: string; content: string; isNewFile: boolean }

describe('nano -o in the local terminal, one measured behaviour per test', () => {
  it('resolves the file name against the operating directory', async () => {
    await type('nano -o /tmp/jail f.txt');
    const mode = session.inputMode as unknown as EditorMode;
    expect(mode.type).toBe('editor');
    expect(mode.absolutePath).toBe('/tmp/jail/f.txt');
    expect(mode.content).toBe('inside\n');
  });

  it('resolves a relative operating directory against the working directory first', async () => {
    await type('cd /tmp');
    await type('nano -o jail f.txt');
    const mode = session.inputMode as unknown as EditorMode;
    expect(mode.absolutePath).toBe('/tmp/jail/f.txt');
  });

  it('keeps an absolute file name as it was typed', async () => {
    await type('nano -o /tmp/jail /tmp/g.txt');
    const mode = session.inputMode as unknown as EditorMode;
    expect(mode.absolutePath).toBe('/tmp/g.txt');
  });

  it('refuses a missing operating directory with nano\'s sentence and opens nothing', async () => {
    await type('nano -o /nonexistent f.txt');
    expect(session.inputMode.type).toBe('normal');
    expect(output(3)).toContain('Invalid operating directory: /nonexistent');
  });

  it('refuses a file given as the operating directory', async () => {
    await type('nano -o /tmp/g.txt f.txt');
    expect(session.inputMode.type).toBe('normal');
    expect(output(3)).toContain('Invalid operating directory: /tmp/g.txt');
  });

  it('a refused launch does not swallow the rest of the chain', async () => {
    await type('nano -o /nonexistent f.txt; echo after-the-editor');
    expect(session.inputMode.type).toBe('normal');
    const text = output(4);
    expect(text).toContain('Invalid operating directory: /nonexistent');
    expect(text).toContain('after-the-editor');
  });

  it('the non-interactive command says the same and fails', async () => {
    const out = await pc.executeCommand('nano -o /nonexistent f.txt');
    expect(out).toContain('Invalid operating directory: /nonexistent');
  });

  function engineFor(commandLine: string, displayName: string): NanoEngine {
    const launch = parseEditorLaunch(commandLine)!;
    const fs = new LinuxEditorFsContext(pc);
    const path = launchedFilePath(fs, launch);
    const engine = new NanoEngine(fs, path, fs.readFile(path) ?? '', fs.readFile(path) === null, false, undefined, false, {
      settings: launch.nano!.settings, start: null, displayName,
    });
    engine.resize(12, 100);
    return engine;
  }

  it('a symbolic link that leaves the operating directory is outside', async () => {
    await pc.executeCommand('ln -s /tmp/g.txt /tmp/jail/escape');
    const engine = engineFor('nano -o /tmp/jail escape', 'escape');
    expect(engine.statusMessage).toBe("[ Can't read file from outside of /tmp/jail/ ]");
    expect(engine.content).toBe('');
  });

  it('WITNESS: a symbolic link that stays inside the operating directory opens', async () => {
    await pc.executeCommand('ln -s /tmp/jail/f.txt /tmp/jail/inner');
    const engine = engineFor('nano -o /tmp/jail inner', 'inner');
    expect(engine.statusMessage).toBe('[ Read 1 line ]');
    expect(engine.content).toBe('inside');
  });

  it('writing through a link that leaves the operating directory is refused', async () => {
    await pc.executeCommand('ln -s /tmp/g.txt /tmp/jail/escape');
    const engine = engineFor('nano -o /tmp/jail f.txt', 'f.txt');
    engine.applyKey({ key: 'x', ctrl: false, shift: false, alt: false });
    engine.applyKey({ key: 'o', ctrl: true, shift: false, alt: false });
    engine.applyKey({ key: 'k', ctrl: true, shift: false, alt: false });
    for (const ch of 'escape') engine.applyKey({ key: ch, ctrl: false, shift: false, alt: false });
    engine.applyKey({ key: 'Enter', ctrl: false, shift: false, alt: false });
    engine.applyKey({ key: 'y', ctrl: false, shift: false, alt: false });
    engine.applyKey({ key: 'y', ctrl: false, shift: false, alt: false });
    expect(engine.statusMessage).toBe("[ Can't write outside of /tmp/jail/ ]");
    expect(await pc.executeCommand('cat /tmp/g.txt')).toBe('outside');
  });

  it('WITNESS: without -o the file name is relative to the working directory', async () => {
    await type('cd /tmp/jail');
    await type('nano f.txt');
    const mode = session.inputMode as unknown as EditorMode;
    expect(mode.absolutePath).toBe('/tmp/jail/f.txt');
    expect(mode.content).toBe('inside\n');
  });
});
