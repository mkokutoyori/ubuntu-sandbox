/**
 * Le saut bref de `showmatch` par SSH : le serveur calcule l'ecran de l'instant du saut ET l'ecran qui lui
 * succede (`screen.hold`), le client n'a plus qu'a basculer de l'un a l'autre apres `matchtime` dixiemes de
 * seconde, sans aller-retour sur le fil.  Les cas lisent `view.screen` renvoye par le fil.
 *
 * Mesure avec `git stash push -- src/network src/terminal src/components` : `showmatch` y etait lu et ignore, la vue
 * ne porte aucun `hold` et le curseur de l'ecran reste apres la parenthese fermante, donc le second cas tombe
 * avant ; le premier est le TEMOIN, le meme pas de lab que « vim opens a buffer on the remote file » de
 * ssh-wire-editor.test.ts, qui passe avant comme apres.
 */
import { describe, it, expect } from 'vitest';
import type { VimEditorView } from '@/network/devices/linux/editors/EditorView';
import { resetSshShellLab, wireShellChannel } from './_helpers/sshShellChannelLab';

resetSshShellLab();

async function type(channel: Awaited<ReturnType<typeof wireShellChannel>>['channel'], keys: string[]): Promise<VimEditorView> {
  let view = null as VimEditorView | null;
  for (const key of keys) view = await channel.sendEditorKey({ key }) as VimEditorView;
  return view!;
}

describe('showmatch over SSH', () => {
  it('TEMOIN : the buffer opens on the server and carries its line', async () => {
    const { channel } = await wireShellChannel();
    await channel.runLine(`printf 'foo(bar\\n' > /tmp/sm0.txt`);
    const view = await channel.openEditor('vim /tmp/sm0.txt') as VimEditorView;
    expect(view.lines).toEqual(['foo(bar']);
  }, 30000);

  it('sends the jump and the screen that follows it in the same view', async () => {
    const { channel } = await wireShellChannel();
    await channel.runLine(`printf 'foo(bar\\n' > /tmp/sm1.txt`);
    await channel.openEditor('vim /tmp/sm1.txt');
    await type(channel, [':', 's', 'e', 't', ' ', 's', 'm', 'Enter', 'A']);
    const view = await type(channel, [')']);
    expect(view.screen.cursor).toEqual({ row: 0, col: 3 });
    expect(view.screen.hold?.millis).toBe(500);
    expect(view.screen.hold?.then.cursor).toEqual({ row: 0, col: 8 });
    const next = await type(channel, ['x']);
    expect(next.screen.hold).toBeUndefined();
  }, 30000);
});
