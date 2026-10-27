/**
 * `~/.nanorc` d'un nano ouvert par SSH : le serveur lit les fichiers de SA machine, avec l'utilisateur de la session
 * (alice), et ouvre l'editeur avec les options obtenues ; les erreurs du fichier voyagent dans la vue (alerte au
 * demarrage, texte de sortie).  Memes regles que probe-nano-rc.test.ts, ici sur le fil.
 *
 * Mesure avec `git stash push -- src/network src/terminal` : les trois tests tombent (le serveur ne lisait aucun
 * fichier nanorc).  Le TEMOIN de « l'editeur s'ouvre de l'autre cote du fil » est dans ssh-nano-screen-geometry.test.ts.
 */
import { describe, it, expect } from 'vitest';
import type { NanoEditorView } from '@/network/devices/linux/editors/EditorView';
import { plainRowText } from '@/network/devices/linux/editors/screen/EditorScreen';
import { resetSshShellLab, wireShellChannel } from './_helpers/sshShellChannelLab';

resetSshShellLab();

const row = (view: NanoEditorView, index: number): string => plainRowText(view.screen.rows[index]).trimEnd();

describe('nano rc files over SSH', () => {
  it('shows the line numbers a remote ~/.nanorc asks for', async () => {
    const { channel } = await wireShellChannel();
    await channel.runLine(`printf 'one\\ntwo\\n' > /tmp/r1.txt`);
    await channel.runLine(`printf 'set linenumbers\\n' > ~/.nanorc`);
    const view = await channel.openEditor('nano /tmp/r1.txt') as NanoEditorView;
    expect(row(view, 1)).toBe(' 1 one');
  }, 30000);

  it('carries the mistakes of the file in the first screen and the last view', async () => {
    const { channel } = await wireShellChannel();
    await channel.runLine(`printf 'one\\n' > /tmp/r2.txt`);
    await channel.runLine(`printf 'set bogus\\n' > ~/.nanorc`);
    const opened = await channel.openEditor('nano /tmp/r2.txt') as NanoEditorView;
    expect(opened.statusMessage).toBe("[ Mistakes in '/home/alice/.nanorc' ]");
    const view = await channel.sendEditorKey({ key: 'x', ctrl: true }) as NanoEditorView;
    expect(view.exited).toBe(true);
    expect(view.exitNotice).toBe('Error in /home/alice/.nanorc on line 1: Unknown option: bogus\n');
  }, 30000);

  it('does not open an editor for a missing -f file, and the shell says why', async () => {
    const { channel } = await wireShellChannel();
    await channel.runLine(`printf 'one\\n' > /tmp/r3.txt`);
    const opened = await channel.openEditor('nano -f /tmp/nowhere.rc /tmp/r3.txt');
    expect(opened).toBeNull();
    const result = await channel.runLine('nano -f /tmp/nowhere.rc /tmp/r3.txt') as { stdout: string };
    expect(result.stdout).toContain('Specified rcfile does not exist');
  }, 30000);
});
