/**
 * La coloration syntaxique d'un `~/.nanorc` lu par un nano ouvert par SSH : le serveur lit les fichiers de SA machine avec
 * l'utilisateur de la session, choisit la syntaxe sur le chemin du fichier et les intervalles peints traversent la vue.  Memes
 * regles que probe-nano-syntax.test.ts, ici sur le fil.
 *
 * Mesure avec un moteur qui lit les syntaxes sans les evaluer : « paints the words a remote syntax asks for » et « follows
 * a remote include » tombent ; le TEMOIN « sans nanorc aucune rangee n'est coloree » passe avant comme apres.
 */
import { describe, it, expect } from 'vitest';
import type { NanoEditorView } from '@/network/devices/linux/editors/EditorView';
import { paintKey } from '@/network/devices/linux/editors/screen/EditorScreen';
import { resetSshShellLab, wireShellChannel } from './_helpers/sshShellChannelLab';

resetSshShellLab();

const paintsOfFirstTextRow = (view: NanoEditorView): string[] =>
  view.screen.rows[1].spans.filter((span) => span.paint !== undefined).map((span) => `${span.from}-${span.to}:${paintKey(span.paint!)}`);

describe('nano syntax colouring over SSH', () => {
  it('WITNESS: a remote nano without a nanorc colours no cell of the text', async () => {
    const { channel } = await wireShellChannel();
    await channel.runLine(`printf 'alpha beta\\n' > /tmp/s1.txt`);
    const view = await channel.openEditor('nano /tmp/s1.txt') as NanoEditorView;
    expect(paintsOfFirstTextRow(view)).toEqual([]);
  }, 30000);

  it('paints the words a remote syntax asks for', async () => {
    const { channel } = await wireShellChannel();
    await channel.runLine(`printf 'alpha beta\\n' > /tmp/s2.txt`);
    await channel.runLine(`printf 'syntax "t" "\\\\.txt$"\\ncolor red "alpha"\\nicolor green "BETA"\\n' > ~/.nanorc`);
    const view = await channel.openEditor('nano /tmp/s2.txt') as NanoEditorView;
    expect(paintsOfFirstTextRow(view)).toEqual(['0-5:1/-/', '6-10:2/-/']);
  }, 30000);

  it('follows a remote include and chooses the syntax on the remote path', async () => {
    const { channel } = await wireShellChannel();
    await channel.runLine(`printf 'alpha beta\\n' > /tmp/s3.txt`);
    await channel.runLine(`printf 'syntax "i" "^/tmp/s3\\\\.txt$"\\ncolor blue "beta"\\n' > ~/more.nanorc`);
    await channel.runLine(`printf 'include "~/more.nanorc"\\n' > ~/.nanorc`);
    const view = await channel.openEditor('nano /tmp/s3.txt') as NanoEditorView;
    expect(paintsOfFirstTextRow(view)).toEqual(['6-10:4/-/']);
  }, 30000);
});
