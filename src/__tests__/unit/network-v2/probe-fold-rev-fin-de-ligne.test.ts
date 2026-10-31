/**
 * util-linux rev et coreutils fold : sorties relevées sur les binaires réels de cette machine (fold 9.4, rev util-linux 2.39).
 * Mesure de départ : fold ajoutait un « \n » à une entrée non terminée et rev ignorait ses fichiers opérandes. 4 des 6 cas tombent avant ; les témoins (fold sur entrée terminée, rev sur stdin) passent dans les deux états.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';

describe('fold et rev', () => {
  let pc: LinuxPC;
  beforeEach(async () => {
    pc = new LinuxPC('linux-pc', 'PC1');
    await pc.executeCommand("printf 'abc\\ndef' > /tmp/rv.txt");
  });

  it('fold n\'ajoute pas de retour à la ligne à une entrée non terminée', async () => {
    expect(await pc.executeCommand("printf 'abcdef' | fold -w 3 | od -c | head -1")).toBe('0000000   a   b   c  \\n   d   e   f');
  });
  it('fold court sur une ligne courte non terminée', async () => {
    expect(await pc.executeCommand("printf 'abc' | fold -w 5 | od -c | head -1")).toBe('0000000   a   b   c');
  });
  it('rev lit un fichier opérande', async () => { expect(await pc.executeCommand('rev /tmp/rv.txt | od -c | head -1')).toBe('0000000   c   b   a  \\n   f   e   d'); });
  it('rev signale un fichier absent et continue', async () => {
    expect(await pc.executeCommand('rev /nonexistent /tmp/rv.txt 2>&1; echo rc=$?')).toBe('rev: cannot open /nonexistent: No such file or directory\ncba\nfedrc=1');
  });
  it('témoin : fold sur une entrée terminée', async () => {
    expect(await pc.executeCommand("printf 'abcdef\\n' | fold -w 3 | od -c | head -1")).toBe('0000000   a   b   c  \\n   d   e   f  \\n');
  });
  it('témoin : rev sur l\'entrée standard', async () => { expect(await pc.executeCommand("printf 'abc\\n' | rev")).toBe('cba'); });
});
