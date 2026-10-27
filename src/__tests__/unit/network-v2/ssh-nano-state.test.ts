/**
 * `nano -H -P` ouvert par SSH : le tampon, le journal et les droits sont ceux de la machine distante et de l'utilisateur
 * de la session (alice), jamais ceux du poste qui tient le clavier ; le texte que nano ecrit sur le terminal a la sortie
 * (« Unable to create directory ... ») voyage dans la derniere vue poussee par le serveur et la session le rend au
 * client.  Les memes regles que probe-nano-state.test.ts rejoue contre un vrai nano 7.2, ici sur le fil.
 *
 * Mesure avec `git stash push -- src/network src/terminal` : les trois tests tombent (le serveur ignorait -H et -P et la
 * vue n'avait pas d'`exitNotice`).  Aucun TEMOIN dans ce fichier : le TEMOIN de « l'editeur s'ouvre de l'autre cote du
 * fil » est dans ssh-nano-screen-geometry.test.ts.
 */
import { describe, it, expect } from 'vitest';
import type { NanoEditorView } from '@/network/devices/linux/editors/EditorView';
import { resetSshShellLab, wireShellChannel } from './_helpers/sshShellChannelLab';

resetSshShellLab();

const press = (key: string, ctrl = false) => ({ key, ctrl });

const outputOf = async (channel: { runLine(line: string): Promise<unknown> }, line: string): Promise<string> => ((await channel.runLine(line)) as { stdout: string }).stdout;

async function typeInto(channel: { sendEditorKey(k: { key: string; ctrl?: boolean }): Promise<unknown> }, ...keys: Array<{ key: string; ctrl?: boolean }>): Promise<NanoEditorView> {
  let view: unknown = null;
  for (const k of keys) view = await channel.sendEditorKey(k);
  return view as NanoEditorView;
}

describe('nano -H -P over SSH', () => {
  it('writes the logs on the remote machine, in the session user\'s home, with private modes', async () => {
    const { channel } = await wireShellChannel();
    await channel.runLine(`printf 'one\\ntwo\\nthree\\n' > /tmp/s1.txt`);
    await channel.openEditor('nano -H -P /tmp/s1.txt');
    const view = await typeInto(channel, press('w', true), press('t'), press('w'), press('o'), press('Enter'), press('ArrowDown'), press('x', true));
    expect(view.exited).toBe(true);
    const listing = await outputOf(channel, 'ls -la ~/.local/share/nano');
    expect(listing).toMatch(/^-rw------- .* alice .* filepos_history$/m);
    expect(listing).toMatch(/^-rw------- .* alice .* search_history$/m);
    expect((await outputOf(channel, 'cat ~/.local/share/nano/filepos_history')).trimEnd()).toBe('/tmp/s1.txt 3 1');
    expect(await outputOf(channel, 'cat ~/.local/share/nano/search_history')).toBe('two\n\n\n');
  }, 30000);

  it('restores the cursor from the remote log in the next session', async () => {
    const { channel } = await wireShellChannel();
    await channel.runLine(`printf 'one\\ntwo\\nthree\\n' > /tmp/s2.txt`);
    await channel.openEditor('nano -P /tmp/s2.txt');
    await typeInto(channel, press('ArrowDown'), press('ArrowDown'), press('ArrowRight'), press('x', true));
    const view = await channel.openEditor('nano -P /tmp/s2.txt') as NanoEditorView;
    expect(view.cursorLine).toBe(2);
    expect(view.cursorCol).toBe(1);
  }, 30000);

  it('carries the exit notice in the last view when the state directory cannot be made', async () => {
    const { channel } = await wireShellChannel();
    await channel.runLine(`printf 'one\\n' > /tmp/s3.txt`);
    await channel.runLine('mkdir -p ~/.local/share && printf x > ~/.local/share/nano');
    const opened = await channel.openEditor('nano -H /tmp/s3.txt') as NanoEditorView;
    expect(opened.statusMessage).toBe('[ Problems with history file ]');
    const view = await typeInto(channel, press('x', true));
    expect(view.exited).toBe(true);
    expect(view.exitNotice).toMatch(/^Unable to create directory \/home\/alice\/\.local\/share\/nano\/: .*\nIt is required for saving\/loading search history or cursor positions\.\n\n$/);
  }, 30000);
});
