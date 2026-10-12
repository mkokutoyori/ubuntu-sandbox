/**
 * Le meme ecran de vim par SSH qu'en local, a la taille du terminal : le serveur recoit la
 * geometrie par `pty-req` puis `window-change` (RFC 4254 §6.2 et §6.7), ouvre l'editeur a cette
 * taille, le redimensionne quand elle change et pousse l'ecran recalcule sans attendre une
 * touche.  Les cas lisent `view.screen` (rangees, cellule du curseur, regle) renvoye par le fil.
 *
 * Mesure avec `git stash push -u -- src/network src/terminal` : le fichier ne se charge meme pas
 * (EditorScreen n'existe pas), donc les 9 cas tombent avant.  Le TEMOIN est le premier cas, le
 * meme pas de lab que « vim opens a buffer on the remote file » de ssh-wire-editor.test.ts, qui
 * passe avant comme apres : l'editeur s'ouvre bien de l'autre cote du fil.
 */
import { describe, it, expect } from 'vitest';
import type { VimEditorView } from '@/network/devices/linux/editors/EditorView';
import { plainRowText } from '@/network/devices/linux/editors/screen/EditorScreen';
import { VimEngine } from '@/network/devices/linux/editors/VimEngine';
import { InMemoryEditorFsContext } from '@/network/devices/linux/editors/InMemoryEditorFsContext';
import { editorKey } from '@/network/devices/linux/editors/EditorKeyInput';
import { resetSshShellLab, wireShellChannel } from './_helpers/sshShellChannelLab';

resetSshShellLab();

const hundred = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join('\n');

async function pushed(channel: { onEditorView(h: (v: unknown) => void): () => void }, action: () => void): Promise<VimEditorView> {
  return new Promise<VimEditorView>((resolve) => {
    const off = channel.onEditorView((view) => { off(); resolve(view as VimEditorView); });
    action();
  });
}

describe('vim over SSH: the screen follows the terminal geometry', () => {
  it('TEMOIN : the buffer opens on the server and carries its lines', async () => {
    const { channel } = await wireShellChannel();
    await channel.runLine(`printf 'one\\ntwo\\n' > /tmp/g0.txt`);
    const view = await channel.openEditor('vim /tmp/g0.txt') as VimEditorView;
    expect(view.lines).toEqual(['one', 'two']);
  }, 30000);

  it('opens at the 24x80 of the pty-req: 23 text rows and the command line', async () => {
    const { channel } = await wireShellChannel();
    await channel.runLine(`printf 'one\\ntwo\\n' > /tmp/g1.txt`);
    const view = await channel.openEditor('vim /tmp/g1.txt') as VimEditorView;
    expect(view.screen.rows.length).toBe(24);
    expect(plainRowText(view.screen.rows[0])).toBe('one');
    expect(view.screen.rows[2].text).toBe('~');
  }, 30000);

  it('opens at the size of a window-change sent before the editor', async () => {
    const { channel } = await wireShellChannel();
    await channel.runLine(`printf 'one\\n' > /tmp/g2.txt`);
    channel.resize(100, 30);
    await channel.runLine('true');
    const view = await channel.openEditor('vim /tmp/g2.txt') as VimEditorView;
    expect(view.screen.rows.length).toBe(30);
  }, 30000);

  it('a window-change while the editor is open pushes the reflowed screen', async () => {
    const { channel } = await wireShellChannel();
    await channel.runLine(`printf 'one\\ntwo\\n' > /tmp/g3.txt`);
    await channel.openEditor('vim /tmp/g3.txt');
    const view = await pushed(channel, () => channel.resize(60, 10));
    expect(view.screen.rows.length).toBe(10);
    expect(view.screen.rows.filter((r) => r.text === '~').length).toBe(7);
  }, 30000);

  it('reflows a wrapped line when the terminal gets narrower', async () => {
    const { channel } = await wireShellChannel();
    await channel.runLine(`printf '${'x'.repeat(100)}\\n' > /tmp/g4.txt`);
    const opened = await channel.openEditor('vim /tmp/g4.txt') as VimEditorView;
    expect(plainRowText(opened.screen.rows[0]).length).toBe(80);
    expect(plainRowText(opened.screen.rows[1]).length).toBe(20);
    const view = await pushed(channel, () => channel.resize(40, 24));
    expect(plainRowText(view.screen.rows[0]).length).toBe(40);
    expect(plainRowText(view.screen.rows[2]).length).toBe(20);
  }, 30000);

  it('puts the cursor cell after a tab where vim does, ruler included', async () => {
    const { channel } = await wireShellChannel();
    await channel.runLine(`printf '\\tx\\n' > /tmp/g5.txt`);
    await channel.openEditor('vim /tmp/g5.txt');
    const view = await channel.sendEditorKey({ key: 'l' }) as VimEditorView;
    expect(view.screen.cursor).toEqual({ row: 0, col: 8 });
    expect(view.screen.rows[23].text).toContain('1,2-9');
  }, 30000);

  it('scrolls a long file with Ctrl-F and keeps the cursor on a visible row', async () => {
    const { channel } = await wireShellChannel();
    await channel.runLine(`seq 1 100 | sed 's/^/line /' > /tmp/g6.txt`);
    await channel.openEditor('vim /tmp/g6.txt');
    const view = await channel.sendEditorKey({ key: 'f', ctrl: true }) as VimEditorView;
    expect(plainRowText(view.screen.rows[0])).toBe('line 22');
    expect(view.screen.cursor!.row).toBeGreaterThanOrEqual(0);
    expect(view.screen.cursor!.row).toBeLessThan(23);
  }, 30000);

  it('scrolls with the mouse wheel by three lines', async () => {
    const { channel } = await wireShellChannel();
    await channel.runLine(`seq 1 100 | sed 's/^/line /' > /tmp/g7.txt`);
    await channel.openEditor('vim /tmp/g7.txt');
    const view = await channel.scrollEditor(true, 3) as VimEditorView;
    expect(plainRowText(view.screen.rows[0])).toBe('line 4');
  }, 30000);

  it('shows the same rows as a local engine fed the same keys at the same size', async () => {
    const { channel } = await wireShellChannel();
    await channel.runLine(`seq 1 100 | sed 's/^/line /' > /tmp/g8.txt`);
    await channel.openEditor('vim /tmp/g8.txt');
    channel.resize(50, 12);
    await channel.runLine('true');
    const keys = [{ key: '3' }, { key: '0' }, { key: 'G' }, { key: 'd', ctrl: true }, { key: 'z' }, { key: 'z' }];
    let remote = await channel.sendEditorKey(keys[0]) as VimEditorView;
    for (const k of keys.slice(1)) remote = await channel.sendEditorKey(k) as VimEditorView;

    const content = hundred.replace(/line/g, 'line') + '\n';
    const local = new VimEngine(new InMemoryEditorFsContext({ '/tmp/g8.txt': content }), '/tmp/g8.txt', content, false, 'vim');
    local.resize(12, 50);
    for (const k of keys) local.applyKey(editorKey(k.key, { ctrl: k.ctrl === true }));
    const rows = (rs: readonly { text: string }[]) => rs.slice(0, -1).map((r) => r.text);
    expect(rows(remote.screen.rows)).toEqual(rows(local.screen.rows));
    expect(remote.screen.cursor).toEqual(local.screen.cursor);
  }, 30000);
});
