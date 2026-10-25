/**
 * Le meme ecran de nano par SSH qu'en local, a la taille du terminal : le serveur recoit la
 * geometrie par `pty-req` puis `window-change` (RFC 4254 §6.2 et §6.7), ouvre nano a cette taille,
 * le redimensionne quand elle change et pousse l'ecran recalcule sans attendre une touche.  Les
 * cas lisent `view.screen` (titre, fenetre, rangee d'etat, raccourcis, cellule du curseur)
 * renvoye par le fil, et le clic de la souris y rejoint le moteur du serveur.
 *
 * Mesure contre le commit precedent (a0acef2cc, extrait a cote) : l'ancienne vue de nano n'a pas
 * d'`screen` (elle portait `displayContent` et `displayCursorOffset` pour un <textarea>) et le
 * serveur ne redimensionne pas nano, donc 7 des 8 cas tombent avant.  Le TEMOIN passe avant comme
 * apres : c'est le meme pas de lab que « nano opens a buffer on the remote file » de
 * ssh-wire-editor.test.ts, l'editeur s'ouvre bien de l'autre cote du fil.
 */
import { describe, it, expect } from 'vitest';
import type { NanoEditorView } from '@/network/devices/linux/editors/EditorView';
import { plainRowText } from '@/network/devices/linux/editors/screen/EditorScreen';
import { NanoEngine } from '@/network/devices/linux/editors/NanoEngine';
import { InMemoryEditorFsContext } from '@/network/devices/linux/editors/InMemoryEditorFsContext';
import { editorKey } from '@/network/devices/linux/editors/EditorKeyInput';
import { resetSshShellLab, wireShellChannel } from './_helpers/sshShellChannelLab';

resetSshShellLab();

async function pushed(channel: { onEditorView(h: (v: unknown) => void): () => void }, action: () => void): Promise<NanoEditorView> {
  return new Promise<NanoEditorView>((resolve) => {
    const off = channel.onEditorView((view) => { off(); resolve(view as NanoEditorView); });
    action();
  });
}

const row = (view: NanoEditorView, index: number): string => plainRowText(view.screen.rows[index]).trimEnd();

describe('nano over SSH: the screen follows the terminal geometry', () => {
  it('TEMOIN : the buffer opens on the server and carries its lines', async () => {
    const { channel } = await wireShellChannel();
    await channel.runLine(`printf 'one\\ntwo\\n' > /tmp/n0.txt`);
    const view = await channel.openEditor('nano /tmp/n0.txt') as NanoEditorView;
    expect(view.lines.slice(0, 2)).toEqual(['one', 'two']);
  }, 30000);

  it('opens at the 24x80 of the pty-req: title, 20 text rows, status and two shortcut rows', async () => {
    const { channel } = await wireShellChannel();
    await channel.runLine(`printf 'one\\ntwo\\n' > /tmp/n1.txt`);
    const view = await channel.openEditor('nano /tmp/n1.txt') as NanoEditorView;
    expect(view.screen.rows.length).toBe(24);
    expect(row(view, 0)).toContain('GNU nano');
    expect(row(view, 1)).toBe('one');
    expect(row(view, 21)).toContain('[ Read 2 lines ]');
    expect(row(view, 22)).toContain('^G Help');
    expect(row(view, 23)).toContain('^X Exit');
  }, 30000);

  it('opens at the size of a window-change sent before the editor', async () => {
    const { channel } = await wireShellChannel();
    await channel.runLine(`printf 'one\\n' > /tmp/n2.txt`);
    channel.resize(100, 30);
    await channel.runLine('true');
    const view = await channel.openEditor('nano /tmp/n2.txt') as NanoEditorView;
    expect(view.screen.rows.length).toBe(30);
    expect(plainRowText(view.screen.rows[0]).length).toBe(100);
  }, 30000);

  it('a window-change while the editor is open pushes the reflowed screen', async () => {
    const { channel } = await wireShellChannel();
    await channel.runLine(`printf 'one\\ntwo\\n' > /tmp/n3.txt`);
    await channel.openEditor('nano /tmp/n3.txt');
    const view = await pushed(channel, () => channel.resize(60, 10));
    expect(view.screen.rows.length).toBe(10);
    expect(plainRowText(view.screen.rows[0]).length).toBe(60);
    expect(row(view, 8)).toContain('^G Help');
  }, 30000);

  it('puts the cursor cell after a tab where nano does', async () => {
    const { channel } = await wireShellChannel();
    await channel.runLine(`printf 'a\\tb\\n' > /tmp/n4.txt`);
    await channel.openEditor('nano /tmp/n4.txt');
    await channel.sendEditorKey({ key: 'ArrowRight' });
    const view = await channel.sendEditorKey({ key: 'ArrowRight' }) as NanoEditorView;
    expect(view.screen.cursor).toEqual({ row: 1, col: 8 });
  }, 30000);

  it('scrolls a long line sideways with the < marker when the terminal is narrow', async () => {
    const { channel } = await wireShellChannel();
    await channel.runLine(`printf '${'0123456789'.repeat(10)}\\n' > /tmp/n5.txt`);
    await channel.openEditor('nano /tmp/n5.txt');
    channel.resize(40, 24);
    await channel.runLine('true');
    const view = await channel.sendEditorKey({ key: 'e', ctrl: true }) as NanoEditorView;
    expect(row(view, 1).startsWith('<')).toBe(true);
    expect(view.screen.cursor!.col).toBeLessThan(40);
  }, 30000);

  it('moves the cursor to the clicked cell', async () => {
    const { channel } = await wireShellChannel();
    await channel.runLine(`printf 'alpha\\nbravo\\ncharlie\\n' > /tmp/n6.txt`);
    await channel.openEditor('nano -m /tmp/n6.txt');
    const view = await channel.clickEditor(3, 4) as NanoEditorView;
    expect(view.cursorLine).toBe(2);
    expect(view.cursorCol).toBe(4);
    expect(view.screen.cursor).toEqual({ row: 3, col: 4 });
  }, 30000);

  it('ignores a click when nano was not started with -m', async () => {
    const { channel } = await wireShellChannel();
    await channel.runLine(`printf 'alpha\nbravo\ncharlie\n' > /tmp/n6b.txt`);
    await channel.openEditor('nano /tmp/n6b.txt');
    const view = await channel.clickEditor(3, 4) as NanoEditorView;
    expect(view.cursorLine).toBe(0);
    expect(view.cursorCol).toBe(0);
  }, 30000);

  it('shows the same rows as a local engine fed the same keys at the same size', async () => {
    const { channel } = await wireShellChannel();
    await channel.runLine(`seq 1 100 | sed 's/^/line /' > /tmp/n7.txt`);
    await channel.openEditor('nano /tmp/n7.txt');
    channel.resize(50, 12);
    await channel.runLine('true');
    const keys = [{ key: 'v', ctrl: true }, { key: 'v', ctrl: true }, { key: 'ArrowDown' }, { key: 'y', ctrl: true }];
    let remote = await channel.sendEditorKey(keys[0]) as NanoEditorView;
    for (const k of keys.slice(1)) remote = await channel.sendEditorKey(k) as NanoEditorView;

    const content = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
    const local = new NanoEngine(new InMemoryEditorFsContext({ '/tmp/n7.txt': content }), '/tmp/n7.txt', content, false, false, undefined, false, { displayName: '/tmp/n7.txt' });
    local.resize(12, 50);
    for (const k of keys) local.applyKey(editorKey(k.key, { ctrl: k.ctrl === true }));
    const body = (rs: readonly { text: string }[]) => rs.slice(1, -3).map((r) => r.text);
    expect(body(remote.screen.rows)).toEqual(body(local.screen.rows));
    expect(remote.screen.cursor).toEqual(local.screen.cursor);
  }, 30000);
});
