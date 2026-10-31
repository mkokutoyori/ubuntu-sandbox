/**
 * bash 5.2 : un piège EXIT posé dans une fonction appartient au shell entier (il s'exécute à la sortie), et « exit N » dans le gestionnaire fixe le code de sortie ; sorties relevées sur le bash réel de cette machine.
 * Mesure de départ : le piège posé dans une fonction disparaissait avec le cadre de la fonction, et « exit 9 » du gestionnaire était avalé (code 0). 2 des 5 cas tombent avant ; les témoins (niveau supérieur, code de sortie conservé, trap - EXIT) passent dans les deux états.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';

describe('piège EXIT', () => {
  let pc: LinuxPC;
  beforeEach(() => { pc = new LinuxPC('linux-pc', 'PC1'); });
  const run = (script: string): Promise<string> => pc.executeCommand(`bash -c '${script}'; echo rc=$?`);

  it('posé dans une fonction', async () => { expect(await run('f(){ trap "echo inner" EXIT; }; f; echo m')).toBe('m\ninner\nrc=0'); });
  it('exit N du gestionnaire fixe le code', async () => { expect(await run('trap "echo A; exit 9" EXIT; true')).toBe('A\nrc=9'); });
  it('témoin : au niveau supérieur', async () => { expect(await run('trap "echo bye" EXIT; echo hi')).toBe('hi\nbye\nrc=0'); });
  it('témoin : le code du script est conservé', async () => { expect(await run('trap "echo A" EXIT; false')).toBe('A\nrc=1'); });
  it('témoin : trap - EXIT le retire', async () => { expect(await run('trap "echo A" EXIT; trap - EXIT; echo x')).toBe('x\nrc=0'); });
});
