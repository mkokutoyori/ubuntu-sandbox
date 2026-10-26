/**
 * Les couleurs d'un `~/.nanorc` lu par un nano ouvert par SSH : le serveur lit les fichiers de SA machine avec l'utilisateur de la
 * session et les peintures traversent la vue (rangees, intervalles et peinture de chaque intervalle).  Memes regles que
 * probe-nano-colors.test.ts, ici sur le fil.
 *
 * Mesure avec un moteur qui lit les couleurs sans les evaluer : « paints the colours a remote ~/.nanorc asks for » tombe ; le
 * TEMOIN « sans nanorc la barre de titre est en video inverse » passe avant comme apres.
 */
import { describe, it, expect } from 'vitest';
import type { NanoEditorView } from '@/network/devices/linux/editors/EditorView';
import { paintKey } from '@/network/devices/linux/editors/screen/EditorScreen';
import { resetSshShellLab, wireShellChannel } from './_helpers/sshShellChannelLab';

resetSshShellLab();

const titleLook = (view: NanoEditorView): string | null => {
  const span = view.screen.rows[0].spans[0];
  return span?.paint === undefined ? span?.style ?? null : paintKey(span.paint);
};

describe('nano interface colours over SSH', () => {
  it('WITNESS: a remote nano without a nanorc has the reverse title bar', async () => {
    const { channel } = await wireShellChannel();
    await channel.runLine(`printf 'one\\n' > /tmp/c1.txt`);
    const view = await channel.openEditor('nano /tmp/c1.txt') as NanoEditorView;
    expect(titleLook(view)).toBe('reverse');
  }, 30000);

  it('paints the colours a remote ~/.nanorc asks for', async () => {
    const { channel } = await wireShellChannel();
    await channel.runLine(`printf 'one\\n' > /tmp/c2.txt`);
    await channel.runLine(`printf 'set titlecolor red,green\\nset keycolor blue\\n' > ~/.nanorc`);
    const view = await channel.openEditor('nano /tmp/c2.txt') as NanoEditorView;
    expect(titleLook(view)).toBe('1/2/');
    const bars = view.screen.rows[view.screen.rows.length - 2];
    expect(bars.spans[0].paint).toMatchObject({ fg: 4, bg: null });
  }, 30000);
});
