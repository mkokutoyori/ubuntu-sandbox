/*
 * Le linter et le formateur d'un nano ouvert par SSH : la commande est lancee par le SERVEUR, avec son systeme de fichiers, et la vue
 * (titre « Linting -- », message du linter, tampon formate) traverse le fil.  Memes regles que probe-nano-lint-machine.test.ts.
 *
 * Mesure avec le commit precedent : « lints with the linter of a remote ~/.nanorc » et « formats with the formatter of a remote
 * ~/.nanorc » tombent ; le TEMOIN « un fichier texte distant n'a pas de linter » passe avant comme apres.
 */
import { describe, it, expect } from 'vitest';
import type { NanoEditorView } from '@/network/devices/linux/editors/EditorView';
import { editorKey } from '@/network/devices/linux/editors/EditorKeyInput';
import { resetSshShellLab, wireShellChannel } from './_helpers/sshShellChannelLab';

resetSshShellLab();

describe('nano linter and formatter over SSH', () => {
  it('WITNESS: a remote text file has no linter', async () => {
    const { channel } = await wireShellChannel();
    await channel.runLine(`printf 'alpha\\n' > /tmp/l1.txt`);
    await channel.openEditor('nano /tmp/l1.txt');
    await channel.sendEditorKey(editorKey('t', { ctrl: true }));
    const view = await channel.sendEditorKey(editorKey('y', { ctrl: true })) as NanoEditorView;
    expect(view.statusMessage).toBe('[ No linter is defined for this type of file ]');
  }, 30000);

  it('lints with the linter of a remote ~/.nanorc', async () => {
    const { channel } = await wireShellChannel();
    await channel.runLine(`printf 'alpha\\nTODO one\\n' > /tmp/l2.txt`);
    await channel.runLine(`printf 'syntax "t" "\\\\.txt$"\\nlinter grep -Hn TODO\\ncolor red "ZZZ"\\n' > ~/.nanorc`);
    await channel.openEditor('nano /tmp/l2.txt');
    await channel.sendEditorKey(editorKey('t', { ctrl: true }));
    const view = await channel.sendEditorKey(editorKey('y', { ctrl: true })) as NanoEditorView;
    expect(view.screen.rows[0].text.trim()).toBe('Linting -- /tmp/l2.txt');
    expect(view.cursorLine).toBe(1);
  }, 30000);

  it('formats with the formatter of a remote ~/.nanorc', async () => {
    const { channel } = await wireShellChannel();
    await channel.runLine(`printf 'alpha\\nbeta\\n' > /tmp/l3.txt`);
    await channel.runLine(`printf 'syntax "t" "\\\\.txt$"\\nformatter sed -i s/a/A/g\\ncolor red "ZZZ"\\n' > ~/.nanorc`);
    await channel.openEditor('nano /tmp/l3.txt');
    await channel.sendEditorKey(editorKey('t', { ctrl: true }));
    const view = await channel.sendEditorKey(editorKey('o', { ctrl: true })) as NanoEditorView;
    expect(view.lines).toEqual(['AlphA', 'betA']);
  }, 30000);
});
