/*
 * Le correcteur alternatif d'un nano ouvert par SSH : le programme est lance par le SERVEUR, sur son systeme de fichiers, et le tampon corrige
 * traverse le fil.  La ligne `nano -s "sed -i s/a/A/g" FICHIER` est decoupee avec les guillemets du shell, comme sur la console.
 *
 * Mesure avec le commit precedent : les deux tests « corrects » tombent (la valeur `speller` n'etait jamais lancee, et la ligne de lancement
 * coupait `-s "sed` aux espaces) ; le TEMOIN « sans
 * programme, le correcteur interne repond « Error invoking "spell" » » passe avant comme apres.
 */
import { describe, it, expect } from 'vitest';
import type { NanoEditorView } from '@/network/devices/linux/editors/EditorView';
import { editorKey } from '@/network/devices/linux/editors/EditorKeyInput';
import { resetSshShellLab, wireShellChannel } from './_helpers/sshShellChannelLab';

resetSshShellLab();

describe('nano alternative spell checker over SSH', () => {
  it('WITNESS: without a program the internal checker answers that "spell" cannot be run', async () => {
    const { channel } = await wireShellChannel();
    await channel.runLine(`printf 'alpha\\n' > /tmp/s1.txt`);
    await channel.openEditor('nano /tmp/s1.txt');
    await channel.sendEditorKey(editorKey('t', { ctrl: true }));
    const view = await channel.sendEditorKey(editorKey('s', { ctrl: true })) as NanoEditorView;
    expect(view.statusMessage).toBe('[ Error invoking "spell" ]');
  }, 30000);

  it('corrects with the program of -s typed between quotes', async () => {
    const { channel } = await wireShellChannel();
    await channel.runLine(`printf 'alpha\\nbeta\\n' > /tmp/s2.txt`);
    await channel.openEditor('nano -s "sed -i s/a/A/g" /tmp/s2.txt');
    await channel.sendEditorKey(editorKey('t', { ctrl: true }));
    const view = await channel.sendEditorKey(editorKey('s', { ctrl: true })) as NanoEditorView;
    expect(view.lines).toEqual(['AlphA', 'betA']);
    expect(view.statusMessage).toBe('[ Finished checking spelling ]');
  }, 30000);

  it('corrects with the speller of a remote ~/.nanorc', async () => {
    const { channel } = await wireShellChannel();
    await channel.runLine(`printf 'alpha\\nbeta\\n' > /tmp/s3.txt`);
    await channel.runLine(`printf 'set speller "sed -i s/a/A/g"\\n' > ~/.nanorc`);
    await channel.openEditor('nano /tmp/s3.txt');
    await channel.sendEditorKey(editorKey('t', { ctrl: true }));
    const view = await channel.sendEditorKey(editorKey('s', { ctrl: true })) as NanoEditorView;
    expect(view.lines).toEqual(['AlphA', 'betA']);
  }, 30000);
});
