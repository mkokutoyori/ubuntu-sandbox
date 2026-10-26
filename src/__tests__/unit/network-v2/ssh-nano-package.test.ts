/*
 * Le paquet nano d'Ubuntu lu par un nano ouvert par SSH : l'image du serveur livre /etc/nanorc et /usr/share/nano, le serveur choisit
 * la syntaxe sur le chemin du fichier et les intervalles peints traversent la vue.  Memes regles que probe-nano-package-machine.test.ts,
 * ici sur le fil.
 *
 * Mesure avec une image sans ces fichiers (le commit precedent) : « colours a remote C file with the package syntax » tombe ; le TEMOIN
 * « un fichier texte distant n'est pas colore » passe avant comme apres.
 */
import { describe, it, expect } from 'vitest';
import type { NanoEditorView } from '@/network/devices/linux/editors/EditorView';
import { paintKey } from '@/network/devices/linux/editors/screen/EditorScreen';
import { resetSshShellLab, wireShellChannel } from './_helpers/sshShellChannelLab';

resetSshShellLab();

const paintsOfFirstTextRow = (view: NanoEditorView): string[] =>
  view.screen.rows[1].spans.filter((span) => span.paint !== undefined).map((span) => `${span.from}-${span.to}:${paintKey(span.paint!)}`);

describe('the nano package over SSH', () => {
  it('WITNESS: a remote text file nothing in the package matches is not coloured', async () => {
    const { channel } = await wireShellChannel();
    await channel.runLine(`printf 'alpha beta\\n' > /tmp/p1.txt`);
    const view = await channel.openEditor('nano /tmp/p1.txt') as NanoEditorView;
    expect(paintsOfFirstTextRow(view)).toEqual([]);
  }, 30000);

  it('colours a remote C file with the package syntax', async () => {
    const { channel } = await wireShellChannel();
    await channel.runLine(`printf 'int x;\\n' > /tmp/p2.c`);
    const view = await channel.openEditor('nano /tmp/p2.c') as NanoEditorView;
    expect(paintsOfFirstTextRow(view)).toEqual(['0-3:2/-/']);
  }, 30000);
});
