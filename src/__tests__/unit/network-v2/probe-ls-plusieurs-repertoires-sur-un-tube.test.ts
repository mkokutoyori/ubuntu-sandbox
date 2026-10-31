/**
 * ls(1) avec plusieurs opérandes répertoires, sortie sur un tube : en-têtes « dir: », une entrée par ligne, ligne vide entre blocs, fichiers d'abord ; sortie relevée sur le ls 9.4 de cette machine.
 * Mesure de départ : l'entrée TODO annonçait la mise en colonnes non comparée ; les 3 cas passent déjà avant (non-régression), l'entrée était périmée.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';

describe('ls sur plusieurs opérandes', () => {
  let pc: LinuxPC;
  beforeEach(async () => {
    pc = new LinuxPC('linux-pc', 'PC1');
    await pc.executeCommand('mkdir -p /tmp/lsm/d1 /tmp/lsm/d2; cd /tmp/lsm; touch d1/b d1/a d2/c f1');
  });
  const run = (command: string): Promise<string> => pc.executeCommand(`cd /tmp/lsm; ${command}`);

  it('deux répertoires', async () => { expect(await run('ls d1 d2 | cat')).toBe('d1:\na\nb\n\nd2:\nc'); });
  it('fichier puis répertoires', async () => { expect(await run('ls f1 d1 d2 | cat')).toBe('f1\n\nd1:\na\nb\n\nd2:\nc'); });
  it('liste longue', async () => { expect(await run('ls -l d1 d2 | cat | grep -cE "^d[12]:"')).toBe('2'); });
});
