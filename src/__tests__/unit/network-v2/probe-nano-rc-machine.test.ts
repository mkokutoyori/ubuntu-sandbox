/*
 * Les fichiers nanorc sur une vraie machine : le terminal local, l'executeur non interactif et la session SSH lisent
 * `/etc/nanorc` puis `~/.nanorc` DANS LE SYSTEME DE FICHIERS DE LA MACHINE, avec les droits et l'environnement de
 * l'utilisateur de la session.  nano-rc-oracle.test.ts et probe-nano-rc.test.ts rejouent le moteur seul contre un vrai
 * nano 7.2 (root, $HOME monte sur /root) ; ici on mesure le cablage.
 *
 * Mesure avec `git stash push -- src/network src/terminal src/components` : 6 des 7 tests tombent.  Celui qui passe avant
 * comme apres, « lets the command line beat the file, and -I ignore the files », est STRUCTUREL : avant, aucun fichier
 * n'etait lu, donc la ligne de commande l'emportait toujours et -I ne changeait rien.  Le TEMOIN « sans fichier nanorc,
 * les options gardent leur defaut » ne sert qu'apres : avant, le champ `rc` de la vue n'existait pas.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { LinuxTerminalSession } from '@/terminal/sessions/LinuxTerminalSession';
import type { KeyEvent } from '@/terminal/sessions/TerminalSession';
import type { NanoLaunch } from '@/network/devices/linux/editors/editorLaunch';
import { NanoEngine } from '@/network/devices/linux/editors/NanoEngine';
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
  await pc.executeCommand('printf "alpha\\nbeta\\n" > /tmp/t.txt');
});

async function type(cmd: string): Promise<void> {
  session.setInput(cmd);
  session.handleKey(key('Enter'));
  await flush();
}

interface EditorMode { type: string; absolutePath: string; nano?: NanoLaunch }
const opened = (): EditorMode => session.inputMode as unknown as EditorMode;
const asRoot = (command: string): Promise<string> => pc.executeCommand(`sudo bash -c '${command.replace(/'/g, "'\\''")}'`);

describe('nano rc files on a machine, one measured behaviour per test', () => {
  it('WITNESS: without any nanorc file the options stay at their defaults', async () => {
    await type('nano /tmp/t.txt');
    expect(opened().type).toBe('editor');
    expect(opened().nano!.settings.linenumbers).toBe(false);
    expect(opened().nano!.settings.tabsize).toBe(8);
    expect(opened().nano!.rc!.errors).toEqual([]);
  });

  it('reads ~/.nanorc of the user who typed the command', async () => {
    await pc.executeCommand('printf "set linenumbers\\nset tabsize 4\\n" > ~/.nanorc');
    await type('nano /tmp/t.txt');
    expect(opened().nano!.settings.linenumbers).toBe(true);
    expect(opened().nano!.settings.tabsize).toBe(4);
  });

  it('reads /etc/nanorc first and lets ~/.nanorc override it', async () => {
    await asRoot('printf "set linenumbers\\nset tabsize 3\\n" > /etc/nanorc');
    await pc.executeCommand('printf "unset linenumbers\\nset tabsize 5\\n" > ~/.nanorc');
    await type('nano /tmp/t.txt');
    expect(opened().nano!.settings.linenumbers).toBe(false);
    expect(opened().nano!.settings.tabsize).toBe(5);
  });

  it('lets the command line beat the file, and -I ignore the files', async () => {
    await pc.executeCommand('printf "set tabsize 4\\nunset linenumbers\\n" > ~/.nanorc');
    await type('nano -l -T 6 /tmp/t.txt');
    expect(opened().nano!.settings.tabsize).toBe(6);
    expect(opened().nano!.settings.linenumbers).toBe(true);
    session.editorExit(true);
    await type('nano -I /tmp/t.txt');
    expect(opened().nano!.settings.tabsize).toBe(8);
  });

  it('reports the mistakes of the file at the first screen and on exit', async () => {
    await pc.executeCommand('printf "set bogus\\nset linenumbers\\n" > ~/.nanorc');
    await type('nano /tmp/t.txt');
    const launch = opened().nano!;
    expect(launch.rc!.errors).toEqual(['Error in /home/user/.nanorc on line 1: Unknown option: bogus']);
    const fs = new LinuxEditorFsContext(pc, session.shell ?? undefined);
    const engine = new NanoEngine(fs, '/tmp/t.txt', 'alpha\nbeta\n', false, false, undefined, false, { settings: launch.settings, rc: launch.rc, menuFlags: launch.menuFlags });
    engine.resize(24, 80);
    expect(engine.statusMessage).toBe("[ Mistakes in '/home/user/.nanorc' ]");
    engine.applyKey({ key: 'x', ctrl: true });
    expect(engine.exitNotice).toBe('Error in /home/user/.nanorc on line 1: Unknown option: bogus\n');
  });

  it('refuses a missing -f file before any editor opens, in nano\'s words', async () => {
    await type('nano -f /tmp/nowhere.rc /tmp/t.txt');
    expect(session.inputMode.type).toBe('normal');
    expect(session.lines.slice(-3).map((l) => l.text).join('\n')).toContain('Specified rcfile does not exist');
  });

  it('answers the same on the non-interactive executor path', async () => {
    const out = await pc.executeCommand('nano -f /tmp/nowhere.rc /tmp/t.txt');
    expect(out).toContain('Specified rcfile does not exist');
  });
});
